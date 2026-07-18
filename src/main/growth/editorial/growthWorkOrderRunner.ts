import { GrowthEditorialRepository } from "../../../domain/growth/editorial/growthEditorialRepository";
import type {
  CandidateRecord,
  EditorialReviewRecord,
  GrowthEditorialRoundSnapshot,
  GrowthWorkOrder,
  GrowthWorkOrderAttempt,
  WorkOrderAttemptStart,
} from "../../../domain/growth/editorial/growthEditorialTypes";
import { ensureGrowthEditorialDiagnostic } from "../../diagnostics/growthEditorialDiagnostics";

export interface GrowthWorkOrderRunnerDependencies {
  prepareAttempt(input: {
    order: GrowthWorkOrder;
    snapshot: GrowthEditorialRoundSnapshot;
  }): Promise<WorkOrderAttemptStart> | WorkOrderAttemptStart;
  generateCandidate(input: {
    order: GrowthWorkOrder;
    attempt: GrowthWorkOrderAttempt;
    signal: AbortSignal;
  }): Promise<CandidateRecord>;
  reviewCandidate(input: {
    order: GrowthWorkOrder;
    attempt: GrowthWorkOrderAttempt;
    snapshot: GrowthEditorialRoundSnapshot;
    signal: AbortSignal;
  }): Promise<{ checker: EditorialReviewRecord; director: EditorialReviewRecord }>;
  rebaseAndRecheck(input: {
    order: GrowthWorkOrder;
    attempt: GrowthWorkOrderAttempt;
    snapshot: GrowthEditorialRoundSnapshot;
    signal: AbortSignal;
  }): Promise<{ status: "ready" } | { status: "rejected"; failureCode: string }>;
  commitCandidate(input: {
    order: GrowthWorkOrder;
    attempt: GrowthWorkOrderAttempt;
    snapshot: GrowthEditorialRoundSnapshot;
    signal: AbortSignal;
  }): Promise<void>;
}

export class GrowthWorkOrderRunner {
  constructor(
    readonly repository: GrowthEditorialRepository,
    readonly dependencies: GrowthWorkOrderRunnerDependencies,
  ) {}

  async runCandidate(workOrderId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return this.#cancelPreCommit(workOrderId);
    let snapshot = this.#requiredSnapshotForOrder(workOrderId);
    let order = this.#requiredOrder(snapshot, workOrderId);
    if (!["ready", "revision_requested", "running", "candidate_ready", "reviewing"].includes(order.status)) return;

    let attempt = this.#latestAttempt(snapshot, workOrderId);
    try {
      if (["ready", "revision_requested"].includes(order.status)) {
        const prepared = await this.dependencies.prepareAttempt({ order, snapshot });
        if (signal.aborted) return this.#cancelPreCommit(workOrderId);
        attempt = this.repository.startAttempt(prepared);
        snapshot = this.#requiredSnapshot(order.roundId);
        order = this.#requiredOrder(snapshot, workOrderId);
      }
      if (!attempt) throw runnerError("GROWTH_EDITORIAL_ATTEMPT_REQUIRED");
      if (attempt.status === "running") {
        const candidate = await this.dependencies.generateCandidate({ order, attempt, signal });
        attempt = this.repository.recordCandidate(candidate);
        if (signal.aborted) return this.#cancelPreCommit(workOrderId);
      }
      if (attempt.status === "candidate_ready") attempt = this.repository.beginReview(attempt.id);
      if (attempt.status === "reviewing") {
        snapshot = this.#requiredSnapshot(order.roundId);
        const reviews = await this.dependencies.reviewCandidate({ order, attempt, snapshot, signal });
        this.repository.recordReview(reviews.checker);
        this.repository.recordReview(reviews.director);
        if (signal.aborted) return this.#cancelPreCommit(workOrderId);
      }
    } catch (error) {
      if (signal.aborted || readCode(error) === "AGENT_RUN_CANCELLED") {
        this.#cancelPreCommit(workOrderId);
        return;
      }
      this.#failPreCommit(workOrderId, readCode(error, "GROWTH_EDITORIAL_CANDIDATE_FAILED"));
    }
  }

