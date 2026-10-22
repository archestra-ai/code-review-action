import type { Classification, ClassificationSource, FailureClass } from "./classify";
import type { Logger } from "./util";

export type Strategy = "rotate" | "ordered" | "random";

/**
 * Puts the agents in the order the action tries them.
 * - rotate: start at (PR number + run attempt) mod N, then continue in order.
 *   The same PR goes to the same runtime on each new workflow run.
 * - ordered: the configured order.
 * - random: a random permutation.
 */
export function orderAgents(
  agents: readonly string[],
  strategy: Strategy,
  options: { prNumber: number; runAttempt: number; random: () => number },
): string[] {
  const n = agents.length;
  if (n === 0) return [];
  if (strategy === "ordered") return [...agents];
  if (strategy === "random") {
    const result = [...agents];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(options.random() * (i + 1));
      [result[i], result[j]] = [result[j] as string, result[i] as string];
    }
    return result;
  }
  const start = (((options.prNumber + options.runAttempt) % n) + n) % n;
  return [...agents.slice(start), ...agents.slice(0, start)];
}

export interface AttemptRecord {
  agentId: string;
  taskId: string | null;
  runUrl: string | null;
  result: "completed" | FailureClass;
  reason: string;
  source: ClassificationSource | null;
  durationMs: number;
}

export type AttemptOutcome<T> =
  | { ok: true; value: T; record: AttemptRecord }
  | { ok: false; classification: Classification; record: AttemptRecord };

export interface FallbackResult<T> {
  ok: boolean;
  value?: T;
  agentId?: string;
  attempts: AttemptRecord[];
  /** True when a fatal failure stopped all attempts. */
  fatal: boolean;
  /** True when the overall deadline stopped the attempts. */
  deadlineReached: boolean;
}

export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [30_000, 60_000];

/**
 * Tries the runtimes in order. A retriable failure retries the same runtime
 * (`retries` times, after 30 s then 60 s). A non-retriable failure, or a
 * retriable one with no retries left, goes to the next runtime. A fatal
 * failure stops all attempts. At most 1 + maxFallbacks runtimes are used, so
 * the total is at most N x (1 + retries).
 */
export async function runWithFallback<T>(params: {
  agents: readonly string[];
  retries: number;
  maxFallbacks: number;
  deadline: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: Logger;
  retryDelaysMs?: readonly number[];
  attempt: (agentId: string, info: { runtimeIndex: number; retry: number }) => Promise<AttemptOutcome<T>>;
}): Promise<FallbackResult<T>> {
  const delays = params.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const attempts: AttemptRecord[] = [];
  const runtimeCount = Math.min(params.agents.length, 1 + Math.max(0, params.maxFallbacks));
  for (let runtimeIndex = 0; runtimeIndex < runtimeCount; runtimeIndex++) {
    const agentId = params.agents[runtimeIndex] as string;
    for (let retry = 0; retry <= params.retries; retry++) {
      if (params.now() >= params.deadline) {
        params.log.warning("Overall deadline reached. No more attempts.");
        return { ok: false, attempts, fatal: false, deadlineReached: true };
      }
      params.log.info(
        `Attempt ${attempts.length + 1}: agent ${agentId} (runtime ${runtimeIndex + 1}/${runtimeCount}, retry ${retry}/${params.retries})`,
      );
      const outcome = await params.attempt(agentId, { runtimeIndex, retry });
      attempts.push(outcome.record);
      if (outcome.ok) {
        return {
          ok: true,
          value: outcome.value,
          agentId,
          attempts,
          fatal: false,
          deadlineReached: false,
        };
      }
      const { classification } = outcome;
      params.log.warning(
        `Attempt failed (${classification.class}, from ${classification.source}): ${classification.reason}`,
      );
      if (classification.class === "fatal") {
        return { ok: false, attempts, fatal: true, deadlineReached: false };
      }
      if (classification.class === "non_retriable") break;
      if (retry < params.retries) {
        const delay = delays[Math.min(retry, delays.length - 1)] ?? DEFAULT_RETRY_DELAYS_MS[0];
        params.log.info(`Retrying the same runtime in ${Math.round((delay ?? 0) / 1000)} s.`);
        await params.sleep(delay ?? 0);
      }
    }
  }
  return { ok: false, attempts, fatal: false, deadlineReached: false };
}
