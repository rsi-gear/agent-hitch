"""Candidate channel for the pinned OSWorld Agent.reset/predict interface.

Management methods must remain behind the controller's private interface. A
reset requires a new Hitch run binding; old candidate tokens cannot cross phases.
The native SDK still owns phase setup, action execution, step budgets and grading.
"""
import base64
import copy
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import struct
import threading


class ChannelClosed(RuntimeError):
    pass


class AgentChannel:
    def __init__(self, evidence_dir, screen_size, validate_actions, *, max_actions_per_turn, max_text_bytes):
        if len(screen_size) != 2 or any(type(v) is not int or not 1 <= v <= 8192 for v in screen_size):
            raise ValueError('invalid locked screenshot dimensions')
        if not callable(validate_actions) or type(max_actions_per_turn) is not int or not 1 <= max_actions_per_turn <= 256:
            raise ValueError('an action validator and explicit batch budget are required')
        if type(max_text_bytes) is not int or not 1 <= max_text_bytes <= 1048576:
            raise ValueError('invalid text transport limit')
        self.directory = Path(evidence_dir)
        self.directory.mkdir(parents=True, exist_ok=False)
        self.screen_size = tuple(screen_size)
        self.validate_actions = validate_actions
        self.max_actions_per_turn, self.max_text_bytes = max_actions_per_turn, max_text_bytes
        self.condition = threading.Condition(threading.RLock())
        self.generation, self.sequence = 0, 0
        self.state = 'created'
        self.binding = None
        self.used_run_ids = set()
        self.pending = None
        self.answer = None
        self.receipts = {}
        self.task_current_date = None

    def _audit(self, event, **fields):
        value = dict(event=event, generation=self.generation, sequence=self.sequence, **fields)
        descriptor = os.open(self.directory / 'channel.jsonl', os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        with os.fdopen(descriptor, 'a', encoding='utf-8') as stream:
            stream.write(json.dumps(value, ensure_ascii=False, allow_nan=False) + '\n')
            stream.flush()

    def reset(self, *_args, **_kwargs):
        """Called by the native runner once per new agent conversation."""
        with self.condition:
            if self.state in ['completed', 'failed', 'cancelled']:
                raise ChannelClosed('native runner reset a closed channel')
            if self.pending is not None:
                raise RuntimeError('native runner reset with an unfinished prediction')
            self.generation += 1
            self.binding = None
            self.answer = None
            self.state = 'context_required'
            self._audit('context_required')
            self.condition.notify_all()

    def predict(self, instruction, observation):
        """Wait for exactly one action batch, without making a model request."""
        with self.condition:
            if self.generation < 1 or self.state in ['completed', 'failed', 'cancelled']:
                raise ChannelClosed('prediction requires an open native conversation')
            if self.pending is not None:
                raise RuntimeError('overlapping native predictions')
            if not isinstance(instruction, str) or len(instruction.encode()) > self.max_text_bytes:
                raise ValueError('invalid instruction')
            if not isinstance(observation, dict) or observation.get('accessibility_tree') is not None or observation.get('terminal') is not None:
                raise ValueError('screenshot profile received another observation modality')
            screenshot = observation.get('screenshot')
            if not isinstance(screenshot, bytes) or not 24 <= len(screenshot) <= 4 * 1024 * 1024 or screenshot[:16] != b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR':
                raise ValueError('native screenshot must be a bounded PNG')
            if struct.unpack('!II', screenshot[16:24]) != self.screen_size:
                raise ValueError('native screenshot dimensions differ from the locked profile')
            user_response = observation.get('user_response')
            if user_response is not None and (not isinstance(user_response, str) or len(user_response.encode()) > self.max_text_bytes):
                raise ValueError('invalid native user-simulator response')
            text_payload = json.dumps(dict(instruction=instruction, user_response=user_response), ensure_ascii=False, allow_nan=False)
            if len(text_payload.encode()) > self.max_text_bytes:
                raise ValueError('native observation text exceeds transport limit')
            self.sequence += 1
            filename = f'observation-{self.sequence:06d}.png'
            descriptor = os.open(self.directory / filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(screenshot)
            self.pending = dict(sequence=self.sequence, generation=self.generation, instruction=instruction,
                                screenshot_file=filename, screenshot_sha256=hashlib.sha256(screenshot).hexdigest(), user_response=user_response)
            self.state = 'awaiting_actions' if self.binding else 'context_required'
            self._audit('prediction', **{k: v for k, v in self.pending.items() if k not in ['sequence', 'generation']})
            self.condition.notify_all()
            self.condition.wait_for(lambda: self.answer is not None or self.state in ['completed', 'failed', 'cancelled'])
            if self.answer is None:
                raise ChannelClosed('candidate channel closed before a prediction completed')
            answer = self.answer
            self.answer = self.pending = None
            self.state = 'sdk_executing'
            self.condition.notify_all()
            return answer

    def management_state(self):
        """Private supervisor view. This is not an agent-facing tool."""
        with self.condition:
            return dict(state=self.state, generation=self.generation, sequence=self.sequence,
                        run_id=self.binding['run_id'] if self.binding else None,
                        prediction=copy.deepcopy(self.pending), task_current_date=self.task_current_date)

    def bind_context(self, generation, run_id):
        """Private supervisor binds an independently started, fresh Hitch run."""
        with self.condition:
            if generation != self.generation or self.state not in ['context_required', 'awaiting_actions'] or self.pending is None:
                raise ValueError('context binding does not match a pending phase')
            if self.binding:
                if self.binding['run_id'] == run_id:
                    return self.binding['token']
                raise ValueError('phase already has a candidate run')
            if not isinstance(run_id, str) or not re.fullmatch(r'run_[a-f0-9]{32}', run_id) or run_id in self.used_run_ids:
                raise ValueError('each native reset requires a fresh Hitch run identity')
            self.binding = dict(run_id=run_id, token=secrets.token_hex(32))
            self.used_run_ids.add(run_id)
            self.state = 'awaiting_actions'
            self._audit('context_bound', run_id=run_id)
            self.condition.notify_all()
            return self.binding['token']

    def _authorize(self, token):
        if not self.binding or not isinstance(token, str) or not hmac.compare_digest(token, self.binding['token']):
            raise PermissionError('closed or stale candidate phase')

    def observe(self, token):
        with self.condition:
            self._authorize(token)
            if self.state != 'awaiting_actions' or self.pending is None:
                return dict(state='processing')
            packet = self.pending
            image = (self.directory / packet['screenshot_file']).read_bytes()
            if hashlib.sha256(image).hexdigest() != packet['screenshot_sha256']:
                raise RuntimeError('recorded screenshot integrity mismatch')
            metadata = {k: packet[k] for k in ['generation', 'sequence', 'instruction', 'user_response']}
            metadata.update(width=self.screen_size[0], height=self.screen_size[1])
            return {'protocol': 'hitch-tool-result@1', 'content': [
                {'type': 'text', 'text': json.dumps(metadata, ensure_ascii=False)},
                {'type': 'image', 'mimeType': 'image/png', 'data': base64.b64encode(image).decode('ascii')}]}

    def submit(self, token, sequence, request_id, response, actions):
        with self.condition:
            self._authorize(token)
            if not isinstance(request_id, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{8,128}', request_id):
                raise ValueError('invalid action request identity')
            if type(sequence) is not int or not isinstance(response, str) or len(response.encode()) > self.max_text_bytes:
                raise ValueError('invalid action response')
            if not isinstance(actions, list) or len(actions) > self.max_actions_per_turn:
                raise ValueError('action batch exceeds the locked profile')
            # JSON is also a copy boundary: caller mutation cannot change a
            # submitted action after validation or a receipt's identity.
            encoded = json.dumps(dict(sequence=sequence, response=response, actions=actions), sort_keys=True, ensure_ascii=False, allow_nan=False)
            if len(encoded.encode()) > self.max_text_bytes:
                raise ValueError('action request exceeds transport limit')
            digest = hashlib.sha256(encoded.encode()).hexdigest()
            key = (self.generation, request_id)
            if key in self.receipts:
                if self.receipts[key]['request_digest'] != digest:
                    raise ValueError('action request identity reused with another payload')
                return copy.deepcopy(self.receipts[key])
            if self.state != 'awaiting_actions' or not self.pending or sequence != self.sequence or self.answer is not None:
                raise ValueError('stale observation or action already submitted')
            batch = json.loads(encoded)['actions']
            self.validate_actions(batch)
            receipt = dict(accepted=True, generation=self.generation, sequence=sequence, request_id=request_id, request_digest=digest)
            self._audit('action_submitted', run_id=self.binding['run_id'], request_id=request_id, request_digest=digest, response=response, actions=batch)
            self.receipts[key] = receipt
            self.answer = (response, batch)
            self.state = 'sdk_executing'
            self.condition.notify_all()
            return copy.deepcopy(receipt)

    def finish(self, status):
        """Private SDK supervisor closes the channel, including on cancellation."""
        if status not in ['completed', 'failed', 'cancelled']:
            raise ValueError('invalid terminal channel status')
        with self.condition:
            if self.state in ['completed', 'failed', 'cancelled']:
                return
            if status == 'completed' and self.pending is not None:
                raise RuntimeError('cannot complete with a pending prediction')
            self.state = status
            self.binding = None
            self.answer = None
            try:
                self._audit(status)
            finally:
                self.condition.notify_all()
