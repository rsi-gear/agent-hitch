export { assertExactLocalGitEvalReference, parseHarnessReference } from "./reference.js";
export type { ParsedHarnessReference, RevisionSelector } from "./reference.js";
export { resolveHarness } from "./resolver.js";
export { gitCacheDirectory } from "./sources/git.js";
export type { ResolvedRevision, VerifiedLocalGitSource } from "../domain/index.js";
