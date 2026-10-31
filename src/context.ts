import type { z } from "zod";
import type { ArchestraClient, RunLimits } from "./archestra/client";
import type { AccessRefusal } from "./archestra/github-actions-auth";
import { type AttemptRecord, type FallbackResult, type ProgressReporter, runWithFallback } from "./attempts";
import type { Octokit } from "./github/octokit";
import type { Inputs } from "./inputs";
import { type AttemptValue, type Clock, continueRun, executeAttempt, readContract } from "./run-attempt";
import { largerLimits } from "./sizes";
import type { SavedJob } from "./stopped";
import type { Attachment, Logger, RepoRef } from "./util";

export interface ActionContext {
  inputs: Inputs;
  repo: RepoRef;
  eventName: string;
  payload: unknown;
  runAttempt: number;
  serverUrl: string;
  workflowRunUrl: string;
  /** The animated Archestra mark of the progress header. */
  progressImageUrl: string;
  /** The job token: posts comments and reviews. */
  gh: Octokit;
  /** The GitHub App token (fix-token): resolves threads, re-runs jobs, opens fix PRs. */
  ghFix: Octokit | null;
  archestra: ArchestraClient;
  log: Logger;
  clock: Clock;
  random: () => number;
  /** Records the live run, so that a canceled job can cancel it. */
  saveLiveRun: (runId: string | null) => void;
  /** Records the job in progress, so that a canceled job can still record itself in the review comment. */
  saveJob: (job: SavedJob) => void;
  /** True once the runner canceled the job: no new run starts, and nothing more is written. */
  isStopping: () => boolean;
  /**
   * Signs in with the job's GitHub Actions identity ("archestra-auth: github-actions"): a context
   * with the pull request author's Archestra token and the review App's GitHub token, or why
   * Archestra refused.
   */
  signIn: () => Promise<{ ok: true; ctx: ActionContext } | { ok: false; refusal: AccessRefusalInfo }>;
  /** True when `gh` is a GitHub App's token from the sign-in, not the workflow's token. */
  appIdentity: boolean;
  /** The review comment found earlier in this job, so later updates read it with one request. */
  cache: { stickyId: number | null };
  startedAt: number;
}

export interface AccessRefusalInfo {
  reason: AccessRefusal;
  /** Archestra's explanation, written for the pull request author. */
  message: string;
  login: string | null;
}

export type ActionStatus =
  | "success"
  | "skipped"
  | "nothing-to-do"
  | "unauthorized"
  | "unavailable"
  | "aborted"
  | "error";

export interface ActionResult {
  status: ActionStatus;
  mode: string;
  agentId: string | null;
  runId: string | null;
  runUrl: string | null;
  findingsCount: number | null;
  attempts: AttemptRecord[];
  pushedCommits: string[];
  applied: Array<{ finding: string; commit: string }>;
  skipped: Array<{ finding: string; reason: string }>;
  triage: unknown;
  /** A message for core.setFailed, or null. */
  failure: string | null;
  /** Markdown for the job summary. */
  summary: string;
}

export function makeResult(mode: string, partial: Partial<ActionResult> & { status: ActionStatus }): ActionResult {
  return {
    mode,
    agentId: null,
    runId: null,
    runUrl: null,
    findingsCount: null,
    attempts: [],
    pushedCommits: [],
    applied: [],
    skipped: [],
    triage: null,
    failure: null,
    summary: "",
    ...partial,
  };
}

export function overallDeadline(ctx: ActionContext): number {
  return ctx.startedAt + ctx.inputs.overallTimeoutMs;
}

export function cloneUrl(ctx: ActionContext): string {
  return `${ctx.serverUrl}/${ctx.repo.owner}/${ctx.repo.repo}.git`;
}

export function repoUrl(ctx: ActionContext): string {
  return `${ctx.serverUrl}/${ctx.repo.owner}/${ctx.repo.repo}`;
}

/** The PR title for a brief: one line, bounded. */
export function briefTitle(title: string): string {
  const line = title.replace(/\s+/g, " ").replace(/"/g, "'").trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/**
 * Starts the work on the runtimes with the retry and fallback policy. When
 * `continueFrom` names one of the agents, the first attempt on that agent
 * continues the retained workspace; a workspace that this token cannot
 * continue gives a fresh run on the same agent. When `credentialToken` is
 * set, it is stored as the actor's CODE_REVIEW_GITHUB_TOKEN credential on the agent
 * before each attempt; it reaches the next turn.
 */
export async function launch<T>(
  ctx: ActionContext,
  p: {
    agents: string[];
    continueFrom: { agentId: string; runId: string } | null;
    message: string;
    attachments: Attachment[];
    contract: { file: string; schema: z.ZodType<T> };
    timeoutMs: number;
    credentialToken: string | null;
    /** Limits for a fresh run; a continuation keeps the limits of its first turn. */
    limits?: RunLimits;
    /** Updates the progress comment at each step; optional. */
    progress?: ProgressReporter;
  },
): Promise<FallbackResult<AttemptValue<T>>> {
  const deadline = overallDeadline(ctx);
  let continueFrom = p.continueFrom;
  return runWithFallback<AttemptValue<T>>({
    agents: p.agents,
    retries: ctx.inputs.retries,
    maxFallbacks: ctx.inputs.maxFallbacks,
    deadline,
    now: ctx.clock.now,
    sleep: ctx.clock.sleep,
    log: ctx.log,
    progress: p.progress,
    limits: p.limits ?? null,
    largerLimits,
    attempt: (agentId, info) =>
      executeAttempt<T>({
        client: ctx.archestra,
        agentId,
        timeoutMs: p.timeoutMs,
        deadline,
        clock: ctx.clock,
        log: ctx.log,
        onLive: (runId) => {
          ctx.saveLiveRun(runId);
          if (runId && p.progress) void p.progress.running(ctx.archestra.runUrl(runId));
        },
        readResult: (runId) => readContract(ctx.archestra, runId, p.contract.file, p.contract.schema),
        onPoll: p.progress?.poll,
        start: async () => {
          if (ctx.isStopping()) throw new Error("The job was canceled; no new run starts.");
          if (p.credentialToken) {
            await ctx.archestra.transferCredential(
              agentId,
              "CODE_REVIEW_GITHUB_TOKEN",
              p.credentialToken,
              "GitHub token of the code review action",
            );
          }
          if (continueFrom && continueFrom.agentId === agentId) {
            const continued = await continueRun({
              client: ctx.archestra,
              runId: continueFrom.runId,
              message: p.message,
              files: p.attachments,
              resultFile: p.contract.file,
              turnKey: `turn-${ctx.clock.now().toString(36)}`,
              deadline,
              clock: ctx.clock,
              log: ctx.log,
            });
            if (continued) return continued;
            continueFrom = null;
          }
          // After a memory kill the same runtime is tried with more memory. That
          // size is the point of the attempt, so an Agent that refuses it ends it.
          const escalated = info.limits !== null && info.limits !== (p.limits ?? null);
          return ctx.archestra.startRun(agentId, {
            message: p.message,
            attachments: p.attachments,
            ...(info.limits ? { limits: info.limits } : {}),
            ...(escalated ? { requireLimits: true } : {}),
          });
        },
      }),
  });
}

/** Puts `first` at the front of the agent order, when it is configured. */
export function preferAgent(order: string[], first: string | null): string[] {
  if (!first || !order.includes(first)) return order;
  return [first, ...order.filter((agent) => agent !== first)];
}
