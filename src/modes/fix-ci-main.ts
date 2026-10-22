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
import { CONTRACTS, FIX_CI_BRANCH_PREFIX } from "../contracts";
import { collectCiEvidence } from "../github/ci";
import { verifyCommits } from "../github/commits";
import type { Sender, TriggerSource } from "../github/event";
import { type Attachment, errorMessage, fullName, jsonAttachment, shortSha, textAttachment } from "../util";
import { failureForError, isResult, prepareFix, reply, summarize, updateSticky } from "./common";

export async function runFixCiMain(
  ctx: ActionContext,
  trigger: { kind: "fix-ci-main"; prNumber: number; sender: Sender; source: TriggerSource; target: number | "all" },
): Promise<ActionResult> {
  const prepared = await prepareFix(ctx, trigger);
  if (isResult(prepared)) return prepared;
  const { pr, identity, sticky } = prepared;
  const { inputs, repo, log } = ctx;
  const ghFix = ctx.ghFix;
  if (!ghFix) throw new Error("unreachable: prepareFix checks the fix token");

  const state = sticky?.state;
  const candidates = (state?.triage ?? [])
    .map((row, index) => ({ row, index }))
    .filter(
      ({ row }) => row.class === "pre_existing" && !state?.fixPrs.some((fixPr) => fixPr.checks.includes(row.check)),
    );
  const chosen = trigger.target === "all" ? candidates : candidates.filter(({ index }) => index === trigger.target);
  if (!state || chosen.length === 0) {
    await reply(ctx, trigger, "No pre-existing failure agrees with the selection. Run the CI triage first.", true);
    return makeResult("fix-ci-main", { status: "nothing-to-do", summary: "No pre-existing failure was selected." });
  }
  const baseBranch = state.baseBranch || pr.baseRef;
  const checks = chosen.map(({ row }) => row.check);

  // Give the evidence again when the checks still fail on the same head.
  const attachments: Attachment[] = [];
  try {
    const { evidence, logs } = await collectCiEvidence(ctx.gh, repo, { headSha: pr.headSha, baseBranch, log });
    const relevant = evidence.failures.filter((failure) => checks.includes(failure.name));
    if (relevant.length > 0) {
      attachments.push(jsonAttachment("ci-failure.json", { ...evidence, failures: relevant }));
      for (const entry of logs.filter((logEntry) => relevant.some((failure) => failure.log === logEntry.name))) {
        attachments.push(textAttachment(entry.name, entry.content));
      }
    }
  } catch (error) {
    log.warning(`Could not collect the CI evidence again: ${errorMessage(error)}`);
  }
  const fixRequest = {
    mode: "fix-ci-main",
    repository: fullName(repo),
    originPullRequest: pr.number,
    baseBranch,
    branchPrefix: FIX_CI_BRANCH_PREFIX,
    author: { login: identity.login, name: identity.name, email: identity.email },
    failures: chosen.map(({ row }) => ({ check: row.check, rootCause: row.rootCause })),
  };
  attachments.unshift(jsonAttachment("fix-request.json", fixRequest));
  const message = renderBrief("fix-ci-main", {
    repo: fullName(repo),
    number: pr.number,
    title: briefTitle(pr.title),
    cloneUrl: cloneUrl(ctx),
    baseBranch,
    branchPrefix: FIX_CI_BRANCH_PREFIX,
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
    s.notice = `Preparing a fix PR against ${baseBranch} for ${checks.map((check) => `\`${check.replace(/`/g, "'")}\``).join(", ")} for @${identity.login}. [Workflow run](${ctx.workflowRunUrl})`;
  });

  const outcome = await launch(ctx, {
    agents: preferAgent(order, continueFrom?.agentId ?? null),
    continueFrom,
    message,
    attachments,
    title: `${fullName(repo)} fix CI on ${baseBranch}`,
    contract: CONTRACTS["fix-ci-main"],
    timeoutMs: inputs.fixTimeoutMs,
    credentialToken: inputs.fixToken,
  });

  if (!outcome.ok || !outcome.value) {
    const reason = outcome.fatal ? "The Archestra API rejected the API key." : "No runtime completed the fix.";
    await updateSticky(ctx, pr, (s) => {
      s.attempts = outcome.attempts;
      s.operation = `fix PR against ${baseBranch}`;
      s.notice = `The fix PR requested by @${identity.login} was not prepared: ${reason}`;
    });
    await reply(ctx, trigger, `The fix PR was not prepared: ${reason}`);
    return makeResult("fix-ci-main", {
      status: outcome.fatal ? "aborted" : "unavailable",
      attempts: outcome.attempts,
      failure: failureForError(ctx, `The fix PR was not prepared: ${reason}`),
      summary: summarize("Archestra fix PR unavailable", [reason], outcome.attempts),
    });
  }

  const { result, taskId } = outcome.value;
  const runUrl = ctx.archestra.runUrl(taskId);
  const check = await verifyCommits(ctx.gh, repo, {
    base: baseBranch,
    head: result.branch,
    expectedEmail: identity.email,
    commits: result.commits,
  });
  if (check.verified.length === 0 || check.rejected.length > 0) {
    const problem =
      check.rejected.map((entry) => `${shortSha(entry.commit)}: ${entry.reason}`).join("; ") || "no commits";
    await updateSticky(ctx, pr, (s) => {
      s.attempts = outcome.attempts;
      s.notice = `The fix branch \`${result.branch}\` did not pass the commit check (${problem}). No PR was opened.`;
    });
    await reply(
      ctx,
      trigger,
      `The fix branch \`${result.branch}\` did not pass the commit check: ${problem}. No PR was opened.`,
      true,
    );
    return makeResult("fix-ci-main", {
      status: "error",
      runId: taskId,
      runUrl,
      attempts: outcome.attempts,
      failure: failureForError(ctx, "The fix branch did not pass the commit check."),
      summary: summarize("Archestra fix PR", [`Commit check failed: ${problem}`], outcome.attempts),
    });
  }

  // The App opens the PR: GitHub cannot open it as the user without the user's token.
  const body = [
    result.summary,
    "",
    ...(result.root_cause ? ["#### Root cause", "", result.root_cause, ""] : []),
    "#### Reproduction",
    "",
    result.reproduction,
    "",
    `Found by the CI triage of #${pr.number}. Requested by @${identity.login}. Prepared by the review runtime ([run](${runUrl})).`,
  ].join("\n");
  const title = result.title ?? `Fix ${checks.join(", ")} on ${baseBranch}`.slice(0, 200);
  const { data: fixPr } = await ghFix.rest.pulls.create({
    ...repo,
    head: result.branch,
    base: baseBranch,
    title,
    body,
  });
  try {
    await ghFix.rest.issues.addAssignees({ ...repo, issue_number: fixPr.number, assignees: [identity.login] });
    await ghFix.rest.pulls.requestReviewers({ ...repo, pull_number: fixPr.number, reviewers: [identity.login] });
  } catch (error) {
    log.warning(`Could not assign the fix PR or request a review: ${errorMessage(error)}`);
  }

  await updateSticky(ctx, pr, (s) => {
    s.fixPrs = [...s.fixPrs, { checks, number: fixPr.number, url: fixPr.html_url }];
    s.attempts = outcome.attempts;
    s.operation = `fix PR against ${baseBranch}`;
    s.notice = null;
  });
  await reply(
    ctx,
    trigger,
    `Opened #${fixPr.number} against ${baseBranch}. Queue the fix PR first, then rebase this pull request.`,
  );

  return makeResult("fix-ci-main", {
    status: "success",
    agentId: outcome.agentId ?? null,
    runId: taskId,
    runUrl,
    attempts: outcome.attempts,
    pushedCommits: check.verified,
    summary: summarize("Archestra fix PR", [`Opened ${fixPr.html_url}`], outcome.attempts),
  });
}
