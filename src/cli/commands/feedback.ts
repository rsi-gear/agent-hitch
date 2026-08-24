import path from "node:path";
import type { MessageFeedbackRating } from "../../domain/index.js";
import { MessageFeedbackService, resolveFeedbackSession, trajectoryTargetValidator } from "../../feedback/index.js";
import { HitchError, SCHEMA_VERSION, invalidInput, statePaths } from "../../foundation/index.js";
import { assertNoArgs, takeFlag, takeOption } from "../arguments.js";

export async function feedbackCommand(args: string[], root: string): Promise<void> {
  const action = args.shift();
  const runId = args.shift();
  if (!runId) throw invalidInput("feedback requires a run ID");
  const runDirectory = path.join(statePaths(root).runs, runId);
  const session = await resolveFeedbackSession(runDirectory);
  if (!session) {
    throw new HitchError(`run ${runId} has no canonical trajectory for feedback`, {
      code: "session-not-found",
      exitCode: 3,
    });
  }
  const service = new MessageFeedbackService({
    root: runDirectory,
    validateTarget: await trajectoryTargetValidator(runDirectory),
  });

  if (action === "list") {
    const json = takeFlag(args, "--json");
    assertNoArgs(args);
    const items = await service.list({ sessionId: session.sessionId }, session);
    if (json) {
      process.stdout.write(`${JSON.stringify({ schema_version: SCHEMA_VERSION, run_id: runId, session_id: session.sessionId, items }, null, 2)}\n`);
      return;
    }
    if (items.length === 0) {
      process.stdout.write("No feedback\n");
      return;
    }
    for (const item of items) {
      process.stdout.write(`${item.messageId}  ${item.rating}  v${item.version}${item.note ? `  ${item.note}` : ""}\n`);
    }
    return;
  }

  if (action === "put") {
    const json = takeFlag(args, "--json");
    const messageId = takeOption(args, "--message");
    const ratingValue = takeOption(args, "--rating");
    const note = takeOption(args, "--note");
    const ifVersion = takeOption(args, "--if-version");
    assertNoArgs(args);
    if (!messageId) throw invalidInput("feedback put requires --message <id>");
    if (ratingValue !== "positive" && ratingValue !== "negative") {
      throw invalidInput("feedback put requires --rating positive|negative");
    }
    const item = await service.put(
      {
        sessionId: session.sessionId,
        messageId,
        rating: ratingValue as MessageFeedbackRating,
        ...(note !== undefined ? { note } : {}),
        ifVersion: ifVersion === undefined ? null : ifVersion,
      },
      session,
      { messageId },
    );
    if (json) process.stdout.write(`${JSON.stringify({ schema_version: SCHEMA_VERSION, item }, null, 2)}\n`);
    else process.stdout.write(`${item.messageId}: ${item.rating} (v${item.version})\n`);
    return;
  }

  if (action === "delete") {
    const json = takeFlag(args, "--json");
    const messageId = takeOption(args, "--message");
    const ifVersion = takeOption(args, "--if-version");
    assertNoArgs(args);
    if (!messageId) throw invalidInput("feedback delete requires --message <id>");
    await service.delete(
      {
        sessionId: session.sessionId,
        messageId,
        ifVersion: ifVersion === undefined ? null : ifVersion,
      },
      session,
    );
    if (json) process.stdout.write(`${JSON.stringify({ schema_version: SCHEMA_VERSION, absent: true }, null, 2)}\n`);
    else process.stdout.write(`Deleted feedback for ${messageId}\n`);
    return;
  }

  throw invalidInput("feedback requires list, put, or delete");
}
