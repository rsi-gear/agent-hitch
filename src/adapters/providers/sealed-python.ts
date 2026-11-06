import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { invalidInput, packageRoot, sha256Bytes } from '../../foundation/index.js';
import type { AdapterDefinition } from '../contract.js';

/** CPU execution of a sealed source closure. No LLM, credentials, or shell prompt. */
export const sealedPythonAdapter: AdapterDefinition = {
  id: 'sealed-python', display_name: 'Sealed Python source executor', command: 'hitch-sealed-python',
  path_env: 'HITCH_SEALED_PYTHON_PATH', version_args: ['--version'],
  revision_sources: { commit: { type: 'git', url: 'https://github.com/rsi-gear/agent-hitch.git', commands: [], entrypoint: 'integrations/sealed-python/cli.js' } },
  capabilities: { non_interactive: true, streaming: false, structured_messages: true, structured_tool_events: false,
    sessions: false, resume: false, model_selection: false, graceful_cancel: true },
  requirements: { network: 'forbidden', credential_names: [], endpoint_override: 'unsupported',
    capture: { native_events: true, native_session: false, model_proxy_compatible: false } },
  async process(request, executable, runtime = {}) {
    if (request.model || request.agent_args.length || runtime.model_endpoint) throw invalidInput('sealed-python cannot receive a model, endpoint, or argument overrides');
    const approved = sha256Bytes(await readFile(path.join(packageRoot(), 'integrations/sealed-python/cli.js')));
    if (runtime.entrypoint_integrity !== approved) throw invalidInput('sealed-python executor differs from the fixed runtime');
    return { executable, args: [], input: '', env: { PYTHONDONTWRITEBYTECODE: '1' } };
  },
  translate(event) {
    if (event.type === 'message.completed' && typeof event.text === 'string') return [{ type: 'message.completed', text: event.text }];
    return [{ type: 'provider.event', provider_type: String(event.type), native: event }];
  },
};
