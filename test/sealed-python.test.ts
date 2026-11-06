import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateEvalRequest } from '../src/evals/index.js';
import { parseEvalRequest } from '../src/cli/arguments.js';
import { sealedPythonAdapter } from '../src/adapters/providers/sealed-python.js';
import { packageRoot, sha256Bytes } from '../src/foundation/index.js';
import { Ajv2020 } from 'ajv/dist/2020.js';

const base = { schema_version: '2', dataset: 'demo@1.0', harness_ref: `sealed-python@git+file:///tmp/executor#${'a'.repeat(40)}`,
  model: null, attempts: 1, infrastructure_retries: 0 };
test('no-model is an explicit eval-only contract; model adapters retain old validation', async () => {
  const args = ['--dataset', 'demo@1.0', '--harness', base.harness_ref, '--no-model', '--infrastructure-retries', '0'];
  const parsed = parseEvalRequest(args); assert.equal(parsed.schema_version, '2'); assert.equal(parsed.model, null); assert.deepEqual(args, []);
  const request = await validateEvalRequest(base); assert.equal(request.schema_version, '2'); assert.equal(request.model, '');
  await validateEvalRequest({ ...base, model: request.model });
  for (const patch of [{ model: 'gpt' }, { attempts: 2 }, { schema_version: '1' }, { infrastructure_retries: 1 }, { pass_env: ['OPENAI_API_KEY'] },
    { agent_args: ['--command', 'evil'] }, { model_binding: {} }, { generation: 0 }, { endpoint_binding: null }, { harness_ref: 'deepseek@version:1.0.0' }]) {
    await assert.rejects(validateEvalRequest({ ...base, ...patch }), /sealed-python|reserved/);
  }
  await assert.rejects(validateEvalRequest({ dataset: 'demo@1.0', harness_ref: 'deepseek@version:1.0.0', model: null }), /model must be a string/);
  assert.throws(() => parseEvalRequest(['--harness', base.harness_ref, '--dataset', 'demo@1.0', '--no-model', '--model', 'gpt']), /combined/);
});
test('published eval schema distinguishes explicit no-model execution from model adapters', async () => {
  const ajv = new Ajv2020({ strict: false, validateFormats: false,
    loadSchema: async uri => JSON.parse(await readFile(path.join(packageRoot(), 'docs/schemas', path.basename(new URL(uri).pathname)), 'utf8')) });
  const validate = await ajv.compileAsync({ $ref: 'https://agent-hitch.local/schemas/eval-request.schema.json' });
  const input = { backend: 'harbor', ...base };
  assert.equal(validate(input), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...input, model: '' }), true);
  for (const patch of [{ schema_version: '1' }, { model: 'gpt' }, { attempts: 2 }, { pass_env: ['TOKEN'] },
    { generation: 0 }, { endpoint_binding: null }, { harness_ref: 'deepseek@version:1.0.0' }]) assert.equal(validate({ ...input, ...patch }), false);
  assert.equal(validate({ backend: 'harbor', dataset: 'demo@1.0', harness_ref: 'deepseek@version:1.0.0', model: 'gpt' }), true);
});
test('sealed executor refuses arbitrary runtime bytes and model arguments', async () => {
  const integrity = sha256Bytes(await readFile(path.join(packageRoot(), 'integrations/sealed-python/cli.js')));
  const request = { model: '', agent_args: [] } as never;
  const result = await sealedPythonAdapter.process(request, '/fixed/cli.js', { entrypoint_integrity: integrity });
  assert.deepEqual(result.args, []); assert.equal(result.input, ''); assert.equal(sealedPythonAdapter.requirements.credential_names.length, 0);
  await assert.rejects(async () => sealedPythonAdapter.process(request, '/evil', { entrypoint_integrity: `sha256:${'0'.repeat(64)}` }), /differs/);
  await assert.rejects(async () => sealedPythonAdapter.process({ model: 'x', agent_args: [] } as never, '/fixed/cli.js', { entrypoint_integrity: integrity }), /cannot receive/);
});
