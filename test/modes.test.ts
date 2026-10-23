import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ArchestraClient } from "../src/archestra/client";
import { MAX_MESSAGE_BYTES } from "../src/briefs";
import { cancelIfLive } from "../src/cancel";
import { collectCiEvidence } from "../src/github/ci";
import { hasWriteAccess } from "../src/github/permissions";
import { parseMarker, parseState } from "../src/github/sticky";
import { run } from "../src/run";
import {
  AGENT_A,
  AGENT_B,
  createHarness,
  FINDING_IN_DIFF,
  FINDING_OUTSIDE,
  issueCommentEvent,
  MemoryLogger,
  mockServer,
  prEvent,
  reviewJson,
  testOctokit,
} from "./helpers";

const server = mockServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function setup() {
  const harness = createHarness();
  server.use(...harness.archestra.handlers(), ...harness.github.handlers());
  return harness;
}

async function reviewed(harness = setup()) {
  harness.archestra.script(AGENT_A, {
    end: "completed",
    files: { "review.json": reviewJson([FINDING_IN_DIFF, FINDING_OUTSIDE]) },
  });
  const result = await run(harness.context("pull_request", prEvent(harness.github)));
  return { harness, result };
}

describe("review mode", () => {
  it("posts inline comments for findings in the diff and a sticky summary", async () => {
    const { harness, result } = await reviewed();
    expect(result).toMatchObject({ status: "success", findingsCount: 2, agentId: AGENT_A });
    const review = harness.github.reviews[0]!;
    expect(review.comments).toHaveLength(1);
    expect(review.comments[0]).toMatchObject({ path: "src/upload.ts", line: 14, start_line: 12, side: "RIGHT" });
    const sticky = harness.github.stickyBody()!;
    expect(parseMarker(sticky)).toMatchObject({
      pr: 7,
      run: result.runId,
      agent: AGENT_A,
      sha: harness.github.pr.head.sha,
    });
    expect(sticky).toContain("(outside the diff)");
    const [commentId] = [...harness.github.reviewComments.keys()];
    expect(parseState(sticky)!.findings.map((finding) => finding.commentId)).toEqual([commentId, null]);
    expect(sticky).toContain(`[1](https://github.com/acme/widgets/pull/7#discussion_r${commentId})`);
    expect(harness.archestra.starts[0]!.attachmentNames).toEqual(["pr.json", "pr.diff"]);
    expect(Buffer.byteLength(harness.archestra.starts[0]!.message)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
  });

  it("skips drafts, [WIP] titles, forks and bot authors", async () => {
    for (const change of [
      (h: ReturnType<typeof setup>) => {
        h.github.pr.draft = true;
      },
      (h: ReturnType<typeof setup>) => {
        h.github.pr.title = "[WIP] retry";
      },
      (h: ReturnType<typeof setup>) => {
        h.github.pr.head.repoFullName = "fork/widgets";
      },
      (h: ReturnType<typeof setup>) => {
        h.github.pr.user = { login: "dependabot[bot]", type: "Bot" };
      },
    ]) {
      const harness = setup();
      change(harness);
      const result = await run(harness.context("pull_request", prEvent(harness.github)));
      expect(result.status).toBe("skipped");
      expect(harness.archestra.starts).toHaveLength(0);
      server.resetHandlers();
    }
  });

  it("falls back to the next runtime and lists the attempts when one fails", async () => {
    const harness = setup();
    harness.archestra.script(AGENT_A, { end: "failed", statusReason: "Budget exceeded" });
    harness.archestra.script(AGENT_B, { end: "completed", files: { "review.json": reviewJson() } });
    const result = await run(harness.context("pull_request", prEvent(harness.github)));
    expect(result.agentId).toBe(AGENT_B);
    expect(result.attempts.map((attempt) => attempt.result)).toEqual(["non_retriable", "completed"]);
    expect(harness.log.lines.some((line) => line.includes("classified from its message"))).toBe(true);
  });

  it("posts 'review unavailable' when all attempts fail, and fails the step with fail-on error", async () => {
    const harness = setup();
    harness.archestra.script(AGENT_A, { start: "http", status: 401 });
    const result = await run(harness.context("pull_request", prEvent(harness.github), { "fail-on": "error" }));
    expect(result.status).toBe("aborted");
    expect(result.failure).toMatch(/unavailable/);
    expect(harness.github.stickyBody()).toContain("Review unavailable");
    expect(harness.archestra.starts).toHaveLength(1);
  });

  it("stores the clone token as the actor's CODE_REVIEW_GITHUB_TOKEN before a review, and nothing without it", async () => {
    const { harness } = await reviewed();
    expect(harness.archestra.credentials).toEqual([]);
    harness.archestra.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson() } });
    harness.github.pr.head.sha = "d".repeat(40);
    await run(
      harness.context("pull_request", prEvent(harness.github, "synchronize"), { "clone-token": "ghs_read_only" }),
    );
    expect(harness.archestra.credentials).toEqual([
      { agentId: AGENT_A, key: "CODE_REVIEW_GITHUB_TOKEN", valueLength: "ghs_read_only".length },
    ]);
  });

  it("moves the findings into the summary when GitHub rejects the inline comments", async () => {
    const harness = setup();
    harness.github.rejectReview = true;
    await reviewed(harness);
    const state = parseState(harness.github.stickyBody()!)!;
    expect(state.findings.every((finding) => !finding.inline)).toBe(true);
  });

  it("continues the last review workspace and reopens regressed threads", async () => {
    const { harness, result } = await reviewed();
    const first = parseState(harness.github.stickyBody()!)!.findings[0]!;
    // A human resolved the thread; the next push regresses the finding.
    harness.github.resolved.add([...harness.github.reviewComments.keys()][0]!);
    harness.github.pr.head.sha = "d".repeat(40);
    harness.archestra.script(AGENT_A, {
      end: "completed",
      files: { "review.json": reviewJson([FINDING_IN_DIFF], { previous: [{ id: first.id, status: "regressed" }] }) },
    });
    await run(harness.context("pull_request", prEvent(harness.github, "synchronize")));
    const second = harness.archestra.starts[1]!;
    expect(second).toMatchObject({ kind: "continue", previousRunId: result.runId });
    expect(second.attachmentNames).toContain("previous-findings.json");
    expect(harness.github.graphqlMutations).toEqual([
      { action: "unresolve", threadId: expect.stringMatching(/^thread-/) },
    ]);
  });

  it("renders what the runtime wrote: coverage, titles, the code of a finding, observations, tests and the verdict", async () => {
    const harness = setup();
    harness.archestra.script(AGENT_A, {
      end: "completed",
      files: {
        "review.json": reviewJson([{ ...FINDING_IN_DIFF, title: "Retries without a pause" }], {
          reviewed: ["The uploader (`src/upload.ts`)"],
          changes: [
            { file: "./src/upload.ts", line: 11, what: "wraps send in a loop" },
            { file: "src/upload.ts", line: 2, what: "a line outside the hunks" },
            { file: "src/other.ts", what: "not in the diff" },
          ],
          observations: ["**Loop bound** (`src/upload.ts`): three attempts is a sane default."],
          tests: [
            { file: "src/upload.ts", focus: "the retry loop" },
            { file: "test/other.test.ts", focus: "not in the diff" },
          ],
          coverage: "The failure after the last attempt has no test.",
          limitations: "No lint: the repository defines none.",
          conclusion: "Fix #1 first.",
        }),
      },
    });
    await run(harness.context("pull_request", prEvent(harness.github)));
    const sticky = harness.github.stickyBody()!;
    expect(sticky).toContain("### Archestra code review: #7 — Add retry to the uploader");
    expect(sticky).toContain("**Reviewed**\n\n- The uploader (`src/upload.ts`)");
    // A "./" prefix still finds the file; a line in the hunks links to the line, a line outside to the file.
    expect(sticky).toMatch(
      /\| \[`src\/upload\.ts:11`\]\(https:\/\/github\.com\/acme\/widgets\/pull\/7\/files#diff-[0-9a-f]{64}R11\) \| wraps send in a loop \|/,
    );
    expect(sticky).toMatch(
      /\| \[`src\/upload\.ts:2`\]\(https:\/\/github\.com\/acme\/widgets\/pull\/7\/files#diff-[0-9a-f]{64}\) \| a line outside the hunks \|/,
    );
    expect(sticky).toContain("| `src/other.ts` | not in the diff |");
    expect(sticky).toContain("| Retries without a pause | open |");
    expect(sticky).toContain("#### 1. Retries without a pause\n\n**File:** [`src/upload.ts:12-14`]");
    // The code at the lines of the finding, from the patch of the fake pull request.
    expect(sticky).toContain("```ts\n    send(a);\n  }\n  return a;\n```");
    expect(sticky).toContain(
      "### Observations\n\n- **Loop bound** (`src/upload.ts`): three attempts is a sane default.",
    );
    expect(sticky).toContain("| [`src/upload.ts`](https://github.com/acme/widgets/pull/7/files#diff-");
    expect(sticky).toContain(") | +3 −1 | the retry loop |\n| `test/other.test.ts` | - | not in the diff |");
    expect(sticky).toContain("### Limitations\n\nNo lint: the repository defines none.");
    expect(sticky).toContain("### Verdict\n\nFix #1 first.");
    const [comment] = [...harness.github.reviewComments.values()];
    expect(comment!.body).toContain(
      `**1. [${FINDING_IN_DIFF.severity}] Retries without a pause**\n\n${FINDING_IN_DIFF.summary}\n\n`,
    );
    expect(parseState(sticky)!.findings[0]!.excerpt).toBe("    send(a);\n  }\n  return a;");
  });

  it("replies that a finding is fixed when it may not resolve its thread", async () => {
    const { harness } = await reviewed();
    const first = parseState(harness.github.stickyBody()!)!.findings[0]!;
    const [commentId] = [...harness.github.reviewComments.keys()];
    harness.github.threadMutationsForbidden = true;
    harness.github.pr.head.sha = "d".repeat(40);
    harness.archestra.script(AGENT_A, {
      end: "completed",
      files: { "review.json": reviewJson([], { previous: [{ id: first.id, status: "fixed" }] }) },
    });
    await run(harness.context("pull_request", prEvent(harness.github, "synchronize")));
    expect(harness.github.graphqlMutations).toEqual([]);
    expect(harness.github.resolved.has(commentId!)).toBe(false);
    const replies = [...harness.github.reviewComments.values()].filter((comment) => comment.inReplyTo === commentId);
    expect(replies.map((comment) => comment.body)).toEqual([
      "Fixed in `ddddddd`: the re-review no longer finds this problem.",
    ]);
    expect(harness.log.lines.some((line) => line.includes("Could not resolve the thread"))).toBe(true);
  });

  it("quotes the code of a finding in the diff with post: comment, when no inline comment is posted", async () => {
    const harness = setup();
    harness.archestra.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson([FINDING_IN_DIFF]) } });
    await run(harness.context("pull_request", prEvent(harness.github), { post: "comment" }));
    expect(harness.github.reviews).toHaveLength(0);
    const state = parseState(harness.github.stickyBody()!)!;
    expect(state.findings[0]).toMatchObject({
      inline: false,
      commentId: null,
      excerpt: "    send(a);\n  }\n  return a;",
    });
  });

  it("shows no commands when fix-commands is false", async () => {
    const harness = setup();
    harness.archestra.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson([FINDING_IN_DIFF]) } });
    await run(harness.context("pull_request", prEvent(harness.github), { "fix-commands": "false" }));
    const sticky = harness.github.stickyBody()!;
    expect(sticky).not.toContain("### Next");
    expect(sticky).not.toContain("/archestra fix");
    expect(sticky).not.toContain("Only users with write access");
    const [comment] = [...harness.github.reviewComments.values()];
    expect(comment!.body).not.toContain("To implement and push this fix");
    expect(comment!.body).toContain("<!-- archestra-finding:");
  });

  it("rewrites the inline comment of a finding reported before, and posts only the new ones", async () => {
    const { harness } = await reviewed();
    const first = parseState(harness.github.stickyBody()!)!.findings[0]!;
    const [commentId] = [...harness.github.reviewComments.keys()];
    harness.github.pr.head.sha = "d".repeat(40);
    harness.archestra.script(AGENT_A, {
      end: "completed",
      files: {
        "review.json": reviewJson(
          [
            { ...FINDING_IN_DIFF, severity: "medium", previous_id: first.id },
            {
              ...FINDING_IN_DIFF,
              line: 13,
              end_line: 13,
              summary: "The loop never ends on a 500.",
              suggestion: undefined,
            },
          ],
          { previous: [{ id: first.id, status: "still_present" }] },
        ),
      },
    });
    await run(harness.context("pull_request", prEvent(harness.github, "synchronize")));
    expect(harness.github.reviewCommentUpdates).toEqual([commentId]);
    const rewritten = harness.github.reviewComments.get(commentId!)!.body;
    expect(rewritten).toContain("**1. [medium] Retries do not wait between attempts.**");
    expect(rewritten).toContain(`<!-- archestra-finding:${first.id} -->`);
    // The thread sits on lines 12-14, the finding's lines: the suggestion applies and stays.
    expect(rewritten).toContain("```suggestion");
    expect(harness.github.reviews).toHaveLength(2);
    expect(harness.github.reviews[1]!.comments).toHaveLength(1);
    expect(harness.github.reviews[1]!.body).toContain("2 findings (1 new; the others were updated in place)");
    expect(harness.github.reviewComments.size).toBe(2);
    const state = parseState(harness.github.stickyBody()!)!;
    expect(state.findings.map((finding) => [finding.id, finding.n])).toEqual([
      [first.id, 1],
      ["ddddddd-2", 2],
    ]);
    // The kept finding keeps its comment; the new one gets the comment the review created.
    expect(state.findings.map((finding) => finding.commentId)).toEqual([...harness.github.reviewComments.keys()]);
  });

  it("pairs a repeated finding by file and summary when the runtime gives no previous_id, and posts no review", async () => {
    const { harness } = await reviewed();
    const ids = parseState(harness.github.stickyBody()!)!.findings.map((finding) => finding.id);
    harness.github.pr.head.sha = "d".repeat(40);
    harness.archestra.script(AGENT_A, {
      end: "completed",
      files: { "review.json": reviewJson([{ ...FINDING_IN_DIFF, end_line: 13 }, FINDING_OUTSIDE]) },
    });
    await run(harness.context("pull_request", prEvent(harness.github, "synchronize")));
    expect(harness.github.reviews).toHaveLength(1);
    expect(harness.github.reviewCommentUpdates).toHaveLength(1);
    expect(parseState(harness.github.stickyBody()!)!.findings.map((finding) => finding.id)).toEqual(ids);
    // The finding now ends on line 13 while the comment sits on 12-14: the suggestion would land wrong.
    const rewritten = [...harness.github.reviewComments.values()][0]!.body;
    expect(rewritten).toContain(`<!-- archestra-finding:${ids[0]} -->`);
    expect(rewritten).not.toContain("```suggestion");
  });

  it("rewrites the comment of a kept finding whose lines left the diff, and records the comment", async () => {
    const { harness } = await reviewed();
    const first = parseState(harness.github.stickyBody()!)!.findings[0]!;
    harness.github.pr.head.sha = "d".repeat(40);
    harness.archestra.script(AGENT_A, {
      end: "completed",
      files: {
        "review.json": reviewJson([
          { ...FINDING_IN_DIFF, line: 3, end_line: 3, suggestion: undefined, previous_id: first.id },
        ]),
      },
    });
    await run(harness.context("pull_request", prEvent(harness.github, "synchronize")));
    expect(harness.github.reviews).toHaveLength(1);
    expect(harness.github.reviewCommentUpdates).toHaveLength(1);
    const sticky = harness.github.stickyBody()!;
    const finding = parseState(sticky)!.findings[0]!;
    expect(finding).toMatchObject({ id: first.id, line: 3, inline: false, commentId: first.commentId });
    // The location links to the file, not to a diff line that does not exist; the comment carries the scenario.
    expect(sticky).toContain(`/blob/${"d".repeat(40)}/src/upload.ts#L3) (outside the diff)`);
    expect(sticky).not.toContain("Findings outside the diff");
  });

  it("posts a new inline comment when a person deleted the old one", async () => {
    const { harness } = await reviewed();
    const first = parseState(harness.github.stickyBody()!)!.findings[0]!;
    harness.github.goneComments.add(first.commentId!);
    harness.github.pr.head.sha = "d".repeat(40);
    harness.archestra.script(AGENT_A, {
      end: "completed",
      files: { "review.json": reviewJson([{ ...FINDING_IN_DIFF, previous_id: first.id }]) },
    });
    await run(harness.context("pull_request", prEvent(harness.github, "synchronize")));
    expect(harness.github.reviews).toHaveLength(2);
    expect(harness.github.reviews[1]!.comments).toHaveLength(1);
    const finding = parseState(harness.github.stickyBody()!)!.findings[0]!;
    expect(finding.id).toBe(first.id);
    expect(finding.commentId).toBe([...harness.github.reviewComments.keys()][1]);
  });

  it("posts a new inline comment when the old one is outdated", async () => {
    const { harness } = await reviewed();
    const first = parseState(harness.github.stickyBody()!)!.findings[0]!;
    harness.github.outdated.add([...harness.github.reviewComments.keys()][0]!);
    harness.github.pr.head.sha = "d".repeat(40);
    harness.archestra.script(AGENT_A, {
      end: "completed",
      files: { "review.json": reviewJson([{ ...FINDING_IN_DIFF, previous_id: first.id }]) },
    });
    await run(harness.context("pull_request", prEvent(harness.github, "synchronize")));
    expect(harness.github.reviewCommentUpdates).toEqual([]);
    expect(harness.github.reviews).toHaveLength(2);
    expect(harness.github.reviews[1]!.comments[0]).toMatchObject({ body: expect.stringContaining(first.id) });
  });

  it("keeps every job of the pull request in the review comment", async () => {
    const harness = setup();
    harness.archestra.script(AGENT_A, { end: "failed", statusReason: "Budget exceeded" });
    harness.archestra.script(AGENT_B, { end: "completed", files: { "review.json": reviewJson([FINDING_IN_DIFF]) } });
    await run(harness.context("pull_request", prEvent(harness.github)));
    harness.github.pr.head.sha = "d".repeat(40);
    harness.archestra.script(AGENT_B, { end: "completed", files: { "review.json": reviewJson([FINDING_IN_DIFF]) } });
    await run(harness.context("pull_request", prEvent(harness.github, "synchronize")));
    const sticky = harness.github.stickyBody()!;
    const state = parseState(sticky)!;
    expect(
      state.jobs.map((job) => [
        job.label,
        job.outcome,
        job.attempts.map((attempt) => [attempt.agentId, attempt.result, attempt.continued]),
      ]),
    ).toEqual([
      [
        "review of aaaaaaa",
        "changes requested, 1 finding",
        [
          [AGENT_A, "non_retriable", false],
          [AGENT_B, "completed", false],
        ],
      ],
      ["review of ddddddd", "changes requested, 1 finding", [[AGENT_B, "completed", true]]],
    ]);
    expect(state.jobs.every((job) => job.startedAt && job.workflowRunUrl)).toBe(true);
    expect(sticky).toContain("History: 2 jobs (3 attempts)");
    expect(sticky).not.toContain("completed: completed");
  });
});

