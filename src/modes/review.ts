import { orderAgents } from "../attempts";
import { renderBrief } from "../briefs";
import {
  type ActionContext,
  type ActionResult,
  briefTitle,
  cloneUrl,
  launch,
  makeResult,
  preferAgent,
} from "../context";
import { CONTRACTS } from "../contracts";
import { buildDiffIndex } from "../github/diff";
import { loadChangedFiles, loadDiff, loadPullRequest, prAttachmentData, skipReason } from "../github/pr";
import { inlineComments, placeFindings, postReview } from "../github/review";
import { findSticky } from "../github/sticky";
import { applyThreadUpdate, listFindingThreads, planThreadUpdates, replyToThread } from "../github/threads";
import { errorMessage, fullName, jsonAttachment, shortSha, textAttachment } from "../util";
import { failureForError, summarize, updateSticky } from "./common";

export async function runReview(ctx: ActionContext, prNumber: number): Promise<ActionResult> {
  const { gh, repo, inputs, log } = ctx;
  const pr = await loadPullRequest(gh, repo, prNumber);
  const skip = skipReason(pr);
  if (skip) {
    log.info(`No review: ${skip}.`);
    return makeResult("review", { status: "skipped", summary: `No review: ${skip}.` });
  }

  const [files, diff, sticky] = await Promise.all([
    loadChangedFiles(gh, repo, pr.number),
    loadDiff(gh, repo, pr.number),
    findSticky(gh, repo, pr.number),
  ]);
  const previous = sticky?.state ?? null;
  const marker = sticky?.marker ?? null;

  // A re-review continues the retained workspace of the last review when its
  // agent is still configured (cheaper; it can report fixed findings).
  const order = orderAgents(inputs.agents, inputs.strategy, {
    prNumber: pr.number,
    runAttempt: ctx.runAttempt,
    random: ctx.random,
  });
  const incremental =
    inputs.incrementalReview &&
    previous?.status === "reviewed" &&
    marker?.run &&
    marker.agent &&
    order.includes(marker.agent)
      ? { agentId: marker.agent, taskId: marker.run }
      : null;
  const agents = preferAgent(order, incremental?.agentId ?? null);

  const attachments = [
    jsonAttachment("pr.json", prAttachmentData(pr, repo, files, diff.truncated)),
    textAttachment("pr.diff", diff.diff, "text/x-diff"),
  ];
  if (inputs.instructions) attachments.push(textAttachment("instructions.md", inputs.instructions, "text/markdown"));
  const previousFindings = previous?.findings ?? [];
  if (previousFindings.length > 0) {
    attachments.push(
      jsonAttachment(
        "previous-findings.json",
        previousFindings.map(({ id, file, line, end_line, severity, summary, failure_scenario, status }) => ({
          id,
          file,
          line,
          end_line,
          severity,
          summary,
          failure_scenario,
          status,
        })),
      ),
    );
  }
  const message = renderBrief("review", {
    repo: fullName(repo),
    number: pr.number,
    title: briefTitle(pr.title),
    cloneUrl: cloneUrl(ctx),
    headSha: pr.headSha,
    baseSha: pr.baseSha,
  });

  const outcome = await launch(ctx, {
    agents,
    continueFrom: incremental,
    message,
    attachments,
    title: `${fullName(repo)}#${pr.number}`,
    contract: CONTRACTS.review,
    timeoutMs: inputs.timeoutMs,
    credentialToken: null,
  });

  if (!outcome.ok || !outcome.value) {
    const reason = outcome.fatal
      ? "The Archestra API rejected the API key. No more attempts were made."
      : outcome.deadlineReached
        ? "The overall time limit was reached."
        : "All attempts failed.";
    if (inputs.post !== "none") {
      await updateSticky(ctx, pr, (state) => {
        state.status = "unavailable";
        state.attempts = outcome.attempts;
        state.operation = `review of ${shortSha(pr.headSha)}`;
        state.notice = `Review unavailable for \`${shortSha(pr.headSha)}\`: ${reason}`;
      });
    }
    const failure = failureForError(ctx, `The review is unavailable: ${reason}`);
    return makeResult("review", {
      status: outcome.fatal ? "aborted" : "unavailable",
      attempts: outcome.attempts,
      failure,
      summary: summarize("Archestra review unavailable", [reason], outcome.attempts),
    });
  }

  const { result: review, taskId, sessionId } = outcome.value;
  const agentId = outcome.agentId ?? null;
  const index = buildDiffIndex(files);
  let findings = placeFindings(review.findings, index, { headSha: pr.headSha, inline: inputs.post === "review" });

  if (inputs.post === "review") {
    const posted = await postReview(gh, repo, {
      pr: pr.number,
      headSha: pr.headSha,
      body: `Archestra review of \`${shortSha(pr.headSha)}\`: ${findings.length} finding${findings.length === 1 ? "" : "s"}. The summary is in the review comment of this pull request.`,
      comments: inlineComments(findings, index),
      log,
    });
    if (!posted) findings = findings.map((finding) => ({ ...finding, inline: false }));
  }

  const statuses = review.previous ?? [];
  const known = new Set(previousFindings.map((finding) => finding.id));
  const fixedIds = statuses.filter((s) => s.status === "fixed" && known.has(s.id)).map((s) => s.id);
  const regressedIds = statuses.filter((s) => s.status === "regressed" && known.has(s.id)).map((s) => s.id);

  if (inputs.post !== "none") {
    await updateSticky(ctx, pr, (state, stickyMarker) => {
      const sameWorkspace = stickyMarker.agent === agentId;
      Object.assign(stickyMarker, {
        run: taskId,
        agent: agentId,
        session: sessionId ?? (sameWorkspace ? stickyMarker.session : null),
        sha: pr.headSha,
      });
      state.status = "reviewed";
      state.verdict = review.verdict;
      state.summary = review.summary;
      state.reviewedSha = pr.headSha;
      state.baseBranch = pr.baseRef;
      state.findings = findings;
      state.attempts = outcome.attempts;
      state.operation = `review of ${shortSha(pr.headSha)}`;
      state.skipped = [];
      state.notice = null;
      if (state.triageSha !== pr.headSha) {
        state.triage = [];
        state.triageSha = null;
      }
      state.applied = state.applied.slice(-50);
    });
    await updatePreviousThreads(ctx, pr.number, fixedIds, regressedIds, pr.headSha);
  }

  const count = findings.length;
  const failure =
    inputs.failOn === "findings" && count > 0 ? `The review has ${count} finding${count === 1 ? "" : "s"}.` : null;
  return makeResult("review", {
    status: "success",
    agentId,
    runId: taskId,
    runUrl: ctx.archestra.runUrl(taskId),
    findingsCount: count,
    attempts: outcome.attempts,
    failure,
    summary: summarize(
      "Archestra review",
      [`Verdict: ${review.verdict}. Findings: ${count}. Run: ${ctx.archestra.runUrl(taskId)}`],
      outcome.attempts,
    ),
  });
}

/** Resolves the threads of fixed findings and reopens the threads of regressed ones. */
async function updatePreviousThreads(
  ctx: ActionContext,
  pr: number,
  fixedIds: string[],
  regressedIds: string[],
  headSha: string,
): Promise<void> {
  if (fixedIds.length === 0 && regressedIds.length === 0) return;
  const gh = ctx.ghFix ?? ctx.gh;
  try {
    const threads = await listFindingThreads(gh, ctx.repo, pr);
    for (const update of planThreadUpdates(threads, { resolve: fixedIds, unresolve: regressedIds })) {
      await applyThreadUpdate(gh, update);
      if (update.action === "unresolve") {
        await replyToThread(
          ctx.gh,
          ctx.repo,
          pr,
          update.commentId,
          `The re-review of \`${shortSha(headSha)}\` found this problem again.`,
        );
      }
    }
  } catch (error) {
    ctx.log.warning(`Could not update the review threads: ${errorMessage(error)}`);
  }
}
