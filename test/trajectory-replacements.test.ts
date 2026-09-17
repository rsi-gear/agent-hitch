import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionEvent, SessionHeaderLine } from "../src/domain/index.js";
import {
  validateTrajectoryInvariants,
  finalizeInterruptedTrajectory,
} from "../src/trajectories/store.js";
import { importDeepseekNativeSession } from "../src/trajectories/providers/deepseek.js";
import { forceRemove } from "../test-support/helpers.js";
const header: SessionHeaderLine = {
  type: "session",
  version: 0,
  id: "native",
  createdAt: 1,
  delegationDepth: 0,
};
function event(type: string, data: Record<string, unknown>): SessionEvent {
  return {
    type,
    data,
    seq: 0,
    time: 1,
  };
}
interface ToolResultData {
  turn: number;
  step: number;
  message: {
    source: { callId: string };
    content: Array<{ toolCallId: string; isError?: boolean }>;
  };
}

function result(text = "original"): SessionEvent {
  return {
    ...event("tool/result", {
      turn: 1,
      step: 1,
      message: {
        id: "result",
        role: "user",
        source: {
          kind: "tool",
          callId: "call_A",
        },
        content: [
          {
            type: "tool-result",
            toolCallId: "call_A",
            content: [
              {
                type: "text",
                text,
              },
            ],
          },
        ],
      },
    }),
    surfaceOp: "append",
  };
}
function replacement(target = 3): SessionEvent {
  return {
    ...result("compressed"),
    surfaceOp: {
      op: "replace",
      start: target,
      end: target,
    },
    sourceEventSeqs: [target],
  };
}
function sequence(middle: SessionEvent[] = [replacement()]): SessionEvent[] {
  return [
    event("turn/start", { turn: 1 }),
    event("step/start", {
      turn: 1,
      step: 1,
    }),
    event("tool/call", {
      turn: 1,
      step: 1,
      callId: "call_A",
      name: "read",
      arguments: "{}",
    }),
    result(),
    event("step/end", {
      turn: 1,
      step: 1,
    }),
    event("step/start", {
      turn: 1,
      step: 2,
    }),
    ...middle,
    event("step/end", {
      turn: 1,
      step: 2,
    }),
    event("turn/end", {
      turn: 1,
      reason: { kind: "completed" },
    }),
  ].map((row, seq) => ({
    ...row,
    seq,
  }));
}
test("historical tool result replacement and successive compression do not consume another call", () => {
  validateTrajectoryInvariants(
    header,
    sequence([replacement(), replacement(6)]),
  );
});
test("replacement validation rejects invalid targets, provenance, and identity changes", () => {
  const changed = replacement();
  (
    (changed.data as Record<string, unknown>).message as Record<string, unknown>
  ).id = "different";
  for (const [rows, pattern] of [
    [[replacement(), replacement()], /not found in surface/],
    [
      [
        {
          ...replacement(),
          surfaceOp: {
            op: "replace",
            start: 99,
            end: 99,
          },
        },
      ],
      /not found in surface/,
    ],
    [
      [
        {
          ...replacement(),
          sourceEventSeqs: undefined,
        },
      ],
      /sourceEventSeqs/,
    ],
    [[changed], /only content/],
  ] as Array<[SessionEvent[], RegExp]>)
    assert.throws(
      () => validateTrajectoryInvariants(header, sequence(rows)),
      pattern,
    );
  assert.throws(
    () => validateTrajectoryInvariants(header, sequence([result()])),
    /matching open tool call/,
  );
  const orphan = sequence([]);
  orphan.splice(2, 1);
  orphan.forEach((row, seq) => {
    row.seq = seq;
  });
  assert.throws(
    () => validateTrajectoryInvariants(header, orphan),
    /matching open tool call/,
  );
});
test("replacement rejects identity mutations and malformed surface ranges", () => {
  for (const mutate of [
    (data: ToolResultData) => {
      data.turn = 2;
    },
    (data: ToolResultData) => {
      data.step = 2;
    },
    (data: ToolResultData) => {
      data.message.source.callId = "other";
    },
    (data: ToolResultData) => {
      data.message.content[0]!.toolCallId = "other";
    },
    (data: ToolResultData) => {
      data.message.content[0]!.isError = true;
    },
  ]) {
    const row = replacement();
    mutate(row.data as ToolResultData);
    assert.throws(
      () => validateTrajectoryInvariants(header, sequence([row])),
      /only content/,
    );
  }
  for (const sources of [
    [3, 3],
    [3, 6],
  ]) {
    assert.throws(
      () =>
        validateTrajectoryInvariants(
          header,
          sequence([
            {
              ...replacement(),
              sourceEventSeqs: sources,
            },
          ]),
        ),
      /sourceEventSeqs/,
    );
  }
  const user = {
    ...event("user/message", {
      id: "user",
      role: "user",
      content: [],
    }),
    surfaceOp: "append" as const,
  };
  assert.throws(
    () =>
      validateTrajectoryInvariants(header, sequence([user, replacement(6)])),
    /exactly one current tool.result/,
  );
  assert.throws(
    () =>
      validateTrajectoryInvariants(
        header,
        sequence([
          user,
          {
            ...replacement(),
            surfaceOp: {
              op: "replace",
              start: 3,
              end: 6,
            },
            sourceEventSeqs: [3, 6],
          },
        ]),
      ),
    /exactly one current tool.result/,
  );
  const closed = sequence([]);
  closed.push({
    ...replacement(),
    seq: closed.length,
  });
  assert.throws(
    () => validateTrajectoryInvariants(header, closed),
    /outside a turn/,
  );
  const legacy = sequence([]).map(({ surfaceOp: _marker, ...row }) => row);
  validateTrajectoryInvariants(header, legacy);
});
test("interrupted finalization preserves a new open call sharing a historical result's callId", () => {
  const rows = sequence([
    event("tool/call", {
      turn: 1,
      step: 2,
      callId: "call_A",
      name: "read",
      arguments: "{}",
    }),
    replacement(),
  ]).slice(0, -2);
  const finalized = finalizeInterruptedTrajectory(header, rows, "timed_out");
  assert.equal(finalized.filter((row) => row.type === "tool/result").length, 3);
  validateTrajectoryInvariants(header, finalized);
});
for (const failure of [
  "none",
  "pairing",
  "sequence",
  "shape",
  "ambiguous",
  "json",
  "child-shape",
] as const) {
  test(`native import retains redacted original evidence: ${failure}`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "hitch-replacement-"));
    t.after(() => forceRemove(root));
    const runtimeHome = path.join(root, "runtime");
    const runDirectory = path.join(root, "run");
    const rows: unknown[] = [
      header,
      ...sequence(failure === "pairing" ? [result()] : [replacement()]),
      {
        type: "provider/custom",
        seq: 9,
        time: 1,
        data: {
          token: "field-secret",
          output: "known-secret",
        },
      },
    ];
    if (failure === "sequence") (rows[2] as SessionEvent).seq = 88;
    if (failure === "shape")
      (rows[2] as unknown as Record<string, unknown>).time = "invalid";
    const source = path.join(
      runtimeHome,
      "sessions",
      "primary",
      "session.jsonl",
    );
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(
      source,
      rows.map((row) => JSON.stringify(row)).join("\n") +
        "\n" +
        (failure === "json" ? '\n{"token":"\\u0073ecret",bad\n' : ""),
    );
    if (failure === "ambiguous" || failure === "child-shape") {
      const other = path.join(
        runtimeHome,
        "sessions",
        "other",
        "session.jsonl",
      );
      await mkdir(path.dirname(other), { recursive: true });
      await writeFile(
        other,
        JSON.stringify({
          ...header,
          id: "other",
          ...(failure === "child-shape"
            ? {
                parentSession: "native",
                version: "invalid",
              }
            : {}),
        }) + "\n",
      );
    }
    const imported = importDeepseekNativeSession({
      runtimeHome,
      runDirectory,
      runId: "run",
      status: "succeeded",
      credentialValues: ["known-secret"],
    });
    if (failure === "none") assert.ok(await imported);
    else await assert.rejects(imported);
    const evidence = await readFile(
      path.join(runDirectory, "trajectory/provider/deepseek-session.jsonl"),
      "utf8",
    );
    assert.doesNotMatch(evidence, /field-secret|known-secret/);
    const evidenceRows = evidence
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    if (failure !== "ambiguous") {
      const custom = evidenceRows.find((row) => row.type === "provider/custom");
      assert.equal(custom.ignorable, undefined);
      assert.equal(custom.data.token, "[REDACTED]");
    }
    if (failure === "json") {
      assert.equal(
        evidenceRows.at(-1).hitch_envelope.kind,
        "invalid_native_json",
      );
      assert.equal(evidenceRows.at(-1).hitch_envelope.line, rows.length + 2);
      assert.doesNotMatch(evidence, /u0073|secret/);
    }
    if (failure === "ambiguous" || failure === "child-shape") {
      const second = await readFile(
        path.join(
          runDirectory,
          "trajectory/provider/deepseek-child-session-1.jsonl",
        ),
        "utf8",
      );
      const all = evidence + second;
      assert.match(all, /"id":"native"/);
      assert.match(all, /"id":"other"/);
      assert.match(all, /provider\/custom/);
      assert.doesNotMatch(all, /field-secret|known-secret/);
    }
    if (failure !== "none")
      await assert.rejects(
        access(path.join(runDirectory, "trajectory.ref.json")),
      );
  });
}