describe("triage command", () => {
  it("appears only when the reviewed commit has failing checks", async () => {
    const { harness } = await reviewed();
    expect(harness.github.stickyBody()).not.toContain("/archestra fix-ci");
    harness.github.checkRuns = [
      {
        id: 301,
        name: "test",
        app: "github-actions",
        conclusion: "failure",
        log: "FAIL\n",
        baseBranchConclusion: "success",
      },
      {
        id: 302,
        name: "lint",
        app: "github-actions",
        conclusion: "timed_out",
        log: "",
        baseBranchConclusion: "success",
      },
      {
        id: 303,
        name: "build",
        app: "github-actions",
        conclusion: "success",
        log: "",
        baseBranchConclusion: "success",
      },
    ];
    harness.github.pr.head.sha = "d".repeat(40);
    harness.archestra.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson([FINDING_IN_DIFF]) } });
    await run(harness.context("pull_request", prEvent(harness.github, "synchronize")));
    const body = harness.github.stickyBody()!;
    expect(body).toContain("- Comment `/archestra fix-ci` to triage and fix the 2 failing checks.");
    expect(body).toContain("| # | Severity | Location | Finding | Status |");
    expect(body).toContain(FINDING_IN_DIFF.recommendation);
    expect(parseState(body)?.failingChecks).toBe(2);
  });
});

