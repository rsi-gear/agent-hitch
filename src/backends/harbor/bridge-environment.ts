import path from "node:path";

const BRIDGE_PAYLOAD_DIRECTORY = path.join("integrations", "harbor");

export function withBridgePythonPath(env: NodeJS.ProcessEnv, runtimeDirectory: string): NodeJS.ProcessEnv {
  const bridgeDirectory = path.join(runtimeDirectory, "payload", BRIDGE_PAYLOAD_DIRECTORY);
  return {
    ...env,
    // Harbor imports these modules from an immutable controller runtime.
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONPATH: [bridgeDirectory, env.PYTHONPATH].filter(Boolean).join(path.delimiter),
  };
}
