import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";

// Compile each published parent as well as its existing fragment entry point.
// Consumers must be able to resolve the shared binding from the shipped schemas.
test("published model-node schemas resolve shared bindings and reject invalid identities", async () => {
  const base = "https://agent-hitch.local/schemas/";
  const ajv = new Ajv2020({
    strict: false,
    validateFormats: false,
    loadSchema: async uri => JSON.parse(await readFile(
      new URL(`../../docs/schemas/${path.basename(new URL(uri).pathname)}`, import.meta.url), "utf8",
    )),
  });
  const binding = {
    schema_version: "2", node_id: "node-1", generation: "boot-1",
    runtime_digest: `sha256:${"a".repeat(64)}`, launcher: "process",
  };
  const invalid = [
    null, {}, { ...binding, schema_version: "1" }, { ...binding, launcher: "docker" },
    { ...binding, node_id: "../node" }, { ...binding, node_id: "x".repeat(129) },
    { ...binding, generation: "" }, { ...binding, runtime_digest: "sha256:bad" },
    { ...binding, host: "unfrozen-host" },
    ...Object.keys(binding).map(key => Object.fromEntries(Object.entries(binding).filter(([name]) => name !== key))),
  ];
  for (const name of ["inference-lock", "inference-service-record", "local-inference-selection", "run-manifest"]) {
    const uri = `${base}${name}.schema.json`;
    await ajv.compileAsync({ $ref: uri });
    const validate = await ajv.compileAsync({ $ref: `${uri}#/$defs/modelNodeBinding` });
    assert.equal(validate(binding), true, `${name}: ${ajv.errorsText(validate.errors)}`);
    for (const value of invalid) {
      assert.equal(validate(value), false, `${name} accepted ${JSON.stringify(value)}`);
    }
  }
});
