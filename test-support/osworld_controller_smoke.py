"""Actual HTTP/Unix/Node transport test, with synthetic observations and actions."""
import base64
import faulthandler
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import threading
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import zlib

faulthandler.dump_traceback_later(10, repeat=True)


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


runtime = Path('benchmark-packages/osworld/runtime')
channel_module = module('agent_channel', runtime / 'agent_channel.py')
server_module = module('controller_server', runtime / 'controller_server.py')
client_module = module('controller_client', runtime / 'controller_client.py')
policy_module = module('action_policy', runtime / 'action_policy.py')
actions = module('native_actions', 'test-support/fixtures/osworld/native_actions.py')
policy = policy_module.GraphicalActionPolicy(actions.ACTION_SPACE)


def chunk(kind, data):
    return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))


png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', 1920, 1080, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress((b'\x00' + b'\x11\x22\x33' * 1920) * 1080)) + chunk(b'IEND', b'')


def tool(binding, name='desktop.observe', args=None, *, raw=None, route='call', token=None):
    encoded = raw if raw is not None else json.dumps({'name': name, 'arguments': args or {}}).encode()
    request = Request(binding['endpoint'] + route, data=encoded, headers={'Authorization': 'Bearer ' + (token or binding['token']), 'Content-Type': 'application/json'})
    try:
        with urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read())
    except HTTPError as error:
        return error.code, json.loads(error.read())


def node_observe(binding):
    code = """
import {invokeTool} from './integrations/harbor/hitch_tool_client.mjs';
let input = ''; for await (const part of process.stdin) input += part;
process.stdout.write(await invokeTool(JSON.parse(input), 'desktop.observe', {}));
"""
    result = subprocess.run(['node', '--input-type=module', '-e', code], input=json.dumps(binding), text=True, capture_output=True, timeout=10)
    assert result.returncode == 0, result.stderr
    observation = json.loads(result.stdout)
    metadata = json.loads(observation['content'][0]['text'])
    image = observation['content'][1]
    try:
        assert Path(image['path']).read_bytes() == png
        assert image['bytes'] == len(png) and image['sha256'] == hashlib.sha256(png).hexdigest()
    finally:
        shutil.rmtree(Path(image['path']).parent)
    return metadata


