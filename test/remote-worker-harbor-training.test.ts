import test from "node:test";
import { verifyRemoteModelCapture } from "../test-support/remote-worker-harbor.js";

for (const mode of ["training", "training-verifier-source", "training-recovery"] as const) {
  test(`packaged remote worker captures and imports ${mode} model evidence`, t => verifyRemoteModelCapture(t, mode));
}
