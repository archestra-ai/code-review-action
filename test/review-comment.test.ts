import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { exchangeGitHubActionsToken, tokenEndpoint } from "../src/archestra/github-actions-auth";
import { isTransient } from "../src/github/octokit";
import { resolvedReviewBody, verdictFor } from "../src/github/review";
import { checklistTitle, parseState } from "../src/github/sticky";
import { reviewBody, summaryWords } from "../src/modes/review";
import { run } from "../src/run";
import { recordStoppedJob, type SavedJob } from "../src/stopped";
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

const NIT = { ...FINDING_OUTSIDE, severity: "nit", title: "Two names for one timeout" };

describe("verdict", () => {
  it("follows from the severities, so the same findings always get the same verdict", () => {
    expect(verdictFor([])).toBe("approve");
    expect(verdictFor([{ severity: "nit" }])).toBe("comment");
    expect(verdictFor([{ severity: "low" }, { severity: "nit" }])).toBe("comment");
    expect(verdictFor([{ severity: "low" }, { severity: "medium" }])).toBe("request_changes");
  });

  it("ignores the runtime's verdict: a single nit never blocks the merge", async () => {
    const harness = setup();
    harness.archestra.script(AGENT_A, {
      end: "completed",
      files: { "review.json": { ...reviewJson([NIT]), verdict: "request_changes" } },
    });
    await run(harness.context("pull_request", prEvent(harness.github)));
    const sticky = harness.github.stickyBody()!;
    expect(sticky).toContain("**Nothing blocks the merge** · reviewed `aaaaaaa` · 1 finding: 1 nit");
    expect(parseState(sticky)!.jobs.at(-1)!.outcome).toBe("commented, 1 finding");
  });

  it("gives the summary a word budget that grows with the change", () => {
    expect([10, 51, 401, 2001].map(summaryWords)).toEqual([60, 120, 200, 300]);
  });

  it("links the review to the review comment and names it the summary", () => {
    expect(
      reviewBody(
        "d".repeat(40),
        "comment",
        [{ severity: "nit" }],
        1,
        0,
        "https://github.com/a/b/pull/7#issuecomment-9",
      ),
    ).toBe(
      "**Nothing blocks the merge** · Archestra review of `ddddddd` · 1 finding: 1 nit. [Summary](https://github.com/a/b/pull/7#issuecomment-9)",
    );
  });
});

describe("re-review", () => {
  it("leads with what changed since the last reviewed commit, with the evidence of each fix", async () => {
    const harness = setup();
    harness.archestra.script(AGENT_A, {
      end: "completed",
      files: { "review.json": reviewJson([{ ...FINDING_IN_DIFF, title: "Retries without a pause" }, FINDING_OUTSIDE]) },
    });
    await run(harness.context("pull_request", prEvent(harness.github)));
    const [first, second] = parseState(harness.github.stickyBody()!)!.findings;
    harness.github.pr.head.sha = "d".repeat(40);
    harness.archestra.script(AGENT_A, {
      end: "completed",
      files: {
        "review.json": reviewJson([{ ...FINDING_OUTSIDE, previous_id: second!.id }, NIT], {
          previous: [
            { id: first!.id, status: "fixed", note: "src/upload.ts:13 waits between attempts." },
            { id: second!.id, status: "still_present" },
          ],
        }),
      },
    });
    await run(harness.context("pull_request", prEvent(harness.github, "synchronize")));
    const sticky = harness.github.stickyBody()!;
    expect(sticky).toContain(
      "**Since `aaaaaaa`:** 1 fixed · 1 still open · 1 new\n- Fixed: Retries without a pause (high): src/upload.ts:13 waits between attempts.\n",
    );
    // The brief asks for a summary of what changed since the last reviewed commit.
    expect(harness.archestra.starts[1]!.message).toContain(`The last review covered ${"a".repeat(40)}`);
    expect(harness.archestra.starts[0]!.message).toContain("This is the first review of this pull request.");
  });
});