describe("progress comment", () => {
  it("posts the sticky comment at start with the Archestra logo, updates the step, and ends with the duration", async () => {
    const { harness, result } = await reviewed();
    const history = harness.github.stickyHistory;
    expect(history.length).toBeGreaterThanOrEqual(3);
    expect(history[0]).toContain("**Archestra is reviewing `");
    expect(history[0]).toContain("for @alice…**");
    expect(history[0]).toContain('<img src="https://avatars.githubusercontent.com/u/');
    expect(history[0]).toContain("- preparing the inputs");
    expect(history.some((body) => body.includes("- starting a run on agent 1 of 3"))).toBe(true);
    expect(
      history.some((body) =>
        body.includes("- waiting for the runtime to finish ([run](https://archestra.test/chat/runs/"),
      ),
    ).toBe(true);
    const last = history.at(-1)!;
    expect(last).toMatch(
      /\*\*Archestra reviewed `[0-9a-f]{7}` for @alice in [0-9]+ (s|min [0-9]+ s)\*\* —— \[View job\]\(https:\/\/github\.com\/acme\/widgets\/actions\/runs\/1\)/,
    );
    expect(last).not.toContain("<img");
    expect(parseState(last)?.progress).toBeNull();
    expect(result.status).toBe("success");
    // One comment throughout: created once, then updated.
    expect(harness.github.comments.size).toBe(1);
  });

  it("shows the fallback steps when the first agent fails", async () => {
    const harness = setup();
    harness.archestra.script(AGENT_A, { end: "failed", statusReason: "Budget exceeded" });
    harness.archestra.script(AGENT_B, { end: "completed", files: { "review.json": reviewJson() } });
    await run(harness.context("pull_request", prEvent(harness.github)));
    const steps = harness.github.stickyHistory.map((body) => body.split("\n")[3] ?? "");
    expect(steps).toContain("- starting a run on agent 1 of 3 (`11111111`)");
    expect(steps).toContain("- the run failed; moving to the next agent");
    expect(steps).toContain("- starting a run on agent 2 of 3 (`22222222`)");
    // The failed run's link does not stick to the next agent's steps.
    expect(steps.filter((step) => step.includes("[run]")).length).toBe(2);
  });

  it("uses the requester's login and the fix wording for a fix", async () => {
    const { harness } = await reviewed();
    harness.archestra.script(AGENT_A, {
      end: "completed",
      files: { "fix-result.json": { applied: [], skipped: [], notes: "" } },
    });
    await run(harness.context("issue_comment", issueCommentEvent(harness.github, "/archestra fix")));
    const history = harness.github.stickyHistory;
    expect(history.some((body) => body.includes("**Archestra is applying 2 findings for @maria…**"))).toBe(true);
    expect(history.at(-1)).toContain("**Archestra applied 0 of 2 findings for @maria in ");
  });
});

