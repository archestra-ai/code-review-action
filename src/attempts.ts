import type { Classification, ClassificationSource, FailureClass } from "./classify";

export interface AttemptRecord {
  agentId: string | null;
  runId: string | null;
  runUrl: string | null;
  /** True when the attempt continued the run of an earlier job instead of starting one. */
  continued: boolean;
  /** The name of the tier the run got; null when the gateway did not say or the run never started. */
  tier: string | null;
  result: "completed" | FailureClass;
  reason: string;
  source: ClassificationSource | null;
  durationMs: number;
}

export type AttemptOutcome<T> =
  | { ok: true; value: T; record: AttemptRecord }
  | { ok: false; classification: Classification; record: AttemptRecord };

export interface LaunchResult<T> {
  ok: boolean;
  value?: T;
  agentId?: string;
  attempts: AttemptRecord[];
  /** True when a fatal gateway error stopped the run. */
  fatal: boolean;
}

/** Progress callbacks; each may update a comment and must not throw. */
export interface ProgressReporter {
  attempt: (agentId?: string | null) => Promise<void>;
  running: (runUrl: string) => Promise<void>;
  /** Called after each poll of a live run; may read the run's progress file. Optional. */
  poll?: (runId: string) => Promise<void>;
}
