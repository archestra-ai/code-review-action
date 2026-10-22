import { z } from "zod";

/**
 * Where a call to the Archestra gateway failed:
 * - network: no HTTP response (DNS, TLS, reset, timeout).
 * - http: an HTTP status other than 2xx. `status` is the HTTP status.
 * - rpc: a JSON-RPC error object. `status` is the JSON-RPC error code.
 * - tool: the tool ran and returned `isError`.
 * - response: the response does not have the expected shape.
 * The message never contains the token.
 */
export type ApiErrorKind = "network" | "http" | "rpc" | "tool" | "response";

export class ArchestraApiError extends Error {
  constructor(
    readonly operation: string,
    readonly kind: ApiErrorKind,
    readonly detail: string,
    readonly status: number | null = null,
    /** True when the gateway does not expose the tool at all. */
    readonly missingTool = false,
  ) {
    super(`${operation}: ${prefix(kind, status)}${detail}`);
    this.name = "ArchestraApiError";
  }
}

function prefix(kind: ApiErrorKind, status: number | null): string {
  switch (kind) {
    case "network":
      return "network error: ";
    case "http":
      return `HTTP ${status}: `;
    case "rpc":
      return `JSON-RPC error ${status}: `;
    case "response":
      return "unexpected response: ";
    case "tool":
      return "";
  }
}

/**
 * The revision that every gateway since the Remote Agents tools accepts with
 * the initialize handshake. Newer gateways also accept a stateless revision;
 * the handshake keeps the action compatible with both.
 */
export const MCP_PROTOCOL_VERSION = "2025-11-25";

const ToolResultSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).default([]),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
});

export interface McpSessionOptions {
  /** The gateway endpoint, `<origin>/v1/mcp/<gateway>`. */
  url: string;
  token: string;
  clientName: string;
  clientVersion: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

/**
 * A minimal MCP client over Streamable HTTP that uses POST only. It does not
 * open the optional GET stream: a review polls for up to two hours, and that
 * stream would stay open the whole time without carrying anything this
 * client needs. It declares no client capabilities, so the gateway answers
 * with JSON; an SSE answer is parsed as well.
 */
export class McpSession {
  readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly clientInfo: { name: string; version: string };
  private sessionId: string | null = null;
  private protocolVersion = MCP_PROTOCOL_VERSION;
  private initializing: Promise<void> | null = null;
  private nextId = 1;

  constructor(options: McpSessionOptions) {
    this.url = options.url;
    this.token = options.token;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.clientInfo = { name: options.clientName, version: options.clientVersion };
  }

  /** Calls a tool. Returns the structured result, or the parsed text. */
  async callTool(name: string, args: Record<string, unknown>, operation: string): Promise<Record<string, unknown>> {
    const raw = await this.request("tools/call", { name, arguments: args }, operation);
    const parsed = ToolResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ArchestraApiError(operation, "response", "the tool result has no content");
    }
    const text = parsed.data.content
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("\n")
      .trim();
    if (parsed.data.isError) {
      throw new ArchestraApiError(operation, "tool", toolErrorText(text));
    }
    if (parsed.data.structuredContent) return parsed.data.structuredContent;
    try {
      const json = JSON.parse(text) as unknown;
      if (json && typeof json === "object" && !Array.isArray(json)) return json as Record<string, unknown>;
    } catch {
      // Not JSON: return the text.
    }
    return { text };
  }

