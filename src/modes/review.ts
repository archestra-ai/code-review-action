import { orderAgents } from "../attempts";
import { renderBrief } from "../briefs";
import { deleteRunWorkspaces } from "../cleanup";
import {
  type AccessRefusalInfo,
  type ActionContext,
  type ActionResult,
  briefTitle,
  cloneUrl,
  launch,
  makeResult,
  preferAgent,
  repoUrl,
} from "../context";
import { CONTRACTS } from "../contracts";
import { checkSnapshot } from "../github/ci";
import { isAncestor } from "../github/commits";
import { buildDiffIndex, excerptFor, isRangeInDiff } from "../github/diff";
import { httpStatus } from "../github/octokit";
import {
  type ChangedFile,
  loadChangedFiles,
  loadDiff,
  loadPullRequest,
  type PullRequestInfo,
  prAttachmentData,
  skipReason,
} from "../github/pr";
import {
  coversFinding,
  dismissChangeRequests,
  inlineBody,
  inlineComments,
  placeFindings,
  postReview,
  reviewCommentIds,
  reviewEventFor,
  updateInlineComment,
  verdictFor,
} from "../github/review";
import {
  findingCounts,
  findingTitle,
  findSticky,
  type ReviewDelta,
  type StickyState,
  type StoredFinding,
  verdictLabel,
} from "../github/sticky";
import {
  type FindingThread,
  listFindingThreads,
  planThreadUpdates,
  replyToThread,
  tryThreadUpdate,
} from "../github/threads";
import { type Attachment, errorMessage, fullName, jsonAttachment, shortSha, textAttachment } from "../util";
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

/**
 * A review clones, runs a few checks and writes one file: the smallest tier
 * with two CPUs, whatever the organization calls it, stopped ten minutes after
 * it goes idle, and gone with its files after an hour even when the deletion
 * after the review does not happen. The `min-cpu` and `min-memory-gib` inputs
 * raise the size for a repository whose checks need more; a run killed for
 * memory is tried again with more memory either way.
 */
const REVIEW_RUN_LIMITS = { minCpu: 2, idleTimeoutMinutes: 10, maxDurationHours: 1 } as const;

export async function runReview(ctx: ActionContext, prNumber: number): Promise<ActionResult> {
  const { gh, repo, inputs, log } = ctx;
  const pr = await loadPullRequest(gh, repo, prNumber);
  const skip = skipReason(pr);
  if (skip) {
    log.info(`No review: ${skip}.`);
    return makeResult("review", { status: "skipped", summary: `No review: ${skip}.` });
  }

  const [files, diff, sticky, checks] = await Promise.all([
    loadChangedFiles(gh, repo, pr.number),
    loadDiff(gh, repo, pr.number),
    findSticky(gh, repo, pr.number),
    checkSnapshot(gh, repo, pr.headSha, log),
  ]);
  const failingChecks = checks.failing;
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
  if (checks.checks.length > 0) attachments.push(jsonAttachment("checks.json", checks.checks));
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
  // The commit the last review covered. A re-review writes about what changed since then, when that
  // commit is still in the history of the pull request.
  const lastSha = previous?.verdict ? previous.reviewedSha : null;
  const sinceSha =
    lastSha && lastSha !== pr.headSha && (await isAncestor(gh, repo, lastSha, pr.headSha)) ? lastSha : null;
  const stickyId = await startProgress(ctx, pr, {
    doing: `reviewing \`${shortSha(pr.headSha)}\``,
    login: pr.authorLogin,
    label: `review of ${shortSha(pr.headSha)}`,
  });
  try {
    return await reviewInProgress(ctx, {
      pr,
      files,
      diff,
      previous,
      incremental,
      agents,
      attachments,
      stickyId,
      failingChecks,
      lastSha,
      sinceSha,
      self: sticky?.author ?? null,
    });
  } catch (error) {
    // The comment must not keep a progress header for a job that is gone: it says the job stopped,
    // without the error text, which can name internal hosts; the job log has it.
    try {
      await updateSticky(ctx, pr, (state) => {
        finishProgress(ctx, state, {
          did: `the review of \`${shortSha(pr.headSha)}\``,
          login: pr.authorLogin,
          outcome: "error",
        });
        recordJob(ctx, state, {
          label: `review of ${shortSha(pr.headSha)}`,
          outcome: "stopped with an error",
          attempts: [],
        });
      });
    } catch (stickyError) {
      log.warning(`Could not record the error in the review comment: ${errorMessage(stickyError)}`);
    }
    throw error;
  }
}

