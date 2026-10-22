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
import { verifyCommits } from "../github/commits";
import type { FindingSelection, Sender, TriggerSource } from "../github/event";
import { httpStatus } from "../github/octokit";
import { loadChangedFiles, loadDiff, loadPullRequest, prAttachmentData } from "../github/pr";
import { findingIdFromBody, type StoredFinding } from "../github/sticky";
import { applyThreadUpdate, listFindingThreads, planThreadUpdates, replyToThread } from "../github/threads";
import { errorMessage, fullName, jsonAttachment, shortSha, textAttachment } from "../util";
import { failureForError, isResult, prepareFix, reply, summarize, updateSticky } from "./common";

export interface FixTriggerInput {
  kind: "fix";
  prNumber: number;
  sender: Sender;
  source: TriggerSource;
  findings: FindingSelection;
  note: string;
}

export async function runFix(ctx: ActionContext, trigger: FixTriggerInput): Promise<ActionResult> {
  const prepared = await prepareFix(ctx, trigger);
  if (isResult(prepared)) return prepared;
  const { pr, identity, sticky } = prepared;
  const { inputs, repo, log } = ctx;

  const state = sticky?.state;
  if (!sticky || !state || state.findings.length === 0) {
    await reply(ctx, trigger, "There are no review findings to apply. Wait until the review is complete.", true);
    return makeResult("fix", { status: "nothing-to-do", summary: "No review findings." });
  }
  const selected = await selectFindings(ctx, state.findings, trigger.findings);
  if (selected.length === 0) {
    await reply(
      ctx,
      trigger,
      "No open finding agrees with the selection. Use the numbers in the review comment.",
      true,
    );
    return makeResult("fix", { status: "nothing-to-do", summary: "No finding was selected." });
  }

  const [files, diff] = await Promise.all([
    loadChangedFiles(ctx.gh, repo, pr.number),
    loadDiff(ctx.gh, repo, pr.number),
  ]);
  const fixRequest = {
    mode: "fix",
    repository: fullName(repo),
    number: pr.number,
    branch: pr.headRef,
    headSha: pr.headSha,
    author: { login: identity.login, name: identity.name, email: identity.email },
    findings: selected.map(({ id, n, file, line, end_line, severity, summary, failure_scenario, suggestion }) => ({
      id,
      n,
      file,
      line,
      end_line,
      severity,
      summary,
      failure_scenario,
      suggestion,
    })),
    maintainerNote: trigger.note,
  };
  const attachments = [
    jsonAttachment("fix-request.json", fixRequest),
    jsonAttachment("pr.json", prAttachmentData(pr, repo, files, diff.truncated)),
    textAttachment("pr.diff", diff.diff, "text/x-diff"),
  ];
  const message = renderBrief("fix", {
    repo: fullName(repo),
    number: pr.number,
    title: briefTitle(pr.title),
    cloneUrl: cloneUrl(ctx),
    branch: pr.headRef,
    headSha: pr.headSha,
    authorName: identity.name,
    authorEmail: identity.email,
  });

  const marker = sticky.marker;
  const order = orderAgents(inputs.agents, inputs.strategy, {
    prNumber: pr.number,
    runAttempt: ctx.runAttempt,
    random: ctx.random,
  });
  const continueFrom =
    marker.run && marker.agent && order.includes(marker.agent) ? { agentId: marker.agent, taskId: marker.run } : null;
  const agents = preferAgent(order, continueFrom?.agentId ?? null);

  await updateSticky(ctx, pr, (s) => {
    s.notice = `Applying ${selected.length} finding${selected.length === 1 ? "" : "s"} for @${identity.login}. [Workflow run](${ctx.workflowRunUrl})`;
  });

  const outcome = await launch(ctx, {
    agents,
    continueFrom,
    message,
    attachments,
    title: `${fullName(repo)}#${pr.number} fix`,
    contract: CONTRACTS.fix,
    timeoutMs: inputs.fixTimeoutMs,
    credentialToken: inputs.fixToken,
  });

  if (!outcome.ok || !outcome.value) {
    const reason = outcome.fatal ? "The Archestra API rejected the API key." : "No runtime completed the fix.";
    await updateSticky(ctx, pr, (s) => {
      s.attempts = outcome.attempts;
      s.operation = "fix";
      s.notice = `The fix requested by @${identity.login} did not complete: ${reason}`;
    });
    await reply(ctx, trigger, `The fix did not complete: ${reason} The review comment lists the attempts.`);
    return makeResult("fix", {
      status: outcome.fatal ? "aborted" : "unavailable",
      attempts: outcome.attempts,
      failure: failureForError(ctx, `The fix did not complete: ${reason}`),
      summary: summarize("Archestra fix unavailable", [reason], outcome.attempts),
    });
  }

  const { result, taskId, sessionId } = outcome.value;
  const runUrl = ctx.archestra.runUrl(taskId);
  const selectedIds = new Set(selected.map((finding) => finding.id));
  const reported = result.applied.filter((entry) => selectedIds.has(entry.finding));
  const after = await loadPullRequest(ctx.gh, repo, pr.number);
  const check = await verifyCommits(ctx.gh, repo, {
    base: pr.headSha,
    head: after.headSha,
    expectedEmail: identity.email,
    commits: reported.map((entry) => entry.commit),
  });
  const applied = reported.filter((entry) => check.verified.includes(entry.commit));
  const appliedIds = new Set(applied.map((entry) => entry.finding));
  const skipped = [
    ...result.skipped.filter((entry) => selectedIds.has(entry.finding) && !appliedIds.has(entry.finding)),
    ...reported
      .filter((entry) => !appliedIds.has(entry.finding))
      .map((entry) => ({
        finding: entry.finding,
        reason: `not verified: ${check.rejected.find((r) => r.commit === entry.commit)?.reason ?? "unknown"}`,
      })),
  ];
  for (const finding of selected) {
    if (!appliedIds.has(finding.id) && !skipped.some((entry) => entry.finding === finding.id)) {
      skipped.push({ finding: finding.id, reason: "the runtime did not report this finding" });
    }
  }
  log.info(`Applied ${applied.length} finding(s); skipped ${skipped.length}.`);

  await updateFindingThreads(ctx, pr.number, [...appliedIds], skipped);
  await updateSticky(ctx, pr, (s, stickyMarker) => {
    Object.assign(stickyMarker, {
      run: taskId,
      agent: outcome.agentId ?? stickyMarker.agent,
      session: sessionId ?? stickyMarker.session,
    });
    s.findings = s.findings.map((finding) =>
      appliedIds.has(finding.id)
        ? { ...finding, status: "applied" as const }
        : skipped.some((entry) => entry.finding === finding.id)
          ? { ...finding, status: "skipped" as const }
          : finding,
    );
    s.applied = [
      ...s.applied,
      ...applied.map((entry) => ({
        finding: entry.finding,
        check: null,
        commit: entry.commit,
        login: identity.login,
        runUrl,
      })),
    ].slice(-50);
    s.skipped = skipped;
    s.attempts = outcome.attempts;
    s.operation = "fix";
    s.notice = null;
  });

  const number = (id: string) => selected.find((finding) => finding.id === id)?.n ?? id;
  const lines = [
    applied.length > 0
      ? `Applied ${applied.map((entry) => `${number(entry.finding)} (${shortSha(entry.commit)})`).join(", ")} on behalf of @${identity.login}. [Run](${runUrl})`
      : `No finding was applied. [Run](${runUrl})`,
    ...skipped.map((entry) => `- Skipped ${number(entry.finding)}: ${entry.reason.replace(/\s+/g, " ").slice(0, 300)}`),
  ];
  await reply(ctx, trigger, lines.join("\n"));

  return makeResult("fix", {
    status: "success",
    agentId: outcome.agentId ?? null,
    runId: taskId,
    runUrl,
    attempts: outcome.attempts,
    pushedCommits: check.verified,
    applied,
    skipped,
    summary: summarize("Archestra fix", lines, outcome.attempts),
  });
}

