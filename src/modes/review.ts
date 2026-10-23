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
import { countFailingChecks } from "../github/ci";
import { buildDiffIndex } from "../github/diff";
import { loadChangedFiles, loadDiff, loadPullRequest, prAttachmentData, skipReason } from "../github/pr";
import { inlineComments, placeFindings, postReview } from "../github/review";
import { findSticky } from "../github/sticky";
import { applyThreadUpdate, listFindingThreads, planThreadUpdates, replyToThread } from "../github/threads";
import { errorMessage, fullName, jsonAttachment, shortSha, textAttachment } from "../util";
import {
  failureForError,
  fatalReason,
  finishProgress,
  progressReporter,
  startProgress,
  summarize,
  updateSticky,
} from "./common";

export async function runReview(ctx: ActionContext, prNumber: number): Promise<ActionResult> {
  const { gh, repo, inputs, log } = ctx;
  const pr = await loadPullRequest(gh, repo, prNumber);
  const skip = skipReason(pr);
  if (skip) {
    log.info(`No review: ${skip}.`);
    return makeResult("review", { status: "skipped", summary: `No review: ${skip}.` });
  }

  const [files, diff, sticky, failingChecks] = await Promise.all([
    loadChangedFiles(gh, repo, pr.number),
    loadDiff(gh, repo, pr.number),
    findSticky(gh, repo, pr.number),
    countFailingChecks(gh, repo, pr.headSha, log),
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
      ? { agentId: marker.agent, runId: marker.run }
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
        previousFindings.map(
          ({ id, file, line, end_line, severity, summary, failure_scenario, recommendation, status }) => ({
            id,
            file,
            line,
            end_line,
            severity,
            summary,
            failure_scenario,
            recommendation,
            status,
          }),
        ),
      ),
    );
  }
  await startProgress(ctx, pr, { doing: `reviewing \`${shortSha(pr.headSha)}\``, login: pr.authorLogin });
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
    contract: CONTRACTS.review,
    timeoutMs: inputs.timeoutMs,
    // A fix leaves a short-lived App token in the actor's GITHUB_TOKEN; a
    // private repository needs a fresh read-only token for the review.
    credentialToken: inputs.cloneToken || null,
    progress: progressReporter(ctx, pr, agents.length),
  });

  if (!outcome.ok || !outcome.value) {
    const reason = outcome.fatal
      ? fatalReason(outcome.attempts)
      : outcome.deadlineReached
        ? "The overall time limit was reached."
        : "All attempts failed.";
    await updateSticky(ctx, pr, (state) => {
      finishProgress(ctx, state, {
        did: `the review of \`${shortSha(pr.headSha)}\``,
        login: pr.authorLogin,
        outcome: "unavailable",
      });
      if (inputs.post === "none") return;
      state.status = "unavailable";
      state.attempts = outcome.attempts;
      state.operation = `review of ${shortSha(pr.headSha)}`;
      state.notice = `Review unavailable for \`${shortSha(pr.headSha)}\`: ${reason}`;
    });
    const failure = failureForError(ctx, `The review is unavailable: ${reason}`);
    return makeResult("review", {
      status: outcome.fatal ? "aborted" : "unavailable",
      attempts: outcome.attempts,
      failure,
      summary: summarize("Archestra review unavailable", [reason], outcome.attempts),
    });
  }

  const { result: review, runId } = outcome.value;
  const agentId = outcome.agentId ?? null;
  const index = buildDiffIndex(files);
  let findings = placeFindings(review.findings, index, { headSha: pr.headSha, inline: inputs.post === "review" });

  if (inputs.post === "review") {
    const posted = await postReview(gh, repo, {
      pr: pr.number,
      headSha: pr.headSha,
      body: `Archestra review of \`${shortSha(pr.headSha)}\`: ${findings.length} finding${findings.length === 1 ? "" : "s"}. The summary is in the review comment of this pull request.`,
      comments: inlineComments(findings, index, inputs.fixCommand),
      log,
    });
    if (!posted) findings = findings.map((finding) => ({ ...finding, inline: false }));
  }

  const statuses = review.previous ?? [];
  const known = new Set(previousFindings.map((finding) => finding.id));
  const fixedIds = statuses.filter((s) => s.status === "fixed" && known.has(s.id)).map((s) => s.id);
  const regressedIds = statuses.filter((s) => s.status === "regressed" && known.has(s.id)).map((s) => s.id);

  await updateSticky(ctx, pr, (state, stickyMarker) => {
    finishProgress(ctx, state, { did: `reviewed \`${shortSha(pr.headSha)}\``, login: pr.authorLogin, outcome: "ok" });
    if (inputs.post === "none") return;
    // The run id is also the workspace id: a later fix continues it.
    Object.assign(stickyMarker, {
      run: runId,
      agent: agentId,
      session: runId,
      sha: pr.headSha,
    });
    state.status = "reviewed";
    state.verdict = review.verdict;
    state.summary = review.summary;
    state.reviewedSha = pr.headSha;
    state.baseBranch = pr.baseRef;
    state.findings = findings;
    state.failingChecks = failingChecks;
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
  if (inputs.post !== "none") await updatePreviousThreads(ctx, pr.number, fixedIds, regressedIds, pr.headSha);

  const count = findings.length;
  const failure =
    inputs.failOn === "findings" && count > 0 ? `The review has ${count} finding${count === 1 ? "" : "s"}.` : null;
  return makeResult("review", {
    status: "success",
    agentId,
    runId,
    runUrl: ctx.archestra.runUrl(runId),
    findingsCount: count,
    attempts: outcome.attempts,
    failure,
    summary: summarize(
      "Archestra review",
      [`Verdict: ${review.verdict}. Findings: ${count}. Run: ${ctx.archestra.runUrl(runId)}`],
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
