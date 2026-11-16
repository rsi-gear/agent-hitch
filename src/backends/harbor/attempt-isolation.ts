import { readFile } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../../foundation/index.js";
import { harborPython } from "./task-resources.js";
import { DEFAULT_HARBOR_VERSION, locateHarbor } from "./tools.js";
export const HARBOR_ATTEMPT_ISOLATION_PROTOCOL = "hitch-attempt-isolation@1";
/** Fail closed: old runtimes and tasks with host-global resources keep task locks. */
export async function supportsHarborAttemptIsolation(input: {
  root: string; taskDirectories: readonly string[]; runtimeDirectory: string;
  harborExecutable?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal;
}): Promise<boolean> {
  if (!input.taskDirectories.length) return false;
  const env=input.env??process.env, helper=path.join(input.runtimeDirectory,"payload/integrations/harbor/hitch_attempt_isolation.py");
  try {
    const source=await readFile(helper,"utf8"), provider=await readFile(path.join(path.dirname(helper),"hitch_harbor_environment.py"),"utf8");
    if (!source.includes(`ATTEMPT_ISOLATION_PROTOCOL = "${HARBOR_ATTEMPT_ISOLATION_PROTOCOL}"`) || !provider.includes("hitch_isolated_attempts")) return false;
    const harbor=await locateHarbor({root:input.root,explicit:input.harborExecutable,env});
    if (!harbor.executable || harbor.version!==DEFAULT_HARBOR_VERSION) return false;
    const python=await harborPython(harbor.executable,env); if(!python)return false;
    for(const task of input.taskDirectories){
      const result=await runCommand(python,[helper,task],{env,timeoutMs:10000,...(input.signal?{signal:input.signal}:{}),failureCode:"attempt_isolation_unavailable",failureExitCode:10});
      const value=JSON.parse(result.stdout);
      if(value.protocol!==HARBOR_ATTEMPT_ISOLATION_PROTOCOL||value.supported!==true||!Array.isArray(value.blockers)||value.blockers.length)return false;
    }
    return true;
  } catch(error) { if(input.signal?.aborted)throw error; return false; }
}
