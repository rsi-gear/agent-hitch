/**
 * Pinned DSH trajectory compatibility contract (spec §5.3). The contract is
 * pinned to an exact reviewed commit, never inferred from DSH `master`.
 *
 * An implementation PR must re-check the DSH baseline and replace
 * CONTRACT_COMMIT if a different exact revision is selected.
 */

export const SESSION_FORMAT_VERSION = 0;
export const CONTRACT_COMMIT = "141eb6fef83422698aef7a981029e843e8161534";

/** Reader compatibility is audited separately from the unchanged v0 writer. */
export const READER_CONTRACT_COMMIT = "46a7f68b0922371ce7144b668b90e377d8e799f4";
export const SUPPORTED_SESSION_FORMAT_VERSIONS = [0, 1, 2, 3, 4] as const;
export const LATEST_SESSION_FORMAT_VERSION = 4;

export interface TrajectoryFormatRef {
  family: "dsh-session";
  version: 0;
  contract_commit: typeof CONTRACT_COMMIT;
  compression: "none";
  pack_chunks: false;
}

export const TRAJECTORY_FORMAT: TrajectoryFormatRef = {
  family: "dsh-session",
  version: 0,
  contract_commit: CONTRACT_COMMIT,
  compression: "none",
  pack_chunks: false,
};
