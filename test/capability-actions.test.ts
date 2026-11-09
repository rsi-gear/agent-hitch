import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { admitParameters, submitParameterAction } from "../src/parameters/authority.js";
import { capabilityPlanInput, reserveCapabilityAction, startCapabilityStep, finishCapabilityStep, finishCapabilityAction, unavailableCapabilityAction } from "../src/parameters/capability-actions.js";
import type { CapabilityBinding } from "../src/parameters/bindings.js";
const binding = { id:"service",counter:{limit_parameter:"/limit",unit:"top-level-attempt"},source:{sha256:"sha256:"+"1".repeat(64)},coverage:"explicit-interface",capabilities:["bounded-fit@1"] } as CapabilityBinding;
function fixture() {
  const s = admitParameters({version:1,parameters:{limit:3,folds:2},schema:{type:"object",additionalProperties:false,required:["limit","folds"],properties:{limit:{type:"integer"},folds:{type:"integer"}}},parameter_policy:{"/limit":{mutable:true,actors:["target"],apply_at:"training_start"},"/folds":{mutable:true,actors:["target"],apply_at:"training_start"}}},{identity:{task:"example",eval:"run1"}});
  s.bindings=[binding]; s.counters={service:{reserved:0,consumed:0,limit:3,unit:"top-level-attempt"}}; return s;
}
const request = (id:string) => ({binding:"service",id,parameter_action:"task",operation:"evaluate",arguments:{model:{name:"closed-model"}}});
function planned(s:ReturnType<typeof fixture>, id:string, count=2, freeze=false) {
 const input=capabilityPlanInput(s,request(id)).input;
 return {version:1,count_unit:"top-level-attempt",source_digest:binding.source.sha256,plan:{...input,id:"sha256:"+"2".repeat(64),assignments:[[0,2],[1,3]]},steps:Array.from({length:count},(_,i)=>({index:i,rows:[i,i+2]})),...(freeze?{freeze:{key:"selection",identity:"sha256:"+"3".repeat(64)}}:{})};
}
test("quota reservations are atomic, immutable and consume failures without refund",()=>{
 let s=fixture(); const p=planned(s,"a"); s=reserveCapabilityAction(s,request("a"),p);
 assert.deepEqual(s.counters.service,{reserved:2,consumed:0,limit:3,unit:"top-level-attempt"});
 assert.throws(()=>reserveCapabilityAction(s,request("b"),planned(s,"b")),/quota exhausted/);
 assert.deepEqual(reserveCapabilityAction(s,request("a"),p),s);
 assert.throws(()=>capabilityPlanInput(s,{...request("a"),arguments:{model:{name:"different"}}}),/frozen/);
 s=startCapabilityStep(s,"a",0); assert.throws(()=>startCapabilityStep(s,"a",0),/restarted/);
 s=finishCapabilityStep(s,"a",0,{version:1,status:"training_failed",step_index:0,plan_id:p.plan.id,top_level_attempts:1});
 s=startCapabilityStep(s,"a",1); s=finishCapabilityStep(s,"a",1,{version:1,status:"completed",step_index:1,plan_id:p.plan.id,top_level_attempts:1});
 s=finishCapabilityAction(s,"a",{version:1,status:"training_failed",summary:{fits:2}});
 assert.deepEqual(s.counters.service,{reserved:0,consumed:2,limit:3,unit:"top-level-attempt"}); assert.equal(s.capability_actions.a?.status,"failed");
 assert.equal(submitParameterAction(s,"widen",{limit:20,folds:2}).accepted,false);
});
test("unknown started outcomes never rerun, unstarted reservations retain exact plan and frozen selections stop new work",()=>{
 let s=fixture(); const p=planned(s,"a"); s=reserveCapabilityAction(s,request("a"),p);
 const resumed=capabilityPlanInput(JSON.parse(JSON.stringify(s)),request("a")); assert.deepEqual(resumed.existing?.plan.assignments,p.plan.assignments);
 s=startCapabilityStep(s,"a",0); assert.throws(()=>startCapabilityStep(s,"a",1),/unavailable evidence/);
 s=unavailableCapabilityAction(s,"a","cancelled; outcome unknown"); assert.deepEqual(s.counters.service,{reserved:1,consumed:1,limit:3,unit:"top-level-attempt"});
 assert.throws(()=>startCapabilityStep(s,"a",1),/unavailable/);
 let frozen=fixture(); frozen=reserveCapabilityAction(frozen,request("final"),planned(frozen,"final",1,true));
 assert.throws(()=>capabilityPlanInput(frozen,request("later")),/selection is frozen/); assert.ok(capabilityPlanInput(frozen,request("final")).existing);
});
function cli(file:string,command:string,body:unknown):Promise<any> {return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.resolve("dist/src/parameters/cli.js"),command,file]);let out="",err="";child.stdout.on("data",v=>out+=v);child.stderr.on("data",v=>err+=v);child.on("error",reject);child.on("close",code=>{if(code)reject(new Error(err));else resolve(JSON.parse(out));});child.stdin.end(JSON.stringify(body));});}
test("concurrent host reservations cannot overrun the last slots; recovery does not reset consumed attempts",async()=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),"hitch-capability-")),file=path.join(folder,"state.json"),s=fixture();await writeFile(file,JSON.stringify(s));
 const result=await Promise.all(["a","b"].map(id=>cli(file,"capability-reserve",{request:request(id),plan:planned(s,id)})));
 assert.equal(result.filter(r=>r.accepted===false).length,1);const saved=JSON.parse(await readFile(file,"utf8"));const id=Object.keys(saved.capability_actions)[0]!;
 assert.equal(saved.counters.service.reserved,2); await cli(file,"capability-start",{id,index:0});
 const duplicate=await cli(file,"capability-start",{id,index:0});assert.equal(duplicate.accepted,false);
 const final=JSON.parse(await readFile(file,"utf8"));assert.equal(final.counters.service.consumed,1);assert.equal(final.counters.service.reserved,1);assert.equal(final.capability_actions[id].steps[0].status,"started");
});