async function selectFindings(
  ctx: ActionContext,
  findings: StoredFinding[],
  selection: FindingSelection,
): Promise<StoredFinding[]> {
  if (selection === "all") {
    return findings.filter((finding) => finding.status === "open" || finding.status === "skipped");
  }
  if (Array.isArray(selection)) {
    return findings.filter((finding) => selection.includes(finding.n) && finding.status !== "applied");
  }
  // A reply under an inline finding: the parent comment carries the finding marker.
  try {
    const { data } = await ctx.gh.rest.pulls.getReviewComment({ ...ctx.repo, comment_id: selection.inlineReplyTo });
    const id = findingIdFromBody(data.body);
    return findings.filter((finding) => finding.id === id && finding.status !== "applied");
  } catch (error) {
    if (httpStatus(error) === 404) return [];
    throw error;
  }
}

async function updateFindingThreads(
  ctx: ActionContext,
  pr: number,
  appliedIds: string[],
  skipped: Array<{ finding: string; reason: string }>,
): Promise<void> {
  const gh = ctx.ghFix ?? ctx.gh;
  try {
    const threads = await listFindingThreads(gh, ctx.repo, pr);
    for (const update of planThreadUpdates(threads, { resolve: appliedIds, unresolve: [] })) {
      await applyThreadUpdate(gh, update);
    }
    for (const entry of skipped) {
      const thread = threads.get(entry.finding);
      if (thread) {
        await replyToThread(ctx.gh, ctx.repo, pr, thread.commentId, `Not applied: ${entry.reason.slice(0, 1000)}`);
      }
    }
  } catch (error) {
    ctx.log.warning(`Could not update the review threads: ${errorMessage(error)}`);
  }
}
