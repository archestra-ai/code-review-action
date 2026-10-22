import type { z } from "zod";
import {
  type AgentRun,
  ArchestraApiError,
  type ArchestraClient,
  isTerminalState,
  type StartedRun,
} from "./archestra/client";
import type { AttemptOutcome, AttemptRecord } from "./attempts";
import { type Classification, classifyApiError, classifyRun } from "./classify";
import { type Attachment, errorMessage, type Logger } from "./util";

export interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface AttemptValue<T> {
  result: T;
  taskId: string;
  sessionId: string | null;
}

export type ContractResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export const POLL_MIN_MS = 5_000;
export const POLL_MAX_MS = 30_000;

/**
 * Runs one attempt: start (or continue) a run, poll its state until it is
 * terminal or the time limit is reached, then read the result file.
 * Polls the state only, never the terminal output.
 */
export async function executeAttempt<T>(p: {
  client: ArchestraClient;
  agentId: string;
  start: () => Promise<StartedRun>;
  readResult: (taskId: string) => Promise<ContractResult<T>>;
  timeoutMs: number;
  deadline: number;
  clock: Clock;
  log: Logger;
  onLive: (taskId: string | null) => void;
}): Promise<AttemptOutcome<AttemptValue<T>>> {
  const { client, clock, log } = p;
  const startedAt = clock.now();
  let taskId: string | null = null;
  const record = (
    result: AttemptRecord["result"],
    reason: string,
    source: AttemptRecord["source"],
  ): AttemptRecord => ({
    agentId: p.agentId,
    taskId,
    runUrl: taskId ? client.runUrl(taskId) : null,
    result,
    reason,
    source,
    durationMs: clock.now() - startedAt,
  });
  const fail = (
    classification: Classification,
  ): AttemptOutcome<AttemptValue<T>> => ({
    ok: false,
    classification,
    record: record(classification.class, classification.reason, classification.source),
  });

  let started: StartedRun;
  try {
    started = await p.start();
  } catch (error) {
    if (error instanceof ArchestraApiError) return fail(classifyApiError(error));
    throw error;
  }
  taskId = started.taskId;
  const liveTaskId = taskId;
  p.onLive(liveTaskId);
  log.info(`Run started on agent ${p.agentId}: ${client.runUrl(liveTaskId)}`);

  const stopAt = Math.min(startedAt + p.timeoutMs, p.deadline);
  let interval = POLL_MIN_MS;
  let lastState = started.state ?? "";
  let run: AgentRun | null = null;
  for (;;) {
    const remaining = stopAt - clock.now();
    if (remaining <= 0) {
      await cancelQuietly(client, liveTaskId, log);
      p.onLive(null);
      return fail({
        class: "non_retriable",
        reason: `no terminal state within ${Math.round(p.timeoutMs / 60_000)} min`,
        source: "timeout",
      });
    }
    await clock.sleep(Math.min(interval, remaining));
    interval = Math.min(POLL_MAX_MS, Math.round(interval * 1.5));
    try {
      run = await client.getRun(liveTaskId);
    } catch (error) {
      if (!(error instanceof ArchestraApiError)) throw error;
      const classification = classifyApiError(error);
      if (classification.class === "retriable") {
        log.debug(`Polling failed, will poll again: ${error.message}`);
        continue;
      }
      if (classification.class === "non_retriable") {
        await cancelQuietly(client, liveTaskId, log);
      }
      p.onLive(null);
      return fail(classification);
    }
    if (run.state !== lastState) {
      log.info(`Run ${liveTaskId}: ${run.state.replace("TASK_STATE_", "")}`);
      lastState = run.state;
    }
    if (isTerminalState(run.state)) break;
  }

  if (run.state !== "TASK_STATE_COMPLETED") {
    // INPUT_REQUIRED and AUTH_REQUIRED runs wait; release them.
    if (
      run.state === "TASK_STATE_INPUT_REQUIRED" ||
      run.state === "TASK_STATE_AUTH_REQUIRED"
    ) {
      await cancelQuietly(client, liveTaskId, log);
    }
    p.onLive(null);
    const classification = classifyRun(run);
    if (classification.source === "message-pattern") {
      log.info(
        "This deployment gives no structured failure; the failure was classified from its message.",
      );
    }
    return fail(classification);
  }
  p.onLive(null);

  // Read the result file. Retry transient read failures a few times.
  for (let readAttempt = 1; ; readAttempt++) {
    try {
      const result = await p.readResult(liveTaskId);
      if (!result.ok) {
        return fail({ class: "non_retriable", reason: result.reason, source: "contract" });
      }
      return {
        ok: true,
        value: {
          result: result.value,
          taskId: liveTaskId,
          sessionId: started.sessionId ?? run.sessionId ?? null,
        },
        record: record("completed", "completed", null),
      };
    } catch (error) {
      if (!(error instanceof ArchestraApiError)) throw error;
      const classification = classifyApiError(error);
      if (classification.class !== "retriable" || readAttempt >= 3) {
        return fail({
          ...classification,
          class: classification.class === "fatal" ? "fatal" : "non_retriable",
        });
      }
      await clock.sleep(POLL_MIN_MS);
    }
  }
}

