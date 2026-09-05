"""One owned SDK process: native tools remain live until the parent quiesces it."""
import argparse
import importlib
import logging
import os
from pathlib import Path
import signal
import sys
import threading
import traceback
import types
from urllib.parse import urlparse

from action_policy import load_graphical_policy
from agent_channel import AgentChannel
from controller_server import ControllerServer
from model_audit import install_model_audit
from native_runner import run_native
from runtime_config import load_config, read_bytes, read_json, write_json
from screenshot_transport import transport_profile
from vm_provider import create_desktop_env


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    config, config_digest = load_config(args.config)
    root, evidence = Path(config['private_root']), Path(config['evidence_directory'])
    status_file = root / 'worker-status.json'
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    channel = server = model_audit = None
    status = 'failed'
    try:
        session = read_json(Path(config['session_directory']) / 'session.json')
        sys.path.insert(0, config['sdk_root'])
        # This is set before importing the SDK; never inherit its hosted default.
        os.environ['WEBSITE_HOST_SUFFIX'] = config['website_host_suffix']
        os.environ['OSWORLD_FILE_BASE_URL'] = config['assets_directory']
        model_audit = install_model_audit(config['sdk_root'], evidence / 'model-calls.json')
        # A package opts in through its frozen controller environment. Register
        # the named transport without changing the SDK's default providers.
        if any(os.environ.get(name) == 'hitch_deepseek_chat_v1' for name in ('OSWORLD_EVAL_MODEL_PROVIDER', 'OSWORLD_USER_SIM_PROVIDER')):
            importlib.import_module('deepseek_backend')
        policy = load_graphical_policy()
        channel = AgentChannel(evidence / 'channel', (1920, 1080), policy,
                               max_actions_per_turn=config['max_actions_per_turn'], max_text_bytes=config['max_text_bytes'])
        endpoint = urlparse(config['public_endpoint'])
        server = ControllerServer(channel, session, policy, root / 'phase.sock',
                                  public_address=('0.0.0.0', endpoint.port), public_endpoint=config['public_endpoint'], native_deadline=config['native_deadline'])
        server.start()
        write_json(status_file, {'state': 'starting', 'config_digest': config_digest})
        task = importlib.import_module('task_loader').load_task_from_file(config['task_path'])
        password = read_bytes(config['client_password_file'], 4096).decode().strip() if config['client_password_file'] else ''
        env = create_desktop_env(session, cache_dir=config['cache_directory'], screen_size=(1920, 1080),
                                 screenshot_http_timeout_sec=config.get('screenshot_http_timeout_sec', 10),
                                 action_space='computer_13', headless=True, enable_proxy=False, client_password=password)
        native_args = types.SimpleNamespace(sleep_after_execution=config['sleep_after_execution'], result_dir=str(evidence / 'native'))
        metadata = run_native(channel, env, task, config['max_steps'], native_args,
                              evidence / 'native', finalize_on_budget=config['native_deadline'], model_audit=model_audit)
        write_json(evidence / 'native-execution.json', {'protocol': 'osworld-native-execution@1', 'config_digest': config_digest,
                   'source_task_id': config['source_task_id'], 'task_sha256': config['task_sha256'], 'native': metadata,
                   'screenshot_transport': transport_profile(config.get('screenshot_http_timeout_sec', 10))})
        logging.shutdown()
        status = 'completed'
        write_json(status_file, {'state': status, 'config_digest': config_digest})
    except BaseException as error:
        if channel: channel.finish('failed')
        # SDK stdout/stderr stays private to the parent; errors never echo keys.
        locations = [{'file': Path(frame.filename).name, 'line': frame.lineno, 'function': frame.name}
                     for frame in traceback.extract_tb(error.__traceback__)]
        write_json(status_file, {'state': 'failed', 'error_type': type(error).__name__, 'error_locations': locations, 'config_digest': config_digest})
    finally:
        # Keep the completed state RPC available for the host supervisor until
        # quiesce. A cancelled/stuck native thread is bounded by the parent's
        # process-group teardown, not by pretending the task completed.
        if status == 'completed': stop.wait()
        if server: server.close()
        if model_audit: model_audit.close()
        logging.shutdown()
    return 0 if status == 'completed' else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        sys.stderr.write('native worker initialization failed\n')
        raise SystemExit(1)
