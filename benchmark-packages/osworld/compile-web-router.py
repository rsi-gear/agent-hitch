#!/usr/bin/env python3
"""Compile static routes from Git-pinned OSWorld web-compose definitions.

Requires PyYAML==6.0.2. Does not start services, guess a task's applications,
initialize state, establish TLS trust, or create an executable benchmark package.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

from web_routes import compile_routes, router_compose

WEBSITE_COMMIT = '90ec2218f7747b15fe5117cdbe59b8978446ab9c'


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.PIPE, timeout=30)


def load_components(checkout, apps):
    import yaml
    if yaml.__version__ != '6.0.2': raise ValueError('PyYAML 6.0.2 is required')
    class StrictLoader(yaml.SafeLoader):
        pass
    def mapping(loader, node, deep=False):
        value = {}
        for key, item in node.value:
            key = loader.construct_object(key, deep=deep)
            if key in value: raise ValueError('duplicate website YAML key')
            value[key] = loader.construct_object(item, deep=deep)
        return value
    StrictLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping)
    root = Path(checkout).resolve()
    links = {}
    for row in git(root, 'ls-tree', '-z', WEBSITE_COMMIT).split(b'\0'):
        if row:
            meta, name = row.split(b'\t', 1); mode, kind, oid = meta.decode().split()
            if mode == '160000' and kind == 'commit': links[name.decode()] = oid
    if not apps or len(apps) != len(set(apps)) or any(app not in links or app == 'basesite' or not re.fullmatch(r'[a-z][a-z0-9_]+', app) for app in apps):
        raise ValueError('select distinct runtime applications from the pinned parent tree')
    documents, sources = {}, []
    for app in sorted(apps):
        checkout_root = git(root / app, 'rev-parse', '--show-toplevel').decode().strip()
        if Path(checkout_root).resolve() != root / app:
            raise ValueError('website submodule checkout is missing: ' + app)
        raw = git(root / app, 'show', links[app] + ':web-compose.yml')
        if len(raw) > 1024 * 1024: raise ValueError('oversized website compose definition')
        documents[app] = yaml.load(raw, Loader=StrictLoader)
        sources.append({'application': app, 'commit': links[app], 'compose_sha256': 'sha256:' + hashlib.sha256(raw).hexdigest(),
                        'source': 'https://github.com/Task-Web/' + app + '/blob/' + links[app] + '/web-compose.yml'})
    return documents, sources


def produce(args):
    output = Path(args.out)
    if output.exists() or output.is_symlink(): raise ValueError('output already exists')
    documents, sources = load_components(args.website_checkout, args.apps)
    plan, caddyfile = compile_routes(documents, args.namespace)
    plan.update(website_commit=WEBSITE_COMMIT, sources=sources, router_image=args.router_image,
                caddyfile_sha256='sha256:' + hashlib.sha256(caddyfile.encode()).hexdigest())
    compose = router_compose(plan, args.router_image)
    output.mkdir(parents=True)
    (output / 'Caddyfile').write_text(caddyfile)
    (output / 'routes.json').write_text(json.dumps(plan, indent=2) + '\n')
    # JSON is valid YAML and avoids dumping executable/custom YAML tags.
    (output / 'docker-compose.proxy.yaml').write_text(json.dumps(compose, indent=2) + '\n')
    return {'directory': str(output.resolve()), 'routes': len(plan['routes']), 'requires_private_ca_trust': plan['requires_private_ca_trust'], 'full_task_assembly_complete': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--website-checkout', required=True)
    parser.add_argument('--apps', nargs='+', required=True)
    parser.add_argument('--namespace', required=True)
    parser.add_argument('--router-image', required=True)
    parser.add_argument('--out', required=True)
    print(json.dumps(produce(parser.parse_args()), sort_keys=True))
