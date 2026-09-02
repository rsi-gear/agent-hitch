"""Declared graphical computer_13 profile, using the pinned SDK definitions.

The SDK also defines EXECUTE (guest bash). That belongs to a different profile;
it is never exposed by this screenshot/graphical channel. Coordinates are native
pixels, with no resizing, OCR, accessibility tree or coordinate transformation.
"""
import hashlib
import importlib
import importlib.util
import math
from pathlib import Path

ACTIONS_SHA256 = '8ef3e804a7d5c49619a0921688e08c0df8a1d3d9e05a1d565b799444e163ec92'


class GraphicalActionPolicy:
    def __init__(self, action_space):
        self.actions = {entry['action_type']: entry for entry in action_space}
        if len(self.actions) != len(action_space) or not {'WAIT', 'FAIL', 'DONE', 'CLICK', 'HOTKEY'} <= self.actions.keys():
            raise ValueError('invalid upstream action-space definitions')
        self.actions.pop('EXECUTE', None)

    def __call__(self, batch):
        for action in batch:
            if isinstance(action, str):
                if action not in ['WAIT', 'FAIL', 'DONE']:
                    raise ValueError('graphical actions cannot contain raw code')
                continue
            if not isinstance(action, dict) or action.get('action_type') not in self.actions:
                raise ValueError('unsupported graphical action')
            definition = self.actions[action['action_type']]
            definitions = definition.get('parameters', {})
            if 'parameters' in action:
                if set(action) != {'action_type', 'parameters'} or not isinstance(action['parameters'], dict):
                    raise ValueError('ambiguous action parameter encoding')
                parameters = action['parameters']
            else:
                parameters = {key: value for key, value in action.items() if key != 'action_type'}
            if set(parameters) - definitions.keys() or any(not spec.get('optional', False) and name not in parameters for name, spec in definitions.items()):
                raise ValueError('unknown or missing action parameter')
            if ('x' in parameters) != ('y' in parameters):
                raise ValueError('coordinate pairs must be complete')
            for name, value in parameters.items():
                spec = definitions[name]
                kind, domain = spec['type'], spec.get('range')
                if kind is float:
                    valid = type(value) in [int, float] and math.isfinite(value) and (domain is None or domain[0] <= value <= domain[1])
                elif kind is list:
                    valid = isinstance(value, list) and all(type(item) is str and (domain is None or item in domain[0]) for item in value)
                else:
                    valid = type(value) is kind and (domain is None or value in domain)
                if not valid:
                    raise ValueError('invalid graphical action parameter: ' + name)

    def tool_definitions(self, *, max_actions_per_turn, max_text_bytes):
        """Public tool schemas; privileged SDK operations are never tools."""
        variants = [{'type': 'string', 'enum': ['WAIT', 'FAIL', 'DONE']}]
        for name, definition in self.actions.items():
            properties = {'action_type': {'const': name}}
            required = ['action_type']
            for key, spec in definition.get('parameters', {}).items():
                kind, domain = spec['type'], spec.get('range')
                field = {'type': {float: 'number', int: 'integer', str: 'string', list: 'array'}[kind]}
                if domain is not None:
                    if kind is float:
                        field.update(minimum=domain[0], maximum=domain[1])
                    elif kind is list:
                        field['items'] = {'type': 'string', 'enum': domain[0]}
                    else:
                        field['enum'] = domain
                if kind is str:
                    field['maxLength'] = max_text_bytes
                properties[key] = field
                if not spec.get('optional', False):
                    required.append(key)
            value = {'type': 'object', 'properties': properties, 'required': required, 'additionalProperties': False}
            if 'x' in properties:
                value['dependentRequired'] = {'x': ['y'], 'y': ['x']}
            variants.append(value)
        return [
            {'name': 'desktop.observe', 'description': 'Read the current native screenshot and observation sequence. A processing response means the SDK is still executing. Open the returned image with the native image viewer.',
             'inputSchema': {'type': 'object', 'properties': {}, 'additionalProperties': False}},
            {'name': 'desktop.submit', 'description': f'Submit one action batch for an observed sequence. One batch consumes one native prediction step. Use the same request_id and payload when retrying. An empty batch asks the native user simulator the question in response. The complete payload is limited to {max_text_bytes} UTF-8 bytes.',
             'inputSchema': {'type': 'object', 'properties': {
                 'sequence': {'type': 'integer', 'minimum': 1},
                 'request_id': {'type': 'string', 'pattern': '^[a-zA-Z0-9_-]{8,128}$'},
                 'response': {'type': 'string', 'maxLength': max_text_bytes},
                 'actions': {'type': 'array', 'maxItems': max_actions_per_turn, 'items': {'oneOf': variants}}},
                 'required': ['sequence', 'request_id', 'response', 'actions'], 'additionalProperties': False}}
        ]


def load_graphical_policy():
    spec = importlib.util.find_spec('desktop_env.actions')
    if spec is None or not spec.origin or hashlib.sha256(Path(spec.origin).read_bytes()).hexdigest() != ACTIONS_SHA256:
        raise RuntimeError('OSWorld actions differ from the locked v2026.08.08 source')
    return GraphicalActionPolicy(importlib.import_module('desktop_env.actions').ACTION_SPACE)
