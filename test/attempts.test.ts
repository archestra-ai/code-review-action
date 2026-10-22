import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ArchestraClient } from "../src/archestra/client";
import { type AttemptOutcome, orderAgents, runWithFallback } from "../src/attempts";
import { ReviewResultSchema } from "../src/contracts";
import { executeAttempt, readContract } from "../src/run-attempt";
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
      taskId: null,
      runUrl: null,
      result: result === "ok" ? ("completed" as const) : result,
      reason: result,
      source: null,
      durationMs: 0,
    };
    if (result === "ok") return { ok: true, value: agentId, record };
    return { ok: false, classification: { class: result, reason: result, source: "http" }, record };
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

describe("executeAttempt against the fake Archestra API", () => {
  const server = mockServer();
  beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  function setup() {
    const fake = new FakeArchestra();
    server.use(...fake.handlers());
    const client = new ArchestraClient({ baseUrl: fake.baseUrl, apiKey: fake.apiKey });
    const clock = new FakeClock();
    const log = new MemoryLogger();
    const live: Array<string | null> = [];
    const run = (agentId: string, timeoutMs = 600_000) =>
      executeAttempt({
        client,
        agentId,
        start: () => client.startRun(agentId, { message: "review", attachments: [], title: "acme/widgets#7" }),
        readResult: (taskId) => readContract(client, taskId, "review.json", ReviewResultSchema),
        timeoutMs,
        deadline: clock.now() + 3_600_000,
        clock,
        log,
        onLive: (taskId) => void live.push(taskId),
      });
    return { fake, client, clock, log, live, run };
  }

  it("completes, reads review.json and polls with 5 s -> 30 s backoff", async () => {
    const { fake, clock, live, run } = setup();
    fake.script(AGENT_A, { end: "TASK_STATE_COMPLETED", files: { "review.json": reviewJson() }, polls: 6 });
    const outcome = await run(AGENT_A);
    expect(outcome.ok).toBe(true);
    expect(clock.sleeps).toEqual([5000, 7500, 11250, 16875, 25313, 30000]);
    expect(live[0]).toMatch(/^0000/);
    expect(live.at(-1)).toBeNull();
    expect(fake.starts[0]).toMatchObject({
      runtimeMode: "one_shot",
      title: "acme/widgets#7",
      authorization: "<api key>",
    });
  });

  it("classifies a 401 on start as fatal", async () => {
    const { fake, run } = setup();
    fake.script(AGENT_A, { start: "http", status: 401 });
    const outcome = await run(AGENT_A);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.classification.class).toBe("fatal");
  });

  it("classifies 403/404/409 on start as non-retriable and 429/503 as retriable", async () => {
    const { fake, run } = setup();
    fake.script(
      AGENT_A,
      { start: "http", status: 403 },
      { start: "http", status: 409, message: "Sign in to Claude Code before starting this Agent." },
    );
    fake.script(AGENT_B, { start: "http", status: 429 }, { start: "http", status: 503 });
    for (const [agent, expected] of [
      [AGENT_A, "non_retriable"],
      [AGENT_A, "non_retriable"],
      [AGENT_B, "retriable"],
      [AGENT_B, "retriable"],
      [AGENT_C, "non_retriable"], // 404: no script = agent missing
    ] as const) {
      const outcome = await run(agent);
      expect(outcome.ok ? "ok" : outcome.classification.class).toBe(expected);
    }
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
      { end: "TASK_STATE_COMPLETED", files: {} },
      { end: "TASK_STATE_COMPLETED", files: { "review.json": { verdict: "maybe" } } },
    );
    for (const reason of [/missing/, /does not match the schema/]) {
      const outcome = await run(AGENT_A);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.classification.source).toBe("contract");
        expect(outcome.classification.reason).toMatch(reason);
      }
    }
  });

  it("cancels an INPUT_REQUIRED run (the agent asked a question)", async () => {
    const { fake, run } = setup();
    fake.script(AGENT_A, { end: "TASK_STATE_INPUT_REQUIRED", statusReason: "Which branch?" });
    const outcome = await run(AGENT_A);
    expect(outcome.ok ? null : outcome.classification.class).toBe("non_retriable");
    expect(fake.cancels).toHaveLength(1);
  });
});
