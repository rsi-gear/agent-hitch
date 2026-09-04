"""Compile the pinned website labels into static Caddy routes, without Docker API.

This is a deployment component. The caller still owns application images,
private networks, per-trial state, TLS trust and complete task assembly.
"""
import re

HOST_PATTERN = re.compile(r'\$\{CADDY_SCHEME-(https?://)\}([a-z0-9]+(?:[.-][a-z0-9]+)*)\.\$\{HOST_SUFFIX:-localhost\}')
PROXY_PATTERN = re.compile(r'(?:(/(?:api|mcp)\*) )?([a-z][a-z0-9_-]*):([0-9]+)')


def compile_routes(documents, namespace):
    if not re.fullmatch(r'[a-z0-9]+(?:[.-][a-z0-9]+)*', namespace) or '.' not in namespace:
        raise ValueError('an explicit private DNS namespace is required')
    services, routes, hosts = {}, [], set()
    for app, document in sorted(documents.items()):
        if not isinstance(document, dict):
            raise ValueError('website component must be a mapping')
        current = document.get('services')
        if not isinstance(current, dict) or not current:
            raise ValueError('website component must declare its services')
        for name, value in current.items():
            if not re.fullmatch(r'[a-z][a-z0-9_-]*', name) or name in services or not isinstance(value, dict):
                raise ValueError('ambiguous website service identity')
            services[name] = {'app': app, 'definition': value}
    for service, entry in services.items():
        labels = entry['definition'].get('labels', {})
        if not labels: continue
        if not isinstance(labels, dict) or 'caddy' not in labels:
            raise ValueError('unsupported website labels')
        if any(key != 'caddy' and not re.fullmatch(r'caddy\.(?:[0-9]+_)?reverse_proxy', key) for key in labels):
            raise ValueError('website routing directive needs an explicit adapter')
        if not isinstance(labels['caddy'], str): raise ValueError('invalid website hosts')
        site_hosts = []
        for value in labels['caddy'].split(', '):
            match = HOST_PATTERN.fullmatch(value)
            if not match: raise ValueError('website hostname differs from the supported release profile')
            scheme, prefix = match.groups()
            hostname = prefix + '.' + namespace
            if hostname in hosts: raise ValueError('duplicate website hostname')
            hosts.add(hostname); site_hosts.append({'scheme': scheme[:-3], 'hostname': hostname})
        if len({h['scheme'] for h in site_hosts}) != 1:
            raise ValueError('one route cannot mix HTTP and HTTPS')
        raw = [(key, value) for key, value in labels.items() if key != 'caddy']
        if len(raw) > 1 and any(key == 'caddy.reverse_proxy' for key, _ in raw):
            raise ValueError('ambiguous proxy directive order')
        def order(pair):
            return 0 if pair[0] == 'caddy.reverse_proxy' else int(pair[0].split('.')[1].split('_')[0])
        if len({order(pair) for pair in raw}) != len(raw):
            raise ValueError('ambiguous proxy directive order')
        ordered = sorted(raw, key=order)
        proxies, matchers = [], set()
        for _key, value in ordered:
            match = PROXY_PATTERN.fullmatch(value) if isinstance(value, str) else None
            if not match: raise ValueError('unsupported reverse-proxy target')
            matcher, upstream, port = match.groups()
            if upstream not in services or services[upstream]['app'] != entry['app'] or not 1 <= int(port) <= 65535:
                raise ValueError('proxy target must be an owned service from this component')
            if matcher in matchers: raise ValueError('duplicate proxy matcher')
            matchers.add(matcher); proxies.append({'matcher': matcher, 'service': upstream, 'port': int(port)})
        if not proxies or proxies[-1]['matcher'] is not None or any(p['matcher'] is None for p in proxies[:-1]):
            raise ValueError('website route must finish with one fallback proxy')
        routes.append({'app': entry['app'], 'label_service': service, 'hosts': site_hosts, 'proxies': proxies})
    if not routes: raise ValueError('no website routes found')
    lines = ['{', '  admin off', '  skip_install_trust', '}', '']
    for route in routes:
        lines.append(', '.join(h['scheme'] + '://' + h['hostname'] for h in route['hosts']) + ' {')
        if route['hosts'][0]['scheme'] == 'https': lines.append('  tls internal')
        # A route block preserves the explicit upstream label ordering.
        lines.append('  route {')
        for proxy in route['proxies']:
            lines.append('    reverse_proxy ' + ((proxy['matcher'] + ' ') if proxy['matcher'] else '') + proxy['service'] + ':' + str(proxy['port']))
        lines += ['  }', '}', '']
    plan = {'protocol': 'osworld-web-routes@1', 'namespace': namespace, 'routes': routes,
            'backend_services': sorted(services), 'router_dns_aliases': sorted(hosts),
            'requires_private_ca_trust': any(h['scheme'] == 'https' for r in routes for h in r['hosts']),
            'private_ca_certificate_path': '/data/caddy/pki/authorities/local/root.crt',
            'no_host_ports_or_docker_socket': True, 'full_task_assembly_complete': False}
    return plan, '\n'.join(lines)


def router_compose(plan, image):
    if not re.fullmatch(r'[a-z0-9][a-z0-9._/-]*:[a-zA-Z0-9._-]+@sha256:[a-f0-9]{64}', image):
        raise ValueError('router requires an immutable tagged registry image')
    return {'services': {'web_proxy': {
        'image': image, 'entrypoint': ['/bin/caddy'], 'command': ['run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'],
        'volumes': ['./Caddyfile:/etc/caddy/Caddyfile:ro', 'web_proxy_data:/data', 'web_proxy_config:/config'],
        'networks': {'web': None, 'vm': {'aliases': plan['router_dns_aliases']}},
        'cpus': 0.25, 'mem_limit': '128m', 'pids_limit': 64,
    }}, 'networks': {'web': {'internal': True}, 'vm': {'internal': True}},
        'volumes': {'web_proxy_data': {}, 'web_proxy_config': {}}}