  /** Lists the names of all tools, following the pagination cursor. */
  async listToolNames(operation: string): Promise<string[]> {
    const names: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const result = (await this.request("tools/list", cursor ? { cursor } : {}, operation)) as {
        tools?: Array<{ name?: unknown }>;
        nextCursor?: unknown;
      };
      for (const tool of result.tools ?? []) {
        if (typeof tool.name === "string") names.push(tool.name);
      }
      if (typeof result.nextCursor !== "string" || result.nextCursor === "") break;
      cursor = result.nextCursor;
    }
    return names;
  }

  async request(method: string, params: Record<string, unknown>, operation: string): Promise<unknown> {
    await this.ensureInitialized(operation);
    try {
      return await this.send(method, params, operation);
    } catch (error) {
      // A 404 to a request that carries a session id means that the session
      // expired: initialize again once, then repeat the request.
      if (error instanceof ArchestraApiError && error.kind === "http" && error.status === 404 && this.sessionId) {
        this.sessionId = null;
        this.initializing = null;
        await this.ensureInitialized(operation);
        return this.send(method, params, operation);
      }
      throw error;
    }
  }

  private ensureInitialized(operation: string): Promise<void> {
    this.initializing ??= this.initialize(operation).catch((error: unknown) => {
      this.initializing = null;
      throw error;
    });
    return this.initializing;
  }

  private async initialize(operation: string): Promise<void> {
    const result = (await this.send(
      "initialize",
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: this.clientInfo },
      operation,
    )) as { protocolVersion?: unknown };
    if (typeof result.protocolVersion === "string" && result.protocolVersion) {
      this.protocolVersion = result.protocolVersion;
    }
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, operation);
  }

  private async send(method: string, params: Record<string, unknown>, operation: string): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id, method, params }, operation);
    const message = findResponse(response.messages, id);
    if (!message) {
      throw new ArchestraApiError(operation, "response", `no JSON-RPC response for ${method}`);
    }
    if (message.error) {
      throw new ArchestraApiError(
        operation,
        "rpc",
        String(message.error.message ?? "no message").slice(0, 500),
        typeof message.error.code === "number" ? message.error.code : null,
      );
    }
    return message.result ?? {};
  }

  private async post(body: Record<string, unknown>, operation: string): Promise<{ messages: unknown[] }> {
    const isInitialize = body.method === "initialize";
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(isInitialize ? {} : { "Mcp-Protocol-Version": this.protocolVersion }),
          ...(this.sessionId && !isInitialize ? { "Mcp-Session-Id": this.sessionId } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      throw new ArchestraApiError(operation, "network", error instanceof Error ? error.message : String(error));
    }
    if (isInitialize) {
      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId) this.sessionId = sessionId;
    }
    const text = await response.text();
    if (!response.ok) {
      throw new ArchestraApiError(operation, "http", errorDetail(text, response.statusText), response.status);
    }
    if (text.trim() === "") return { messages: [] };
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) return { messages: parseSse(text) };
    try {
      const json = JSON.parse(text) as unknown;
      return { messages: Array.isArray(json) ? json : [json] };
    } catch {
      throw new ArchestraApiError(operation, "response", "the response is not JSON");
    }
  }
}

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

function findResponse(messages: unknown[], id: number): JsonRpcResponse | null {
  for (const message of messages) {
    if (message && typeof message === "object" && (message as JsonRpcResponse).id === id) {
      const candidate = message as JsonRpcResponse;
      if ("result" in candidate || "error" in candidate) return candidate;
    }
  }
  return null;
}

/** Reads the JSON messages of an SSE body. Events without JSON data are skipped. */
export function parseSse(text: string): unknown[] {
  const messages: unknown[] = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      // Not a JSON-RPC message.
    }
  }
  return messages;
}

/** Tool errors start with "Error: "; the prefix adds nothing to a log line. */
function toolErrorText(text: string): string {
  return (text.replace(/^Error:\s*/, "") || "the tool returned an error without a message").slice(0, 1000);
}

/** The gateway answers HTTP errors as { error, message } or as a JSON-RPC error. */
function errorDetail(text: string, fallback: string): string {
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    if (typeof parsed.message === "string") return parsed.message.slice(0, 500);
    if (typeof parsed.error === "string") return parsed.error.slice(0, 500);
    if (typeof parsed.error?.message === "string") return parsed.error.message.slice(0, 500);
  } catch {
    // Not JSON: use the raw text.
  }
  return (text.trim() || fallback || "no detail").slice(0, 300);
}