test("recovery cannot extend a persisted capability wall budget",()=>{
 const s=fixture(),p=planned(s,"a");let reserved=reserveCapabilityAction(s,request("a"),p);reserved.capability_deadline_ms=Date.now()-1;
 assert.throws(()=>startCapabilityStep(reserved,"a",0),/wall budget exhausted/);
 assert.throws(()=>reserveCapabilityAction(reserved,request("b"),planned(reserved,"b",1)),/wall budget exhausted/);
 assert.deepEqual(reserveCapabilityAction(reserved,request("a"),p).counters,reserved.counters);
});


test("parallel same-task services have separate quota and frozen delivery selection", async () => {
 const folder = await mkdtemp(path.join(os.tmpdir(), "hitch-capability-trials-"));
 const trials = await Promise.all([1, 2, 3].map(async repetition => {
  const directory = path.join(folder, `trial-${repetition}`); await mkdir(directory);
  const file = path.join(directory, "parameter-state.json"), state = fixture();
  state.execution_id += `-${repetition}`; await writeFile(file, JSON.stringify(state));
  return { file, state };
 }));
 const results = await Promise.all(trials.map(({ file, state }) => cli(file, "capability-reserve", {
  request: request("same-final"), plan: planned(state, "same-final", 1, true),
 })));
 assert.ok(results.every(r => r.accepted !== false));
 await cli(trials[0]!.file, "capability-start", { id: "same-final", index: 0 });
 await cli(trials[0]!.file, "capability-unavailable", { id: "same-final", reason: "lost receipt" });
 const states = await Promise.all(trials.map(({ file }) => cli(file, "show", {})));
 assert.deepEqual(states.map(s => s.counters.service.consumed), [1, 0, 0]);
 assert.deepEqual(states.map(s => s.counters.service.reserved), [0, 1, 1]);
 assert.deepEqual(states.map(s => s.capability_actions["same-final"].status), ["unavailable", "reserved", "reserved"]);
 for (const { file } of trials) assert.equal((await cli(file, "capability-plan", request("later"))).accepted, false);
});
