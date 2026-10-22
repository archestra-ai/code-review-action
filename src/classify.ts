import type { AgentRun, ArchestraApiError } from "./archestra/client";

/**
 * - retriable: try the same runtime again (after a delay).
 * - non_retriable: go to the next runtime.
 * - fatal: stop all attempts (the API key is shared by all runtimes).
 */
export type FailureClass = "retriable" | "non_retriable" | "fatal";

/** Which signal gave the class. The action logs it for each attempt. */
export type ClassificationSource =
  | "http"
  | "failure-field"
  | "message-pattern"
  | "state"
  | "timeout"
  | "contract";

export interface Classification {
  class: FailureClass;
  reason: string;
  source: ClassificationSource;
}

/** Classifies an HTTP or network failure of the Archestra API. */
export function classifyApiError(error: ArchestraApiError): Classification {
  const { status } = error;
  if (status === null) {
    return { class: "retriable", reason: error.message, source: "http" };
  }
  if (status === 401) {
    return {
      class: "fatal",
      reason: `${error.message} (the API key is not valid; all runtimes use the same key)`,
      source: "http",
    };
  }
  if (status === 429 || status >= 500) {
    return { class: "retriable", reason: error.message, source: "http" };
  }
  // 403/404 (no use permission, agent missing), 409 (preflight: missing
  // credentials, misconfigured runtime, Claude Code sign-in) and other 4xx.
  return { class: "non_retriable", reason: error.message, source: "http" };
}

/** Classifies a run that stopped in a state other than COMPLETED. */
export function classifyRun(run: AgentRun): Classification {
  const reason = run.statusReason?.trim() || "no reason given";
  switch (run.state) {
    case "TASK_STATE_FAILED": {
      if (run.failure) {
        return {
          class: run.failure.retriable ? "retriable" : "non_retriable",
          reason: `${run.failure.code}: ${run.failure.message}`,
          source: "failure-field",
        };
      }
      return classifyFailureMessage(reason);
    }
    case "TASK_STATE_INPUT_REQUIRED":
      return {
        class: "non_retriable",
        reason: `the agent asked a question (the brief forbids questions): ${reason}`,
        source: "state",
      };
    default:
      return {
        class: "non_retriable",
        reason: `run ended in ${run.state.replace("TASK_STATE_", "")}: ${reason}`,
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
      };
    }
  }
  return {
    class: "non_retriable",
    reason: `unrecognized failure: ${message}`,
    source: "message-pattern",
  };
}