describe("change requests", () => {
  it("requests changes for a blocking finding, and dismisses the request once nothing blocks", async () => {
    const harness = setup();
    const inputs = { "review-event": "request-changes" };
    harness.archestra.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson([FINDING_IN_DIFF]) } });
    await run(harness.context("pull_request", prEvent(harness.github), inputs));
    expect(harness.github.reviews.map((review) => review.event)).toEqual(["REQUEST_CHANGES"]);
    expect(harness.github.reviews[0]!.body).toContain("<!-- archestra-review -->");

    harness.github.pr.head.sha = "d".repeat(40);
    harness.archestra.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson([NIT]) } });
    await run(harness.context("pull_request", prEvent(harness.github, "synchronize"), inputs));
    // The nit is outside the diff: no new review, and the old change request no longer blocks.
    expect(harness.github.reviews).toHaveLength(1);
    expect(harness.github.dismissed).toEqual([701]);
    // GitHub shows a dismissed review as a plain comment; its first words say what it was.
    expect(harness.github.reviews[0]!.body).toMatch(
      /^\*\*Changes requested, resolved in `ddddddd`\*\* · Archestra review of `[0-9a-f]{7}` · /,
    );
    expect(harness.github.reviews[0]!.body).toContain("<!-- archestra-review -->");
  });

  it("marks a dismissed change request without a verdict label as resolved", () => {
    expect(resolvedReviewBody("Old review body\n\n<!-- archestra-review -->", "ddddddd")).toBe(
      "**Changes requested, resolved in `ddddddd`** · Old review body\n\n<!-- archestra-review -->",
    );
  });

  it("posts a comment review when GitHub refuses the change request, so no finding loses its inline comment", async () => {
    const harness = setup();
    harness.github.refuseChangeRequests = true;
    harness.archestra.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson([FINDING_IN_DIFF]) } });
    await run(harness.context("pull_request", prEvent(harness.github), { "review-event": "request-changes" }));
    expect(harness.github.reviews.map((review) => review.event)).toEqual(["COMMENT"]);
    expect(parseState(harness.github.stickyBody()!)!.findings[0]).toMatchObject({ inline: true });
    expect(parseState(harness.github.stickyBody()!)!.findings[0]!.commentId).not.toBeNull();
  });

  it("posts only comment reviews by default", async () => {
    const harness = setup();
    harness.archestra.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson([FINDING_IN_DIFF]) } });
    await run(harness.context("pull_request", prEvent(harness.github)));
    expect(harness.github.reviews.map((review) => review.event)).toEqual(["COMMENT"]);
  });
});

