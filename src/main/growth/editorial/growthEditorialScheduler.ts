import { GrowthEditorialRepository } from "../../../domain/growth/editorial/growthEditorialRepository";
import type { WorkspaceDatabase } from "../../../domain/workspace/workspaceRepository";
import type {
  EditorialRoundCreate,
  GrowthEditorialRoundSnapshot,
} from "../../../domain/growth/editorial/growthEditorialTypes";
import {
  GrowthWorkOrderRunner,
  type GrowthWorkOrderRunnerDependencies,
} from "./growthWorkOrderRunner";

export interface GrowthEditorialSchedulerOptions {
  creativeConcurrency?: number;
  availableProviderSlots?: () => number;
}

export class GrowthEditorialSchedulerApplication {
  #current: {
    workspace: WorkspaceDatabase;
    dependencies: GrowthWorkOrderRunnerDependencies;
    scheduler: GrowthEditorialScheduler;
  } | null = null;

  get(
    workspace: WorkspaceDatabase,
    dependencies: GrowthWorkOrderRunnerDependencies,
    options?: GrowthEditorialSchedulerOptions,
  ): GrowthEditorialScheduler {
    if (this.#current?.workspace === workspace) {
      if (this.#current.dependencies !== dependencies) throw schedulerError("GROWTH_EDITORIAL_SCHEDULER_ALREADY_CONFIGURED");
      return this.#current.scheduler;
    }
    this.dispose();
    const repository = new GrowthEditorialRepository(workspace);
    const scheduler = new GrowthEditorialScheduler(repository, new GrowthWorkOrderRunner(repository, dependencies), options);
    this.#current = { workspace, dependencies, scheduler };
    return scheduler;
  }

  dispose(): void {
    this.#current?.scheduler.dispose();
    this.#current = null;
  }
}

export class GrowthEditorialScheduler {
  readonly #creativeConcurrency: number;
  readonly #availableProviderSlots: () => number;
  readonly #roundRuns = new Map<string, Promise<GrowthEditorialRoundSnapshot>>();
  readonly #roundControllers = new Map<string, AbortController>();
  #commitTail: Promise<void> = Promise.resolve();

