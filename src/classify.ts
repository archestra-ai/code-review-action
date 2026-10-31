import type { AgentRun, ArchestraApiError } from "./archestra/client";

/**
 * - retriable: try the same runtime again (after a delay).
 * - non_retriable: go to the next runtime.
 * - fatal: stop all attempts (all runtimes share the gateway and the token).
 */
export type FailureClass = "retriable" | "non_retriable" | "fatal";

/** Which signal gave the class. The action logs it for each attempt. */
export type ClassificationSource = "api" | "failure-field" | "message-pattern" | "state" | "timeout" | "contract";

export interface Classification {
  class: FailureClass;
  reason: string;
  source: ClassificationSource;
  /** True when the run was killed for memory: the same agent can try again at a larger tier. */
  outOfMemory?: boolean;
}

/**
 * Tool errors that the gateway returns. The first match wins; a tool error
 * that matches no row is non-retriable.
 */
export const TOOL_ERROR_PATTERNS: ReadonlyArray<{ pattern: RegExp; class: FailureClass; label: string }> = [
  {
    pattern: /not assigned to this agent|unknown tool|tool .* (?:is not available|not found)/i,
    class: "fatal",
    label: "the gateway does not expose the Remote Agents tools",
  },
  {
    pattern: /\[appa\]|guardrails/i,
    class: "non_retriable",
    label: "refused by Guardrails",
  },
  {
    pattern: /needs credentials you have not set up/i,
    class: "non_retriable",
    label: "the actor has not set up the agent's credentials",
  },
  {
    pattern: /internal error occurred/i,
    class: "retriable",
    label: "Archestra internal error",
  },
];

/** Classifies a failure of a gateway call. */
export function classifyApiError(error: ArchestraApiError): Classification {
  const fail = (cls: FailureClass, note?: string): Classification => ({
    class: cls,
    reason: note ? `${error.message} (${note})` : error.message,
    source: "api",
  });
  switch (error.kind) {
    case "network":
      return fail("retriable");
    case "http": {
      const status = error.status ?? 0;
      if (status === 401 || status === 403) {
        return fail("fatal", "the gateway rejected the token; all runtimes use the same token");
      }
      if (status === 404) return fail("fatal", "the gateway URL is wrong; all runtimes use the same gateway");
      if (status === 408 || status === 429 || status >= 500) return fail("retriable");
      return fail("non_retriable");
    }
    case "rpc":
      if (error.status === -32601) return fail("fatal", "the gateway does not support this method");
      if (error.status === -32603) return fail("retriable");
      return fail("non_retriable");
    case "response":
      return error.status !== null && error.status >= 500 ? fail("retriable") : fail("non_retriable");
    case "tool": {
      if (error.missingTool) return fail("fatal");
      for (const row of TOOL_ERROR_PATTERNS) {
        if (row.pattern.test(error.detail)) return fail(row.class, row.label);
      }
      return fail("non_retriable");
    }
  }
}

/** Classifies a run that stopped in a state other than completed. */
export function classifyRun(run: AgentRun): Classification {
  const reason = run.statusReason?.trim() || "no reason given";
  switch (run.state) {
    case "failed": {
      if (run.failure) {
        return {
          class: run.failure.retriable ? "retriable" : "non_retriable",
          reason: `${run.failure.code}: ${reason}`,
          source: "failure-field",
          ...(run.failure.code === "pod.oom_killed" ? { outOfMemory: true } : {}),
        };
      }
      return classifyFailureMessage(reason);
    }
    case "input-required":
      return {
        class: "non_retriable",
        reason: `the agent asked a question (the brief forbids questions): ${reason}`,
        source: "state",
      };
    default:
      return {
        class: "non_retriable",
        reason: `run ended in ${run.state}: ${reason}`,
        source: "state",
      };
  }
}

/**
 * Fallback for deployments without `failure` on the run. The first match
 * wins. A message that matches no row is non-retriable.
 */
export const FAILURE_MESSAGE_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  class: FailureClass;
  label: string;
  outOfMemory?: boolean;
}> = [
  {
    pattern: /budget|cost limit|spend limit/i,
    class: "non_retriable",
    label: "budget exceeded",
  },
  {
    pattern: /ImagePull|ErrImagePull|image pull|pull image/i,
    class: "non_retriable",
    label: "image pull failed",
  },
  {
    pattern: /OOMKilled|out of memory/i,
    class: "non_retriable",
    label: "out of memory",
    outOfMemory: true,
  },
  {
    pattern: /guardrail|invalid .*policy|policy .*invalid/i,
    class: "non_retriable",
    label: "invalid guardrails policy",
  },
  {
    pattern: /privilege|image .*changed|changed .*image/i,
    class: "non_retriable",
    label: "image or privilege changed",
  },
  {
    pattern: /envelope/i,
    class: "non_retriable",
    label: "runtime envelope configuration error",
  },
  {
    pattern: /required credentials|missing credential|must configure|sign in to/i,
    class: "non_retriable",
    label: "credentials or configuration missing",
  },
  { pattern: /evicted/i, class: "retriable", label: "pod evicted" },
  {
    pattern: /overloaded|too many requests|rate limit|throttl/i,
    class: "retriable",
    label: "API overloaded",
  },
  { pattern: /capacity/i, class: "retriable", label: "capacity wait expired" },
  {
    pattern: /temporarily unavailable|service unavailable|try again/i,
    class: "retriable",
    label: "provider temporarily unavailable",
  },
  {
    pattern: /terminal recording stopped/i,
    class: "retriable",
    label: "terminal recording stopped",
  },
];

export function classifyFailureMessage(message: string): Classification {
  for (const row of FAILURE_MESSAGE_PATTERNS) {
    if (row.pattern.test(message)) {
      return {
        class: row.class,
        reason: `${row.label}: ${message}`,
        source: "message-pattern",
        ...(row.outOfMemory ? { outOfMemory: true } : {}),
      };
    }
  }
  return {
    class: "non_retriable",
    reason: `unrecognized failure: ${message}`,
    source: "message-pattern",
  };
}
