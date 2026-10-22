import { describe, expect, it } from "vitest";
import { type AgentRun, ArchestraApiError } from "../src/archestra/client";
import { classifyApiError, classifyFailureMessage, classifyRun } from "../src/classify";

const run = (overrides: Partial<AgentRun>): AgentRun => ({ taskId: "t", state: "TASK_STATE_FAILED", ...overrides });

describe("classifyApiError", () => {
  it.each([
    [null, "retriable"],
    [429, "retriable"],
    [500, "retriable"],
    [502, "retriable"],
    [503, "retriable"],
    [504, "retriable"],
    [401, "fatal"],
    [403, "non_retriable"],
    [404, "non_retriable"],
    [409, "non_retriable"],
    [400, "non_retriable"],
  ])("HTTP %s -> %s", (status, expected) => {
    const result = classifyApiError(new ArchestraApiError("start run", status, "detail"));
    expect(result.class).toBe(expected);
    expect(result.source).toBe("http");
  });
});

describe("classifyRun with the failure field", () => {
  it("uses failure.retriable = true", () => {
    const result = classifyRun(run({ failure: { code: "pod_evicted", retriable: true, message: "Evicted" } }));
    expect(result).toMatchObject({ class: "retriable", source: "failure-field" });
  });
  it("uses failure.retriable = false, also when the message looks retriable", () => {
    const result = classifyRun(
      run({ statusReason: "service unavailable", failure: { code: "budget_exceeded", retriable: false, message: "Budget exceeded" } }),
    );
    expect(result).toMatchObject({ class: "non_retriable", source: "failure-field" });
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

  it.each(["TASK_STATE_CANCELED", "TASK_STATE_REJECTED", "TASK_STATE_INPUT_REQUIRED", "TASK_STATE_AUTH_REQUIRED"])(
    "%s -> non-retriable from the state",
    (state) => {
      expect(classifyRun(run({ state, statusReason: "x" }))).toMatchObject({ class: "non_retriable", source: "state" });
    },
  );

  it("is the default for an empty message", () => {
    expect(classifyFailureMessage("").class).toBe("non_retriable");
  });
});