describe("identity", () => {
  it("skips with a warning when the actor has no token and there is no fallback", async () => {
    const harness = setup();
    const result = await run(harness.context("pull_request", prEvent(harness.github), { "archestra-token": "" }));
    expect(result).toMatchObject({ status: "skipped", mode: "review" });
    expect(result.summary).toContain("No Archestra token for this actor");
    expect(harness.archestra.calls).toEqual([]);
  });

  it("uses the fallback token and the fallback agents when the actor has no token", async () => {
    const harness = setup();
    harness.archestra.script(AGENT_B, { end: "completed", files: { "review.json": reviewJson() } });
    const result = await run(
      harness.context("pull_request", prEvent(harness.github), {
        "archestra-token": "",
        "fallback-token": harness.archestra.otherToken,
        "fallback-agents": AGENT_B,
      }),
    );
    expect(result).toMatchObject({ status: "success", agentId: AGENT_B });
    expect(harness.archestra.starts.map((start) => start.token)).toEqual([harness.archestra.otherToken]);
    expect(harness.log.lines.some((line) => line.includes("use the fallback token"))).toBe(true);
  });

  it("starts a fresh run under the requester's token when another person asks for a fix", async () => {
    const { harness, result: review } = await reviewed();
    harness.archestra.script(AGENT_A, {
      end: "completed",
      files: { "fix-result.json": { applied: [], skipped: [], notes: "" } },
    });
    await run(
      harness.context("issue_comment", issueCommentEvent(harness.github, "/archestra fix"), {
        "archestra-token": harness.archestra.otherToken,
      }),
    );
    expect(harness.archestra.starts[1]).toMatchObject({
      kind: "start",
      agentId: AGENT_A,
      token: harness.archestra.otherToken,
    });
    expect(harness.archestra.starts[1]!.runId).not.toBe(review.runId);
    expect(harness.archestra.credentials).toEqual([
      { agentId: AGENT_A, key: "CODE_REVIEW_GITHUB_TOKEN", valueLength: "ghs_app_token".length },
    ]);
  });
});

