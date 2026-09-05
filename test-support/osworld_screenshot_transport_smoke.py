"""Bounded screenshot override; SDK reset and other controllers stay isolated."""
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'benchmark-packages/osworld/runtime'))
from screenshot_transport import configure_screenshot_transport, transport_profile
from vm_provider import ManagedVMProvider, create_desktop_env

PNG = b'\x89PNG\r\n\x1a\nimage'


class Controller:
    retry_times = 3
    retry_interval = 5
    http_server = 'http://vm:5000'
    def get_screenshot(self): return b'native'
    def execute_action(self): return 'native action'
    def _is_valid_image_response(self, content_type, content): return content == PNG


class TransportTests(unittest.TestCase):
    def test_native_sdk_receives_private_ip_for_chrome_host_validation(self):
        provider = ManagedVMProvider({})
        def answers(*addresses):
            return [(2, 1, 6, '', (address, 0)) for address in addresses]
        with patch('vm_provider.socket.getaddrinfo', return_value=answers('172.26.0.3')) as lookup:
            self.assertEqual(provider.get_ip_address('/System.qcow2'), '172.26.0.3:5000:9222:8006:8080')
            self.assertEqual(lookup.call_args.args[0], 'vm')
            # A new DNS result after a container replacement is used next time.
            lookup.return_value = answers('172.26.0.4')
            self.assertEqual(provider.get_ip_address('/System.qcow2'), '172.26.0.4:5000:9222:8006:8080')
        for addresses in ((), ('172.26.0.3', '172.26.0.4'), ('127.0.0.1',), ('169.254.1.1',), ('8.8.8.8',)):
            with patch('vm_provider.socket.getaddrinfo', return_value=answers(*addresses)):
                with self.assertRaises(ValueError): provider.get_ip_address('/System.qcow2')

    def response(self, content=PNG, status=200):
        return types.SimpleNamespace(status_code=status, headers={'Content-Type': 'image/png'}, content=content)

    def test_default_is_untouched_and_configuration_is_bounded(self):
        controller = Controller()
        configure_screenshot_transport(controller, 10)
        self.assertNotIn('get_screenshot', vars(controller))
        self.assertEqual(transport_profile(10)['mode'], 'sdk-default')
        for value in (None, True, 9, 121, 120.0, float('nan'), float('inf'), '120'):
            with self.assertRaises(ValueError): configure_screenshot_transport(controller, value)

    def test_request_retry_and_validation_preserve_native_failure_semantics(self):
        request = Mock(side_effect=[TimeoutError(), self.response(b'bad'), self.response()])
        with patch.dict(sys.modules, {'requests': types.SimpleNamespace(get=request)}), patch('screenshot_transport.time.sleep') as sleep:
            controller = Controller(); configure_screenshot_transport(controller, 120)
            self.assertEqual(controller.get_screenshot(), PNG)
            self.assertEqual(request.call_count, 3)
            for call in request.call_args_list:
                self.assertEqual(call.args, ('http://vm:5000/screenshot',))
                self.assertEqual(call.kwargs, {'timeout': 120})
            self.assertEqual([call.args for call in sleep.call_args_list], [(5,), (5,)])
            self.assertEqual(controller.execute_action(), 'native action')
            self.assertEqual(Controller().get_screenshot(), b'native')
            request.reset_mock(side_effect=True); request.return_value = self.response(status=503)
            sleep.reset_mock()
            self.assertIsNone(controller.get_screenshot())
            self.assertEqual(request.call_count, 3)
            self.assertEqual(sleep.call_count, 3)

    def test_provider_rebinds_after_reset_and_restores_upstream_factory(self):
        sdk = types.ModuleType('desktop_env.desktop_env')
        original = Mock(); sdk.create_vm_manager_and_provider = original
        class DesktopEnv:
            def __init__(self, **kwargs):
                self.kwargs = kwargs
                self.manager, self.provider = sdk.create_vm_manager_and_provider(kwargs['provider_name'])
                self._start_emulator()
            def _start_emulator(self): self.controller = Controller()
            def reset(self): self._start_emulator()
        sdk.DesktopEnv = DesktopEnv
        package = types.ModuleType('desktop_env'); package.desktop_env = sdk
        request = Mock(return_value=self.response())
        with patch.dict(sys.modules, {'desktop_env': package, 'desktop_env.desktop_env': sdk, 'requests': types.SimpleNamespace(get=request)}):
            default = create_desktop_env({})
            self.assertIs(type(default), DesktopEnv)
            env = create_desktop_env({}, screenshot_http_timeout_sec=120)
            self.assertIs(sdk.create_vm_manager_and_provider, original)
            self.assertFalse(env.kwargs['require_a11y_tree'])
            self.assertFalse(env.kwargs['require_terminal'])
            first = env.controller
            self.assertEqual(first.get_screenshot(), PNG)
            env.reset()
            self.assertIsNot(first, env.controller)
            self.assertEqual(env.controller.get_screenshot(), PNG)
            self.assertEqual(default.controller.get_screenshot(), b'native')
            with patch.object(DesktopEnv, '_start_emulator', side_effect=RuntimeError('setup failed')):
                with self.assertRaises(RuntimeError): create_desktop_env({}, screenshot_http_timeout_sec=120)
            self.assertIs(sdk.create_vm_manager_and_provider, original)


if __name__ == '__main__':
    result = unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(TransportTests))
    if not result.wasSuccessful(): raise SystemExit(1)
    print('OSWorld explicit screenshot timeout and reset isolation passed')
