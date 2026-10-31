import { z } from "zod";
import type { Attachment } from "../util";
import { ArchestraApiError, McpSession } from "./mcp";

export { ArchestraApiError } from "./mcp";

/**
 * The run states of the Remote Agents tools. `input-required` and
 * `auth-required` wait for a person, so the action treats them as the end.
 */
const TERMINAL_STATES = new Set(["completed", "failed", "canceled", "rejected", "input-required", "auth-required"]);

export function isTerminalState(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

/** The tools that the action calls, by their short names. */
export const RUN_TOOLS = {
  start: "start_agent_run",
  get: "get_agent_run",
  steer: "steer_agent_run",
  cancel: "cancel_agent_run",
  read: "read_workspace_file",
  write: "write_workspace_file",
  credential: "transfer_credential",
  delete: "delete_workspace",
} as const;

/** Limits a run asks for, each at or below its Agent's own. */
export interface RunLimits {
  /** A runtime tier by the name the organization gave it. */
  tier?: string;
  /** CPUs the work needs: the smallest tier the Agent may use with at least this many. */
  minCpu?: number;
  /** GiB of memory the work needs, with the same effect. */
  minMemoryGib?: number;
  idleTimeoutMinutes?: number;
  /** The run and its saved files end this many hours after the start. */
  maxDurationHours?: number;
  maxCostUsd?: number;
}

const ARCHESTRA_PREFIX = "archestra__";
const RUN_TOOL = "run_tool";

const FailureSchema = z.object({ code: z.string(), retriable: z.boolean() });

const RunSummarySchema = z.object({
  run_id: z.string(),
  state: z.string(),
  agent_id: z.string().nullish(),
  status_reason: z.string().nullish(),
  failure: FailureSchema.nullish(),
  created_at: z.string().nullish(),
  state_changed_at: z.string().nullish(),
});

/** The limits a run got, as the gateway reports them on a start. */
const RunLimitsSchema = z.object({
  tier: z.string().nullish(),
  idle_timeout_minutes: z.number().nullish(),
  max_duration_hours: z.number().nullish(),
  max_cost_usd: z.number().nullish(),
});

const StartResultSchema = z.object({
  run: RunSummarySchema,
  run_url: z.string().nullish(),
  limits: RunLimitsSchema.nullish(),
});

const GetResultSchema = z.object({
  run: RunSummarySchema,
  run_url: z.string().nullish(),
  workspace: z
    .object({
      state: z.string(),
      retained_until: z.string().nullish(),
      can_continue: z.boolean(),
      continuation_error: z.string().nullish(),
    })
    .nullish(),
});

const SteerResultSchema = z.object({ status: z.string(), run_url: z.string().nullish() });

const FileResultSchema = z.object({
  status: z.string().optional(),
  content: z.string().optional(),
  size: z.number().optional(),
});

export interface RunFailure {
  code: string;
  retriable: boolean;
}

export interface AgentRun {
  /** Stable across turns: the first turn's id, also the workspace id. */
  runId: string;
  state: string;
  statusReason: string | null;
  failure: RunFailure | null;
  /** When the current turn was created. A continuation changes it. */
  turnCreatedAt: string | null;
  runUrl: string | null;
  workspace: {
    state: string;
    retainedUntil: string | null;
    canContinue: boolean;
    continuationError: string | null;
  } | null;
}

export interface StartedRun {
  runId: string;
  state: string;
  runUrl: string | null;
  /** For a continuation: the previous turn's creation time, to tell the new turn apart. */
  previousTurnCreatedAt: string | null;
  /** True when the run continued the workspace of an earlier run. */
  continued: boolean;
  /**
   * The limits the run got: what the gateway reported (its tier by name),
   * else the request when the gateway accepted it. Null when the run took the
   * Agent's own limits without saying which, or continued an earlier run.
   */
  limits: RunLimits | null;
}

export interface ArchestraClientOptions {
  /** `<origin>/v1/mcp/<gateway>`. */
  gatewayUrl: string;
  token: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  clientVersion?: string;
}

/**
 * The Remote Agents tools of one Archestra MCP gateway. Every call acts as
 * the token's user: the runs, their cost and their credentials are that
 * person's. Gateways that list the tools directly and gateways that expose
 * them only through run_tool both work.
 */
export class ArchestraClient {
  readonly gatewayUrl: string;
  readonly origin: string;
  private readonly session: McpSession;
  private toolNames: Promise<Map<string, string>> | null = null;
  private runTool: string | null = null;
  private readonly runUrls = new Map<string, string>();
  /** False once the gateway rejected `limits`: a deployment from before run limits. */
  private limitsSupported = true;

  constructor(options: ArchestraClientOptions) {
    this.gatewayUrl = options.gatewayUrl.replace(/\/+$/, "");
    this.origin = new URL(this.gatewayUrl).origin;
    this.session = new McpSession({
      url: this.gatewayUrl,
      token: options.token,
      clientName: "archestra-code-review-action",
      clientVersion: options.clientVersion ?? "1",
      fetch: options.fetch,
      requestTimeoutMs: options.requestTimeoutMs,
    });
  }

  /** The run page in the Archestra UI. */
  runUrl(runId: string): string {
    return this.runUrls.get(runId) ?? `${this.origin}/chat/runs/${runId}`;
  }

  async startRun(
    agentId: string,
    body: {
      message: string;
      attachments: Attachment[];
      limits?: RunLimits;
      /** Fail instead of starting with the Agent's own limits when it refuses the request. */
      requireLimits?: boolean;
    },
  ): Promise<StartedRun> {
    const args = {
      agent_id: agentId,
      message: body.message,
      ...(body.attachments.length > 0 ? { attachments: body.attachments } : {}),
    };
    const limits = this.limitsSupported && body.limits ? runLimitsArgs(body.limits) : null;
    // A retry with more memory after a memory kill is worth running only at that size: a
    // deployment that cannot take the request would run the Agent's own size again.
    if (body.requireLimits && limits === null) {
      throw new ArchestraApiError(
        "start run",
        "response",
        "the gateway does not take run limits, so the run cannot ask for more memory",
      );
    }
    let applied = limits !== null;
    let data: Record<string, unknown>;
    try {
      data = await this.call(RUN_TOOLS.start, limits ? { ...args, limits } : args, "start run");
    } catch (error) {
      // A deployment from before run limits ignores the argument or, when its schema is strict,
      // rejects it; the run then takes the Agent's defaults. Zod and the gateway word the
      // rejection differently, so only the key name is matched.
      const toolError = limits !== null && error instanceof ArchestraApiError && error.kind === "tool";
      const rejectedLimits = toolError && /unrecognized key.*\blimits\b/i.test(error.detail);
      // An Agent whose own limits are below the request, or whose tiers have no size that fits,
      // refuses them; that Agent's run then takes its own limits. Other Agents still get the
      // request.
      const refusedLimits =
        toolError &&
        /is above this Agent's|sizes its runs with explicit resources|No tier this Agent's runs may use|There is no tier named|has less than the/i.test(
          error.detail,
        );
      if (!rejectedLimits && !refusedLimits) throw error;
      if (body.requireLimits) throw error;
      if (rejectedLimits) this.limitsSupported = false;
      applied = false;
      data = await this.call(RUN_TOOLS.start, args, "start run");
    }
    const result = parse(StartResultSchema, data, "start run");
    this.remember(result.run.run_id, result.run_url);
    const reported = result.limits
      ? {
          // Organizations name their tiers; the saved comment state holds 100 characters of it.
          ...(result.limits.tier ? { tier: result.limits.tier.slice(0, 100) } : {}),
          ...(result.limits.idle_timeout_minutes ? { idleTimeoutMinutes: result.limits.idle_timeout_minutes } : {}),
          ...(result.limits.max_duration_hours ? { maxDurationHours: result.limits.max_duration_hours } : {}),
          ...(result.limits.max_cost_usd ? { maxCostUsd: result.limits.max_cost_usd } : {}),
        }
      : null;
    return {
      runId: result.run.run_id,
      state: result.run.state,
      runUrl: result.run_url ?? null,
      previousTurnCreatedAt: null,
      continued: false,
      limits: reported ?? (applied && body.limits ? body.limits : null),
    };
  }

  async getRun(runId: string): Promise<AgentRun> {
    const data = await this.call(RUN_TOOLS.get, { run_id: runId }, "get run");
    const result = parse(GetResultSchema, data, "get run");
    this.remember(runId, result.run_url);
    const { run, workspace } = result;
    return {
      runId,
      state: run.state,
      statusReason: run.status_reason ?? null,
      failure: run.failure ?? null,
      turnCreatedAt: run.created_at ?? null,
      runUrl: result.run_url ?? null,
      workspace: workspace
        ? {
            state: workspace.state,
            retainedUntil: workspace.retained_until ?? null,
            canContinue: workspace.can_continue,
            continuationError: workspace.continuation_error ?? null,
          }
        : null,
    };
  }

  /**
   * Sends a message to the run. A finished run with a retained workspace
   * continues in a new turn ("continued"); a live run gets the message as a
   * correction ("steered").
   */
  async steerRun(runId: string, message: string): Promise<"continued" | "steered"> {
    const data = await this.call(RUN_TOOLS.steer, { run_id: runId, message }, "continue run");
    const result = parse(SteerResultSchema, data, "continue run");
    return result.status === "steered" ? "steered" : "continued";
  }

  async cancelRun(runId: string): Promise<void> {
    await this.call(RUN_TOOLS.cancel, { run_id: runId }, "cancel run");
  }
  /** Deletes the run's workspace and its files. The run must have ended. */
  async deleteWorkspace(runId: string): Promise<void> {
    await this.call(RUN_TOOLS.delete, { run_id: runId, confirm_delete: true }, "delete workspace");
  }

  /** Reads a file of the run's workspace. Returns null when it does not exist. */
  async readWorkspaceFile(runId: string, path: string): Promise<Buffer | null> {
    let data: Record<string, unknown>;
    try {
      data = await this.call(RUN_TOOLS.read, { run_id: runId, path, encoding: "base64" }, "read workspace file");
    } catch (error) {
      if (
        error instanceof ArchestraApiError &&
        error.kind === "tool" &&
        /No such file or directory/i.test(error.detail)
      ) {
        return null;
      }
      throw error;
    }
    const file = parse(FileResultSchema, data, "read workspace file");
    if (file.status === "pending" || file.content === undefined) {
      throw new ArchestraApiError("read workspace file", "response", `${path} is not readable yet`, 503);
    }
    return Buffer.from(file.content, "base64");
  }

  /** Writes a file into the run's workspace. The parent directory must exist. */
  async writeWorkspaceFile(runId: string, path: string, content: Buffer): Promise<void> {
    await this.call(
      RUN_TOOLS.write,
      { run_id: runId, path, content: content.toString("base64"), encoding: "base64", overwrite: true },
      "write workspace file",
    );
  }

  /**
   * Stores a personal credential of the token's user on the agent. It
   * reaches the agent's next turn, so store it before starting or
   * continuing the run.
   */
  async transferCredential(agentId: string, key: string, value: string, label: string): Promise<void> {
    await this.call(
      RUN_TOOLS.credential,
      { agent_id: agentId, environment: [{ key, type: "secret", value }], label },
      "store runtime credential",
    );
  }

  private remember(runId: string, runUrl: string | null | undefined): void {
    if (runUrl) this.runUrls.set(runId, runUrl);
  }

  private async call(shortName: string, args: Record<string, unknown>, operation: string) {
    const names = await this.resolveTools(operation);
    const direct = names.get(shortName);
    if (direct) return this.session.callTool(direct, args, operation);
    if (this.runTool) {
      return this.session.callTool(
        this.runTool,
        { tool_name: `${ARCHESTRA_PREFIX}${shortName}`, tool_args: args },
        operation,
      );
    }
    throw new ArchestraApiError(
      operation,
      "tool",
      `the gateway does not expose ${shortName}. An administrator adds the Remote Agents tools to the MCP gateway.`,
      null,
      true,
    );
  }

  private resolveTools(operation: string): Promise<Map<string, string>> {
    this.toolNames ??= this.session.listToolNames(operation).then(
      (names) => {
        const byShortName = new Map<string, string>();
        for (const shortName of [...Object.values(RUN_TOOLS), RUN_TOOL]) {
          const match =
            names.find((name) => name === `${ARCHESTRA_PREFIX}${shortName}`) ??
            names.find((name) => name === shortName) ??
            names.find((name) => name.endsWith(`__${shortName}`));
          if (match) byShortName.set(shortName, match);
        }
        this.runTool = byShortName.get(RUN_TOOL) ?? null;
        return byShortName;
      },
      (error: unknown) => {
        this.toolNames = null;
        throw error;
      },
    );
    return this.toolNames;
  }
}

function runLimitsArgs(limits: RunLimits): Record<string, unknown> {
  return {
    ...(limits.tier ? { tier: limits.tier } : {}),
    ...(limits.minCpu ? { min_cpu: limits.minCpu } : {}),
    ...(limits.minMemoryGib ? { min_memory_gib: limits.minMemoryGib } : {}),
    ...(limits.idleTimeoutMinutes ? { idle_timeout_minutes: limits.idleTimeoutMinutes } : {}),
    ...(limits.maxDurationHours ? { max_duration_hours: limits.maxDurationHours } : {}),
    ...(limits.maxCostUsd ? { max_cost_usd: limits.maxCostUsd } : {}),
  };
}

function parse<T>(schema: z.ZodType<T>, data: unknown, operation: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ArchestraApiError(
      operation,
      "response",
      result.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    );
  }
  return result.data;
}
