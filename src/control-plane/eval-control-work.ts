import type { EvalControlStateV1, EvalControlV1 } from "../domain/index.js";

const PHASES: EvalControlStateV1[] = ["queued", "planning", "preparing", "running", "finalizing"];

export function applyEvalPhase(control: EvalControlV1, phase: "planning" | "preparing" | "running" | "finalizing", queued?: string[], terminal?: string[]): EvalControlV1 {
  if (control.state === "cancelling" || terminalState(control.state)) return control;
  const currentRank = PHASES.indexOf(control.state);
  const nextRank = PHASES.indexOf(phase);
  if (currentRank > nextRank) return control;
  const terminalItems = canonical(terminal ?? control.terminal_work_items);
  const queuedItems = canonical(queued ?? control.queued_work_items).filter((id) => !terminalItems.includes(id));
  return { ...control, state: phase, queued_work_items: queuedItems, terminal_work_items: terminalItems };
}

export function applyEvalWorkItem(control: EvalControlV1, workId: string, leaseId: string, state: "running" | "terminal"): EvalControlV1 {
  if (!/^work_[a-f0-9]{32}$/.test(workId) || !/^lease_[a-f0-9]{32}$/.test(leaseId) || terminalState(control.state)) return control;
  const queued = control.queued_work_items.filter((id) => id !== workId);
  const active = control.active_leases.filter((id) => id !== leaseId);
  const terminal = control.terminal_work_items.filter((id) => id !== workId);
  if (state === "running") active.push(leaseId);
  else terminal.push(workId);
  return { ...control, queued_work_items: canonical(queued), active_leases: canonical(active), terminal_work_items: canonical(terminal) };
}

export function queueEvalWorkItem(control: EvalControlV1, workId: string): EvalControlV1 {
  if (!/^work_[a-f0-9]{32}$/.test(workId) || terminalState(control.state) || control.terminal_work_items.includes(workId)) return control;
  return { ...control, queued_work_items: canonical([...control.queued_work_items, workId]) };
}

export function settleEvalWorkItems(control: EvalControlV1): EvalControlV1 {
  return {
    ...control,
    active_leases: [],
    queued_work_items: [],
    terminal_work_items: canonical([...control.terminal_work_items, ...control.queued_work_items]),
  };
}

function terminalState(state: EvalControlStateV1): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

function canonical(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}
