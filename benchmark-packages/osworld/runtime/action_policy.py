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


def load_graphical_policy():
    spec = importlib.util.find_spec('desktop_env.actions')
    if spec is None or not spec.origin or hashlib.sha256(Path(spec.origin).read_bytes()).hexdigest() != ACTIONS_SHA256:
        raise RuntimeError('OSWorld actions differ from the locked v2026.08.08 source')
    return GraphicalActionPolicy(importlib.import_module('desktop_env.actions').ACTION_SPACE)