describe("GitHub Actions sign-in", () => {
  const gatewayUrl = "https://archestra.test/v1/mcp/11111111-1111-4111-8111-111111111111";
  const getIdToken = async (audience: string) => `oidc-for-${audience}`;

  it("trades the job's identity token for the author's Archestra token and the App's GitHub token", async () => {
    let request: unknown = null;
    server.use(
      http.post(tokenEndpoint(gatewayUrl), async ({ request: req }) => {
        request = await req.json();
        return HttpResponse.json({ access_token: "arch-1", github_token: "ghs-app", github_login: "alice" });
      }),
    );
    const result = await exchangeGitHubActionsToken({ gatewayUrl, getIdToken, retryDelaysMs: [] });
    expect(result).toEqual({ ok: true, accessToken: "arch-1", githubToken: "ghs-app", githubLogin: "alice" });
    // The audience is the deployment, and the resource names the gateway.
    expect(request).toEqual({ token: "oidc-for-https://archestra.test", resource: gatewayUrl });
  });

  it("passes on why Archestra refused, and retries a server error once", async () => {
    let calls = 0;
    server.use(
      http.post(tokenEndpoint(gatewayUrl), () => {
        calls++;
        return calls === 1
          ? HttpResponse.json({ error: "server_error" }, { status: 503 })
          : HttpResponse.json(
              { error: "not_linked", login: "bob", message: "Connect GitHub under Credentials in Archestra." },
              { status: 403 },
            );
      }),
    );
    const result = await exchangeGitHubActionsToken({ gatewayUrl, getIdToken, retryDelaysMs: [0] });
    expect(result).toEqual({
      ok: false,
      reason: "not_linked",
      message: "Connect GitHub under Credentials in Archestra.",
      login: "bob",
    });
    expect(calls).toBe(2);
  });

  it("asks for a fresh identity token on each try", async () => {
    const tokens: string[] = [];
    server.use(
      http.post(tokenEndpoint(gatewayUrl), async ({ request: req }) => {
        tokens.push(((await req.json()) as { token: string }).token);
        return tokens.length === 1
          ? HttpResponse.json({ error: "rate_limited" }, { status: 429 })
          : HttpResponse.json({ access_token: "arch-2" });
      }),
    );
    let n = 0;
    const result = await exchangeGitHubActionsToken({
      gatewayUrl,
      getIdToken: async () => `oidc-${++n}`,
      retryDelaysMs: [0],
    });
    expect(result).toMatchObject({ ok: true, accessToken: "arch-2" });
    expect(tokens).toEqual(["oidc-1", "oidc-2"]);
  });

  it("says nothing when someone other than the author started the run", async () => {
    const harness = setup();
    const result = await run({
      ...harness.context("pull_request", prEvent(harness.github, "synchronize"), {
        "archestra-auth": "github-actions",
      }),
      signIn: refusedBy({ reason: "not_author", message: "started by bob", login: "alice" }),
    });
    expect(result.status).toBe("skipped");
    expect(harness.github.stickyBody()).toBeNull();
  });

  it("explains a job without an identity token", async () => {
    const result = await exchangeGitHubActionsToken({
      gatewayUrl,
      getIdToken: async () => {
        throw new Error("Unable to get ACTIONS_ID_TOKEN_REQUEST_URL env variable");
      },
    });
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    expect(!result.ok && result.message).toContain("id-token: write");
  });

  function refusedBy(refusal: {
    reason: "not_linked" | "not_author" | "unavailable";
    message: string;
    login: string | null;
  }) {
    return async () => ({ ok: false as const, refusal });
  }

  it("tells an author who has not connected GitHub why there is no review, without failing the job", async () => {
    const harness = setup();
    const ctx = {
      ...harness.context("pull_request", prEvent(harness.github), { "archestra-auth": "github-actions" }),
      signIn: refusedBy({
        reason: "not_linked",
        message: "@alice has not connected GitHub to Archestra.",
        login: "alice",
      }),
    };
    const result = await run(ctx);
    expect(result).toMatchObject({ status: "unauthorized", failure: null });
    expect(harness.archestra.starts).toHaveLength(0);
    expect(harness.github.stickyBody()).toContain(
      "> No review of `aaaaaaa`: @alice has not connected GitHub to Archestra.",
    );
  });

  it("says nothing on a pull request that is never reviewed, and fails the job when the sign-in failed", async () => {
    const harness = setup();
    const inputs = { "archestra-auth": "github-actions" };
    harness.github.pr.draft = true;
    const draft = await run({
      ...harness.context("pull_request", prEvent(harness.github), inputs),
      signIn: refusedBy({ reason: "not_linked", message: "not connected", login: "alice" }),
    });
    expect(draft.status).toBe("skipped");
    expect(harness.github.stickyBody()).toBeNull();
    harness.github.pr.draft = false;
    const failed = await run({
      ...harness.context("pull_request", prEvent(harness.github), inputs),
      signIn: refusedBy({ reason: "unavailable", message: "Archestra did not answer", login: null }),
    });
    expect(failed.failure).toMatch(/did not answer/);
  });

  it("reviews with the signed-in clients, and signs in only for a review", async () => {
    const harness = setup();
    harness.archestra.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson() } });
    let signIns = 0;
    const base = harness.context("pull_request", prEvent(harness.github), { "archestra-auth": "github-actions" });
    const ctx = {
      ...base,
      signIn: async () => {
        signIns++;
        const signed = harness.context("pull_request", prEvent(harness.github));
        return {
          ok: true as const,
          ctx: { ...signed, inputs: { ...signed.inputs, archestraAuth: "github-actions" as const } },
        };
      },
    };
    const result = await run(ctx);
    expect(result.status).toBe("success");
    expect(signIns).toBe(1);
    const command = await run({
      ...harness.context("issue_comment", issueCommentEvent(harness.github, "/archestra fix"), {
        "archestra-auth": "github-actions",
      }),
      signIn: async () => {
        signIns++;
        throw new Error("no sign-in for a command");
      },
    });
    expect(command.status).toBe("skipped");
    expect(signIns).toBe(1);
  });

  it("moves to a new review comment only when the old one belongs to the workflow token", async () => {
    const harness = setup();
    harness.archestra.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson([FINDING_IN_DIFF]) } });
    await run(harness.context("pull_request", prEvent(harness.github)));
    const [oldId] = [...harness.github.comments.keys()];
    harness.github.foreignComments.add(oldId!);
    harness.github.pr.head.sha = "d".repeat(40);
    // Without the App identity, a refused edit is an error: no second comment.
    harness.archestra.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson([]) } });
    await expect(run(harness.context("pull_request", prEvent(harness.github, "synchronize")))).rejects.toThrow();
    const stickies = () =>
      [...harness.github.comments.values()].filter((c) => c.body.includes("archestra-code-review"));
    expect(stickies()).toHaveLength(1);
    // As the review App, the workflow token's comment is taken over.
    harness.archestra.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson([]) } });
    await run({ ...harness.context("pull_request", prEvent(harness.github, "synchronize")), appIdentity: true });
    expect(stickies()).toHaveLength(2);
    // The new comment carries on with the old one's history.
    expect(parseState(stickies()[1]!.body)!.jobs.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps a checklist step from mentioning anyone or linking anywhere", () => {
    expect(checklistTitle("Ping @org/everyone at [x](https://evil.test) <b>")).toBe(
      "Ping @\u2060org/everyone at x(https:/\u2060/evil.test) &lt;b>",
    );
  });
});

