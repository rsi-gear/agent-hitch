/**
 * Pinned DSH trajectory compatibility contract (spec §5.3). The contract is
 * pinned to an exact reviewed commit, never inferred from DSH `master`.
 *
 * An implementation PR must re-check the DSH baseline and replace
 * CONTRACT_COMMIT if a different exact revision is selected.
 */
export const SESSION_FORMAT_VERSION = 0;
export const CONTRACT_COMMIT = "141eb6fef83422698aef7a981029e843e8161534";
export const TRAJECTORY_FORMAT = {
    family: "dsh-session",
    version: 0,
    contract_commit: CONTRACT_COMMIT,
    compression: "none",
    pack_chunks: false,
};
//# sourceMappingURL=contract.js.map