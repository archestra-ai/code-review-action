import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ArchestraClient, type StartedRun } from "../src/archestra/client";
import { type AttemptOutcome, orderAgents, runWithFallback } from "../src/attempts";
import { ReviewResultSchema } from "../src/contracts";
import { continueRun, executeAttempt, readContract } from "../src/run-attempt";
import { jsonAttachment, textAttachment } from "../src/util";
import { FakeArchestra } from "./fakes/archestra";
import { AGENT_A, AGENT_B, AGENT_C, FakeClock, MemoryLogger, mockServer, reviewJson } from "./helpers";

describe("orderAgents", () => {
  const agents = ["a", "b", "c"];
  it("rotates on (PR number + run attempt) mod N", () => {
    expect(orderAgents(agents, "rotate", { prNumber: 7, runAttempt: 1, random: Math.random })).toEqual(["c", "a", "b"]);
    expect(orderAgents(agents, "rotate", { prNumber: 7, runAttempt: 2, random: Math.random })).toEqual(["a", "b", "c"]);
    // Deterministic: the same inputs give the same order.
    expect(orderAgents(agents, "rotate", { prNumber: 7, runAttempt: 1, random: Math.random })).toEqual(["c", "a", "b"]);
  });
  it("keeps the configured order for ordered", () => {
    expect(orderAgents(agents, "ordered", { prNumber: 7, runAttempt: 1, random: Math.random })).toEqual(agents);
  });
  it("is a permutation for random", () => {
    const order = orderAgents(agents, "random", { prNumber: 7, runAttempt: 1, random: () => 0 });
    expect([...order].sort()).toEqual(agents);
  });
});

function scripted(results: Array<"ok" | "retriable" | "non_retriable" | "fatal">) {
  const calls: string[] = [];
  let i = 0;
  const attempt = async (agentId: string): Promise<AttemptOutcome<string>> => {
    calls.push(agentId);
    const result = results[i++] ?? "non_retriable";
    const record = {
      agentId,
      runId: null,
      runUrl: null,
      continued: false,
      result: result === "ok" ? ("completed" as const) : result,
      reason: result,
      source: null,
      durationMs: 0,
    };
    if (result === "ok") return { ok: true, value: agentId, record };
    return { ok: false, classification: { class: result, reason: result, source: "api" }, record };
  };
  return { calls, attempt };
}

describe("runWithFallback", () => {
  const base = (clock: FakeClock) => ({
    agents: ["a", "b", "c"],
    deadline: clock.now() + 3_600_000,
    now: clock.now,
    sleep: clock.sleep,
    log: new MemoryLogger(),
  });

  it("retries a retriable failure on the same runtime after 30 s", async () => {
    const clock = new FakeClock();
    const { calls, attempt } = scripted(["retriable", "ok"]);
    const result = await runWithFallback({ ...base(clock), retries: 1, maxFallbacks: 2, attempt });
    expect(calls).toEqual(["a", "a"]);
    expect(clock.sleeps).toEqual([30_000]);
    expect(result).toMatchObject({ ok: true, value: "a", agentId: "a" });
  });

  it("goes to the next runtime after a non-retriable failure", async () => {
    const clock = new FakeClock();
    const { calls, attempt } = scripted(["non_retriable", "ok"]);
    const result = await runWithFallback({ ...base(clock), retries: 1, maxFallbacks: 2, attempt });
    expect(calls).toEqual(["a", "b"]);
    expect(result.agentId).toBe("b");
  });

  it("goes to the next runtime when the retries are used up", async () => {
    const clock = new FakeClock();
    const { calls, attempt } = scripted(["retriable", "retriable", "retriable", "ok"]);
    await runWithFallback({ ...base(clock), retries: 2, maxFallbacks: 2, attempt });
    expect(calls).toEqual(["a", "a", "a", "b"]);
    expect(clock.sleeps).toEqual([30_000, 60_000]);
  });

  it("stops all attempts on a fatal failure", async () => {
    const clock = new FakeClock();
    const { calls, attempt } = scripted(["fatal", "ok"]);
    const result = await runWithFallback({ ...base(clock), retries: 1, maxFallbacks: 2, attempt });
    expect(calls).toEqual(["a"]);
    expect(result).toMatchObject({ ok: false, fatal: true });
  });

  it("makes at most N x (1 + retries) attempts", async () => {
    const clock = new FakeClock();
    const { calls, attempt } = scripted(Array(20).fill("retriable"));
    const result = await runWithFallback({ ...base(clock), retries: 2, maxFallbacks: 99, attempt });
    expect(calls).toHaveLength(9);
    expect(result.attempts).toHaveLength(9);
    expect(result.ok).toBe(false);
  });

  it("respects max-fallbacks", async () => {
    const clock = new FakeClock();
    const { calls, attempt } = scripted(Array(20).fill("non_retriable"));
    await runWithFallback({ ...base(clock), retries: 1, maxFallbacks: 1, attempt });
    expect(calls).toEqual(["a", "b"]);
  });

  it("stops at the overall deadline", async () => {
    const clock = new FakeClock();
    const { calls, attempt } = scripted(Array(20).fill("retriable"));
    const result = await runWithFallback({
      ...base(clock),
      deadline: clock.now() + 45_000,
      retries: 5,
      maxFallbacks: 2,
      attempt,
    });
    expect(calls).toEqual(["a", "a"]);
    expect(result.deadlineReached).toBe(true);
  });
});

