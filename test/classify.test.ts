import { describe, expect, it } from "vitest";
import { type AgentRun, ArchestraApiError } from "../src/archestra/client";
import { classifyApiError, classifyFailureMessage, classifyRun } from "../src/classify";

const run = (overrides: Partial<AgentRun>): AgentRun => ({
  runId: "r",
  state: "failed",
  statusReason: null,
  failure: null,
  turnCreatedAt: null,
  runUrl: null,
  tier: null,
  workspace: null,
  ...overrides,
});

describe("classifyApiError", () => {
  it.each([
    ["network", null, "retriable"],
    ["http", 408, "retriable"],
    ["http", 429, "retriable"],
    ["http", 500, "retriable"],
    ["http", 502, "retriable"],
    ["http", 503, "retriable"],
    ["http", 401, "fatal"],
    ["http", 403, "fatal"],
    ["http", 404, "fatal"],
    ["http", 400, "non_retriable"],
    ["rpc", -32601, "fatal"],
    ["rpc", -32603, "retriable"],
    ["rpc", -32602, "non_retriable"],
    ["response", null, "non_retriable"],
    ["response", 503, "retriable"],
  ] as const)("%s %s -> %s", (kind, status, expected) => {
    const result = classifyApiError(new ArchestraApiError("start run", kind, "detail", status));
    expect(result.class).toBe(expected);
    expect(result.source).toBe("api");
  });

  it.each([
    ["Tool archestra__start_agent_run is not assigned to this agent", "fatal"],
    ["[appa] Blocked: start_agent_run cannot run yet.", "non_retriable"],
    [
      "This Agent's Agent Runtime needs credentials you have not set up yet:\n- GitHub token (GITHUB_TOKEN)",
      "non_retriable",
    ],
    ["An internal error occurred while starting the run", "retriable"],
    ["Agent not found", "non_retriable"],
  ] as const)("tool error %s -> %s", (detail, expected) => {
    expect(classifyApiError(new ArchestraApiError("start run", "tool", detail)).class).toBe(expected);
  });

  it("is fatal when the gateway does not expose the tool", () => {
    const error = new ArchestraApiError("start run", "tool", "the gateway does not expose start_agent_run", null, true);
    expect(classifyApiError(error).class).toBe("fatal");
  });
});

describe("classifyRun with the failure field", () => {
  it("uses failure.retriable = true", () => {
    const result = classifyRun(run({ statusReason: "Evicted", failure: { code: "pod.evicted", retriable: true } }));
    expect(result).toMatchObject({ class: "retriable", source: "failure-field", reason: "pod.evicted: Evicted" });
  });
  it("uses failure.retriable = false, also when the message looks retriable", () => {
    const result = classifyRun(
      run({ statusReason: "service unavailable", failure: { code: "budget.exceeded", retriable: false } }),
    );
    expect(result).toMatchObject({ class: "non_retriable", source: "failure-field" });
  });
  it("keeps the code when Guardrails withholds the status reason", () => {
    const result = classifyRun(
      run({
        statusReason: "Details are withheld under Guardrails; a person can read them on the run page.",
        failure: { code: "launch.kubernetes_unavailable", retriable: true },
      }),
    );
    expect(result).toMatchObject({
      class: "retriable",
      reason: expect.stringMatching(/^launch\.kubernetes_unavailable/),
    });
  });
});

describe("classifyRun without the failure field (older deployments)", () => {
  it.each([
    ["Kubernetes API overloaded", "retriable"],
    ["Capacity wait expired", "retriable"],
    ["The provider is temporarily unavailable", "retriable"],
    ["Terminal recording stopped", "retriable"],
    ["Pod was Evicted", "retriable"],
    ["Budget exceeded for this key", "non_retriable"],
    ["ErrImagePull: image not found", "non_retriable"],
    ["Container OOMKilled", "non_retriable"],
    ["The guardrails policy is invalid", "non_retriable"],
    ["The runtime image changed", "non_retriable"],
    ["Image envelope error: bad config", "non_retriable"],
    ["Something nobody expected", "non_retriable"],
  ])("%s -> %s", (message, expected) => {
    const result = classifyRun(run({ statusReason: message }));
    expect(result).toMatchObject({ class: expected, source: "message-pattern" });
  });

  it.each(["canceled", "rejected", "input-required", "auth-required"])(
    "%s -> non-retriable from the state",
    (state) => {
      expect(classifyRun(run({ state, statusReason: "x" }))).toMatchObject({ class: "non_retriable", source: "state" });
    },
  );

  it("is the default for an empty message", () => {
    expect(classifyFailureMessage("").class).toBe("non_retriable");
  });
});
