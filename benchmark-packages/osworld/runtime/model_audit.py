"""Keep swallowed SDK model failures from becoming valid benchmark scores.

The pinned facade resolves configuration and constructs a backend for every
text/chat call. Observe those shared boundaries so even previously imported
facade aliases are covered. Prompts, answers, keys and exception messages stay
out of this metadata receipt. Original return values and exceptions are kept.
"""
import hashlib
import importlib
from pathlib import Path
import threading

from runtime_config import write_json

MODEL_CLIENT_SHA256 = '02c75be6fc42dcd426464c25cb58a5cbbdf61e551bce2f41bd36dde0e73c2297'


class ModelDependencyFailure(RuntimeError):
    pass


class ModelCallAudit:
    def __init__(self, module, output):
        if getattr(module, '_hitch_model_audit', None) is not None:
            raise ModelDependencyFailure('model audit already installed')
        self.module, self.output = module, Path(output)
        if self.output.exists() or self.output.is_symlink():
            raise ValueError('model audit requires a fresh receipt')
        self.lock, self.calls, self.pending = threading.RLock(), [], {}
        self.persistence_failed = self.closed = False
        self.original_config, self.original_factory = module._build_config, module.create_backend
        self._save()
        module._hitch_model_audit = self
        module._build_config, module.create_backend = self._config, self._backend

    def _save(self):
        try:
            write_json(self.output, {'protocol': 'osworld-model-audit@1',
                'model_client_sha256': 'sha256:' + MODEL_CLIENT_SHA256,
                'calls': self.calls, 'persistence_failed': self.persistence_failed})
        except BaseException:
            self.persistence_failed = True
            raise

    def _update(self, record, **values):
        with self.lock:
            record.update(values)
            self._save()

    def _config(self, *args, **kwargs):
        with self.lock:
            if self.closed:
                raise ModelDependencyFailure('model audit is closed')
            record = {'index': len(self.calls), 'state': 'configuring'}
            self.calls.append(record)
            self._save()
        try:
            config = self.original_config(*args, **kwargs)
            # No credential-bearing config object is serialized or retained.
            metadata = {key: getattr(config, key) for key in (
                'provider', 'model', 'max_tokens', 'temperature',
                'retry_attempts', 'retry_delay', 'image_detail')}
            metadata['reasoning_effort'] = config.extra.get('reasoning_effort')
            metadata['base_url_sha256'] = ('sha256:' + hashlib.sha256(config.base_url.encode()).hexdigest()
                                            if config.base_url else None)
            with self.lock:
                self.pending[id(config)] = record
                self._update(record, state='configured', effective_config=metadata)
            return config
        except BaseException as error:
            self._update(record, state='failed', stage='configuration', error_type=type(error).__name__)
            raise

    def _backend(self, config):
        with self.lock:
            record = self.pending.pop(id(config), None)
            if record is None:
                record = {'index': len(self.calls), 'state': 'failed', 'stage': 'untracked_configuration'}
                self.calls.append(record)
                self._save()
                raise ModelDependencyFailure('untracked model configuration')
        try:
            backend = self.original_factory(config)
            self._update(record, state='backend_ready')
        except BaseException as error:
            self._update(record, state='failed', stage='backend_creation', error_type=type(error).__name__)
            raise
        audit = self

        class ObservedBackend:
            def generate(self, *args, **kwargs):
                return audit._invoke(record, 'generate', backend.generate, args, kwargs, backend)

            def chat(self, *args, **kwargs):
                return audit._invoke(record, 'chat', backend.chat, args, kwargs, backend)

        return ObservedBackend()

    def _invoke(self, record, method, operation, args, kwargs, backend):
        with self.lock:
            if record['state'] != 'backend_ready':
                self._update(record, state='failed', stage='reused_backend')
                raise ModelDependencyFailure('unexpected model backend reuse')
            self._update(record, state='running', method=method)
        try:
            result = operation(*args, **kwargs)
            metadata = {'response_type': type(result).__name__}
            if isinstance(result, str):
                metadata['response_sha256'] = 'sha256:' + hashlib.sha256(result.encode()).hexdigest()
            self._update(record, state='completed', **metadata)
            return result
        except BaseException as error:
            self._update(record, state='failed', stage=method, error_type=type(error).__name__)
            raise
        finally:
            if hasattr(backend, 'hitch_model_calls'):
                try:
                    self._update(record, transport_calls=backend.hitch_model_calls)
                finally:
                    try:
                        backend.close()
                    except BaseException as error:
                        self._update(record, state='failed', stage='backend_close', error_type=type(error).__name__)
                        raise

    def assert_healthy(self):
        with self.lock:
            if self.closed or self.persistence_failed or any(call['state'] != 'completed' for call in self.calls):
                raise ModelDependencyFailure('native model dependency failed or did not complete')
            self._save()

    def close(self):
        with self.lock:
            if not self.closed:
                self.closed = True
                self.module._build_config, self.module.create_backend = self.original_config, self.original_factory
                del self.module._hitch_model_audit


def install_model_audit(sdk_root, output):
    path = Path(sdk_root) / 'desktop_env/evaluators/model_client.py'
    if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != MODEL_CLIENT_SHA256:
        raise ValueError('OSWorld model facade differs from the pinned source')
    module = importlib.import_module('desktop_env.evaluators.model_client')
    if Path(module.__file__).resolve() != path.resolve():
        raise ValueError('OSWorld model facade was imported from another SDK')
    return ModelCallAudit(module, output)