  async commit(workOrderId: string, signal: AbortSignal): Promise<void> {
    let snapshot = this.#requiredSnapshotForOrder(workOrderId);
    let order = this.#requiredOrder(snapshot, workOrderId);
    if (order.status === "committed" || order.status === "reconciliation_required") return;
    let attempt = this.#latestAttempt(snapshot, workOrderId);
    if (!attempt || attempt.status !== "accepted") return;

    if (order.status === "accepted") {
      let recheck: Awaited<ReturnType<GrowthWorkOrderRunnerDependencies["rebaseAndRecheck"]>>;
      try {
        recheck = await this.dependencies.rebaseAndRecheck({ order, attempt, snapshot, signal });
      } catch (error) {
        if (signal.aborted || readCode(error) === "AGENT_RUN_CANCELLED") this.#cancelPreCommit(workOrderId);
        else this.#failPreCommit(workOrderId, readCode(error, "GROWTH_EDITORIAL_RECHECK_FAILED"));
        return;
      }
      if (signal.aborted) {
        this.#cancelPreCommit(workOrderId);
        return;
      }
      if (recheck.status === "rejected") {
        this.#failPreCommit(workOrderId, normalizeFailureCode(recheck.failureCode, "GROWTH_EDITORIAL_REBASE_REJECTED"));
        return;
      }
      order = this.repository.queueCommit(workOrderId);
      snapshot = this.#requiredSnapshot(order.roundId);
      attempt = this.#latestAttempt(snapshot, workOrderId);
      if (!attempt) throw runnerError("GROWTH_EDITORIAL_ATTEMPT_REQUIRED");
    }
    if (order.status !== "commit_queued") return;
    if (attempt.sideEffectState === "commit_requested") {
      this.repository.markReconciliationRequired({
        workOrderId,
        attemptId: attempt.id,
        failureCode: "GROWTH_EDITORIAL_COMMIT_OUTCOME_UNKNOWN",
      });
      this.#recordDiagnostic(workOrderId, "GROWTH_EDITORIAL_COMMIT_OUTCOME_UNKNOWN");
      return;
    }
    if (attempt.sideEffectState !== "none") return;
    if (signal.aborted) return;

    attempt = this.repository.markCommitRequested(workOrderId);
    try {
      await this.dependencies.commitCandidate({ order, attempt, snapshot, signal });
      this.repository.markCommitted(workOrderId);
    } catch {
      this.repository.markReconciliationRequired({
        workOrderId,
        attemptId: attempt.id,
        failureCode: "GROWTH_EDITORIAL_COMMIT_OUTCOME_UNKNOWN",
      });
      this.#recordDiagnostic(workOrderId, "GROWTH_EDITORIAL_COMMIT_OUTCOME_UNKNOWN");
    }
  }

  #cancelPreCommit(workOrderId: string): void {
    const order = this.repository.getWorkOrder(workOrderId);
    if (!order || ["commit_queued", "committed", "cancelled", "failed", "reconciliation_required"].includes(order.status)) return;
    this.repository.terminalizeWorkOrder({
      workOrderId,
      status: "cancelled",
      failureCode: "GROWTH_EDITORIAL_CANCELLED",
    });
  }

  #failPreCommit(workOrderId: string, failureCode: string): void {
    const order = this.repository.getWorkOrder(workOrderId);
    if (!order || ["commit_queued", "committed", "cancelled", "failed", "reconciliation_required"].includes(order.status)) return;
    const safeFailureCode = normalizeFailureCode(failureCode, "GROWTH_EDITORIAL_CANDIDATE_FAILED");
    this.repository.terminalizeWorkOrder({
      workOrderId,
      status: "failed",
      failureCode: safeFailureCode,
    });
    this.#recordDiagnostic(workOrderId, safeFailureCode);
  }

  #recordDiagnostic(workOrderId: string, sourceCode: unknown): void {
    const order = this.repository.getWorkOrder(workOrderId);
    if (!order) return;
    try {
      ensureGrowthEditorialDiagnostic({
        workspace: this.repository.workspace,
        workOrderId,
        sourceCode,
      });
    } catch {
      // Durable Work Order truth must not be replaced by diagnostic persistence failure.
    }
  }

  #requiredSnapshotForOrder(workOrderId: string): GrowthEditorialRoundSnapshot {
    const order = this.repository.getWorkOrder(workOrderId);
    if (!order) throw runnerError("GROWTH_EDITORIAL_WORK_ORDER_NOT_FOUND");
    return this.#requiredSnapshot(order.roundId);
  }

  #requiredSnapshot(roundId: string): GrowthEditorialRoundSnapshot {
    const snapshot = this.repository.getRoundSnapshot(roundId);
    if (!snapshot) throw runnerError("GROWTH_EDITORIAL_ROUND_NOT_FOUND");
    return snapshot;
  }

  #requiredOrder(snapshot: GrowthEditorialRoundSnapshot, workOrderId: string): GrowthWorkOrder {
    const order = snapshot.workOrders.find((candidate) => candidate.id === workOrderId);
    if (!order) throw runnerError("GROWTH_EDITORIAL_WORK_ORDER_NOT_FOUND");
    return order;
  }

  #latestAttempt(snapshot: GrowthEditorialRoundSnapshot, workOrderId: string): GrowthWorkOrderAttempt | null {
    return snapshot.attempts.filter((attempt) => attempt.workOrderId === workOrderId).at(-1) ?? null;
  }
}

function readCode(error: unknown, fallback = "GROWTH_EDITORIAL_CANDIDATE_FAILED"): string {
  const value = error && typeof error === "object" && "code" in error ? String(error.code) : fallback;
  return normalizeFailureCode(value, fallback);
}

function normalizeFailureCode(value: string, fallback: string): string {
  return /^[A-Z][A-Z0-9_]{2,119}$/.test(value) ? value : fallback;
}

function runnerError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
