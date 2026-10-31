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
import { PROGRESS_FILE } from "./contracts";
import { type Attachment, errorMessage, type Logger } from "./util";

export interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface AttemptValue<T> {
  result: T;
  /** Stable across turns; a later fix continues it. */
  runId: string;
}

export type ContractResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export const POLL_MIN_MS = 5_000;
export const POLL_MAX_MS = 30_000;
/** How long a continued run may still show its previous turn. */
export const CONTINUATION_VISIBLE_MS = 180_000;
/** Where the retained workspace is mounted in the runtime container. */
export const WORKSPACE_ROOT = "/home/node/workspace";
/** write_workspace_file takes at most 4 MiB for each file. */
export const MAX_WORKSPACE_FILE_BYTES = 4 * 1024 * 1024;
/**
 * Written over the result file before a continuation, so a turn that does
 * not write the file cannot return the result of the turn before it.
 */
export const PENDING_RESULT = { archestra_pending: true } as const;

/**
 * Runs one attempt: start (or continue) a run, poll its state until it is
 * terminal or the time limit is reached, then read the result file.
 * Polls the state only, never the terminal output.
 */
export async function executeAttempt<T>(p: {
  client: ArchestraClient;
  agentId: string;
  start: () => Promise<StartedRun>;
  readResult: (runId: string) => Promise<ContractResult<T>>;
  timeoutMs: number;
  deadline: number;
  clock: Clock;
  log: Logger;
  onLive: (runId: string | null) => void;
  /** Called after each poll that finds the run still working; its errors are ignored. */
  onPoll?: (runId: string) => Promise<void>;
}): Promise<AttemptOutcome<AttemptValue<T>>> {
  const { client, clock, log } = p;
  const startedAt = clock.now();
  let runId: string | null = null;
  let continued = false;
  let tier: string | null = null;
  const record = (result: AttemptRecord["result"], reason: string, source: AttemptRecord["source"]): AttemptRecord => ({
    agentId: p.agentId,
    runId,
    runUrl: runId ? client.runUrl(runId) : null,
    continued,
    tier,
    result,
    reason,
    source,
    durationMs: clock.now() - startedAt,
  });
  const fail = (classification: Classification): AttemptOutcome<AttemptValue<T>> => ({
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
  runId = started.runId;
  continued = started.continued;
  tier = started.limits?.tier ?? null;
  const liveRunId = runId;
  p.onLive(liveRunId);
  log.info(`Run on agent ${p.agentId}: ${client.runUrl(liveRunId)}`);

  const stopAt = Math.min(startedAt + p.timeoutMs, p.deadline);
  let interval = POLL_MIN_MS;
  let lastState = "";
  let run: AgentRun | null = null;
  for (;;) {
    const remaining = stopAt - clock.now();
    if (remaining <= 0) {
      await cancelQuietly(client, liveRunId, log);
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
      run = await client.getRun(liveRunId);
    } catch (error) {
      if (!(error instanceof ArchestraApiError)) throw error;
      const classification = classifyApiError(error);
      if (classification.class === "retriable") {
        log.debug(`Polling failed, will poll again: ${error.message}`);
        continue;
      }
      if (classification.class === "non_retriable") {
        await cancelQuietly(client, liveRunId, log);
      }
      p.onLive(null);
      return fail(classification);
    }
    if (started.previousTurnCreatedAt && run.turnCreatedAt === started.previousTurnCreatedAt) {
      // The run still shows the turn before the continuation.
      if (clock.now() - startedAt >= CONTINUATION_VISIBLE_MS) {
        p.onLive(null);
        return fail({
          class: "retriable",
          reason: `the continuation did not start within ${CONTINUATION_VISIBLE_MS / 60_000} min`,
          source: "state",
        });
      }
      continue;
    }
    // A continued run reports its tier here, not on the start.
    if (run.tier) tier = run.tier;
    if (run.state !== lastState) {
      log.info(`Run ${liveRunId}: ${run.state}`);
      lastState = run.state;
    }
    if (isTerminalState(run.state)) break;
    if (p.onPoll) {
      try {
        await p.onPoll(liveRunId);
      } catch (error) {
        log.debug(`Progress update failed: ${errorMessage(error)}`);
      }
    }
  }

  if (run.state !== "completed") {
    // input-required and auth-required runs wait for a person; release them.
    if (run.state === "input-required" || run.state === "auth-required") {
      await cancelQuietly(client, liveRunId, log);
    }
    p.onLive(null);
    const classification = classifyRun(run);
    if (classification.source === "message-pattern") {
      log.info("This deployment gives no structured failure; the failure was classified from its message.");
    }
    return fail(classification);
  }
  p.onLive(null);

  // Read the result file. Retry transient read failures a few times.
  for (let readAttempt = 1; ; readAttempt++) {
    try {
      const result = await p.readResult(liveRunId);
      if (!result.ok) {
        return fail({ class: "non_retriable", reason: result.reason, source: "contract" });
      }
      return {
        ok: true,
        value: { result: result.value, runId: liveRunId },
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
  runId: string,
  path: string,
  schema: z.ZodType<T>,
): Promise<ContractResult<T>> {
  const data = await client.readWorkspaceFile(runId, path);
  // The reasons reach the review comment's history: they say what went wrong, not which file.
  if (!data) return { ok: false, reason: "the run finished without writing its result" };
  let json: unknown;
  try {
    json = JSON.parse(data.toString("utf8"));
  } catch {
    return { ok: false, reason: "the result is not valid JSON" };
  }
  if (json && typeof json === "object" && (json as Record<string, unknown>).archestra_pending === true) {
    return { ok: false, reason: "the run did not write a new result in this turn" };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, reason: `the result does not match the contract: ${issues}` };
  }
  return { ok: true, value: parsed.data };
}

/** Workspace-relative names for the input files of a continuation. */
export function continuationFileNames(turnKey: string, files: readonly Attachment[]): string[] {
  return files.map((file) => `${turnKey}-${file.name}`);
}

/**
 * Continues the retained workspace of `runId` in a new turn. A continuation
 * takes no attachments, so the input files are written into the workspace
 * first and the message lists their paths, the way the platform lists
 * attachments. When the workspace is busy, waits until it is free (bounded
 * by `deadline`). Returns null when the run cannot continue for this
 * token: another person's run, or a workspace that is no longer retained.
 * The caller then starts a fresh run.
 */
export async function continueRun(p: {
  client: ArchestraClient;
  runId: string;
  message: string;
  files: readonly Attachment[];
  resultFile: string;
  turnKey: string;
  deadline: number;
  clock: Clock;
  log: Logger;
  busyWaitMs?: number;
}): Promise<StartedRun | null> {
  const wait = p.busyWaitMs ?? 30_000;
  const tooLarge = p.files.find((file) => Buffer.byteLength(file.contentBase64, "base64") > MAX_WORKSPACE_FILE_BYTES);
  if (tooLarge) {
    p.log.info(`${tooLarge.name} is larger than 4 MiB, so it can go only as an attachment. Starting a fresh run.`);
    return null;
  }
  const busy = async (why: string) => {
    if (p.clock.now() + wait >= p.deadline) {
      throw new ArchestraApiError("continue run", "response", "the workspace stayed busy until the deadline");
    }
    p.log.info(`${why} Waiting ${Math.round(wait / 1000)} s.`);
    await p.clock.sleep(wait);
  };
  for (;;) {
    let previous: AgentRun;
    try {
      previous = await p.client.getRun(p.runId);
    } catch (error) {
      if (error instanceof ArchestraApiError && error.kind === "tool" && /run not found/i.test(error.detail)) {
        p.log.info("The previous run is not visible to this token. Starting a fresh run.");
        return null;
      }
      throw error;
    }
    const workspace = previous.workspace;
    if (!workspace) {
      p.log.info("The previous run has no workspace that this token can continue. Starting a fresh run.");
      return null;
    }
    if (!isTerminalState(previous.state)) {
      await busy(`The previous run is still ${previous.state}.`);
      continue;
    }
    if (!workspace.canContinue) {
      if (["active", "resuming", "suspending"].includes(workspace.state)) {
        await busy(`The workspace is ${workspace.state}.`);
        continue;
      }
      p.log.info(
        `The previous workspace cannot continue (${workspace.continuationError ?? workspace.state}). Starting a fresh run.`,
      );
      return null;
    }

    const names = continuationFileNames(p.turnKey, p.files);
    for (const [index, file] of p.files.entries()) {
      await p.client.writeWorkspaceFile(p.runId, names[index] as string, Buffer.from(file.contentBase64, "base64"));
    }
    await p.client.writeWorkspaceFile(p.runId, p.resultFile, Buffer.from(`${JSON.stringify(PENDING_RESULT)}\n`));
    // The plan of the turn before must not show as this turn's progress, also on the same commit.
    await p.client.writeWorkspaceFile(p.runId, PROGRESS_FILE, Buffer.from("{}\n"));
    const message =
      names.length > 0
        ? `${p.message}\n\nAttached files are available for this run:\n${names.map((name) => `- ${WORKSPACE_ROOT}/${name}`).join("\n")}`
        : p.message;

    let status: "continued" | "steered";
    try {
      status = await p.client.steerRun(p.runId, message);
    } catch (error) {
      if (!(error instanceof ArchestraApiError) || error.kind !== "tool") throw error;
      if (/only the person the run acts as/i.test(error.detail)) {
        p.log.info("The previous run belongs to another person. Starting a fresh run.");
        return null;
      }
      if (/unavailable, busy, or expired/i.test(error.detail)) {
        await busy("The workspace did not accept the continuation.");
        continue;
      }
      throw error;
    }
    if (status === "steered") {
      p.log.warning("The run became live before the continuation; the message went to the live turn.");
    }
    return {
      runId: p.runId,
      state: "submitted",
      runUrl: previous.runUrl,
      previousTurnCreatedAt: status === "continued" ? previous.turnCreatedAt : null,
      continued: true,
      limits: null,
    };
  }
}

export async function cancelQuietly(client: ArchestraClient, runId: string, log: Logger): Promise<void> {
  try {
    await client.cancelRun(runId);
    log.info(`Canceled run ${runId}.`);
  } catch (error) {
    log.warning(`Could not cancel run ${runId}: ${errorMessage(error)}`);
  }
}