def run_case(root, cancel):
    root.mkdir()
    session = {'token': 'a' * 64, 'lease_id': 'lease_synthetic_controller', 'epoch': 2}
    private = root / 'private'; private.mkdir(mode=0o700)
    session_file = private / 'session.json'; session_file.write_text(json.dumps(session)); session_file.chmod(0o600)
    channel = channel_module.AgentChannel(root / 'evidence', (1920, 1080), policy, max_actions_per_turn=2, max_text_bytes=16384)
    server = server_module.ControllerServer(channel, session, policy, private / 'control.sock', public_address=('127.0.0.1', 0), public_endpoint='http://127.0.0.1:0/')
    assert server.private_socket.stat().st_mode & 0o777 == 0o600
    server.start()
    counter = 0
    def admin(operation, params=None, *, identity=None, rid=None):
        nonlocal counter
        counter += 1
        return client_module.control(server.private_socket, identity or session, {'request_id': rid or f'request_{counter:08d}', 'operation': operation, 'parameters': params or {}})
    outputs, errors = [], []
    proceed = threading.Event()
    def sdk():
        try:
            for generation in [1, 2]:
                channel.reset()
                outputs.append(channel.predict(f'phase {generation}', {'screenshot': png}))
                if generation == 1:
                    assert proceed.wait(5)
            channel.finish('completed')
        except channel_module.ChannelClosed as error:
            errors.append(error)
        except BaseException as error:
            errors.append(error); channel.finish('failed')
    thread = threading.Thread(target=sdk); thread.start()
    try:
        for generation in [1, 2]:
            with channel.condition:
                assert channel.condition.wait_for(lambda: channel.generation == generation and channel.pending is not None or errors, 5)
                assert not errors
            state = admin('state', rid='read_current_state')
            assert state['generation'] == generation and state['prediction']['instruction'] == f'phase {generation}'
            assert 'read_current_state' not in server.receipts
            for wrong in [{**session, 'epoch': 1}, {**session, 'token': 'b' * 64}]:
                try: admin('bind', {'generation': generation, 'run_id': 'run_' + str(generation).zfill(32)}, identity=wrong); raise AssertionError('stale private lease accepted')
                except RuntimeError: pass
            if generation == 2:
                assert tool(binding)[0] == 401
            bind_request = {'request_id': f'bind_phase_{generation}', 'operation': 'bind', 'parameters': {'generation': generation, 'run_id': 'run_' + str(generation).zfill(32)}}
            # The same CLI that a controller hook will invoke reads the private
            # session from disk; no secret appears in its process arguments.
            response = subprocess.run(['python3', str(runtime / 'controller_client.py'), '--socket', str(server.private_socket), '--session', str(session_file)], input=json.dumps(bind_request), text=True, capture_output=True, timeout=5)
            assert response.returncode == 0, response.stderr
            binding = json.loads(response.stdout)['binding']
            assert admin('bind', bind_request['parameters'], rid=bind_request['request_id'])['binding'] == binding
            assert [t['name'] for t in binding['tools']] == ['desktop.observe', 'desktop.submit']
            assert 'EXECUTE' not in json.dumps(binding['tools']) and binding['token'] != session['token']
            assert tool(binding, token=session['token'])[0] == 401
            assert tool(binding, route='control', token=session['token'])[0] == 404
            assert tool(binding, 'reset')[0] == 400
            assert tool(binding, raw=b'{"name":"desktop.observe","name":"reset","arguments":{}}')[0] == 400
            assert tool(binding, raw=b'{"name":"desktop.observe","arguments":{"value":NaN}}')[0] == 400
            assert tool(binding, raw=b'x' * 18000)[0] == 413
            metadata = node_observe(binding)
            assert metadata['generation'] == generation and metadata['sequence'] == generation
            args = {'sequence': metadata['sequence'], 'request_id': f'action_phase_{generation}', 'response': '完成', 'actions': ['DONE']}
            invalid = {**args, 'actions': [{'action_type': 'CLICK', 'x': 9999, 'y': 1}]}
            assert tool(binding, 'desktop.submit', invalid)[0] == 400
            if cancel and generation == 2:
                assert admin('cancel', rid='cancel_native_run') == {'cancelled': True}
                assert admin('cancel', rid='cancel_native_run') == {'cancelled': True}
                assert tool(binding)[0] == 401
                break
            status, receipt = tool(binding, 'desktop.submit', args)
            assert status == 200 and receipt['accepted'] is True
            if generation == 1:
                assert tool(binding, 'desktop.submit', args) == (200, receipt)
                assert tool(binding, 'desktop.submit', {**args, 'response': 'changed'})[0] == 400
                assert tool(binding) == (200, {'state': 'processing'})
                proceed.set()
        thread.join(5)
        assert not thread.is_alive()
        assert outputs == [('完成', ['DONE'])] * (1 if cancel else 2)
        assert len(errors) == (1 if cancel else 0)
        assert channel.management_state()['state'] == ('cancelled' if cancel else 'completed')
        assert tool(binding)[0] == 401
        audit = (root / 'evidence/channel.jsonl').read_text()
        assert session['token'] not in audit and binding['token'] not in audit
    finally:
        proceed.set(); server.close(); thread.join(5)
        assert not thread.is_alive() and not server.private_socket.exists()
        assert all(not worker.is_alive() for worker in server.threads)


with tempfile.TemporaryDirectory(prefix='osw-', dir='/tmp') as temporary:
    root = Path(temporary)
    run_case(root / 'complete', False)
    run_case(root / 'cancel', True)
print('OSWorld candidate HTTP/private Unix/Node image/phase fencing transport passed (synthetic only)')
