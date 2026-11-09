import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const python = process.env.KAGGLE_TEST_PYTHON ?? 'python3';
const available = spawnSync(python, ['-B', '-c', 'import pandas,sklearn,numpy'], { encoding: 'utf8' });
test('closed trusted training uses five real CV fits and one frozen final fit, with independent evidence verification', { skip: available.status !== 0 ? 'pinned sklearn test environment unavailable' : false }, () => {
  const result = spawnSync(python, ['-B', fileURLToPath(new URL('training-service.py', import.meta.url))], { encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'passed');
});
