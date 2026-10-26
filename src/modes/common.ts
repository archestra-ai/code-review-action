import type { AttemptRecord, ProgressReporter } from "../attempts";
import { type ActionContext, type ActionResult, makeResult, repoUrl } from "../context";
import { type AuthorIdentity, userIdentity } from "../github/commits";
import type { Sender, TriggerSource } from "../github/event";
import { hasWriteAccess } from "../github/permissions";
import { isFork, loadPullRequest, type PullRequestInfo } from "../github/pr";
import {
  addJob,
  attemptsTable,
  emptyState,
  findSticky,
  type LastJob,
  renderSticky,
  type StickyComment,
  type StickyMarker,
  type StickyState,
  writeSticky,
} from "../github/sticky";
import type { Inputs } from "../inputs";
import { errorMessage, fullName } from "../util";

export interface FixTrigger {
  kind: "fix" | "fix-ci" | "fix-ci-main";
  prNumber: number;
  sender: Sender;
  source: TriggerSource;
}

export interface FixPreparation {
  pr: PullRequestInfo;
  identity: AuthorIdentity;
  sticky: StickyComment | null;
}

/**
 * The checks before any fix mode: open same-repo PR, sender with write
 * access, a fix token. Returns a result to stop with, or the preparation.
 */
export async function prepareFix(ctx: ActionContext, trigger: FixTrigger): Promise<FixPreparation | ActionResult> {
  const pr = await loadPullRequest(ctx.gh, ctx.repo, trigger.prNumber);
  if (isFork(pr)) {
    return makeResult(trigger.kind, {
      status: "skipped",
      summary: "Fixes are not available for pull requests from forks.",
    });
  }
  if (pr.state !== "open") {
    return makeResult(trigger.kind, { status: "skipped", summary: "The pull request is not open." });
  }
  if (!(await hasWriteAccess(ctx.gh, ctx.repo, trigger.sender.login))) {
    ctx.log.warning(`${trigger.sender.login} has no write access. No fix.`);
    await reply(
      ctx,
      trigger,
      `@${trigger.sender.login} only users with write access to this repository can start a fix.`,
      true,
    );
    return makeResult(trigger.kind, {
      status: "unauthorized",
      summary: `${trigger.sender.login} has no write access.`,
    });
  }
  await acknowledge(ctx, trigger);
  if (!ctx.ghFix || !ctx.inputs.fixToken) {
    const message =
      'The fix cannot push: the workflow does not give the "fix-token" input (a GitHub App installation token).';
    await reply(ctx, trigger, message, true);
    return makeResult(trigger.kind, { status: "error", failure: message, summary: message });
  }
  const identity = await userIdentity(ctx.gh, trigger.sender.login);
  const sticky = await findSticky(ctx.gh, ctx.repo, pr.number);
  return { pr, identity, sticky };
}

export function isResult(value: FixPreparation | ActionResult): value is ActionResult {
  return "status" in value;
}

/**
 * Answers at the place of the trigger: a reply in the review thread, or a
 * PR comment. A dispatch gets no comment (the sticky comment shows the
 * result), unless `important` is set.
 */
export async function reply(
  ctx: ActionContext,
  trigger: { prNumber: number; source: TriggerSource },
  body: string,
  important = false,
): Promise<void> {
  try {
    const { source } = trigger;
    if (source.type === "review-comment") {
      await ctx.gh.rest.pulls.createReplyForReviewComment({
        ...ctx.repo,
        pull_number: trigger.prNumber,
        comment_id: source.inReplyTo ?? source.commentId,
        body,
      });
      return;
    }
    if (source.type === "issue-comment" || important) {
      await ctx.gh.rest.issues.createComment({ ...ctx.repo, issue_number: trigger.prNumber, body });
    }
  } catch (error) {
    ctx.log.warning(`Could not post the reply: ${errorMessage(error)}`);
  }
}

async function acknowledge(ctx: ActionContext, trigger: FixTrigger): Promise<void> {
  try {
    if (trigger.source.type === "issue-comment") {
      await ctx.gh.rest.reactions.createForIssueComment({
        ...ctx.repo,
        comment_id: trigger.source.commentId,
        content: "eyes",
      });
    } else if (trigger.source.type === "review-comment") {
      await ctx.gh.rest.reactions.createForPullRequestReviewComment({
        ...ctx.repo,
        comment_id: trigger.source.commentId,
        content: "eyes",
      });
    }
  } catch (error) {
    ctx.log.debug(`Could not add the reaction: ${errorMessage(error)}`);
  }
}

/** The command prefix the comments name; null when no workflow listens to the commands. */
export function commentCommand(inputs: Pick<Inputs, "fixCommand" | "fixCommands">): string | null {
  return inputs.fixCommands ? inputs.fixCommand : null;
}

/**
 * Reads the sticky comment again, changes its state, and writes it. Reading
 * again keeps changes that another workflow run made in the meantime.
 * Returns the id of the comment.
 */
