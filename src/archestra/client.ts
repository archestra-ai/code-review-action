import { z } from "zod";
import type { Attachment } from "../util";

export const TASK_STATES = [
  "TASK_STATE_UNSPECIFIED",
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_AUTH_REQUIRED",
] as const;

/** States after which the action stops polling. */
const TERMINAL_STATES = new Set<string>([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_AUTH_REQUIRED",
]);

export function isTerminalState(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * An HTTP or network failure of the Archestra API. `status` is null for a
 * network failure. The message never contains the API key.
 */
export class ArchestraApiError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number | null,
    readonly detail: string,
  ) {
    super(
      status === null
        ? `${operation}: network error: ${detail}`
        : `${operation}: HTTP ${status}: ${detail}`,
    );
    this.name = "ArchestraApiError";
  }
}

const FailureSchema = z.object({
  code: z.string(),
  retriable: z.boolean(),
  message: z.string(),
});

const RunSchema = z.object({
  taskId: z.string(),
  state: z.string(),
  statusReason: z.string().nullish(),
  sessionId: z.string().nullish(),
  agentId: z.string().nullish(),
  endedAt: z.string().nullish(),
  failure: FailureSchema.nullish(),
  workspace: z
    .object({ state: z.string(), expiresAt: z.string().nullish() })
    .nullish(),
});

export type AgentRun = z.infer<typeof RunSchema>;

const StartSchema = z.object({
  taskId: z.string(),
  state: z.string().optional(),
  sessionId: z.string().nullish(),
});

export type StartedRun = z.infer<typeof StartSchema>;

const FileSchema = z.object({
  path: z.string(),
  size: z.number(),
  sha256: z.string(),
  content_base64: z.string().optional(),
});

export interface ArchestraClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

export class ArchestraClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: ArchestraClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
  }

  /** The run page in the Archestra UI. */
  runUrl(taskId: string): string {
    return `${this.baseUrl}/chat/runs/${taskId}`;
  }

  async startRun(
    agentId: string,
    body: { message: string; attachments: Attachment[]; title: string },
  ): Promise<StartedRun> {
    const data = await this.request(
      "POST",
      `/api/agents/${encodeURIComponent(agentId)}/runs`,
      "start run",
      { ...body, runtimeMode: "one_shot" },
    );
    return parse(StartSchema, data, "start run");
  }

  async continueRun(
    taskId: string,
    body: { message: string; attachments: Attachment[] },
  ): Promise<StartedRun> {
    const data = await this.request(
      "POST",
      `/api/agent-runs/${encodeURIComponent(taskId)}/continue`,
      "continue run",
      { ...body, runtimeMode: "one_shot" },
    );
    return parse(StartSchema, data, "continue run");
  }

  async getRun(taskId: string): Promise<AgentRun> {
    const data = await this.request(
      "GET",
      `/api/agent-runs/${encodeURIComponent(taskId)}`,
      "get run",
    );
    return parse(RunSchema, data, "get run");
  }

  async cancelRun(taskId: string): Promise<void> {
    await this.request(
      "POST",
      `/api/agent-runs/${encodeURIComponent(taskId)}/cancel`,
      "cancel run",
      {},
    );
  }

  /** Reads a file from the run's workspace. Returns null when it is absent. */
  async readWorkspaceFile(taskId: string, path: string): Promise<Buffer | null> {
    let data: unknown;
    try {
      data = await this.request(
        "GET",
        `/api/agent-runs/${encodeURIComponent(taskId)}/workspace/files?path=${encodeURIComponent(path)}`,
        "read workspace file",
      );
    } catch (error) {
      if (error instanceof ArchestraApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
    const file = parse(FileSchema, data, "read workspace file");
    if (file.content_base64 === undefined) {
      throw new ArchestraApiError(
        "read workspace file",
        200,
        `${path} has no content in the response (${file.size} bytes)`,
      );
    }
    return Buffer.from(file.content_base64, "base64");
  }

  async setRuntimeCredential(
    agentId: string,
    key: string,
    value: string,
  ): Promise<void> {
    await this.request(
      "PUT",
      `/api/agents/${encodeURIComponent(agentId)}/runtime/credentials/${encodeURIComponent(key)}`,
      "store runtime credential",
      { value },
    );
  }

  private async request(
    method: string,
    path: string,
    operation: string,
    body?: unknown,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: this.apiKey,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      throw new ArchestraApiError(
        operation,
        null,
        error instanceof Error ? error.message : String(error),
      );
    }
    const text = await response.text();
    if (!response.ok) {
      throw new ArchestraApiError(
        operation,
        response.status,
        errorDetail(text, response.statusText),
      );
    }
    if (text.trim() === "") return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new ArchestraApiError(
        operation,
        response.status,
        "the response is not JSON",
      );
    }
  }
}

function parse<T>(schema: z.ZodType<T>, data: unknown, operation: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ArchestraApiError(
      operation,
      200,
      `unexpected response shape: ${result.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

/** The platform formats errors as { error: { message, type } }. */
function errorDetail(text: string, fallback: string): string {
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    if (typeof parsed.error === "string") return parsed.error.slice(0, 500);
    if (typeof parsed.error?.message === "string") {
      return parsed.error.message.slice(0, 500);
    }
    if (typeof parsed.message === "string") return parsed.message.slice(0, 500);
  } catch {
    // Not JSON: use the raw text.
  }
  return (text.trim() || fallback || "no detail").slice(0, 300);
}
