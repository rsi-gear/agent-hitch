"""Regression gates for the limited, pinned website routing dialect."""
import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'benchmark-packages/osworld'))
from web_routes import compile_routes, router_compose


def component(numbered=True, scheme='http', multiple=False):
    host = '${CADDY_SCHEME-' + scheme + '://}app.${HOST_SUFFIX:-localhost}'
    if multiple:
        host += ', ${CADDY_SCHEME-' + scheme + '://}studio.app.${HOST_SUFFIX:-localhost}'
    labels = {'caddy': host}
    if numbered:
        # Deliberately shuffled: order is defined by the upstream numeric prefix.
        labels.update({'caddy.2_reverse_proxy': 'frontend:80', 'caddy.1_reverse_proxy': '/mcp* backend:8000', 'caddy.0_reverse_proxy': '/api* backend:8000'})
    else:
        labels['caddy.reverse_proxy'] = 'frontend:80'
    return {'app_web': {'services': {'backend': {}, 'frontend': {'labels': labels}}}}


class RoutesTests(unittest.TestCase):
    def test_plain_proxy_and_ordered_paths(self):
        for numbered in (False, True):
            plan, config = compile_routes(component(numbered), 'trial.hitch.test')
            self.assertIn('http://app.trial.hitch.test', config)
            self.assertEqual(plan['router_dns_aliases'], ['app.trial.hitch.test'])
            self.assertFalse(plan['requires_private_ca_trust'])
            if numbered:
                self.assertLess(config.index('/api*'), config.index('/mcp*'))
                self.assertLess(config.index('/mcp*'), config.index('reverse_proxy frontend:80'))
            else:
                self.assertEqual(config.count('reverse_proxy'), 1)

    def test_https_multihost_and_private_topology(self):
        plan, config = compile_routes(component(scheme='https', multiple=True), 'trial.hitch.test')
        self.assertIn('tls internal', config)
        self.assertIn('https://studio.app.trial.hitch.test', config)
        self.assertTrue(plan['requires_private_ca_trust'])
        compose = router_compose(plan, 'example.test/proxy:2@sha256:' + 'a' * 64)
        proxy = compose['services']['web_proxy']
        self.assertNotIn('ports', proxy)
        self.assertFalse(any('docker.sock' in value for value in proxy['volumes']))
        self.assertEqual(proxy['entrypoint'], ['/bin/caddy'])
        self.assertTrue(all(value['internal'] for value in compose['networks'].values()))
        self.assertEqual(proxy['networks']['vm']['aliases'], plan['router_dns_aliases'])
        self.assertFalse(plan['full_task_assembly_complete'])

    def test_reject_ambiguous_or_unowned_proxy_and_new_dialects(self):
        mutations = [
            {'caddy.00_reverse_proxy': '/api* backend:8000'},
            {'caddy.0_reverse_proxy': '/api* external:8000'},
            {'caddy.0_reverse_proxy': '/api* backend:0'},
            {'caddy.0_reverse_proxy': '/unknown* backend:8000'},
            {'caddy.0_reverse_proxy': 'backend:8000'},
            {'caddy.2_reverse_proxy': '/api* frontend:80'},
            {'caddy.reverse_proxy': 'frontend:80'},
            {'caddy.handle': 'respond unsafe'},
            {'caddy': '${CADDY_SCHEME-http://}app.${HOST_SUFFIX:-localhost}\n:8080'},
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                doc = component()
                doc['app_web']['services']['frontend']['labels'].update(mutation)
                compile_routes(doc, 'trial.hitch.test')
        doc = component()
        doc['other_web'] = copy.deepcopy(doc['app_web'])
        with self.assertRaises(ValueError): compile_routes(doc, 'trial.hitch.test')
        with self.assertRaises(ValueError): compile_routes(component(), 'localhost')
        with self.assertRaises(ValueError): router_compose({}, 'proxy:latest')


if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(RoutesTests)
    result = unittest.TextTestRunner().run(suite)
    if not result.wasSuccessful(): sys.exit(1)
    print('website routing and private topology gates passed')
