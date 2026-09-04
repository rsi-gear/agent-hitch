import type { ResourceAllocationV1, ResourceVectorV1 } from "../domain/index.js";
import { HitchError } from "../foundation/index.js";
import { CollisionLockManager } from "./collisions.js";
import type { CollisionLease } from "./collisions.js";
import { ResourceLedger } from "./resources.js";
import type { ResourceLease } from "./resources.js";

export interface WorkDispatchRequest {
  evalId: string;
  workId: string;
  maxParallelism: number;
  reservation: ResourceVectorV1;
  collisionKeys: readonly string[];
  priority?: number;
  signal?: AbortSignal;
}

export interface WorkDispatchPermit {
  allocation: ResourceAllocationV1;
  collision_keys: string[];
  release(): void;
}

export interface WorkDispatcherSnapshot {
  quantum: number;
  active: number;
  queued: number;
  lanes: Array<{
    eval_id: string;
    active: number;
    queued: number;
    max_parallelism: number;
    deficit: number;
    grants: number;
  }>;
}

interface PendingWork {
  request: WorkDispatchRequest;
  cost: number;
  resolve: (permit: WorkDispatchPermit) => void;
  reject: (error: unknown) => void;
  abort?: () => void;
  sequence: number;
}

interface EvalLane {
  evalId: string;
  maxParallelism: number;
  active: number;
  deficit: number;
  grants: number;
  queue: PendingWork[];
}

export interface WorkItemDispatcherOptions {
  resources: ResourceLedger;
  collisions?: CollisionLockManager;
  quantum?: number;
}

export class WorkItemDispatcher {
  readonly resources: ResourceLedger;
  readonly collisions: CollisionLockManager;
  readonly quantum: number;
  private readonly lanes = new Map<string, EvalLane>();
  private readonly order: string[] = [];
  private readonly workIds = new Set<string>();
  private readonly unsubscribeResources: () => void;
  private scheduled = false;
  private draining = false;
  private closed = false;
  private lastGrantedEvalId: string | undefined;
  private nextSequence = 0;

  constructor({ resources, collisions = new CollisionLockManager(), quantum = 1 }: WorkItemDispatcherOptions) {
    if (!Number.isSafeInteger(quantum) || quantum < 1) throw new TypeError("work dispatcher quantum must be a positive safe integer");
    this.resources = resources;
    this.collisions = collisions;
    this.quantum = quantum;
    this.unsubscribeResources = resources.subscribe(() => this.scheduleDrain());
  }

  async acquire(request: WorkDispatchRequest): Promise<WorkDispatchPermit> {
    validateRequest(request);
    if (this.closed) throw unavailable("work dispatcher is closed", "work_dispatcher_closed");
    if (request.signal?.aborted) throw cancelled();
    if (!this.resources.canEverFit(request.reservation)) {
      throw unavailable("work item exceeds the worker resource capacity", "resource_request_unsatisfiable");
    }
    let lane = this.lanes.get(request.evalId);
    if (lane && lane.maxParallelism !== request.maxParallelism) {
      throw new TypeError("work dispatcher eval max parallelism changed");
    }
    if (this.workIds.has(request.workId)) throw unavailable("work item is already queued or active", "work_item_already_scheduled");
    if (!lane) {
      lane = { evalId: request.evalId, maxParallelism: request.maxParallelism, active: 0, deficit: 0, grants: 0, queue: [] };
      this.lanes.set(request.evalId, lane);
    }
    if (!this.order.includes(request.evalId)) this.order.push(request.evalId);
    this.workIds.add(request.workId);
    return new Promise<WorkDispatchPermit>((resolve, reject) => {
      const pending: PendingWork = {
        request,
        cost: Math.max(1, request.reservation.container_slots),
        sequence: this.nextSequence++,
        resolve,
        reject,
      };
      if (request.signal) {
        pending.abort = () => {
          const current = this.lanes.get(request.evalId);
          const index = current?.queue.indexOf(pending) ?? -1;
          if (current && index >= 0) {
            current.queue.splice(index, 1);
            this.workIds.delete(request.workId);
            reject(cancelled());
            this.cleanupLane(current);
            this.scheduleDrain();
          }
        };
        request.signal.addEventListener("abort", pending.abort, { once: true });
      }
      lane.queue.push(pending);
      this.scheduleDrain();
    });
  }

  evalSnapshot(evalId: string): { active: number; queued: number; max_parallelism: number; deficit: number; grants: number } | null {
    const lane = this.lanes.get(evalId);
    return lane ? { active: lane.active, queued: lane.queue.length, max_parallelism: lane.maxParallelism, deficit: lane.deficit, grants: lane.grants } : null;
  }

