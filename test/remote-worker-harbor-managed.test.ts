import test from "node:test";
import { verifyRemoteModelCapture } from "../test-support/remote-worker-harbor.js";

for (const mode of ["managed", "managed-verifier-source-recovery", "managed-repair", "managed-recovery"] as const) {
  test(`packaged remote worker captures and imports ${mode} model evidence`, t => verifyRemoteModelCapture(t, mode));
}
