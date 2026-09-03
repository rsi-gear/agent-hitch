"""Synthetic SDK child for lifecycle tests; uses the actual channel/transports."""
import importlib.util
import faulthandler
import json
import os
from pathlib import Path
import signal
import struct
import sys
import threading
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'benchmark-packages/osworld/runtime'))
from action_policy import GraphicalActionPolicy
from agent_channel import AgentChannel, ChannelClosed
from controller_server import ControllerServer
from runtime_config import read_json, write_json


def main():
    faulthandler.dump_traceback_later(1, repeat=True)
    config_file, config_digest, mode = sys.argv[1:]
    config = read_json(config_file)
    root, evidence = Path(config['private_root']), Path(config['evidence_directory'])
    if mode == 'crash-before-ready': return 23
    if mode == 'wait-before-ready':
        signal.pause()
        return 24
    if mode == 'daemon-helper':
        intermediate = os.fork()
        if intermediate == 0:
            os.setsid()
            if os.fork() != 0: os._exit(0)
            (root / 'daemon.pid').write_text(str(os.getpid()))
            while True: signal.pause()
        os.waitpid(intermediate, 0)
    spec = importlib.util.spec_from_file_location('native_actions', Path(__file__).parent / 'fixtures/osworld/native_actions.py')
    actions = importlib.util.module_from_spec(spec); spec.loader.exec_module(actions)
    policy = GraphicalActionPolicy(actions.ACTION_SPACE)
    channel = AgentChannel(evidence / 'channel', (1920, 1080), policy, max_actions_per_turn=2, max_text_bytes=16384)
    session = read_json(Path(config['session_directory']) / 'session.json')
    server = ControllerServer(channel, session, policy, root / 'phase.sock', public_address=('127.0.0.1', 0), public_endpoint='http://127.0.0.1:0/', native_deadline=True)
    stop = threading.Event()
    signal.signal(signal.SIGTERM, (lambda *_: None) if mode == 'ignore-stop' else (lambda *_: stop.set()))
    server.start()
    write_json(root / 'worker-status.json', {'state': 'starting', 'config_digest': 'wrong' if mode == 'wrong-config' else config_digest})
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', 1920, 1080, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress((b'\x00' + b'\x11\x22\x33' * 1920) * 1080)) + chunk(b'IEND', b'')
    try:
        channel.reset()
        channel.predict('synthetic lifecycle task', {'screenshot': png})
        if mode == 'crash-after-action':
            while not (root / 'crash-now').exists(): stop.wait(0.01)
            os._exit(25)
        (evidence / 'native').mkdir()
        write_json(evidence / 'native/result.json', {'score': 0.25, 'synthetic_only': True})
        channel.finish('completed')
        write_json(root / 'worker-status.json', {'state': 'completed', 'config_digest': config_digest})
        stop.wait()
    except ChannelClosed:
        if mode == 'ignore-stop': threading.Event().wait()
    finally:
        server.close()
        # This write occurs AFTER the completed status. Snapshot must include it,
        # proving that quiesce waited for process exit, not only a status flag.
        write_json(evidence / 'worker-exit.json', {'closed': True})
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
