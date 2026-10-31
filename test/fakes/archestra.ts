import { HttpResponse, http } from "msw";

// An in-memory Archestra MCP gateway with the Remote Agents tools, for tests
// and the local harness. It follows the platform's run model: a run id is
// stable across turns, get_agent_run shows the newest turn, the workspace
// keeps its files between turns, and steer_agent_run on a finished run
// starts the next turn. Each agent has a queue of scripts; each start or
// continuation takes the next one.

export type RunScript =
  | { start: "http"; status: number; message?: string }
  | { start: "tool-error"; text: string }
  | {
      end: "completed";
      files: Record<string, unknown>;
      polls?: number;
      /** Files the run writes while it works, before it completes. */
      liveFiles?: Record<string, unknown>;
    }
  | {
      end: "failed";
      statusReason: string;
      failure?: { code: string; retriable: boolean };
      polls?: number;
      liveFiles?: Record<string, unknown>;
    }
  | { end: "canceled" | "rejected" | "input-required" | "auth-required"; statusReason?: string; polls?: number }
  | { end: "never" };

type TurnScript = Exclude<RunScript, { start: string }>;

interface FakeTurn {
  state: string;
  statusReason: string | null;
  failure: { code: string; retriable: boolean } | null;
  polls: number;
  script: TurnScript;
  createdAt: string;
  ended: boolean;
}

interface FakeRun {
  runId: string;
  agentId: string;
  owner: string;
  turns: FakeTurn[];
  files: Record<string, string>;
  /** get_agent_run calls that still show the turn before the last continuation. */
  lag: number;
}

export interface RecordedStart {
  kind: "start" | "continue";
  agentId: string;
  runId: string | null;
  previousRunId: string | null;
  message: string;
  /** Input file names: attachments, or the files written before a continuation (without the turn prefix). */
  attachmentNames: string[];
  attachments: Record<string, string>;
  token: string | null;
  /** The `limits` argument of a start, when the caller sent one. */
  limits?: unknown;
}

const TIERS = ["S", "M", "L"] as const;

const TOOL_NAMES = [
  "start_agent_run",
  "get_agent_run",
  "steer_agent_run",
  "cancel_agent_run",
  "read_workspace_file",
  "write_workspace_file",
  "transfer_credential",
  "delete_workspace",
] as const;

type ToolResult = { content: Array<{ type: "text"; text: string }>; structuredContent?: unknown; isError?: boolean };
type ToolOutcome = ToolResult | { httpStatus: number; message: string };

export class FakeArchestra {
  readonly origin = "https://archestra.test";
  readonly gatewayUrl = `${this.origin}/v1/mcp/code-review`;
  readonly token = "archestra_token_maria";
  /** Another person's token: runs are theirs. */
  readonly otherToken = "archestra_token_other";
  readonly runs = new Map<string, FakeRun>();
  readonly scripts = new Map<string, RunScript[]>();
  readonly starts: RecordedStart[] = [];
  readonly cancels: string[] = [];
  /** Runs whose workspace was deleted, in order. */
  readonly deletes: string[] = [];
  readonly deletedWorkspaces = new Set<string>();
  /** Old deployments: start_agent_run has no `limits` argument. */
  rejectLimits = false;
  /** Agents whose own limits refuse a request, with the platform's message. */
  readonly limitRefusals = new Map<string, string>();
  /** An Agent's own container size; M when unset, as on the platform. */
  readonly agentTiers = new Map<string, "S" | "M" | "L">();
  /** The largest tier an Agent lets a run ask for; its own size when unset. */
  readonly maxTiers = new Map<string, "S" | "M" | "L">();
  readonly credentials: Array<{ agentId: string; key: string; valueLength: number }> = [];
  readonly writes: Array<{ runId: string; path: string; turn: number }> = [];
  /** Every JSON-RPC method and tool name, in order. */
  readonly calls: string[] = [];
  /** Requests after initialize that lacked the protocol version or session id header. */
  readonly missingHeaders: string[] = [];
  /** Run ids whose newest turn shows as working this many more times. */
  readonly busyContinues = new Map<string, number>();
  /** Run ids whose workspace is no longer retained. */
  readonly expiredWorkspaces = new Set<string>();
  /** "direct": the tools are listed. "run_tool": only search_tools and run_tool are listed. */
  exposure: "direct" | "run_tool" = "direct";
  /** Tools that the gateway does not expose. */
  readonly hiddenTools = new Set<string>();
  /** Answer requests as SSE instead of JSON. */
  sse = false;
  /** Old deployments: no `failure` field on runs. */
  legacy = false;
  /** Guardrails narrows status reasons. */
  narrow = false;
  /** get_agent_run calls that still show the previous turn after a continuation. */
  continuationLag = 0;
  private counter = 0;