describe("fix mode", () => {
  it("rejects a sender without write access", async () => {
    const { harness } = await reviewed();
    const result = await run(
      harness.context("issue_comment", issueCommentEvent(harness.github, "/archestra fix", "reader")),
    );
    expect(result.status).toBe("unauthorized");
    expect(harness.archestra.starts).toHaveLength(1);
  });

  it("continues the review run, verifies the commits, resolves the thread and updates the sticky comment", async () => {
    const { harness, result: review } = await reviewed();
    const state = parseState(harness.github.stickyBody()!)!;
    const [inDiff, outside] = state.findings;
    const good = "1".repeat(40);
    const foreign = "2".repeat(40);
    harness.github.headAfterPush = "e".repeat(40);
    harness.github.branchCommits.set("e".repeat(40), [
      { sha: good, authorEmail: "1001+maria@users.noreply.github.com" },
      { sha: foreign, authorEmail: "bot@example.com" },
    ]);
    harness.archestra.script(AGENT_A, {
      end: "completed",
      files: {
        "fix-result.json": {
          applied: [
            { finding: inDiff!.id, commit: good },
            { finding: outside!.id, commit: foreign },
          ],
          skipped: [],
          notes: "",
        },
      },
    });
    const result = await run(
      harness.context("issue_comment", issueCommentEvent(harness.github, "/archestra fix 1,2 keep it small")),
    );

    const fixStart = harness.archestra.starts[1]!;
    expect(fixStart).toMatchObject({ kind: "continue", previousRunId: review.runId });
    const request = JSON.parse(fixStart.attachments["fix-request.json"]!);
    expect(request).toMatchObject({
      branch: "feature/retry",
      author: { name: "Maria Lopez", email: "1001+maria@users.noreply.github.com" },
      maintainerNote: "keep it small",
    });
    expect(fixStart.message).toContain('git config user.email "1001+maria@users.noreply.github.com"');
    expect(harness.archestra.credentials).toEqual([
      { agentId: AGENT_A, key: "CODE_REVIEW_GITHUB_TOKEN", valueLength: "ghs_app_token".length },
    ]);

    expect(result.pushedCommits).toEqual([good]);
    expect(result.applied).toEqual([{ finding: inDiff!.id, commit: good }]);
    expect(result.skipped[0]).toMatchObject({ finding: outside!.id, reason: expect.stringContaining("not verified") });
    expect(harness.github.graphqlMutations).toEqual([{ action: "resolve", threadId: expect.any(String) }]);
    const sticky = harness.github.stickyBody()!;
    expect(sticky).toContain("on behalf of @maria");
    expect(parseState(sticky)!.findings.map((finding) => finding.status)).toEqual(["applied", "skipped"]);
    expect(harness.github.reactions).toEqual([{ commentId: 9001, content: "eyes" }]);
  });

  it("waits while the workspace is busy, then continues", async () => {
    const { harness, result: review } = await reviewed();
    harness.archestra.busyContinues.set(review.runId!, 2);
    harness.archestra.script(AGENT_A, {
      end: "completed",
      files: { "fix-result.json": { applied: [], skipped: [], notes: "" } },
    });
    await run(harness.context("issue_comment", issueCommentEvent(harness.github, "/archestra fix")));
    expect(harness.archestra.starts[1]).toMatchObject({ kind: "continue" });
    expect(harness.clock.sleeps.filter((ms) => ms === 30_000).length).toBeGreaterThanOrEqual(2);
  });

  it("starts a fresh run on the same agent when the workspace is no longer retained", async () => {
    const { harness, result: review } = await reviewed();
    harness.archestra.expiredWorkspaces.add(review.runId!);
    harness.archestra.script(AGENT_A, {
      end: "completed",
      files: { "fix-result.json": { applied: [], skipped: [], notes: "" } },
    });
    await run(harness.context("issue_comment", issueCommentEvent(harness.github, "/archestra fix")));
    expect(harness.archestra.starts[1]).toMatchObject({ kind: "start", agentId: AGENT_A });
    expect(harness.archestra.starts[1]!.attachmentNames).toEqual(["fix-request.json", "pr.json", "pr.diff"]);
  });
});