describe("executeAttempt against the fake Archestra gateway", () => {
  const server = mockServer();
  beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  function setup(configure: (fake: FakeArchestra) => void = () => {}, token?: string) {
    const fake = new FakeArchestra();
    configure(fake);
    server.use(...fake.handlers());
    const client = new ArchestraClient({ gatewayUrl: fake.gatewayUrl, token: token ?? fake.token });
    const clock = new FakeClock();
    const log = new MemoryLogger();
    const live: Array<string | null> = [];
    const attempt = (agentId: string, start: () => Promise<StartedRun>, timeoutMs = 600_000) =>
      executeAttempt({
        client,
        agentId,
        start,
        readResult: (runId) => readContract(client, runId, "review.json", ReviewResultSchema),
        timeoutMs,
        deadline: clock.now() + 3_600_000,
        clock,
        log,
        onLive: (runId) => void live.push(runId),
      });
    const run = (agentId: string, timeoutMs = 600_000) =>
      attempt(agentId, () => client.startRun(agentId, { message: "review", attachments: [] }), timeoutMs);
    const resume = (runId: string) =>
      attempt(AGENT_A, async () => {
        const started = await continueRun({
          client,
          runId,
          message: "review again",
          files: [jsonAttachment("pr.json", { number: 7 })],
          resultFile: "review.json",
          turnKey: "turn-k1",
          deadline: clock.now() + 3_600_000,
          clock,
          log,
        });
        if (!started) throw new Error("no continuation");
        return started;
      });
    return { fake, client, clock, log, live, run, resume };
  }

  it("completes, reads review.json and polls with 5 s -> 30 s backoff", async () => {
    const { fake, clock, live, run } = setup();
    fake.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson() }, polls: 6 });
    const outcome = await run(AGENT_A);
    expect(outcome.ok).toBe(true);
    expect(clock.sleeps).toEqual([5000, 7500, 11250, 16875, 25313, 30000]);
    expect(live[0]).toMatch(/^0000/);
    expect(live.at(-1)).toBeNull();
    expect(fake.starts[0]).toMatchObject({ kind: "start", token: fake.token });
    expect(outcome.record.runUrl).toBe(`${fake.origin}/chat/runs/${live[0]}`);
  });

  it("initializes once and sends the protocol version and session id on later requests", async () => {
    const { fake, run } = setup();
    fake.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson() } });
    await run(AGENT_A);
    expect(fake.calls.filter((call) => call === "initialize")).toHaveLength(1);
    expect(fake.calls.slice(0, 3)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(fake.missingHeaders).toEqual([]);
  });

  it("reads SSE answers", async () => {
    const { fake, run } = setup((f) => {
      f.sse = true;
    });
    fake.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson() } });
    expect((await run(AGENT_A)).ok).toBe(true);
  });

  it("calls the tools through run_tool when the gateway lists only run_tool", async () => {
    const { fake, run } = setup((f) => {
      f.exposure = "run_tool";
    });
    fake.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson() } });
    expect((await run(AGENT_A)).ok).toBe(true);
    expect(fake.calls.filter((call) => call.startsWith("tools/call")).every((call) => call.endsWith("run_tool"))).toBe(
      true,
    );
  });

  it("is fatal when the gateway does not expose start_agent_run", async () => {
    const { fake, run } = setup((f) => {
      f.hiddenTools.add("start_agent_run");
    });
    const outcome = await run(AGENT_A);
    expect(outcome.ok ? null : outcome.classification).toMatchObject({
      class: "fatal",
      reason: expect.stringContaining("does not expose start_agent_run"),
    });
    expect(fake.starts).toHaveLength(0);
  });

  it("classifies a rejected token as fatal", async () => {
    const { fake, run } = setup(() => {}, "not-a-valid-token");
    const outcome = await run(AGENT_A);
    expect(outcome.ok ? null : outcome.classification).toMatchObject({
      class: "fatal",
      reason: expect.stringContaining("HTTP 401: Invalid or expired platform token"),
    });
    expect(fake.calls).toEqual([]);
  });

  it("classifies start refusals: tool errors go to the next runtime, 429/503 retry", async () => {
    const { fake, run } = setup();
    fake.script(
      AGENT_A,
      { start: "tool-error", text: "[appa] Blocked: start_agent_run cannot run yet." },
      { start: "tool-error", text: "This Agent's Agent Runtime needs credentials you have not set up yet" },
      { start: "tool-error", text: "An internal error occurred while starting the run" },
    );
    fake.script(AGENT_B, { start: "http", status: 429 }, { start: "http", status: 503 });
    for (const [agent, expected] of [
      [AGENT_A, "non_retriable"],
      [AGENT_A, "non_retriable"],
      [AGENT_A, "retriable"],
      [AGENT_B, "retriable"],
      [AGENT_B, "retriable"],
      [AGENT_C, "non_retriable"], // Agent not found
    ] as const) {
      const outcome = await run(agent);
      expect(outcome.ok ? "ok" : outcome.classification.class).toBe(expected);
    }
  });

  it("uses the failure code under Guardrails, where the status reason is withheld", async () => {
    const { fake, run } = setup((f) => {
      f.narrow = true;
    });
    fake.script(AGENT_A, {
      end: "failed",
      statusReason: "Kubernetes API unavailable",
      failure: { code: "launch.kubernetes_unavailable", retriable: true },
    });
    const outcome = await run(AGENT_A);
    expect(outcome.ok ? null : outcome.classification).toMatchObject({
      class: "retriable",
      source: "failure-field",
      reason: expect.stringMatching(/^launch\.kubernetes_unavailable: Details are withheld/),
    });
  });

  it("cancels the run and moves on when the attempt times out", async () => {
    const { fake, run } = setup();
    fake.script(AGENT_A, { end: "never" });
    const outcome = await run(AGENT_A, 120_000);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.classification).toMatchObject({ class: "non_retriable", source: "timeout" });
    expect(fake.cancels).toHaveLength(1);
  });

  it("treats a missing or invalid review.json as non-retriable", async () => {
    const { fake, run } = setup();
    fake.script(
      AGENT_A,
      { end: "completed", files: {} },
      { end: "completed", files: { "review.json": { verdict: "maybe" } } },
    );
    for (const reason of [/without writing its result/, /does not match the contract/]) {
      const outcome = await run(AGENT_A);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.classification.source).toBe("contract");
        expect(outcome.classification.reason).toMatch(reason);
      }
    }
  });

  it("cancels an input-required run (the agent asked a question)", async () => {
    const { fake, run } = setup();
    fake.script(AGENT_A, { end: "input-required", statusReason: "Which branch?" });
    const outcome = await run(AGENT_A);
    expect(outcome.ok ? null : outcome.classification.class).toBe("non_retriable");
    expect(fake.cancels).toHaveLength(1);
  });

  it("continues a finished run: writes the inputs, lists them, and waits for the new turn", async () => {
    const { fake, run, resume, clock } = setup((f) => {
      f.continuationLag = 3;
    });
    fake.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson() } });
    const first = await run(AGENT_A);
    const runId = first.ok ? first.value.runId : "";
    fake.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson([], { summary: "Second turn." }) } });
    const sleepsBefore = clock.sleeps.length;
    const second = await resume(runId);
    expect(second.ok ? second.value : null).toMatchObject({ runId, result: { summary: "Second turn." } });
    expect(clock.sleeps.length - sleepsBefore).toBeGreaterThanOrEqual(5); // 3 lagged polls + 2 working
    const record = fake.starts[1];
    expect(record).toMatchObject({ kind: "continue", previousRunId: runId, attachmentNames: ["pr.json"] });
    expect(record?.message).toContain(
      "Attached files are available for this run:\n- /home/node/workspace/turn-k1-pr.json",
    );
  });

  it("does not return the previous turn's result when the new turn writes none", async () => {
    const { fake, run, resume } = setup();
    fake.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson() } });
    const first = await run(AGENT_A);
    fake.script(AGENT_A, { end: "completed", files: {} });
    const second = await resume(first.ok ? first.value.runId : "");
    expect(second.ok ? null : second.classification).toMatchObject({
      source: "contract",
      reason: "the run did not write a new result in this turn",
    });
  });

  it("gives up on the continuation when the new turn never shows", async () => {
    const { fake, run, resume } = setup((f) => {
      f.continuationLag = 1000;
    });
    fake.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson() } });
    const first = await run(AGENT_A);
    fake.script(AGENT_A, { end: "completed", files: { "review.json": reviewJson() } });
    const second = await resume(first.ok ? first.value.runId : "");
    expect(second.ok ? null : second.classification).toMatchObject({ class: "retriable", source: "state" });
  });
});

