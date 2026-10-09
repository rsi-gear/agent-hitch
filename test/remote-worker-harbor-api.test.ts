import test from "node:test";
import { verifyRemoteModelCapture } from "../test-support/remote-worker-harbor.js";

for (const mode of ["api", "api-verifier-source", "api-repair"] as const) {
  test(`packaged remote worker captures and imports ${mode} model evidence`, t => verifyRemoteModelCapture(t, mode));
}
