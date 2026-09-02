import type { Sha256 } from "../../domain/index.js";
import { invalidInput, parseDuration } from "../../foundation/index.js";
import { gcEnvironmentImages, pinEnvironmentImage, unpinEnvironmentImage } from "../../images/index.js";
import { assertNoArgs, takeFlag, takeOption } from "../arguments.js";

export async function imagesCommand(args: string[], root: string): Promise<void> {
  const action = args.shift();
  if (action === "gc") {
    const apply = takeFlag(args, "--apply");
    const json = takeFlag(args, "--json");
    const minimumAge = takeOption(args, "--minimum-age");
    assertNoArgs(args);
    const report = await gcEnvironmentImages({
      root,
      dryRun: !apply,
      ...(minimumAge === undefined ? {} : { minimumAgeMs: parseDuration(minimumAge) }),
    });
    if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(`${apply ? "Removed" : "Eligible"} ${apply ? report.removed.length : report.eligible.length} of ${report.scanned} environment images; retained ${report.retained.length}, skipped ${report.skipped.length}\n`);
    return;
  }
  const imageId = args.shift();
  if (!imageId || !/^sha256:[a-f0-9]{64}$/.test(imageId)) throw invalidInput("images pin/unpin requires an environment image SHA-256 ID");
  if (action === "pin") {
    const reason = takeOption(args, "--reason");
    assertNoArgs(args);
    await pinEnvironmentImage(root, imageId as Sha256, reason);
    process.stdout.write(`Pinned environment image ${imageId}\n`);
    return;
  }
  if (action === "unpin") {
    assertNoArgs(args);
    await unpinEnvironmentImage(root, imageId as Sha256);
    process.stdout.write(`Unpinned environment image ${imageId}\n`);
    return;
  }
  throw invalidInput("images requires gc, pin, or unpin");
}