/** Reads a JSON result file from the workspace and validates it. */
export async function readContract<T>(
  client: ArchestraClient,
  taskId: string,
  path: string,
  schema: z.ZodType<T>,
): Promise<ContractResult<T>> {
  const data = await client.readWorkspaceFile(taskId, path);
  if (!data) return { ok: false, reason: `${path} is missing after the run completed` };
  let json: unknown;
  try {
    json = JSON.parse(data.toString("utf8"));
  } catch {
    return { ok: false, reason: `${path} is not valid JSON` };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, reason: `${path} does not match the schema: ${issues}` };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Continues the retained workspace of `previousTaskId`. When the workspace
 * is busy, waits until it is free (bounded by `deadline`). When it is no
 * longer retained, returns null: the caller starts a fresh run.
 *
 * The platform answers both cases with the same 409 message, so the action
 * reads the previous run to tell them apart.
 */
export async function continueOrNull(p: {
  client: ArchestraClient;
  previousTaskId: string;
  body: { message: string; attachments: Attachment[] };
  deadline: number;
  clock: Clock;
  log: Logger;
  busyWaitMs?: number;
}): Promise<StartedRun | null> {
  const wait = p.busyWaitMs ?? 30_000;
  for (;;) {
    try {
      return await p.client.continueRun(p.previousTaskId, p.body);
    } catch (error) {
      if (!(error instanceof ArchestraApiError)) throw error;
      if (error.status === 404) {
        p.log.info("The previous run is not visible to this key. Starting a fresh run.");
        return null;
      }
      if (error.status !== 409) throw error;
    }
    let previous: AgentRun;
    try {
      previous = await p.client.getRun(p.previousTaskId);
    } catch (error) {
      if (error instanceof ArchestraApiError && error.status === 404) return null;
      throw error;
    }
    if (!isWorkspaceBusy(previous, p.clock.now())) {
      p.log.info(
        "The previous workspace is no longer retained. Starting a fresh run on the same agent.",
      );
      return null;
    }
    if (p.clock.now() + wait >= p.deadline) {
      throw new ArchestraApiError(
        "continue run",
        409,
        "the workspace stayed busy until the deadline",
      );
    }
    p.log.info(`The workspace is busy. Waiting ${Math.round(wait / 1000)} s.`);
    await p.clock.sleep(wait);
  }
}

export function isWorkspaceBusy(run: AgentRun, now: number): boolean {
  const workspace = run.workspace;
  if (!workspace) return false;
  if (workspace.expiresAt && Date.parse(workspace.expiresAt) <= now) return false;
  if (["deleting", "deleted"].includes(workspace.state)) return false;
  if (!isTerminalState(run.state)) return true;
  return ["active", "resuming", "suspending"].includes(workspace.state);
}

export async function cancelQuietly(
  client: ArchestraClient,
  taskId: string,
  log: Logger,
): Promise<void> {
  try {
    await client.cancelRun(taskId);
    log.info(`Canceled run ${taskId}.`);
  } catch (error) {
    log.warning(`Could not cancel run ${taskId}: ${errorMessage(error)}`);
  }
}