describe("progress checklist", () => {
  it("shows the runtime's plan while it works, and ignores a file of an earlier commit", async () => {
    const harness = setup();
    const steps = [
      { title: "Read the diff and the changed files", status: "done" },
      { title: "Run the backend type check", status: "doing" },
      { title: "Write the review", status: "todo" },
    ];
    harness.archestra.script(AGENT_A, {
      end: "completed",
      polls: 4,
      liveFiles: { "progress.json": { sha: "a".repeat(40), steps } },
      files: { "review.json": reviewJson() },
    });
    await run(harness.context("pull_request", prEvent(harness.github)));
    const withPlan = harness.github.stickyHistory.find((body) => body.includes("- [x] Read the diff"));
    expect(withPlan).toContain(
      "- [x] Read the diff and the changed files\n- [ ] **Run the backend type check**\n- [ ] Write the review\n",
    );
    // The finished comment has no checklist any more.
    expect(harness.github.stickyBody()).not.toContain("- [x] Read the diff");

    const stale = setup();
    stale.archestra.script(AGENT_A, {
      end: "completed",
      polls: 4,
      liveFiles: { "progress.json": { sha: "f".repeat(40), steps } },
      files: { "review.json": reviewJson() },
    });
    await run(stale.context("pull_request", prEvent(stale.github)));
    expect(stale.github.stickyHistory.some((body) => body.includes("Read the diff"))).toBe(false);
  });
});

describe("progress checklist after a failed run", () => {
  it("drops the failed run's plan when the next agent starts", async () => {
    const harness = setup();
    harness.archestra.script(AGENT_A, {
      end: "failed",
      polls: 4,
      statusReason: "Budget exceeded",
      liveFiles: { "progress.json": { sha: "a".repeat(40), steps: [{ title: "Read the diff", status: "doing" }] } },
    });
    harness.archestra.script(AGENT_B, { end: "completed", files: { "review.json": reviewJson() } });
    await run(harness.context("pull_request", prEvent(harness.github)));
    // The plan showed while the first run worked, and went with it.
    expect(harness.github.stickyHistory.some((body) => body.includes("- [ ] **Read the diff**"))).toBe(true);
    const moving = harness.github.stickyHistory.find((body) => body.includes("moving to the next agent"));
    expect(moving).toBeDefined();
    expect(moving).not.toContain("Read the diff");
  });

  it("resets the progress file before it continues a workspace", async () => {
    const harness = setup();
    harness.archestra.script(AGENT_A, {
      end: "completed",
      files: {
        "review.json": reviewJson(),
        "progress.json": { sha: "a".repeat(40), steps: [{ title: "Done", status: "done" }] },
      },
    });
    await run(harness.context("pull_request", prEvent(harness.github)));
    harness.archestra.script(AGENT_A, { end: "completed", polls: 3, files: { "review.json": reviewJson() } });
    await run(harness.context("pull_request", prEvent(harness.github, "reopened")));
    expect(harness.archestra.starts[1]).toMatchObject({ kind: "continue" });
    expect(harness.github.stickyHistory.slice(-6).some((body) => body.includes("- [x] Done"))).toBe(false);
  });
});

describe("checks", () => {
  it("gives the reviewer the checks of the head commit, with the details of the failing ones", async () => {
    const harness = setup();
    harness.github.checkRuns = [
      {
        id: 301,
        name: "Supply Chain Policy",
        app: "github-actions",
        conclusion: "failure",
        log: "",
        baseBranchConclusion: "success",
        annotations: [
          {
            path: "release.yml",
            start_line: 3,
            end_line: 3,
            annotation_level: "failure",
            message: "agent-kimi archives are not relayed",
          },
        ],
      },
      { id: 302, name: "lint", app: "github-actions", conclusion: "success", log: "", baseBranchConclusion: "success" },
    ];
    harness.archestra.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson() } });
    await run(harness.context("pull_request", prEvent(harness.github)));
    const start = harness.archestra.starts[0]!;
    expect(start.attachmentNames).toContain("checks.json");
    const checks = JSON.parse(start.attachments["checks.json"]!) as Array<{
      name: string;
      conclusion: string;
      annotations?: Array<{ message: string }>;
    }>;
    expect(checks.map((check) => [check.name, check.conclusion])).toEqual([
      ["Supply Chain Policy", "failure"],
      ["lint", "success"],
    ]);
    expect(checks[0]!.annotations?.[0]?.message).toBe("agent-kimi archives are not relayed");
    expect(start.message).toContain("Read `checks.json`");
  });
});