  script(agentId: string, ...scripts: RunScript[]): this {
    this.scripts.set(agentId, [...(this.scripts.get(agentId) ?? []), ...scripts]);
    return this;
  }

  /** Adds a finished run, for example the review that a fix continues. */
  seedRun(agentId: string, runId: string, owner = this.token): void {
    this.runs.set(runId, {
      runId,
      agentId,
      owner,
      turns: [
        {
          state: "completed",
          statusReason: null,
          failure: null,
          polls: 0,
          script: { end: "completed", files: {} },
          createdAt: this.timestamp(),
          ended: true,
        },
      ],
      files: {},
      lag: 0,
    });
  }

  handlers() {
    return [
      http.post(this.gatewayUrl, async ({ request }) => {
        const authorization = request.headers.get("authorization") ?? "";
        const caller = [this.token, this.otherToken].find((token) => authorization === `Bearer ${token}`);
        if (!caller) {
          return HttpResponse.json(
            { error: "Unauthorized", message: "Invalid or expired platform token" },
            { status: 401 },
          );
        }
        const body = (await request.json()) as {
          id?: number;
          method?: string;
          params?: { name?: string; arguments?: Record<string, unknown> };
        };
        const method = body.method ?? "";
        this.calls.push(method === "tools/call" ? `tools/call ${body.params?.name}` : method);
        if (method !== "initialize") {
          if (
            !request.headers.get("mcp-protocol-version") ||
            request.headers.get("mcp-session-id") !== "fake-session"
          ) {
            this.missingHeaders.push(method);
          }
        }
        if (method === "notifications/initialized") return new HttpResponse(null, { status: 202 });
        if (method === "initialize") {
          return this.reply(
            body.id,
            {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "archestra-fake", version: "1" },
            },
            { "mcp-session-id": "fake-session" },
          );
        }
        if (method === "tools/list") return this.reply(body.id, { tools: this.listTools() });
        if (method !== "tools/call") {
          return HttpResponse.json({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32601, message: "Method not found" },
          });
        }
        const outcome = this.callTool(caller, body.params?.name ?? "", body.params?.arguments ?? {});
        if ("httpStatus" in outcome) {
          return HttpResponse.json(
            { error: "Error", message: outcome.message ?? `HTTP ${outcome.httpStatus}` },
            { status: outcome.httpStatus },
          );
        }
        return this.reply(body.id, outcome);
      }),
    ];
  }

  private reply(id: number | undefined, result: unknown, headers: Record<string, string> = {}) {
    const message = { jsonrpc: "2.0", id, result };
    if (this.sse) {
      return new HttpResponse(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
        headers: { "content-type": "text/event-stream", ...headers },
      });
    }
    return HttpResponse.json(message, { headers });
  }

  private listTools() {
    const names =
      this.exposure === "run_tool"
        ? ["archestra__search_tools", "archestra__run_tool"]
        : TOOL_NAMES.filter((name) => !this.hiddenTools.has(name)).map((name) => `archestra__${name}`);
    return [...names, "archestra__whoami"].map((name) => ({ name, inputSchema: { type: "object" } }));
  }

  private callTool(caller: string, name: string, args: Record<string, unknown>): ToolOutcome {
    let toolName = name;
    let toolArgs = args;
    if (this.exposure === "run_tool") {
      if (name !== "archestra__run_tool") return toolError(`Tool ${name} is not available`);
      toolName = String(args.tool_name ?? "");
      toolArgs = (args.tool_args as Record<string, unknown>) ?? {};
    }
    const short = toolName.replace(/^archestra__/, "");
    if (!(TOOL_NAMES as readonly string[]).includes(short) || this.hiddenTools.has(short)) {
      return toolError(`Tool ${toolName} is not assigned to this agent`);
    }
    switch (short) {
      case "start_agent_run":
        return this.start(caller, toolArgs);
      case "get_agent_run":
        return this.get(caller, String(toolArgs.run_id));
      case "steer_agent_run":
        return this.steer(caller, String(toolArgs.run_id), String(toolArgs.message ?? ""));
      case "cancel_agent_run":
        return this.cancel(caller, String(toolArgs.run_id));
      case "read_workspace_file":
        return this.read(caller, String(toolArgs.run_id), String(toolArgs.path));
      case "write_workspace_file":
        return this.write(caller, toolArgs);
      case "delete_workspace":
        return this.deleteWorkspace(caller, String(toolArgs.run_id), toolArgs.confirm_delete === true);
      default:
        return this.transfer(toolArgs);
    }
  }

  private start(caller: string, args: Record<string, unknown>): ToolOutcome {
    const agentId = String(args.agent_id);
    const attachments = Array.isArray(args.attachments)
      ? (args.attachments as Array<{ name: string; contentBase64: string }>)
      : [];
    const record: RecordedStart = {
      kind: "start",
      agentId,
      runId: null,
      previousRunId: null,
      message: String(args.message ?? ""),
      attachmentNames: attachments.map((attachment) => attachment.name),
      attachments: Object.fromEntries(
        attachments.map((attachment) => [
          attachment.name,
          Buffer.from(attachment.contentBase64, "base64").toString("utf8"),
        ]),
      ),
      token: caller,
      ...(args.limits !== undefined ? { limits: args.limits } : {}),
    };
    this.starts.push(record);
    if (this.rejectLimits && args.limits !== undefined) {
      return toolError('Validation error in archestra__start_agent_run: unrecognized key "limits"');
    }
    const refusal = this.limitRefusals.get(agentId);
    if (refusal && args.limits !== undefined) return toolError(refusal);
    const requested = (args.limits as { tier?: "S" | "M" | "L" } | undefined)?.tier;
    const agentTier = this.agentTiers.get(agentId) ?? "M";
    const maxTier = this.maxTiers.get(agentId) ?? agentTier;
    if (requested && TIERS.indexOf(requested) > TIERS.indexOf(maxTier)) {
      return toolError(`Tier ${requested} is above this Agent's largest tier ${maxTier}`);
    }
    const script = this.scripts.get(agentId)?.shift();
    if (!script) return toolError("Agent not found");
    if ("start" in script) {
      return script.start === "http"
        ? { httpStatus: script.status, message: script.message ?? `HTTP ${script.status}` }
        : toolError(script.text);
    }
    const runId = `00000000-0000-4000-8000-${String(++this.counter).padStart(12, "0")}`;
    record.runId = runId;
    const run: FakeRun = { runId, agentId, owner: caller, turns: [this.newTurn(script)], files: {}, lag: 0 };
    this.runs.set(runId, run);
    // The platform reports the limits the run got: the request, else the Agent's own.
    const limits = { ...((args.limits as Record<string, unknown> | undefined) ?? {}), tier: requested ?? agentTier };
    return toolResult({
      run: this.summary(run),
      run_url: `${this.origin}/chat/runs/${runId}`,
      limits,
      next_step: "Wait.",
    });
  }

  private get(caller: string, runId: string): ToolOutcome {
    const run = this.runs.get(runId);
    if (!run) return toolError("Run not found");
    const own = run.owner === caller;
    const busy = this.busyContinues.get(runId) ?? 0;
    let shown = run.turns.at(-1) as FakeTurn;
    if (busy > 0) {
      this.busyContinues.set(runId, busy - 1);
      shown = { ...shown, state: "working", ended: false };
    } else if (run.lag > 0) {
      run.lag--;
      shown = run.turns.at(-2) ?? shown;
    } else {
      this.advance(run, shown);
    }
    const expired = this.expiredWorkspaces.has(runId);
    const deleted = this.deletedWorkspaces.has(runId);
    const workspaceState = deleted ? "deleted" : expired ? "suspended" : shown.ended ? "idle" : "active";
    return toolResult({
      run: this.summary(run, shown),
      run_url: `${this.origin}/chat/runs/${runId}`,
      requests: [],
      output: "",
      output_truncated: false,
      workspace: own
        ? {
            state: workspaceState,
            retained_until: new Date(Date.now() + (expired ? -3_600_000 : 3_600_000)).toISOString(),
            can_continue: !expired && !deleted && (shown.ended ? workspaceState === "idle" : true),
            continuation_error: deleted
              ? "This run's workspace was removed and cannot resume."
              : expired
                ? "This run expired and cannot resume."
                : null,
            connection: null,
          }
        : null,
      session: { attachable: !shown.ended, started_at: shown.createdAt },
    });
  }

  private steer(caller: string, runId: string, message: string): ToolOutcome {
    const run = this.runs.get(runId);
    if (!run) return toolError("Run not found");
    if (run.owner !== caller) return toolError("Only the person the run acts as can steer it.");
    const current = run.turns.at(-1) as FakeTurn;
    if (!current.ended) return toolResult({ status: "steered", run_id: runId, run_url: "", next_step: "Wait." });
    if (this.expiredWorkspaces.has(runId) || this.deletedWorkspaces.has(runId)) {
      return toolError("The run is unavailable, busy, or expired. No new run was started.");
    }
    const since = this.writes.filter((write) => write.runId === runId && write.turn === run.turns.length);
    const inputs = since.filter((write) => !/\.json$/.test(write.path) || /^turn-/.test(write.path));
    const record: RecordedStart = {
      kind: "continue",
      agentId: run.agentId,
      runId,
      previousRunId: runId,
      message,
      attachmentNames: inputs.map((write) => write.path.replace(/^turn-[a-z0-9]+-/, "")),
      attachments: Object.fromEntries(
        inputs.map((write) => [write.path.replace(/^turn-[a-z0-9]+-/, ""), run.files[write.path] ?? ""]),
      ),
      token: caller,
    };
    this.starts.push(record);
    const script = this.scripts.get(run.agentId)?.shift();
    if (!script || "start" in script) return toolError("An internal error occurred while steering the run");
    run.turns.push(this.newTurn(script));
    run.lag = this.continuationLag;
    return toolResult({ status: "continued", run_id: runId, run_url: "", next_step: "Wait." });
  }

  private deleteWorkspace(caller: string, runId: string, confirmed: boolean): ToolOutcome {
    const run = this.runs.get(runId);
    if (!run || run.owner !== caller) return toolError("Run not found");
    if (!confirmed) return toolError("confirm_delete must be true");
    const turn = run.turns.at(-1) as FakeTurn;
    if (!turn.ended) return toolError("Cancel any active run first and wait for it to finish.");
    this.deletes.push(runId);
    this.deletedWorkspaces.add(runId);
    return toolResult({ run_id: runId, state: "deleted" });
  }
  private cancel(caller: string, runId: string): ToolOutcome {
    const run = this.runs.get(runId);
    if (!run || run.owner !== caller) return toolError("Run not found");
    const turn = run.turns.at(-1) as FakeTurn;
    if (turn.ended) return toolError(`Run ${runId} cannot be canceled because it is already terminal.`);
    this.cancels.push(runId);
    turn.state = "canceled";
    turn.ended = true;
    return toolResult({ run: this.summary(run) });
  }

  private read(caller: string, runId: string, path: string): ToolOutcome {
    const run = this.runs.get(runId);
    if (!run || run.owner !== caller) return toolError("Run not found");
    const content = run.files[path];
    if (content === undefined) {
      return toolError(
        `Could not read ${path} from the run's workspace: [Errno 2] No such file or directory: '${path}'`,
      );
    }
    const bytes = Buffer.from(content, "utf8");
    return toolResult({
      path,
      size: bytes.byteLength,
      sha256: "0".repeat(64),
      encoding: "base64",
      content: bytes.toString("base64"),
    });
  }

  private write(caller: string, args: Record<string, unknown>): ToolOutcome {
    const runId = String(args.run_id);
    const run = this.runs.get(runId);
    if (!run || run.owner !== caller) return toolError("Run not found");
    const path = String(args.path);
    if (path.includes("/")) return toolError(`Could not write ${path}: parent directory does not exist`);
    if (run.files[path] !== undefined && args.overwrite !== true) {
      return toolError(`Could not write ${path}: [Errno 17] File exists`);
    }
    const content = String(args.content ?? "");
    run.files[path] = args.encoding === "base64" ? Buffer.from(content, "base64").toString("utf8") : content;
    this.writes.push({ runId, path, turn: run.turns.length });
    return toolResult({ path, size: content.length, sha256: "0".repeat(64) });
  }

  private transfer(args: Record<string, unknown>): ToolOutcome {
    const entry = (args.environment as Array<{ key: string; type: string; value?: string }> | undefined)?.[0];
    if (!entry) return toolError("Validation error: environment");
    if (entry.type !== "secret") return toolError("Validation error: environment.0.type");
    this.credentials.push({ agentId: String(args.agent_id), key: entry.key, valueLength: entry.value?.length ?? 0 });
    return toolResult({ key: entry.key, scope: "personal", valueStored: true });
  }

  private newTurn(script: TurnScript): FakeTurn {
    return {
      state: "submitted",
      statusReason: null,
      failure: null,
      polls: 0,
      script,
      createdAt: this.timestamp(),
      ended: false,
    };
  }

  private timestamp(): string {
    return new Date(Date.UTC(2026, 9, 23) + ++this.counter * 1000).toISOString();
  }

  private summary(run: FakeRun, turn = run.turns.at(-1) as FakeTurn) {
    return {
      run_id: run.runId,
      state: turn.state,
      agent_id: run.agentId,
      status_reason:
        turn.statusReason && this.narrow
          ? "Details are withheld under Guardrails; a person can read them on the run page."
          : turn.statusReason,
      ...(this.legacy ? {} : { failure: turn.state === "failed" ? turn.failure : null }),
      created_at: turn.createdAt,
      state_changed_at: turn.createdAt,
    };
  }

  private advance(run: FakeRun, turn: FakeTurn) {
    if (turn.ended) return;
    turn.polls++;
    const { script } = turn;
    if (turn.polls === 1 && (script.end === "completed" || script.end === "failed")) {
      for (const [name, value] of Object.entries(script.liveFiles ?? {})) {
        run.files[name] = typeof value === "string" ? value : JSON.stringify(value);
      }
    }
    if (script.end === "never" || turn.polls < (script.polls ?? 2)) {
      turn.state = "working";
      return;
    }
    turn.state = script.end;
    // A run that waits for a person stays open, as on the platform.
    turn.ended = script.end !== "input-required" && script.end !== "auth-required";
    if (script.end === "completed") {
      for (const [name, value] of Object.entries(script.files)) {
        run.files[name] = typeof value === "string" ? value : JSON.stringify(value);
      }
    } else if (script.end === "failed") {
      turn.statusReason = script.statusReason;
      turn.failure = script.failure ?? null;
    } else {
      turn.statusReason = script.statusReason ?? null;
    }
  }
}

function toolResult(structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
}

function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}
