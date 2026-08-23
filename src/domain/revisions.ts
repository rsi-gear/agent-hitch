import type { ArtifactSourceType } from "./artifacts.js";

export type RevisionSelector =
  | { type: "installed" }
  | { type: "version"; value: string }
  | { type: "commit"; value: string; source?: { type: "git"; url: string; local_path: string; explicit: boolean } };

export interface ResolvedRevision {
  schema_version: string;
  requested_ref: string;
  canonical_ref: string;
  harness_id: string;
  selector: RevisionSelector;
  source: {
    type: ArtifactSourceType;
    executable?: string;
    integrity?: string;
    package?: string;
    tarball?: string;
    url?: string;
    registered?: boolean;
  };
  revision: {
    type: string;
    version?: string | null;
    requested_commit?: string;
    commit?: string;
  };
  identity: string;
  resolved_at: string;
}

export interface VerifiedLocalGitSource {
  directory: string;
  commit: string;
  tree: string;
  resolutionIdentity: string;
  payloadSha256: string;
}