describe("review scope", () => {
  it("reviews the whole pull request again after a force-push dropped the last reviewed commit", async () => {
    const harness = setup();
    harness.archestra.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson([FINDING_IN_DIFF]) } });
    await run(harness.context("pull_request", prEvent(harness.github)));
    harness.github.pr.head.sha = "d".repeat(40);
    harness.github.compareStatus = "diverged";
    harness.archestra.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson([]) } });
    await run(harness.context("pull_request", prEvent(harness.github, "synchronize")));
    expect(harness.archestra.starts[1]!.message).toContain("is no longer in the history of this pull request");
    expect(parseState(harness.github.stickyBody()!)!.delta).toBeNull();
  });

  it("checks the previous findings again when the same commit is reviewed again", async () => {
    const harness = setup();
    harness.archestra.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson([FINDING_IN_DIFF]) } });
    await run(harness.context("pull_request", prEvent(harness.github)));
    harness.archestra.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson([FINDING_IN_DIFF]) } });
    await run(harness.context("pull_request", prEvent(harness.github, "reopened")));
    expect(harness.archestra.starts[1]!.message).toContain("This review repeats the last one on the same commit");
    expect(harness.archestra.starts[1]!.attachmentNames).toContain("previous-findings.json");
  });
});

describe("failures", () => {
  it("fails the job by default when the review is unavailable", async () => {
    const harness = setup();
    harness.archestra.script(AGENT_A, { start: "http", status: 401 });
    const result = await run(harness.context("pull_request", prEvent(harness.github)));
    expect(result.failure).toMatch(/unavailable/);
    expect(harness.github.stickyBody()).toContain("**Review unavailable.**");
  });

  it("says in the comment that the job stopped with an error, without the error text", async () => {
    const harness = setup();
    harness.github.reviewError = 500;
    harness.archestra.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson([FINDING_IN_DIFF]) } });
    await expect(run(harness.context("pull_request", prEvent(harness.github)))).rejects.toThrow();
    const sticky = harness.github.stickyBody()!;
    expect(sticky).toMatch(/\*\*Archestra stopped the review of `aaaaaaa` for @alice with an error after \d+ s\*\*/);
    expect(sticky).not.toContain("Server Error");
    expect(parseState(sticky)!.jobs.at(-1)!.outcome).toBe("stopped with an error");
    expect(parseState(sticky)!.progress).toBeNull();
  });

  it("retries a GitHub request that never reached GitHub, and a read after a gateway error", () => {
    const tls = Object.assign(new Error("request to https://api.github.com failed"), {
      cause: Object.assign(new Error("Hostname/IP does not match certificate's altnames"), {
        code: "ERR_TLS_CERT_ALTNAME_INVALID",
      }),
    });
    expect(isTransient(tls, "POST")).toBe(true);
    expect(isTransient(Object.assign(new Error("Bad Gateway"), { status: 502 }), "GET")).toBe(true);
    // A write may have happened: it is not repeated after a gateway error.
    expect(isTransient(Object.assign(new Error("Bad Gateway"), { status: 502 }), "POST")).toBe(false);
    expect(isTransient(Object.assign(new Error("Not Found"), { status: 404 }), "GET")).toBe(false);
  });

  it("repeats the request after a dropped connection", async () => {
    let calls = 0;
    server.use(
      http.get("https://api.github.com/repos/acme/widgets", () => {
        calls++;
        return calls === 1 ? HttpResponse.error() : HttpResponse.json({ id: 1 });
      }),
    );
    const gh = testOctokit("ghs_token", [0, 0]);
    const { data } = await gh.rest.repos.get({ owner: "acme", repo: "widgets" });
    expect(data.id).toBe(1);
    expect(calls).toBe(2);
  });
});

