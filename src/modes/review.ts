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
import { buildDiffIndex, excerptFor, isRangeInDiff } from "../github/diff";
import { httpStatus } from "../github/octokit";
import {
  type ChangedFile,
  loadChangedFiles,
  loadDiff,
  loadPullRequest,
  prAttachmentData,
  skipReason,
} from "../github/pr";
import {
  coversFinding,
  inlineBody,
  inlineComments,
  placeFindings,
  postReview,
  reviewCommentIds,
  updateInlineComment,
} from "../github/review";
import { findSticky, type StoredFinding } from "../github/sticky";
import {
  type FindingThread,
  listFindingThreads,
  planThreadUpdates,
  replyToThread,
  tryThreadUpdate,
} from "../github/threads";
import { errorMessage, fullName, jsonAttachment, shortSha, textAttachment } from "../util";
import {
  commentCommand,
  failureForError,
  fatalReason,
  finishProgress,
  progressReporter,
  recordJob,
  startProgress,
  summarize,
  updateSticky,
} from "./common";

const VERDICT_WORDS = { approve: "approved", comment: "commented", request_changes: "changes requested" } as const;

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
          ({ id, file, line, end_line, severity, title, summary, failure_scenario, recommendation, status }) => ({
            id,
            file,
            line,
            end_line,
            severity,
            title,
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
    // A fix leaves a short-lived App token in the actor's CODE_REVIEW_GITHUB_TOKEN; a
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
      recordJob(ctx, state, { label: `review of ${shortSha(pr.headSha)}`, outcome: null, attempts: outcome.attempts });
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
  // The threads of the findings reported before: their comments are rewritten in place below, and
  // the threads of fixed and regressed findings are resolved or reopened at the end.
  const threads = await findingThreads(ctx, pr.number, inputs.post !== "none" && previousFindings.length > 0);
  const command = commentCommand(inputs);
  // A finding whose lines are in the diff quotes them in the review comment.
  let findings = placeFindings(review.findings, index, {
    headSha: pr.headSha,
    inline: inputs.post === "review",
    previous: previousFindings,
    reservedIds: threads.keys(),
  }).map((finding) => ({ ...finding, excerpt: excerptFor(index, finding) }));
  const count = findings.length;

  if (inputs.post === "review") {
    // A finding reported before keeps its inline comment: the comment is rewritten in place, and
    // the thread with its replies and its resolution stays. Only new findings get new comments.
    const previousIds = new Set(previousFindings.map((finding) => finding.id));
    const kept: Array<{ finding: StoredFinding; thread: FindingThread }> = [];
    const fresh = new Set<string>();
    for (const finding of findings) {
      const thread = previousIds.has(finding.id) ? threads.get(finding.id) : undefined;
      if (thread && !thread.isOutdated) kept.push({ finding, thread });
      else if (finding.inline) fresh.add(finding.id);
    }
    // The inline comment of each finding: the kept thread, or the comment the new review creates.
    const commentIds = new Map<string, number>();
    for (const { finding, thread } of kept) {
      // A suggestion applies to the lines the comment sits on; it is left out when the finding moved.
      const body = inlineBody(finding, index, command, { suggestion: coversFinding(thread, finding) });
      try {
        await updateInlineComment(gh, repo, thread.commentId, body);
        commentIds.set(finding.id, thread.commentId);
      } catch (error) {
        if (httpStatus(error) === 404 && finding.inline) {
          // A person deleted the comment; the finding gets a new one.
          log.warning(`The inline comment of finding ${finding.n} is gone; a new one is posted.`);
          fresh.add(finding.id);
        } else {
          log.warning(`Could not update the inline comment of finding ${finding.n}: ${errorMessage(error)}`);
          commentIds.set(finding.id, thread.commentId);
        }
      }
    }
    const posting = await postReview(gh, repo, {
      pr: pr.number,
      headSha: pr.headSha,
      body: `Archestra review of \`${shortSha(pr.headSha)}\`: ${count} finding${count === 1 ? "" : "s"}${kept.length > 0 ? ` (${fresh.size} new; the others were updated in place)` : ""}. The summary is in the review comment of this pull request.`,
      comments: inlineComments(
        findings.filter((finding) => fresh.has(finding.id)),
        index,
        command,
      ),
      log,
    });
    if (posting.reviewId !== null) {
      try {
        for (const [id, commentId] of await reviewCommentIds(gh, repo, pr.number, posting.reviewId)) {
          commentIds.set(id, commentId);
        }
      } catch (error) {
        log.warning(`Could not read the ids of the new inline comments: ${errorMessage(error)}`);
      }
    }
    // A rejected new comment moves its finding into the summary; every other finding records its comment, if any.
    findings = findings.map((finding) =>
      !posting.posted && fresh.has(finding.id)
        ? { ...finding, inline: false, commentId: null }
        : { ...finding, commentId: commentIds.get(finding.id) ?? null },
    );
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
    state.title = pr.title;
    state.summary = review.summary;
    state.reviewed = review.reviewed ?? [];
    state.changes = (review.changes ?? []).map((change) => {
      const file = changedFile(files, change.file);
      const line = change.line ?? null;
      return {
        file: file?.filename ?? change.file,
        line,
        what: change.what,
        link: !file ? "none" : line !== null && isRangeInDiff(index, file.filename, line, line) ? "line" : "file",
      } as const;
    });
    state.observations = review.observations ?? [];
    // The line counts of a test file come from the pull request; a file outside the diff has none.
    state.tests = (review.tests ?? []).map((test) => {
      const file = changedFile(files, test.file);
      return {
        file: file?.filename ?? test.file,
        additions: file?.additions ?? null,
        deletions: file?.deletions ?? null,
        focus: test.focus,
      };
    });
    state.coverage = review.coverage ?? "";
    state.limitations = review.limitations ?? "";
    state.conclusion = review.conclusion ?? "";
    state.reviewedSha = pr.headSha;
    state.baseBranch = pr.baseRef;
    state.findings = findings;
    state.failingChecks = failingChecks;
    recordJob(ctx, state, {
      label: `review of ${shortSha(pr.headSha)}`,
      outcome: `${VERDICT_WORDS[review.verdict]}, ${findings.length} finding${findings.length === 1 ? "" : "s"}`,
      attempts: outcome.attempts,
    });
    state.skipped = [];
    state.notice = null;
    if (state.triageSha !== pr.headSha) {
      state.triage = [];
      state.triageSha = null;
    }
    state.applied = state.applied.slice(-50);
  });
  if (inputs.post !== "none") await updatePreviousThreads(ctx, pr.number, fixedIds, regressedIds, pr.headSha, threads);

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

/**
 * The changed file a runtime path names: the path as the pull request lists it, with a leading
 * "./" or "/" stripped, or the old name of a renamed file.
 */
function changedFile(files: ChangedFile[], path: string): ChangedFile | undefined {
  const normalized = path.replace(/^(?:\.\/|\/)+/, "");
  return files.find((file) => file.filename === normalized || file.previousFilename === normalized);
}

/**
 * The review threads of the findings reported before. When the list fails, the review still goes
 * on: every finding gets a new inline comment, and no thread is resolved or reopened.
 */
async function findingThreads(ctx: ActionContext, pr: number, wanted: boolean): Promise<Map<string, FindingThread>> {
  if (!wanted) return new Map();
  try {
    return await listFindingThreads(ctx.gh, ctx.repo, pr);
  } catch (error) {
    ctx.log.warning(
      `Could not list the review threads; the findings get new inline comments, and no thread is resolved or reopened: ${errorMessage(error)}`,
    );
    return new Map();
  }
}

/** Resolves the threads of fixed findings and reopens the threads of regressed ones. */
async function updatePreviousThreads(
  ctx: ActionContext,
  pr: number,
  fixedIds: string[],
  regressedIds: string[],
  headSha: string,
  threads: Map<string, FindingThread>,
): Promise<void> {
  if (fixedIds.length === 0 && regressedIds.length === 0) return;
  const gh = ctx.ghFix ?? ctx.gh;
  try {
    for (const update of planThreadUpdates(threads, { resolve: fixedIds, unresolve: regressedIds })) {
      const done = await tryThreadUpdate(gh, update, ctx.log);
      // A reopened thread gets a reply in any case; a thread that could not be resolved gets one instead.
      const note =
        update.action === "unresolve"
          ? `The re-review of \`${shortSha(headSha)}\` found this problem again.`
          : done
            ? null
            : `Fixed in \`${shortSha(headSha)}\`: the re-review no longer finds this problem.`;
      if (note) await replyToThread(ctx.gh, ctx.repo, pr, update.commentId, note);
    }
  } catch (error) {
    ctx.log.warning(`Could not update the review threads: ${errorMessage(error)}`);
  }
}
