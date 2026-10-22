// Runs each mode of the action against fake Archestra and GitHub servers
// (msw) and prints what the action sent: the runtime briefs and attachment
// names, the review, and the sticky comment. Usage: npm run local-run
import { setupServer } from "msw/node";
import { parseState } from "../src/github/sticky";
import { run } from "../src/run";
import {
  AGENT_A,
  AGENT_B,
  createHarness,
  FINDING_IN_DIFF,
  FINDING_OUTSIDE,
  issueCommentEvent,
  prEvent,
  reviewJson,
} from "../test/helpers";

const harness = createHarness();
const server = setupServer(...harness.archestra.handlers(), ...harness.github.handlers());
server.listen({ onUnhandledFrame: "error" });
const out: string[] = ["# Local run of code-review-action against fake servers", ""];
const section = (title: string) => out.push("", `## ${title}`, "");
const block = (lang: string, text: string) => out.push(`\`\`\`\`${lang}`, text, "````", "");

try {
  // 1. Review: the first runtime fails with a non-retriable reason, the second completes.
  section("Mode review (pull_request opened)");
  harness.archestra.script(AGENT_A, { end: "TASK_STATE_FAILED", statusReason: "Budget exceeded for this virtual key" });
  harness.archestra.script(AGENT_B, {
    end: "TASK_STATE_COMPLETED",
    files: { "review.json": reviewJson([FINDING_IN_DIFF, FINDING_OUTSIDE]) },
  });
  let result = await run(harness.context("pull_request", prEvent(harness.github)));
  out.push(
    `Result: \`${JSON.stringify({ status: result.status, agentId: result.agentId, findings: result.findingsCount })}\``,
    "",
  );
  out.push("Start requests:", "");
  for (const start of harness.archestra.starts) {
    out.push(
      `- ${start.kind} agent ${start.agentId.slice(0, 8)} runtimeMode=${start.runtimeMode} title=${start.title} attachments=${start.attachmentNames.join(", ")} message=${Buffer.byteLength(start.message)} bytes`,
    );
  }
  out.push("", "Review brief (as sent):", "");
  block("markdown", harness.archestra.starts[0]!.message);
  out.push("Posted review:", "");
  block("json", JSON.stringify(harness.github.reviews[0], null, 2));
  out.push("Sticky comment:", "");
  block(
    "markdown",
    harness.github.stickyBody()!.replace(/<!-- archestra-state:[^>]+ -->/, "<!-- archestra-state:… -->"),
  );

  // 2. Fix: a maintainer comments /archestra fix 1.
  section("Mode fix (/archestra fix 1 keep it small)");
  const state = parseState(harness.github.stickyBody()!)!;
  const commit = "1".repeat(40);
  harness.github.headAfterPush = "e".repeat(40);
  harness.github.branchCommits.set("e".repeat(40), [
    { sha: commit, authorEmail: "1001+maria@users.noreply.github.com" },
  ]);
  harness.archestra.script(AGENT_B, {
    end: "TASK_STATE_COMPLETED",
    files: {
      "fix-result.json": {
        applied: [{ finding: state.findings[0]!.id, commit }],
        skipped: [],
        notes: "Added a delay.",
      },
    },
  });
  result = await run(
    harness.context("issue_comment", issueCommentEvent(harness.github, "/archestra fix 1 keep it small")),
  );
  const fixStart = harness.archestra.starts.at(-1)!;
  out.push(
    `Result: \`${JSON.stringify({ status: result.status, applied: result.applied, pushed: result.pushedCommits })}\``,
    "",
  );
  out.push(`- ${fixStart.kind} of ${fixStart.previousTaskId} with attachments ${fixStart.attachmentNames.join(", ")}`);
  out.push(`- runtime credentials stored: ${JSON.stringify(harness.archestra.credentials)} (value lengths only)`);
  out.push(`- thread mutations: ${JSON.stringify(harness.github.graphqlMutations)}`, "");
  out.push("fix-request.json:", "");
  block("json", fixStart.attachments["fix-request.json"]!);
  out.push("Fix brief (as sent):", "");
  block("markdown", fixStart.message);
  out.push("Reply on the PR:", "");
  block("markdown", [...harness.github.comments.values()].at(-1)!.body);

  // 3. CI triage: /archestra fix-ci.
  section("Mode fix-ci (/archestra fix-ci)");
  harness.github.checkRuns = [
    {
      id: 301,
      name: "test",
      app: "github-actions",
      conclusion: "failure",
      log: "FAIL upload.test.ts\n",
      baseBranchConclusion: "success",
    },
    {
      id: 302,
      name: "lint",
      app: "github-actions",
      conclusion: "failure",
      log: "src/x.ts: unused import\n",
      baseBranchConclusion: "failure",
    },
  ];
  harness.archestra.script(AGENT_B, {
    end: "TASK_STATE_COMPLETED",
    files: {
      "ci-triage.json": {
        failures: [
          { check: "test", class: "flaky", root_cause: "timing", commits: [] },
          { check: "lint", class: "pre_existing", root_cause: "main has an unused import", commits: [] },
        ],
        notes: "",
      },
    },
  });
  result = await run(
    harness.context("issue_comment", issueCommentEvent(harness.github, "/archestra fix-ci", "maria", 9002), {
      "ci-rerun": "true",
    }),
  );
  const ciStart = harness.archestra.starts.at(-1)!;
  out.push(`Result: \`${JSON.stringify({ status: result.status, triage: result.triage })}\``, "");
  out.push(
    `- attachments: ${ciStart.attachmentNames.join(", ")}`,
    `- re-run workflow runs: ${JSON.stringify(harness.github.reruns)}`,
    "",
  );
  out.push("ci-failure.json:", "");
  block("json", ciStart.attachments["ci-failure.json"]!);

  // 4. Fix on main: the maintainer ticks the box of the pre-existing failure.
  section("Mode fix-ci-main (box ticked in the sticky comment)");
  const sticky = [...harness.github.comments.values()].find((comment) =>
    comment.body.includes("<!-- archestra-code-review "),
  )!;
  const ticked = sticky.body.replace(/- \[ \] (Open a fix PR against main for `lint`)/, "- [x] $1");
  const branch = "archestra/fix-ci-lint";
  const mainCommit = "4".repeat(40);
  harness.github.branchCommits.set(branch, [{ sha: mainCommit, authorEmail: "1001+maria@users.noreply.github.com" }]);
  harness.archestra.script(AGENT_B, {
    end: "TASK_STATE_COMPLETED",
    files: {
      "ci-main-fix.json": {
        branch,
        commits: [mainCommit],
        title: "Remove an unused import that fails lint on main",
        summary: "Lint fails on main because of an unused import.",
        reproduction: "pnpm lint: 1 error before, 0 after",
      },
    },
  });
  result = await run(
    harness.context("issue_comment", {
      action: "edited",
      issue: { number: harness.github.pr.number, pull_request: { url: "x" } },
      comment: { id: sticky.id, body: ticked, user: sticky.user },
      changes: { body: { from: sticky.body } },
      sender: { login: "maria", id: 1001, type: "User" },
    }),
  );
  out.push(`Result: \`${JSON.stringify({ status: result.status, pushed: result.pushedCommits })}\``, "");
  out.push("Opened pull request:", "");
  block("json", JSON.stringify(harness.github.createdPulls, null, 2));
  out.push("Final sticky comment:", "");
  block(
    "markdown",
    harness.github.stickyBody()!.replace(/<!-- archestra-state:[^>]+ -->/, "<!-- archestra-state:… -->"),
  );

  // 5. Secret check: the API key and tokens never appear in the log lines.
  section("Secret check");
  const leaked = harness.log.lines.filter((line) => /arch_test_key|ghs_app_token|ghs_job_token/.test(line));
  out.push(`Log lines: ${harness.log.lines.length}. Lines with the API key or a token: ${leaked.length}.`);
  out.push("", "Action log:", "");
  block("text", harness.log.lines.join("\n"));
} finally {
  server.close();
}
console.log(out.join("\n"));
