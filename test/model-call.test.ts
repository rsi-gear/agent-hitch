import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getAdapter } from "../src/adapters/index.js";
import { sha256Bytes, packageRoot } from "../src/foundation/index.js";

const runner = path.join(packageRoot(), "integrations/model-call/cli.js");

test("model-call sends native images once with no tools and captures response identity", async t => {
  const requests: Record<string, unknown>[] = [];
  let mode = "answer";
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    assert.equal(req.url, "/v1/responses");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({id:"resp_test", model:"model-observed", status:mode === "empty" ? "incomplete" : "completed", usage:{input_tokens:2,output_tokens:1}, output: mode === "empty" ? [] : mode === "answer" ? [{type:"message", content:[{type:"output_text", text:"42"}]}] : [{type:"function_call", name:"exec", arguments:"{}"}]}));
  });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(() => new Promise<void>((resolve,reject) => server.close(e => e ? reject(e) : resolve())));
  const port = (server.address() as {port:number}).port;
  const image = "data:image/png;base64,aGVsbG8=";
  const input = {schema_version:"1", messages:[{role:"user",content:[{type:"input_text",text:"What is this?"},{type:"input_image",image_url:image}]}]};
  async function call(value: unknown) {
    const child = spawn(process.execPath, [runner,"--model","test-model"], {env:{PATH:process.env.PATH, OPENAI_API_KEY:"test-key", OPENAI_BASE_URL:`http://127.0.0.1:${port}/v1`},stdio:["pipe","pipe","pipe"]});
    let stdout="",stderr=""; child.stdout.on("data",c => stdout+=c); child.stderr.on("data",c => stderr+=c);
    child.stdin.end(JSON.stringify(value));
    const code = await new Promise<number|null>(resolve => child.on("close",resolve));
    return {code,stdout,stderr};
  }
  const result=await call(input);
  assert.equal(result.code,0,result.stderr);
  assert.equal(requests.length,1);
  assert.deepEqual(requests[0]?.tools,[]);
  assert.equal(requests[0]?.tool_choice,"none");
  assert.deepEqual(requests[0]?.input,input.messages);
  const events=result.stdout.trim().split("\n").map(l => JSON.parse(l));
  assert.equal(events.at(-1).text,"42");
  assert.equal(events.find(e => e.type === "provider.response").response.model,"model-observed");
  mode="tool";
  const prohibited=await call(input);
  assert.notEqual(prohibited.code,0);
  assert.match(prohibited.stderr,/prohibited tool/);
  assert.equal(requests.length,2); // no continuation or retry
  const invalid=await call({...input,tools:[{type:"web_search"}]});
  assert.notEqual(invalid.code,0);
  assert.equal(requests.length,2);
  mode="empty";
  const exhausted=await call(input);
  assert.equal(exhausted.code,0,exhausted.stderr);
  assert.equal(JSON.parse(exhausted.stdout.trim().split("\n").at(-1)!).text,"");
  assert.equal(requests.length,3);
});

test("model-call rejects an untrusted executable and agent overrides", async () => {
  const request={cwd:"/app",model:"test",prompt:"{}",agent_args:[],workspace_mode:"shared",harness_ref:"model-call@commit:"+"a".repeat(40),timeout_ms:0};
  const adapter=getAdapter("model-call");
  await assert.rejects(async () => adapter.process(request,process.execPath,{entrypoint_integrity:"sha256:"+"0".repeat(64)}),/trusted implementation/);
  const integrity=sha256Bytes(await readFile(runner));
  assert.equal((await adapter.process(request,process.execPath,{entrypoint_integrity:integrity})).input,"{}");
  const endpoint = {
    kind: "managed-local" as const,
    inference_id: `sha256:${"1".repeat(64)}` as const,
    api: "responses" as const,
    base_url: "http://host.docker.internal:4321/capability/run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/openai",
    wire_model: "hitch-wire-model",
    credential_env_name: "HITCH_LOCAL_MODEL_TOKEN" as const,
    capabilities: { streaming: true, tool_calls: false, parallel_tool_calls: false, input_modalities: ["text"] as ["text"] },
  };
  const local = await adapter.process(request, process.execPath, {
    entrypoint_integrity: integrity, model_endpoint: endpoint, model_endpoint_credential: "hitch-managed-local",
  });
  assert.equal(local.env?.HITCH_LOCAL_MAX_OUTPUT_TOKENS, undefined);
  await assert.rejects(async () => adapter.process({...request,agent_args:["--tools"]},process.execPath,{entrypoint_integrity:integrity}),/agent arguments/);
});
