import type { InferenceRuntimeManifestV1, LocalInferenceBackend } from "../domain/index.js";
import { inferenceRuntimeIdentity } from "./manifest.js";

interface RuntimeCatalogDefinition extends Omit<InferenceRuntimeManifestV1, "runtime_id"> {}

const DEFINITIONS: Readonly<Record<"cpu" | "cuda", RuntimeCatalogDefinition>> = {
  cpu: {
    schema_version: "1",
    engine: "sglang",
    sglang_version: "0.5.15.post1",
    sglang_commit: "658e0a942ec771aeeef1b1adf4180764cacd79b2",
    backend: "cpu",
    package: {
      kind: "oci",
      image: "docker.io/lmsysorg/sglang@sha256:c365eb5796b1a1fe42f6833f199cdb4e725bb8a469b9f37f1fadd95cf55d78df",
      image_digest: "sha256:c365eb5796b1a1fe42f6833f199cdb4e725bb8a469b9f37f1fadd95cf55d78df",
      platform: "linux/amd64",
    },
    compatibility_profile: "sglang-0.5.15.post1-xeon-amx-p0-v1",
  },
  cuda: {
    schema_version: "1",
    engine: "sglang",
    sglang_version: "0.5.16",
    sglang_commit: "d21f3c3a10606ba3c7bf43f981496da0a7d620cd",
    backend: "cuda",
    package: {
      kind: "oci",
      image: "docker.io/lmsysorg/sglang@sha256:984699c298a95b73c469b2191403ddc85fd780506e13c39c4afff3845e27bc6c",
      image_digest: "sha256:984699c298a95b73c469b2191403ddc85fd780506e13c39c4afff3845e27bc6c",
      platform: "linux/amd64",
    },
    compatibility_profile: "sglang-0.5.16-cuda-p0-v1",
  },
};

export function runtimeCatalogEntry(backend: LocalInferenceBackend): InferenceRuntimeManifestV1 {
  if (backend === "metal") throw new TypeError("Metal runtime is not present in the P0 catalog");
  const definition = DEFINITIONS[backend];
  return { ...definition, runtime_id: inferenceRuntimeIdentity(definition) };
}

export function listRuntimeCatalog(): InferenceRuntimeManifestV1[] {
  return [runtimeCatalogEntry("cpu"), runtimeCatalogEntry("cuda")];
}
