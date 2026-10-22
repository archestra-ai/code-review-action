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
import { collectCiEvidence } from "../github/ci";
import { verifyCommits } from "../github/commits";
import type { Sender, TriggerSource } from "../github/event";
import { loadChangedFiles, loadDiff, loadPullRequest, prAttachmentData } from "../github/pr";
import { errorMessage, fullName, jsonAttachment, shortSha, textAttachment } from "../util";
import { failureForError, isResult, prepareFix, reply, summarize, updateSticky } from "./common";

export async function runFixCi(
  ctx: ActionContext,
  trigger: { kind: "fix-ci"; prNumber: number; sender: Sender; source: TriggerSource },
): Promise<ActionResult> {
  const prepared = await prepareFix(ctx, trigger);
  if (isResult(prepared)) return prepared;
  const { pr, identity, sticky } = prepared;
  const { inputs, repo, log } = ctx;

  const { evidence, logs } = await collectCiEvidence(ctx.gh, repo, {
    headSha: pr.headSha,
    baseBranch: pr.baseRef,
    log,
  });
  if (evidence.failures.length === 0) {
    await reply(ctx, trigger, `No check fails on \`${shortSha(pr.headSha)}\`. Nothing to triage.`, true);
    await updateSticky(ctx, pr, (s) => {
      s.notice = `No check fails on \`${shortSha(pr.headSha)}\`.`;
    });
    return makeResult("fix-ci", { status: "nothing-to-do", summary: "No failing checks." });
  }

  const [files, diff] = await Promise.all([
    loadChangedFiles(ctx.gh, repo, pr.number),
    loadDiff(ctx.gh, repo, pr.number),
  ]);
  const fixRequest = {
    mode: "fix-ci",
    repository: fullName(repo),
    number: pr.number,
    branch: pr.headRef,
    headSha: pr.headSha,
    baseBranch: pr.baseRef,
    author: { login: identity.login, name: identity.name, email: identity.email },
  };
  const attachments = [
    jsonAttachment("fix-request.json", fixRequest),
    jsonAttachment("ci-failure.json", evidence),
    ...logs.map((entry) => textAttachment(entry.name, entry.content)),
    jsonAttachment("pr.json", prAttachmentData(pr, repo, files, diff.truncated)),
    textAttachment("pr.diff", diff.diff, "text/x-diff"),
  ];
  const message = renderBrief("fix-ci", {
    repo: fullName(repo),
    number: pr.number,
    title: briefTitle(pr.title),
    cloneUrl: cloneUrl(ctx),
    branch: pr.headRef,
    headSha: pr.headSha,
    baseBranch: pr.baseRef,
    authorName: identity.name,
    authorEmail: identity.email,
  });

  const marker = sticky?.marker ?? null;
  const order = orderAgents(inputs.agents, inputs.strategy, {
    prNumber: pr.number,
    runAttempt: ctx.runAttempt,
    random: ctx.random,
  });
  const continueFrom =
    marker?.run && marker.agent && order.includes(marker.agent) ? { agentId: marker.agent, taskId: marker.run } : null;

  await updateSticky(ctx, pr, (s) => {
    s.notice = `Triaging ${evidence.failures.length} failing check${evidence.failures.length === 1 ? "" : "s"} for @${identity.login}. [Workflow run](${ctx.workflowRunUrl})`;
  });

  const outcome = await launch(ctx, {
    agents: preferAgent(order, continueFrom?.agentId ?? null),
    continueFrom,
    message,
    attachments,
    title: `${fullName(repo)}#${pr.number} CI triage`,
    contract: CONTRACTS["fix-ci"],
    timeoutMs: inputs.fixTimeoutMs,
    credentialToken: inputs.fixToken,
  });

  if (!outcome.ok || !outcome.value) {
    const reason = outcome.fatal ? "The Archestra API rejected the API key." : "No runtime completed the triage.";
    await updateSticky(ctx, pr, (s) => {
      s.attempts = outcome.attempts;
      s.operation = "CI triage";
      s.notice = `The CI triage requested by @${identity.login} did not complete: ${reason}`;
    });
    await reply(ctx, trigger, `The CI triage did not complete: ${reason}`);
    return makeResult("fix-ci", {
      status: outcome.fatal ? "aborted" : "unavailable",
      attempts: outcome.attempts,
      failure: failureForError(ctx, `The CI triage did not complete: ${reason}`),
      summary: summarize("Archestra CI triage unavailable", [reason], outcome.attempts),
    });
  }

  const { result: triage, taskId, sessionId } = outcome.value;
  const runUrl = ctx.archestra.runUrl(taskId);
  const knownChecks = new Set(evidence.failures.map((failure) => failure.name));
  const rows = triage.failures.filter((row) => knownChecks.has(row.check));
  const reportedCommits = rows.filter((row) => row.class === "pr_caused").flatMap((row) => row.commits);
  const after = await loadPullRequest(ctx.gh, repo, pr.number);
  const check = await verifyCommits(ctx.gh, repo, {
    base: pr.headSha,
    head: after.headSha,
    expectedEmail: identity.email,
    commits: reportedCommits,
  });
  for (const rejected of check.rejected)
    log.warning(`Commit ${shortSha(rejected.commit)} not verified: ${rejected.reason}`);

  // Re-run flaky jobs when the workflow allows it (needs actions: write on the App token).
  const rerun: number[] = [];
  if (inputs.ciRerun && ctx.ghFix) {
    const flaky = new Set(rows.filter((row) => row.class === "flaky").map((row) => row.check));
    const runIds = new Set(
      evidence.failures
        .filter((failure) => flaky.has(failure.name) && failure.runId !== null)
        .map((failure) => failure.runId as number),
    );
    for (const runId of runIds) {
      try {
        await ctx.ghFix.rest.actions.reRunWorkflowFailedJobs({ ...repo, run_id: runId });
        rerun.push(runId);
      } catch (error) {
        log.warning(`Could not re-run workflow run ${runId}: ${errorMessage(error)}`);
      }
    }
  }

  await updateSticky(ctx, pr, (s, stickyMarker) => {
    Object.assign(stickyMarker, {
      run: taskId,
      agent: outcome.agentId ?? stickyMarker.agent,
      session: sessionId ?? stickyMarker.session,
    });
    s.triage = rows.map((row) => ({
      check: row.check,
      class: row.class,
      rootCause: row.root_cause,
      commits: row.commits.filter((commit) => check.verified.includes(commit)),
    }));
    s.triageSha = pr.headSha;
    s.applied = [
      ...s.applied,
      ...rows.flatMap((row) =>
        row.commits
          .filter((commit) => check.verified.includes(commit))
          .map((commit) => ({ finding: null, check: row.check, commit, login: identity.login, runUrl })),
      ),
    ].slice(-50);
    s.attempts = outcome.attempts;
    s.operation = "CI triage";
    s.notice = null;
  });

  const lines = rows.map((row) => {
    const verified = row.commits.filter((commit) => check.verified.includes(commit));
    const action =
      row.class === "pr_caused"
        ? verified.length > 0
          ? `fixed in ${verified.map(shortSha).join(", ")}`
          : "no verified fix commit"
        : row.class === "flaky"
          ? rerun.length > 0
            ? "failed jobs re-run"
            : "re-run the failed jobs"
          : row.class === "pre_existing"
            ? `also fails on ${pr.baseRef}: fix it in a separate PR (tick the box in the review comment)`
            : row.class === "infrastructure"
              ? "re-run the job"
              : "needs a person";
    return `- \`${row.check.replace(/`/g, "'")}\`: ${row.class}, ${action}.`;
  });
  await reply(ctx, trigger, [`CI triage of \`${shortSha(pr.headSha)}\` ([run](${runUrl})):`, ...lines].join("\n"));

  return makeResult("fix-ci", {
    status: "success",
    agentId: outcome.agentId ?? null,
    runId: taskId,
    runUrl,
    attempts: outcome.attempts,
    pushedCommits: check.verified,
    triage: rows,
    summary: summarize("Archestra CI triage", lines, outcome.attempts),
  });
}