/** The review after the progress header is up: the brief, the runtime, and the comment, review and threads. */
async function reviewInProgress(
  ctx: ActionContext,
  p: {
    pr: PullRequestInfo;
    files: ChangedFile[];
    diff: { diff: string; truncated: boolean };
    previous: StickyState | null;
    incremental: { agentId: string; runId: string } | null;
    agents: string[];
    attachments: Attachment[];
    stickyId: number;
    failingChecks: number;
    /** The commit of the last completed review; null before the first. */
    lastSha: string | null;
    /** `lastSha` when it is in the history of the head commit and differs from it. */
    sinceSha: string | null;
    /** The login of the action's token, from its review comment; null on a first review. */
    self: string | null;
  },
): Promise<ActionResult> {
  const { gh, repo, inputs, log } = ctx;
  const { pr, files, previous, incremental, agents, attachments, failingChecks, lastSha, sinceSha } = p;
  const previousFindings = previous?.findings ?? [];
  const message = renderBrief("review", {
    repo: fullName(repo),
    number: pr.number,
    title: briefTitle(pr.title),
    cloneUrl: cloneUrl(ctx),
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    summaryWords: summaryWords(files.reduce((sum, file) => sum + file.additions + file.deletions, 0)),
    reviewScope: reviewScope(lastSha, sinceSha, pr.headSha),
  });

  const outcome = await launch(ctx, {
    agents,
    continueFrom: incremental,
    message,
    attachments,
    contract: CONTRACTS.review,
    timeoutMs: inputs.timeoutMs,
    limits: {
      ...REVIEW_RUN_LIMITS,
      ...(inputs.minCpu ? { minCpu: inputs.minCpu } : {}),
      ...(inputs.minMemoryGib ? { minMemoryGib: inputs.minMemoryGib } : {}),
    },
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
      recordJob(ctx, state, {
        label: `review of ${shortSha(pr.headSha)}`,
        outcome: "unavailable",
        attempts: outcome.attempts,
      });
      state.notice = `Review unavailable for \`${shortSha(pr.headSha)}\`: ${reason}`;
    });
    await deleteRunWorkspaces(
      ctx.archestra,
      outcome.attempts.map((attempt) => attempt.runId),
      log,
    );
    const failure = failureForError(ctx, `The review is unavailable: ${reason}`);
    return makeResult("review", {
      status: outcome.fatal ? "aborted" : "unavailable",
      attempts: outcome.attempts,
      failure,
      summary: summarize("Archestra review unavailable", [reason], outcome.attempts),
    });
  }

  const { result: review, runId } = outcome.value;
  try {
    const agentId = outcome.agentId ?? null;
    const summaryUrl = `${repoUrl(ctx)}/pull/${pr.number}#issuecomment-${p.stickyId}`;
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
    // The verdict follows from the severities, so the same findings always get the same verdict.
    const verdict = verdictFor(findings);

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
      const event = reviewEventFor(inputs.reviewEvent, verdict);
      const posting = await postReview(gh, repo, {
        pr: pr.number,
        headSha: pr.headSha,
        body: reviewBody(pr.headSha, verdict, findings, fresh.size, kept.length, summaryUrl),
        event,
        comments: inlineComments(
          findings.filter((finding) => fresh.has(finding.id)),
          index,
          command,
        ),
        log,
      });
      // Nothing blocks the merge any more: the change requests of earlier reviews stop blocking it.
      if (inputs.reviewEvent === "request-changes" && event !== "REQUEST_CHANGES") {
        await dismissChangeRequests(gh, repo, {
          pr: pr.number,
          message: `The review of ${shortSha(pr.headSha)} finds nothing that blocks the merge.`,
          resolvedIn: shortSha(pr.headSha),
          self: p.self,
          log,
        });
      }
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
    const known = new Map(previousFindings.map((finding) => [finding.id, finding]));
    const fixed = statuses.filter((s) => s.status === "fixed" && known.has(s.id));
    const regressedIds = statuses.filter((s) => s.status === "regressed" && known.has(s.id)).map((s) => s.id);
    const delta = sinceSha ? reviewDelta(sinceSha, previousFindings, findings, fixed, regressedIds.length) : null;

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
      state.verdict = verdict;
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
      state.delta = delta;
      state.reviewedSha = pr.headSha;
      state.baseBranch = pr.baseRef;
      state.findings = findings;
      state.failingChecks = failingChecks;
      recordJob(ctx, state, {
        label: `review of ${shortSha(pr.headSha)}`,
        outcome: `${VERDICT_WORDS[verdict]}, ${findings.length} finding${findings.length === 1 ? "" : "s"}`,
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
    if (inputs.post !== "none") {
      await updatePreviousThreads(ctx, pr.number, {
        fixedIds: fixed.map((status) => status.id),
        regressedIds,
        headSha: pr.headSha,
        threads,
      });
    }

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
        [`${verdictLabel(verdict)}: ${findingCounts(findings)}. Run: ${ctx.archestra.runUrl(runId)}`],
        outcome.attempts,
      ),
    });
  } finally {
    // The review is complete, posted or not: nothing reads its files any more. The next
    // review of this pull request gets the previous findings as an input and clones again.
    await deleteRunWorkspaces(ctx.archestra, [runId, ...outcome.attempts.map((attempt) => attempt.runId)], log);
  }
}

