import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Ajv } from "ajv";
import { canonical, identity, parseResourceDataset, parseResourceLock, parseResourceSelection, parseTree, selectResources } from "../src/resources/index.js";

test("published schemas and public cross-repository fixtures agree", async () => {
  const f = JSON.parse(await readFile("test-contracts/hitch-resources-v1.json", "utf8"));
  assert.equal(canonical(parseResourceLock(f.lock)), f.lockCanonical); assert.equal(identity(f.lock.protocol, f.lock), f.lockIdentity);
  assert.deepEqual(selectResources(parseResourceDataset(f.dataset), ["case-1"]), parseResourceSelection(f.selection)); assert.deepEqual(parseTree(f.tree), f.tree);
  const ajv = new Ajv({ strict: true });
  for (const [name, value] of [["hitch-resource-lock-v1", f.lock], ["hitch-tree-v1", f.tree], ["hitch-resource-dataset-v2", f.dataset], ["hitch-resource-selection-v1", f.selection]] as const) {
    const validate = ajv.compile(JSON.parse(await readFile(`docs/schemas/${name}.schema.json`, "utf8")));
    assert.equal(validate(value), true, JSON.stringify(validate.errors)); assert.equal(validate({ ...value, unknown: true }), false);
  }
});
