import type { z } from "zod";
import type { ArchestraClient } from "./archestra/client";
import type { AccessRefusal } from "./archestra/github-actions-auth";
import type { AttemptRecord, LaunchResult, ProgressReporter } from "./attempts";
import type { Octokit } from "./github/octokit";
import type { Inputs } from "./inputs";
import { type AttemptValue, type Clock, continueRun, executeAttempt, readContract } from "./run-attempt";
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
 * Starts the work on the Archestra MCP gateway. Subagent selection, load
 * balancing, retries, OOM tier escalation, and subagent failover are governed
 * by the gateway and agent runtime configurations on the platform. When
 * `continueFrom` names an earlier run, continues its retained workspace if
 * available; otherwise starts a fresh run. When `credentialToken` is set,
 * transfers a one-time ephemeral credential grant (or persistent credential on
 * a continuation) for `CODE_REVIEW_GITHUB_TOKEN`.
 */
export async function launch<T>(
  ctx: ActionContext,
  p: {
    continueFrom: { agentId: string; runId: string } | null;
    preferredAgentId?: string | null;
    message: string;
    attachments: Attachment[];
    contract: { file: string; schema: z.ZodType<T> };
    credentialToken: string | null;
    /** Updates the progress comment at each step; optional. */
    progress?: ProgressReporter;
  },
): Promise<LaunchResult<AttemptValue<T>>> {
  const preferredAgentId = p.continueFrom?.agentId ?? p.preferredAgentId ?? null;
  const initialAgentId = p.continueFrom?.agentId ?? null;
  ctx.log.info(`Starting run on agent ${initialAgentId ?? "gateway"}`);
  await p.progress?.attempt(initialAgentId);

  const outcome = await executeAttempt<T>({
    client: ctx.archestra,
    agentId: initialAgentId,
    clock: ctx.clock,
    log: ctx.log,
    isStopping: ctx.isStopping,
    onLive: (runId) => {
      ctx.saveLiveRun(runId);
      if (runId && p.progress) void p.progress.running(ctx.archestra.runUrl(runId));
    },
    readResult: (runId) => readContract(ctx.archestra, runId, p.contract.file, p.contract.schema),
    onPoll: p.progress?.poll,
    start: async (setAgentId) => {
      if (ctx.isStopping()) throw new Error("The job was canceled; no new run starts.");
      if (p.continueFrom) {
        const continuationAgentId = p.continueFrom.agentId;
        setAgentId(continuationAgentId);
        const continued = await continueRun({
          client: ctx.archestra,
          runId: p.continueFrom.runId,
          message: p.message,
          files: p.attachments,
          resultFile: p.contract.file,
          turnKey: `turn-${ctx.clock.now().toString(36)}`,
          clock: ctx.clock,
          log: ctx.log,
          beforeSteer: p.credentialToken
            ? async () => {
                await ctx.archestra.transferCredential(
                  continuationAgentId,
                  "CODE_REVIEW_GITHUB_TOKEN",
                  p.credentialToken as string,
                  "GitHub token of the code review action",
                );
              }
            : undefined,
        });
        if (continued) return continued;
      }
      let freshAgentId: string | null = null;
      setAgentId(null);
      const credentialGrantIds: string[] = [];
      if (p.credentialToken) {
        const grantId = await ctx.archestra.transferCredential(
          freshAgentId,
          "CODE_REVIEW_GITHUB_TOKEN",
          p.credentialToken,
          "GitHub token of the code review action",
          {
            ephemeral: true,
            preferredAgentId,
            onAgentSelected: (selectedId) => {
              freshAgentId = selectedId;
              setAgentId(selectedId);
            },
          },
        );
        if (grantId) credentialGrantIds.push(grantId);
      }
      return ctx.archestra.startRun(freshAgentId, {
        message: p.message,
        attachments: p.attachments,
        preferredAgentId,
        onAgentSelected: (selectedId) => {
          freshAgentId = selectedId;
          setAgentId(selectedId);
        },
        ...(credentialGrantIds.length > 0 ? { credentialGrantIds } : {}),
      });
    },
  });

  const attempts = [outcome.record];
  if (outcome.ok) {
    const resolvedAgentId = outcome.record.agentId ?? undefined;
    return {
      ok: true,
      value: outcome.value,
      ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
      attempts,
      fatal: false,
    };
  }
  const { classification } = outcome;
  ctx.log.warning(`Run failed (${classification.class}, from ${classification.source}): ${classification.reason}`);
  return {
    ok: false,
    attempts,
    fatal: classification.class === "fatal",
  };
}