/** What the summary covers: the whole change, or what changed since the last reviewed commit. */
export function reviewScope(lastSha: string | null, sinceSha: string | null, headSha: string): string {
  if (sinceSha) {
    return `This is a re-review. The last review covered ${sinceSha}; write the summary about what changed since then (\`git diff ${sinceSha} ${headSha}\`), not about the whole pull request again.`;
  }
  if (lastSha === headSha) {
    return "This review repeats the last one on the same commit: check the previous findings again, and write the summary about the whole pull request.";
  }
  if (lastSha) {
    return `The commit of the last review (${lastSha}) is no longer in the history of this pull request (a force-push or a rebase): review the whole pull request again.`;
  }
  return "This is the first review of this pull request.";
}

/**
 * Archestra refused the job's GitHub Actions sign-in. A review event says why in the review
 * comment, so the author knows what to do; a pull request that is never reviewed (a draft, a bot's)
 * gets nothing. Only a failed sign-in fails the job; a refusal is a skip.
 */
export async function refuseAccess(
  ctx: ActionContext,
  trigger: { kind: string; prNumber?: number },
  refusal: AccessRefusalInfo,
): Promise<ActionResult> {
  const summary = `No Archestra review: ${refusal.message}`;
  ctx.log.warning(summary);
  // Someone other than the author started the run (a push to their branch, a bot updating it): the
  // author's next push gets the review, so the comment says nothing.
  if (refusal.reason === "not_author") return makeResult(trigger.kind, { status: "skipped", summary });
  const failure = refusal.reason === "unavailable" ? failureForError(ctx, summary) : null;
  const status = refusal.reason === "unavailable" ? "unavailable" : "unauthorized";
  if (trigger.kind !== "review" || trigger.prNumber === undefined || ctx.inputs.post === "none") {
    return makeResult(trigger.kind, { status, failure, summary });
  }
  try {
    const pr = await loadPullRequest(ctx.gh, ctx.repo, trigger.prNumber);
    if (skipReason(pr)) return makeResult("review", { status: "skipped", summary: `No review: ${skipReason(pr)}.` });
    await updateSticky(ctx, pr, (state) => {
      state.notice = `No review of \`${shortSha(pr.headSha)}\`: ${refusal.message}`;
    });
  } catch (error) {
    ctx.log.warning(`Could not say in the review comment why there is no review: ${errorMessage(error)}`);
  }
  return makeResult("review", { status, failure, summary });
}

/** About 60 words for a small change, up to 300 for a large one. */
export function summaryWords(changedLines: number): number {
  if (changedLines <= 50) return 60;
  if (changedLines <= 400) return 120;
  if (changedLines <= 2000) return 200;
  return 300;
}

/** The body of the GitHub review: the verdict, the counts and a link to the review comment. */
export function reviewBody(
  headSha: string,
  verdict: ReturnType<typeof verdictFor>,
  findings: Pick<StoredFinding, "severity">[],
  fresh: number,
  kept: number,
  summaryUrl: string,
): string {
  const update = kept > 0 ? ` ${fresh} new; ${kept} updated in place.` : "";
  return `**${verdictLabel(verdict)}** · Archestra review of \`${shortSha(headSha)}\` · ${findingCounts(findings)}.${update} [Summary](${summaryUrl})`;
}

/** What changed since the last review, for the head of the review comment. */
export function reviewDelta(
  sinceSha: string,
  previous: StoredFinding[],
  findings: StoredFinding[],
  fixed: Array<{ id: string; note?: string }>,
  regressed: number,
): ReviewDelta {
  const previousIds = new Set(previous.map((finding) => finding.id));
  const repeated = findings.filter((finding) => previousIds.has(finding.id)).length;
  return {
    sinceSha,
    fixed: fixed.flatMap((status) => {
      const finding = previous.find((candidate) => candidate.id === status.id);
      return finding
        ? [{ title: findingTitle(finding), severity: finding.severity, note: status.note?.trim() || null }]
        : [];
    }),
    stillOpen: Math.max(0, repeated - regressed),
    regressed,
    added: findings.length - repeated,
  };
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

/**
 * Resolves the threads of fixed findings and reopens the threads of regressed ones. A fixed finding
 * gets no reply: the review comment lists it as fixed.
 */
async function updatePreviousThreads(
  ctx: ActionContext,
  pr: number,
  p: {
    fixedIds: string[];
    regressedIds: string[];
    headSha: string;
    threads: Map<string, FindingThread>;
  },
): Promise<void> {
  if (p.fixedIds.length === 0 && p.regressedIds.length === 0) return;
  const gh = ctx.ghFix ?? ctx.gh;
  const head = shortSha(p.headSha);
  try {
    const updates = planThreadUpdates(p.threads, { resolve: p.fixedIds, unresolve: p.regressedIds });
    for (const update of updates) {
      await tryThreadUpdate(gh, update, ctx.log);
      if (update.action === "unresolve") {
        await replyToThread(
          ctx.gh,
          ctx.repo,
          pr,
          update.commentId,
          `The review of \`${head}\` finds this problem again.`,
        );
      }
    }
  } catch (error) {
    ctx.log.warning(`Could not update the review threads: ${errorMessage(error)}`);
  }
}