export async function updateSticky(
  ctx: ActionContext,
  pr: Pick<PullRequestInfo, "number" | "baseRef">,
  mutate: (state: StickyState, marker: StickyMarker) => void,
): Promise<number> {
  const sticky = await findSticky(ctx.gh, ctx.repo, pr.number);
  const state = sticky?.state ?? emptyState(pr.baseRef);
  const marker: StickyMarker = sticky?.marker ?? {
    repo: fullName(ctx.repo),
    pr: pr.number,
    session: null,
    run: null,
    agent: null,
    sha: null,
  };
  mutate(state, marker);
  const body = renderSticky(state, {
    marker,
    repoUrl: repoUrl(ctx),
    command: commentCommand(ctx.inputs),
    progressImageUrl: ctx.progressImageUrl,
  });
  return writeSticky(ctx.gh, ctx.repo, pr.number, sticky?.id ?? null, body);
}

/**
 * Posts the sticky comment at once with a progress header, so the pull
 * request shows who the job acts for and where it is while the runtime
 * works. The same comment is rewritten with the result at the end.
 */
export async function startProgress(
  ctx: ActionContext,
  pr: PullRequestInfo,
  job: { doing: string; login: string; label?: string },
): Promise<number> {
  const startedAt = new Date(ctx.clock.now()).toISOString();
  // Saved first: a job canceled from now on still gets its row in the history.
  ctx.saveJob({
    pr: pr.number,
    sha: pr.headSha,
    label: job.label ?? job.doing,
    doing: job.doing,
    login: job.login,
    startedAt,
    workflowRunUrl: ctx.workflowRunUrl,
  });
  return updateSticky(ctx, pr, (state) => {
    state.progress = {
      doing: job.doing,
      login: job.login,
      startedAt,
      workflowRunUrl: ctx.workflowRunUrl,
      step: "preparing the inputs",
      runUrl: null,
      sha: pr.headSha,
    };
  });
}

/**
 * Updates the current step of the job in progress. Errors never stop the
 * job: the comment is a progress view, not the result.
 */
export async function stepProgress(
  ctx: ActionContext,
  pr: PullRequestInfo,
  step: string,
  /** The run the step belongs to; null drops the previous run's link. */
  runUrl: string | null = null,
): Promise<void> {
  try {
    await updateSticky(ctx, pr, (state) => {
      if (!state.progress) return;
      state.progress.step = step;
      state.progress.runUrl = runUrl;
    });
  } catch (error) {
    ctx.log.debug(`Could not update the progress: ${errorMessage(error)}`);
  }
}

/** Turns the progress header into the finished header; call it inside the final updateSticky. */
export function finishProgress(
  ctx: ActionContext,
  state: StickyState,
  job: { did: string; login: string; outcome: LastJob["outcome"] },
): void {
  const startedAt = state.progress ? Date.parse(state.progress.startedAt) : Number.NaN;
  state.last = {
    did: job.did,
    login: job.login,
    durationMs: Number.isFinite(startedAt) ? Math.max(0, ctx.clock.now() - startedAt) : 0,
    startedAt: state.progress?.startedAt ?? null,
    workflowRunUrl: ctx.workflowRunUrl,
    outcome: job.outcome,
  };
  state.progress = null;
}

/**
 * Adds the job to the history of the review comment. Call it inside the final updateSticky, before
 * or after finishProgress: the progress header and the finished header both hold the start time.
 */
export function recordJob(
  ctx: ActionContext,
  state: StickyState,
  job: { label: string; outcome: string | null; attempts: AttemptRecord[] },
): void {
  const startedAt = state.progress?.startedAt ?? state.last?.startedAt ?? new Date(ctx.clock.now()).toISOString();
  // The same duration as the header, when finishProgress already ran for this job.
  const durationMs =
    !state.progress && state.last?.startedAt === startedAt
      ? state.last.durationMs
      : Math.max(0, ctx.clock.now() - Date.parse(startedAt));
  addJob(state, {
    label: job.label,
    startedAt,
    workflowRunUrl: ctx.workflowRunUrl,
    outcome: job.outcome,
    attempts: job.attempts,
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
  });
}

/** A step reporter for the attempt runner: each run start and state change updates the comment. */
export function progressReporter(ctx: ActionContext, pr: PullRequestInfo, total: number): ProgressReporter {
  return {
    attempt: (index, agentId) =>
      stepProgress(ctx, pr, `starting a run on agent ${index + 1} of ${total} (\`${agentId.slice(0, 8)}\`)`),
    running: (runUrl) => stepProgress(ctx, pr, "waiting for the runtime to finish", runUrl),
    retry: (delayMs) =>
      stepProgress(ctx, pr, `the run failed; trying the same agent again in ${Math.round(delayMs / 1000)} s`),
    next: () => stepProgress(ctx, pr, "the run failed; moving to the next agent"),
  };
}

export function summarize(title: string, lines: string[], attempts: AttemptRecord[]): string {
  return [`### ${title}`, "", ...lines, "", attempts.length > 0 ? attemptsTable(attempts) : "", ""].join("\n");
}

/**
 * Why a fatal failure stopped all attempts: the gateway refused the token,
 * the gateway URL is wrong, or the gateway does not give the tools.
 */
export function fatalReason(attempts: AttemptRecord[]): string {
  const reason = attempts.at(-1)?.reason ?? "no reason recorded";
  return `The Archestra gateway stopped all attempts (${reason}).`;
}

/** The failure for the job when the work could not finish: unless "fail-on" is "never", the job fails. */
export function failureForError(ctx: ActionContext, message: string): string | null {
  return ctx.inputs.failOn === "never" ? null : message;
}
