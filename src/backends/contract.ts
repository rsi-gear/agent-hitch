export interface BackendArtifactReference {
  kind: string;
  path: string;
}

export interface BackendResult {
  status: "succeeded" | "failed";
  result: Record<string, unknown>;
  artifacts: BackendArtifactReference[];
}
