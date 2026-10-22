import { type ActionContext, type ActionResult, makeResult, repoUrl } from "../context";
import { type AuthorIdentity, userIdentity } from "../github/commits";
import type { Sender, TriggerSource } from "../github/event";
import { hasWriteAccess } from "../github/permissions";
import { isFork, loadPullRequest, type PullRequestInfo } from "../github/pr";
import {
  attemptsTable,
  emptyState,
  findSticky,
  renderSticky,
  type StickyComment,
  type StickyMarker,
  type StickyState,
  writeSticky,
} from "../github/sticky";
import type { AttemptRecord } from "../attempts";
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
export async function prepareFix(
  ctx: ActionContext,
  trigger: FixTrigger,
): Promise<FixPreparation | ActionResult> {
  const pr = await loadPullRequest(ctx.gh, ctx.repo, trigger.prNumber);
  if (isFork(pr)) {
    return makeResult(trigger.kind, { status: "skipped", summary: "Fixes are not available for pull requests from forks." });
  }
  if (pr.state !== "open") {
    return makeResult(trigger.kind, { status: "skipped", summary: "The pull request is not open." });
  }
  if (!(await hasWriteAccess(ctx.gh, ctx.repo, trigger.sender.login))) {
    ctx.log.warning(`${trigger.sender.login} has no write access. No fix.`);
    await reply(ctx, trigger, `@${trigger.sender.login} only users with write access to this repository can start a fix.`, true);
    if (trigger.source.type === "checkbox") await rerenderSticky(ctx, pr);
    return makeResult(trigger.kind, { status: "unauthorized", summary: `${trigger.sender.login} has no write access.` });
  }
  await acknowledge(ctx, trigger);
  if (!ctx.ghFix || !ctx.inputs.fixToken) {
    const message = 'The fix cannot push: the workflow does not give the "fix-token" input (a GitHub App installation token).';
    await reply(ctx, trigger, message, true);
    if (trigger.source.type === "checkbox") await rerenderSticky(ctx, pr);
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
 * PR comment. A ticked box gets no extra comment (the sticky comment shows
 * the result), unless `important` is set.
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
      await ctx.gh.rest.reactions.createForIssueComment({ ...ctx.repo, comment_id: trigger.source.commentId, content: "eyes" });
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

/**
 * Reads the sticky comment again, changes its state, and writes it. Reading
 * again keeps changes that another workflow run made in the meantime.
 */
export async function updateSticky(
  ctx: ActionContext,
  pr: PullRequestInfo,
  mutate: (state: StickyState, marker: StickyMarker) => void,
): Promise<void> {
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
  const body = renderSticky(state, { marker, repoUrl: repoUrl(ctx), command: ctx.inputs.fixCommand });
  await writeSticky(ctx.gh, ctx.repo, pr.number, sticky?.id ?? null, body);
}

/** Renders the sticky comment again without changes; this unticks the boxes. */
async function rerenderSticky(ctx: ActionContext, pr: PullRequestInfo): Promise<void> {
  try {
    const sticky = await findSticky(ctx.gh, ctx.repo, pr.number);
    if (sticky?.state) await updateSticky(ctx, pr, () => {});
  } catch (error) {
    ctx.log.warning(`Could not reset the boxes: ${errorMessage(error)}`);
  }
}

export function summarize(title: string, lines: string[], attempts: AttemptRecord[]): string {
  return [`### ${title}`, "", ...lines, "", attempts.length > 0 ? attemptsTable(attempts) : "", ""].join("\n");
}

export function failureForError(ctx: ActionContext, message: string): string | null {
  return ctx.inputs.failOn === "error" ? message : null;
}
