import type { ResolvedRevision } from "../revisions/index.js";

export interface ArtifactManifest {
  schema_version: string;
  artifact_id: string;
  harness_id: string;
  revision_identity: string;
  source_type: string;
  adapter: string;
  adapter_version: string;
  recipe_version: string;
  platform: string;
  entrypoint: string;
  toolchain: Record<string, string>;
  resolved_revision: ResolvedRevision;
  dependency_lock?: string | null;
  artifact_integrity?: string;
  entrypoint_integrity?: string;
  launcher?: string;
  observed_version?: string | null;
  prepared_at: string;
}

export interface ArtifactInvocation {
  executable: string;
  entrypoint_args: string[];
}

export interface PreparedArtifact extends ArtifactManifest, ArtifactInvocation {
  cache_hit: boolean;
}

export interface ListedArtifact extends ArtifactManifest {
  status: "ready" | "invalid";
}