describe("continueRun", () => {
  const server = mockServer();
  beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  it("returns null for another person's run, so the caller starts a fresh run", async () => {
    const fake = new FakeArchestra();
    server.use(...fake.handlers());
    fake.seedRun(AGENT_A, "99999999-9999-4999-8999-999999999999", fake.otherToken);
    const client = new ArchestraClient({ gatewayUrl: fake.gatewayUrl, token: fake.token });
    const log = new MemoryLogger();
    const clock = new FakeClock();
    const started = await continueRun({
      client,
      runId: "99999999-9999-4999-8999-999999999999",
      message: "fix",
      files: [],
      resultFile: "fix-result.json",
      turnKey: "turn-k1",
      deadline: clock.now() + 600_000,
      clock,
      log,
    });
    expect(started).toBeNull();
    expect(fake.writes).toEqual([]);
    expect(log.lines.join("\n")).toContain("no workspace that this token can continue");
  });

  it("returns null when an input file is larger than a workspace write allows", async () => {
    const fake = new FakeArchestra();
    server.use(...fake.handlers());
    fake.seedRun(AGENT_A, "99999999-9999-4999-8999-999999999999");
    const client = new ArchestraClient({ gatewayUrl: fake.gatewayUrl, token: fake.token });
    const clock = new FakeClock();
    const started = await continueRun({
      client,
      runId: "99999999-9999-4999-8999-999999999999",
      message: "review again",
      files: [textAttachment("pr.diff", "x".repeat(4 * 1024 * 1024 + 1))],
      resultFile: "review.json",
      turnKey: "turn-k1",
      deadline: clock.now() + 600_000,
      clock,
      log: new MemoryLogger(),
    });
    expect(started).toBeNull();
    expect(fake.calls).toEqual([]);
  });

  it("returns null for an unknown run", async () => {
    const fake = new FakeArchestra();
    server.use(...fake.handlers());
    const client = new ArchestraClient({ gatewayUrl: fake.gatewayUrl, token: fake.token });
    const clock = new FakeClock();
    const started = await continueRun({
      client,
      runId: "99999999-9999-4999-8999-999999999999",
      message: "fix",
      files: [],
      resultFile: "fix-result.json",
      turnKey: "turn-k1",
      deadline: clock.now() + 600_000,
      clock,
      log: new MemoryLogger(),
    });
    expect(started).toBeNull();
  });
});