  constructor(
    readonly repository: GrowthEditorialRepository,
    readonly runner: GrowthWorkOrderRunner,
    options: GrowthEditorialSchedulerOptions = {},
  ) {
    const concurrency = options.creativeConcurrency ?? 3;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) {
      throw schedulerError("GROWTH_EDITORIAL_CONCURRENCY_INVALID");
    }
    this.#creativeConcurrency = concurrency;
    this.#availableProviderSlots = options.availableProviderSlots ?? (() => concurrency);
  }

  startRound(input: EditorialRoundCreate, signal?: AbortSignal): Promise<GrowthEditorialRoundSnapshot> {
    const persisted = this.repository.createRound(input);
    return this.#runPersistedRound(persisted.round.id, signal);
  }

  resumeRound(roundId: string, signal?: AbortSignal): Promise<GrowthEditorialRoundSnapshot> {
    if (!this.repository.getRound(roundId)) throw schedulerError("GROWTH_EDITORIAL_ROUND_NOT_FOUND");
    return this.#runPersistedRound(roundId, signal);
  }

  cancelRound(roundId: string): void {
    this.#roundControllers.get(roundId)?.abort();
  }

  dispose(): void {
    for (const controller of this.#roundControllers.values()) controller.abort();
    this.#roundControllers.clear();
  }

  #runPersistedRound(roundId: string, parentSignal?: AbortSignal): Promise<GrowthEditorialRoundSnapshot> {
    const existing = this.#roundRuns.get(roundId);
    if (existing) return existing;
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (parentSignal?.aborted) controller.abort();
    else parentSignal?.addEventListener("abort", abort, { once: true });
    this.#roundControllers.set(roundId, controller);
    const run = this.#pump(roundId, controller.signal).finally(() => {
      parentSignal?.removeEventListener("abort", abort);
      this.#roundRuns.delete(roundId);
      this.#roundControllers.delete(roundId);
    });
    this.#roundRuns.set(roundId, run);
    return run;
  }

  async #pump(roundId: string, signal: AbortSignal): Promise<GrowthEditorialRoundSnapshot> {
    const candidates = new Map<string, Promise<void>>();
    const commits = new Map<string, Promise<void>>();
    while (true) {
      let snapshot = this.#requiredSnapshot(roundId);
      if (signal.aborted) {
        this.#cancelUndispatched(snapshot, candidates);
        await Promise.allSettled([...candidates.values(), ...commits.values()]);
        snapshot = this.#requiredSnapshot(roundId);
        this.#cancelUndispatched(snapshot, candidates);
        this.#terminalizeCancelledRoundIfSettled(roundId);
        return this.#requiredSnapshot(roundId);
      }
      if (["completed", "blocked", "cancelled", "failed", "reconciliation_required"].includes(snapshot.round.status)) {
        await Promise.allSettled([...candidates.values(), ...commits.values()]);
        return this.#requiredSnapshot(roundId);
      }

      this.repository.unlockReadyWorkOrders(roundId);
      snapshot = this.#requiredSnapshot(roundId);
      this.#terminalizeDependencyBlocked(snapshot);
      snapshot = this.#requiredSnapshot(roundId);
      const capacity = this.#creativeCapacity() - candidates.size;
      const dispatchable = snapshot.workOrders.filter((order) => this.#isCandidateDispatchable(snapshot, order.id)
        && !candidates.has(order.id));
      for (const order of dispatchable.slice(0, Math.max(0, capacity))) {
        const task = this.runner.runCandidate(order.id, signal).finally(() => candidates.delete(order.id));
        candidates.set(order.id, task);
      }

      snapshot = this.#requiredSnapshot(roundId);
      for (const order of snapshot.workOrders.filter((candidate) =>
        ["accepted", "commit_queued"].includes(candidate.status) && !commits.has(candidate.id))) {
        const task = this.#enqueueCommit(() => this.runner.commit(order.id, signal)).finally(() => commits.delete(order.id));
        commits.set(order.id, task);
      }

      const active = [...candidates.values(), ...commits.values()];
      if (active.length === 0) {
        this.#terminalizeSettledRound(roundId);
        return this.#requiredSnapshot(roundId);
      }
      await Promise.race(active);
    }
  }

  #enqueueCommit(operation: () => Promise<void>): Promise<void> {
    const result = this.#commitTail.then(operation, operation);
    this.#commitTail = result.catch(() => undefined);
    return result;
  }

  #isCandidateDispatchable(snapshot: GrowthEditorialRoundSnapshot, workOrderId: string): boolean {
    const order = snapshot.workOrders.find((candidate) => candidate.id === workOrderId);
    if (!order) return false;
    if (["ready", "running", "candidate_ready", "reviewing"].includes(order.status)) return true;
    if (order.status !== "revision_requested") return false;
    const latestDirectorReview = snapshot.reviews
      .filter((review) => review.workOrderId === workOrderId && review.reviewerKind === "director")
      .at(-1);
    return latestDirectorReview?.decision === "revise";
  }

  #creativeCapacity(): number {
    const providerSlots = this.#availableProviderSlots();
    if (!Number.isFinite(providerSlots)) throw schedulerError("GROWTH_EDITORIAL_PROVIDER_CAPACITY_INVALID");
    return Math.max(0, Math.min(this.#creativeConcurrency, Math.floor(providerSlots)));
  }

  #cancelUndispatched(snapshot: GrowthEditorialRoundSnapshot, active: ReadonlyMap<string, Promise<void>>): void {
    for (const order of snapshot.workOrders) {
      if (active.has(order.id)) continue;
      if (["planned", "ready", "running", "candidate_ready", "reviewing", "revision_requested", "accepted"].includes(order.status)) {
        this.repository.terminalizeWorkOrder({
          workOrderId: order.id,
          status: "cancelled",
          failureCode: "GROWTH_EDITORIAL_CANCELLED",
        });
      }
    }
  }

  #terminalizeCancelledRoundIfSettled(roundId: string): void {
    const snapshot = this.#requiredSnapshot(roundId);
    if (snapshot.round.status !== "active") return;
    if (snapshot.workOrders.every((order) => ["committed", "cancelled", "failed"].includes(order.status))) {
      this.repository.terminalizeRound({
        roundId,
        status: "cancelled",
        failureCode: "GROWTH_EDITORIAL_CANCELLED",
      });
    }
  }

  #terminalizeDependencyBlocked(snapshot: GrowthEditorialRoundSnapshot): void {
    const failed = new Set(snapshot.workOrders
      .filter((order) => ["failed", "cancelled", "reconciliation_required"].includes(order.status))
      .map((order) => order.id));
    let changed = true;
    while (changed) {
      changed = false;
      for (const order of this.#requiredSnapshot(snapshot.round.id).workOrders) {
        if (order.status !== "planned" || !order.dependencies.some((dependency) => failed.has(dependency))) continue;
        this.repository.terminalizeWorkOrder({
          workOrderId: order.id,
          status: "failed",
          failureCode: "GROWTH_EDITORIAL_DEPENDENCY_FAILED",
        });
        failed.add(order.id);
        changed = true;
      }
    }
  }

  #terminalizeSettledRound(roundId: string): void {
    const snapshot = this.#requiredSnapshot(roundId);
    if (snapshot.round.status !== "active") return;
    if (!snapshot.workOrders.every((order) => ["committed", "cancelled", "failed"].includes(order.status))) return;
    const failed = snapshot.workOrders.find((order) => order.status === "failed");
    this.repository.terminalizeRound(failed
      ? { roundId, status: "failed", failureCode: failed.failureCode ?? "GROWTH_EDITORIAL_WORK_ORDER_FAILED" }
      : { roundId, status: "cancelled", failureCode: "GROWTH_EDITORIAL_CANCELLED" });
  }

  #requiredSnapshot(roundId: string): GrowthEditorialRoundSnapshot {
    const snapshot = this.repository.getRoundSnapshot(roundId);
    if (!snapshot) throw schedulerError("GROWTH_EDITORIAL_ROUND_NOT_FOUND");
    return snapshot;
  }
}

function schedulerError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