  snapshot(): WorkDispatcherSnapshot {
    const lanes = [...this.lanes.values()].sort((left, right) => left.evalId.localeCompare(right.evalId));
    return {
      quantum: this.quantum,
      active: lanes.reduce((total, lane) => total + lane.active, 0),
      queued: lanes.reduce((total, lane) => total + lane.queue.length, 0),
      lanes: lanes.map((lane) => ({
        eval_id: lane.evalId,
        active: lane.active,
        queued: lane.queue.length,
        max_parallelism: lane.maxParallelism,
        deficit: lane.deficit,
        grants: lane.grants,
      })),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeResources();
    for (const lane of this.lanes.values()) {
      for (const pending of lane.queue.splice(0)) {
        if (pending.abort) pending.request.signal?.removeEventListener("abort", pending.abort);
        this.workIds.delete(pending.request.workId);
        pending.reject(unavailable("work dispatcher is closed", "work_dispatcher_closed"));
      }
    }
    this.order.splice(0);
    for (const lane of [...this.lanes.values()]) this.cleanupLane(lane);
  }

  private scheduleDrain(): void {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    queueMicrotask(() => this.drain());
  }

  private drain(): void {
    this.scheduled = false;
    if (this.draining || this.closed) return;
    this.draining = true;
    try {
      for (;;) {
        const ordered = this.orderedLanes();
        if (ordered.length === 0) return;
        let granted = false;
        let eligibleByDeficit = false;
        let waitingForDeficit = false;
        for (const lane of ordered) {
          if (lane.queue.length === 0 || lane.active >= lane.maxParallelism) continue;
          lane.deficit += this.quantum;
          for (const pending of [...lane.queue].sort(comparePending)) {
            if (lane.deficit < pending.cost) {
              waitingForDeficit = true;
              continue;
            }
            eligibleByDeficit = true;
            const collisions = this.collisions.tryAcquire(pending.request.workId, pending.request.collisionKeys);
            if (!collisions) continue;
            const resources = this.resources.tryAcquire(pending.request.workId, "eval", pending.request.reservation);
            if (!resources) {
              collisions.release();
              continue;
            }
            this.grant(lane, pending, resources, collisions);
            granted = true;
            break;
          }
          if (granted) break;
        }
        if (granted) continue;
        if (!eligibleByDeficit && waitingForDeficit) continue;
        return;
      }
    } finally {
      this.draining = false;
    }
  }

  private grant(lane: EvalLane, pending: PendingWork, resources: ResourceLease, collisions: CollisionLease): void {
    const pendingIndex = lane.queue.indexOf(pending);
    if (pendingIndex < 0) throw new Error("work dispatcher pending item disappeared");
    lane.queue.splice(pendingIndex, 1);
    lane.active += 1;
    lane.grants += 1;
    lane.deficit -= pending.cost;
    this.lastGrantedEvalId = lane.evalId;
    if (pending.abort) pending.request.signal?.removeEventListener("abort", pending.abort);
    this.removeFromOrderIfEmpty(lane);
    let released = false;
    pending.resolve({
      allocation: resources.allocation,
      collision_keys: collisions.keys,
      release: () => {
        if (released) return;
        released = true;
        resources.release();
        collisions.release();
        this.workIds.delete(pending.request.workId);
        lane.active -= 1;
        this.cleanupLane(lane);
        this.scheduleDrain();
      },
    });
  }

  private orderedLanes(): EvalLane[] {
    const available = this.order.filter((evalId) => (this.lanes.get(evalId)?.queue.length ?? 0) > 0);
    if (available.length === 0) return [];
    const previous = this.lastGrantedEvalId ? available.indexOf(this.lastGrantedEvalId) : -1;
    const start = previous < 0 ? 0 : (previous + 1) % available.length;
    return [...available.slice(start), ...available.slice(0, start)].map((evalId) => this.lanes.get(evalId) as EvalLane);
  }

  private removeFromOrderIfEmpty(lane: EvalLane): void {
    if (lane.queue.length > 0) return;
    const index = this.order.indexOf(lane.evalId);
    if (index >= 0) this.order.splice(index, 1);
  }

  private cleanupLane(lane: EvalLane): void {
    this.removeFromOrderIfEmpty(lane);
    if (lane.queue.length === 0 && lane.active === 0) this.lanes.delete(lane.evalId);
  }
}

function validateRequest(request: WorkDispatchRequest): void {
  if (!/^eval_[a-f0-9]{32}$/.test(request.evalId) || !/^work_[a-f0-9]{32}$/.test(request.workId)) {
    throw new TypeError("work dispatcher identity is invalid");
  }
  if (request.priority !== undefined && (!Number.isFinite(request.priority) || request.priority < 0)) {
    throw new TypeError("work dispatcher priority is invalid");
  }
  if (!Number.isSafeInteger(request.maxParallelism) || request.maxParallelism < 1) {
    throw new TypeError("work dispatcher max parallelism is invalid");
  }
  if (request.collisionKeys.length === 0 || request.collisionKeys.some((key) => typeof key !== "string" || !key)) {
    throw new TypeError("work dispatcher collision keys are invalid");
  }
}

function comparePending(left: PendingWork, right: PendingWork): number {
  return (right.request.priority ?? 0) - (left.request.priority ?? 0) || left.sequence - right.sequence;
}

function cancelled(): HitchError {
  return new HitchError("work item scheduling was cancelled", { code: "cancelled", exitCode: 9 });
}

function unavailable(message: string, code: string): HitchError {
  return new HitchError(message, { code, exitCode: code === "resource_request_unsatisfiable" ? 10 : 12 });
}