describe("stopped jobs", () => {
  it("starts no run and writes nothing once the runner cancels the job", async () => {
    const harness = setup();
    harness.archestra.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson() } });
    const ctx = { ...harness.context("pull_request", prEvent(harness.github)), isStopping: () => true };
    await expect(run(ctx)).rejects.toThrow(/canceled/);
    expect(harness.archestra.starts).toHaveLength(0);
    expect(harness.github.stickyBody()).toBeNull();
  });

  it("finishes only its own progress header, never a newer job's", async () => {
    const { finishProgress } = await import("../src/modes/common");
    const { emptyState } = await import("../src/github/sticky");
    const harness = setup();
    const ctx = harness.context("pull_request", prEvent(harness.github));
    const state = emptyState("main");
    state.progress = {
      doing: "reviewing `eeeeeee`",
      login: "alice",
      startedAt: new Date(harness.clock.now()).toISOString(),
      workflowRunUrl: "https://github.com/acme/widgets/actions/runs/99",
      step: "waiting for the runtime to finish",
      runUrl: null,
      checklist: [],
    };
    finishProgress(ctx, state, { did: "the review of `aaaaaaa`", login: "alice", outcome: "error" });
    expect(state.progress?.workflowRunUrl).toBe("https://github.com/acme/widgets/actions/runs/99");
    expect(state.last?.workflowRunUrl).toBe(ctx.workflowRunUrl);
  });

  async function inProgress() {
    const harness = setup();
    harness.archestra.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson([FINDING_IN_DIFF]) } });
    await run(harness.context("pull_request", prEvent(harness.github)));
    const job: SavedJob = { ...harness.jobs[0]!, workflowRunUrl: "https://github.com/acme/widgets/actions/runs/2" };
    // A later job of the same commit that the runner canceled.
    expect(job.label).toBe("review of aaaaaaa");
    return { harness, job };
  }

  function record(job: SavedJob) {
    return recordStoppedJob({
      gh: testOctokit("ghs_token"),
      repo: { owner: "acme", repo: "widgets" },
      job,
      render: { repoUrl: "https://github.com/acme/widgets", command: null },
      now: Date.parse(job.startedAt) + 125_000,
      log: new MemoryLogger(),
    });
  }

  it("records a job that a newer push replaced, and leaves the newer job's header alone", async () => {
    const { harness, job } = await inProgress();
    harness.github.pr.head.sha = "e".repeat(40);
    expect(await record(job)).toBe("superseded");
    const state = parseState(harness.github.stickyBody()!)!;
    expect(state.jobs.at(-1)).toMatchObject({
      label: "review of aaaaaaa",
      outcome: "superseded by eeeeeee",
      durationMs: 125_000,
      attempts: [],
    });
    // The header still belongs to the job that finished.
    expect(state.last).toMatchObject({ outcome: "ok", stop: null });
    // A second call (the post step after the signal handler) adds nothing.
    expect(await record(job)).toBe("skipped");
    expect(parseState(harness.github.stickyBody()!)!.jobs).toHaveLength(2);
  });

  it("turns its own progress header into a finished header", async () => {
    const harness = setup();
    harness.archestra.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson() } });
    await run(harness.context("pull_request", prEvent(harness.github)));
    const job = harness.jobs[0]!;
    // Put the progress header of this job back, as if the job were still running.
    const body = harness.github.stickyBody()!;
    const state = parseState(body)!;
    state.progress = {
      doing: job.doing,
      login: job.login,
      startedAt: job.startedAt,
      workflowRunUrl: job.workflowRunUrl,
      step: "waiting for the runtime to finish",
      runUrl: null,
      checklist: [],
    };
    state.jobs = [];
    const { renderSticky, parseMarker } = await import("../src/github/sticky");
    const comment = [...harness.github.comments.values()].find((c) => c.body.includes("archestra-code-review"))!;
    comment.body = renderSticky(state, {
      marker: parseMarker(body)!,
      repoUrl: "https://github.com/acme/widgets",
      command: null,
    });
    expect(await record(job)).toBe("canceled");
    const sticky = harness.github.stickyBody()!;
    expect(sticky).toContain(
      "**Archestra stopped reviewing `aaaaaaa` for @alice after 2 min 5 s: the job was canceled** —— [View job](https://github.com/acme/widgets/actions/runs/1)",
    );
    expect(parseState(sticky)!.jobs.at(-1)!.outcome).toBe("canceled");
    // An older version of the action still reads this state: the outcome stays in its old set.
    expect(parseState(sticky)!.last).toMatchObject({ outcome: "error", stop: "canceled" });
  });
});