describe("fix-ci and fix-ci-main modes", () => {
  function withFailingChecks(harness: ReturnType<typeof setup>) {
    harness.github.checkRuns = [
      {
        id: 301,
        name: "test",
        app: "github-actions",
        conclusion: "failure",
        log: "ok\nFAIL upload.test.ts\n",
        baseBranchConclusion: "success",
      },
      {
        id: 302,
        name: "lint",
        app: "github-actions",
        conclusion: "failure",
        log: "lint error",
        baseBranchConclusion: "failure",
      },
      {
        id: 303,
        name: "external",
        app: "codecov",
        conclusion: "failure",
        summary: "Coverage dropped",
        annotations: [
          { path: "src/upload.ts", start_line: 1, end_line: 1, annotation_level: "failure", message: "uncovered" },
        ],
      },
    ];
  }

  it("triages, verifies the fix commit and offers a fix PR for the pre-existing failure", async () => {
    const { harness } = await reviewed();
    withFailingChecks(harness);
    const fixCommit = "3".repeat(40);
    harness.github.headAfterPush = "f".repeat(40);
    harness.github.branchCommits.set("f".repeat(40), [
      { sha: fixCommit, authorEmail: "1001+maria@users.noreply.github.com" },
    ]);
    harness.archestra.script(AGENT_A, {
      end: "completed",
      files: {
        "ci-triage.json": {
          failures: [
            { check: "test", class: "pr_caused", root_cause: "no await", commits: [fixCommit] },
            { check: "lint", class: "pre_existing", root_cause: "main has a lint error", commits: [] },
            { check: "external", class: "needs_human", root_cause: "coverage", commits: [] },
          ],
          notes: "",
        },
      },
    });
    const result = await run(harness.context("issue_comment", issueCommentEvent(harness.github, "/archestra fix-ci")));
    const start = harness.archestra.starts[1]!;
    expect(start.attachmentNames).toEqual(
      expect.arrayContaining(["ci-failure.json", "ci-log-test.log", "ci-log-lint.log"]),
    );
    const evidence = JSON.parse(start.attachments["ci-failure.json"]!);
    expect(evidence.failures.find((f: { name: string }) => f.name === "lint").baseBranchResult).toMatchObject({
      conclusion: "failure",
    });
    expect(evidence.failures.find((f: { name: string }) => f.name === "external").annotations).toHaveLength(1);
    expect(result.pushedCommits).toEqual([fixCommit]);
    const sticky = harness.github.stickyBody()!;
    expect(sticky).toContain("- Comment `/archestra fix-ci-main 2` to open a fix PR against main for `lint`.");

    // The command opens a fix PR against main.
    const branch = "archestra/fix-ci-lint";
    const mainCommit = "4".repeat(40);
    harness.github.branchCommits.set(branch, [{ sha: mainCommit, authorEmail: "1001+maria@users.noreply.github.com" }]);
    harness.archestra.script(AGENT_A, {
      end: "completed",
      files: {
        "ci-main-fix.json": {
          branch,
          commits: [mainCommit],
          summary: "Fix the lint error",
          reproduction: "pnpm lint: fails, then passes",
        },
      },
    });
    const mainResult = await run(
      harness.context("issue_comment", issueCommentEvent(harness.github, "/archestra fix-ci-main 2")),
    );
    expect(mainResult.status).toBe("success");
    expect(harness.github.createdPulls[0]).toMatchObject({ head: branch, base: "main" });
    expect(harness.github.assignees[0]).toMatchObject({ assignees: ["maria"] });
    const after = harness.github.stickyBody()!;
    expect(after).toContain("Queue the fix PR first, then rebase this pull request.");
    expect(after).not.toContain("to open a fix PR against main for `lint`");
  });

  it("caps the log tail per job", async () => {
    const harness = setup();
    harness.github.checkRuns = [
      { id: 401, name: "big", app: "github-actions", conclusion: "failure", log: `${"x".repeat(300_000)}END` },
    ];
    const { logs, evidence } = await collectCiEvidence(
      testOctokit("t"),
      { owner: "acme", repo: "widgets" },
      {
        headSha: "a".repeat(40),
        baseBranch: "main",
        log: new MemoryLogger(),
        logCapBytes: 200 * 1024,
      },
    );
    expect(logs[0]!.content.byteLength).toBe(200 * 1024);
    expect(logs[0]!.content.toString().endsWith("END")).toBe(true);
    expect(evidence.failures[0]).toMatchObject({ logTruncated: true, log: "ci-log-big.log" });
  });
});

describe("permission check", () => {
  it("accepts admin, maintain and write; rejects read and non-collaborators", async () => {
    const harness = setup();
    harness.github.collaborators = { a: "admin", m: "maintain", w: "write", t: "triage", r: "read" };
    const gh = testOctokit("t");
    const repo = { owner: "acme", repo: "widgets" };
    const results = await Promise.all(
      ["a", "m", "w", "t", "r", "nobody"].map((user) => hasWriteAccess(gh, repo, user)),
    );
    expect(results).toEqual([true, true, true, false, false, false]);
  });
});

describe("post step", () => {
  it("cancels a live run and leaves a finished one alone", async () => {
    const harness = setup();
    harness.archestra.script(AGENT_A, { end: "never" });
    const client = new ArchestraClient({ gatewayUrl: harness.archestra.gatewayUrl, token: harness.archestra.token });
    const { runId } = await client.startRun(AGENT_A, { message: "m", attachments: [] });
    expect(await cancelIfLive(client, runId, new MemoryLogger())).toBe("canceled");
    expect(await cancelIfLive(client, runId, new MemoryLogger())).toBe("not-live");
    expect(harness.archestra.cancels).toEqual([runId]);
  });
});
