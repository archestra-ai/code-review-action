import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isTransient } from "../src/github/octokit";
import { verdictFor } from "../src/github/review";
import { parseState } from "../src/github/sticky";
import { reviewBody, summaryWords } from "../src/modes/review";
import { run } from "../src/run";
import { recordStoppedJob, type SavedJob } from "../src/stopped";
import {
  AGENT_A,
  createHarness,
  FINDING_IN_DIFF,
  FINDING_OUTSIDE,
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
  });

  it("posts only comment reviews by default", async () => {
    const harness = setup();
    harness.archestra.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson([FINDING_IN_DIFF]) } });
    await run(harness.context("pull_request", prEvent(harness.github)));
    expect(harness.github.reviews.map((review) => review.event)).toEqual(["COMMENT"]);
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
    expect(state.last?.outcome).toBe("ok");
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
      sha: job.sha,
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
  });
});
