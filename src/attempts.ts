import type { RunLimits } from "./archestra/client";
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

/** Progress callbacks; each may update a comment and must not throw. */
export interface ProgressReporter {
  attempt: (runtimeIndex: number, agentId: string) => Promise<void>;
  running: (runUrl: string) => Promise<void>;
  retry: (delayMs: number) => Promise<void>;
  /** Called before the same runtime is tried again with more memory after a memory kill. Optional. */
  largerSize?: (limits: RunLimits) => Promise<void>;
  next: () => Promise<void>;
  /** Called after each poll of a live run; may read the run's progress file. Optional. */
  poll?: (runId: string) => Promise<void>;
}

/** How many times one runtime is tried again with more memory after memory kills. */
export const MAX_MEMORY_ESCALATIONS = 2;

/**
 * Tries the runtimes in order. A retriable failure retries the same runtime
 * (`retries` times, after 30 s then 60 s). A non-retriable failure, or a
 * retriable one with no retries left, goes to the next runtime. A fatal
 * failure stops all attempts. At most 1 + maxFallbacks runtimes are used, so
 * the total is at most N x (1 + retries), plus the larger-size attempts below.
 *
 * A run killed for memory asked for a container too small for its work, and
 * the next runtime, sized the same, would die the same way. When `largerLimits`
 * is given, the same runtime is tried again at once with the limits it returns
 * (more memory than the killed run had), at most MAX_MEMORY_ESCALATIONS times
 * and only while the gateway puts each retry on a different tier than the one
 * it killed; that does not count as a retry.
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
  progress?: ProgressReporter;
  /** The limits every first attempt asks for; null for the Agent's own. */
  limits?: RunLimits | null;
  /** The limits to ask for after a memory kill, from the killed attempt's limits and reason. */
  largerLimits?: (previous: RunLimits | null, reason: string) => RunLimits | null;
  attempt: (
    agentId: string,
    info: {
      runtimeIndex: number;
      retry: number;
      /** The limits this attempt asks for; the caller's own until a memory kill raised them. */
      limits: RunLimits | null;
      /** How many memory kills raised the limits before this attempt on this runtime. */
      escalations: number;
    },
  ) => Promise<AttemptOutcome<T>>;
}): Promise<FallbackResult<T>> {
  const delays = params.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const attempts: AttemptRecord[] = [];
  const runtimeCount = Math.min(params.agents.length, 1 + Math.max(0, params.maxFallbacks));
  for (let runtimeIndex = 0; runtimeIndex < runtimeCount; runtimeIndex++) {
    const agentId = params.agents[runtimeIndex] as string;
    let limits = params.limits ?? null;
    let escalations = 0;
    let killedTier: string | null = null;
    let retry = 0;
    while (retry <= params.retries) {
      if (params.now() >= params.deadline) {
        params.log.warning("Overall deadline reached. No more attempts.");
        return { ok: false, attempts, fatal: false, deadlineReached: true };
      }
      params.log.info(
        `Attempt ${attempts.length + 1}: agent ${agentId} (runtime ${runtimeIndex + 1}/${runtimeCount}, retry ${retry}/${params.retries}${escalations > 0 ? `, with at least ${limits?.minMemoryGib} GiB of memory` : ""})`,
      );
      await params.progress?.attempt(runtimeIndex, agentId);
      const outcome = await params.attempt(agentId, { runtimeIndex, retry, limits, escalations });
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
      // The gateway sized the retry no larger than the killed run: nothing left to ask for.
      const sameTier = killedTier !== null && outcome.record.tier !== null && outcome.record.tier === killedTier;
      const larger =
        classification.outOfMemory && params.largerLimits && escalations < MAX_MEMORY_ESCALATIONS && !sameTier
          ? params.largerLimits(limits, classification.reason)
          : null;
      if (larger) {
        escalations++;
        killedTier = outcome.record.tier;
        limits = larger;
        params.log.info(
          `The run ran out of memory${outcome.record.tier ? ` on tier ${outcome.record.tier}` : ""}. Trying the same runtime with at least ${larger.minMemoryGib} GiB of memory.`,
        );
        await params.progress?.largerSize?.(larger);
        continue;
      }
      if (classification.class === "non_retriable") {
        if (runtimeIndex + 1 < runtimeCount) await params.progress?.next();
        break;
      }
      if (retry < params.retries) {
        const delay = delays[Math.min(retry, delays.length - 1)] ?? DEFAULT_RETRY_DELAYS_MS[0];
        params.log.info(`Retrying the same runtime in ${Math.round((delay ?? 0) / 1000)} s.`);
        await params.progress?.retry(delay ?? 0);
        await params.sleep(delay ?? 0);
      } else if (runtimeIndex + 1 < runtimeCount) {
        await params.progress?.next();
      }
      retry += 1;
    }
  }
  return { ok: false, attempts, fatal: false, deadlineReached: false };
}
