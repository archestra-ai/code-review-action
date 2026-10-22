import { HttpResponse, http } from "msw";

// An in-memory Archestra management API for tests and the local harness.
// Each agent has a queue of scripts; each start or continue takes the next.

export type RunScript =
  | { start: "http"; status: number; message?: string }
  | { end: "TASK_STATE_COMPLETED"; files: Record<string, unknown>; polls?: number }
  | {
      end: "TASK_STATE_FAILED";
      statusReason: string;
      failure?: { code: string; retriable: boolean; message: string };
      polls?: number;
    }
  | {
      end: "TASK_STATE_CANCELED" | "TASK_STATE_REJECTED" | "TASK_STATE_INPUT_REQUIRED" | "TASK_STATE_AUTH_REQUIRED";
      statusReason?: string;
      polls?: number;
    }
  | { end: "never" };

interface FakeRun {
  taskId: string;
  agentId: string;
  workspaceId: string;
  state: string;
  statusReason: string | null;
  failure: { code: string; retriable: boolean; message: string } | null;
  polls: number;
  script: Exclude<RunScript, { start: "http" }>;
  files: Record<string, string>;
  workspaceState: string;
  ended: boolean;
}

export interface RecordedStart {
  kind: "start" | "continue";
  agentId: string;
  taskId: string | null;
  previousTaskId: string | null;
  message: string;
  attachmentNames: string[];
  attachments: Record<string, string>;
  runtimeMode: unknown;
  title: unknown;
  authorization: string | null;
}

export class FakeArchestra {
  readonly baseUrl = "https://archestra.test";
  readonly apiKey = "arch_test_key";
  readonly runs = new Map<string, FakeRun>();
  readonly scripts = new Map<string, RunScript[]>();
  readonly starts: RecordedStart[] = [];
  readonly cancels: string[] = [];
  readonly credentials: Array<{ agentId: string; key: string; valueLength: number }> = [];
  /** Task ids whose workspace answers 409 to /continue (busy) this many times. */
  readonly busyContinues = new Map<string, number>();
  /** Task ids whose workspace is no longer retained. */
  readonly expiredWorkspaces = new Set<string>();
  /** Old deployments: no `failure` field on runs. */
  legacy = false;
  private counter = 0;

  script(agentId: string, ...scripts: RunScript[]): this {
    this.scripts.set(agentId, [...(this.scripts.get(agentId) ?? []), ...scripts]);
    return this;
  }

  /** Adds a finished run, for example the review that a fix continues. */
  seedRun(agentId: string, taskId: string, workspaceState = "idle"): void {
    this.runs.set(taskId, {
      taskId,
      agentId,
      workspaceId: `ws-${taskId}`,
      state: "TASK_STATE_COMPLETED",
      statusReason: null,
      failure: null,
      polls: 0,
      script: { end: "TASK_STATE_COMPLETED", files: {} },
      files: {},
      workspaceState,
      ended: true,
    });
  }

  handlers() {
    const base = this.baseUrl;
    return [
      http.post(`${base}/api/agents/:id/runs`, async ({ request, params }) => {
        const denied = this.authorize(request);
        if (denied) return denied;
        const body = (await request.json()) as Record<string, unknown>;
        return this.begin(request, String(params.id), body, null);
      }),
      http.post(`${base}/api/agent-runs/:taskId/continue`, async ({ request, params }) => {
        const denied = this.authorize(request);
        if (denied) return denied;
        const previous = this.runs.get(String(params.taskId));
        if (!previous) return error(404, "Run not found");
        const busy = this.busyContinues.get(previous.taskId) ?? 0;
        if (busy > 0 || this.expiredWorkspaces.has(previous.taskId) || !previous.ended) {
          if (busy > 0) {
            // Another turn runs in the workspace; the next /continue after
            // the last busy answer succeeds.
            this.busyContinues.set(previous.taskId, busy - 1);
            previous.workspaceState = "active";
          }
          return error(409, "This workspace is busy or is no longer retained");
        }
        const body = (await request.json()) as Record<string, unknown>;
        return this.begin(request, previous.agentId, body, previous);
      }),
      http.get(`${base}/api/agent-runs/:taskId`, ({ request, params }) => {
        const denied = this.authorize(request);
        if (denied) return denied;
        const run = this.runs.get(String(params.taskId));
        if (!run) return error(404, "Run not found");
        this.advance(run);
        const expired = this.expiredWorkspaces.has(run.taskId);
        return HttpResponse.json({
          taskId: run.taskId,
          sessionId: run.workspaceId,
          agentId: run.agentId,
          state: run.state,
          statusReason: run.statusReason,
          ...(this.legacy ? {} : { failure: run.failure }),
          workspace: expired
            ? null
            : { state: run.workspaceState, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
        });
      }),
      http.post(`${base}/api/agent-runs/:taskId/cancel`, ({ request, params }) => {
        const denied = this.authorize(request);
        if (denied) return denied;
        const run = this.runs.get(String(params.taskId));
        if (!run) return error(404, "Run not found");
        this.cancels.push(run.taskId);
        run.state = "TASK_STATE_CANCELED";
        run.ended = true;
        run.workspaceState = "idle";
        return HttpResponse.json({ taskId: run.taskId, state: run.state });
      }),
      http.get(`${base}/api/agent-runs/:taskId/workspace/files`, ({ request, params }) => {
        const denied = this.authorize(request);
        if (denied) return denied;
        const run = this.runs.get(String(params.taskId));
        if (!run) return error(404, "Run not found");
        const path = new URL(request.url).searchParams.get("path") ?? "";
        const content = run.files[path];
        if (content === undefined) return error(404, "File not found");
        const bytes = Buffer.from(content, "utf8");
        return HttpResponse.json({ path, size: bytes.byteLength, sha256: "0".repeat(64), content_base64: bytes.toString("base64") });
      }),
      http.put(`${base}/api/agents/:id/runtime/credentials/:key`, async ({ request, params }) => {
        const denied = this.authorize(request);
        if (denied) return denied;
        const body = (await request.json()) as { value?: string };
        this.credentials.push({ agentId: String(params.id), key: String(params.key), valueLength: body.value?.length ?? 0 });
        return HttpResponse.json({ configured: true });
      }),
    ];
  }

  private authorize(request: Request) {
    return request.headers.get("authorization") === this.apiKey ? null : error(401, "Unauthorized");
  }

  private begin(request: Request, agentId: string, body: Record<string, unknown>, previous: FakeRun | null) {
    const attachments = Array.isArray(body.attachments)
      ? (body.attachments as Array<{ name: string; contentBase64: string }>)
      : [];
    const record: RecordedStart = {
      kind: previous ? "continue" : "start",
      agentId,
      taskId: null,
      previousTaskId: previous?.taskId ?? null,
      message: String(body.message ?? ""),
      attachmentNames: attachments.map((attachment) => attachment.name),
      attachments: Object.fromEntries(
        attachments.map((attachment) => [attachment.name, Buffer.from(attachment.contentBase64, "base64").toString("utf8")]),
      ),
      runtimeMode: body.runtimeMode,
      title: body.title,
      authorization: request.headers.get("authorization") === this.apiKey ? "<api key>" : null,
    };
    this.starts.push(record);
    const queue = this.scripts.get(agentId) ?? [];
    const script = queue.shift();
    if (!script) return error(404, `No script for agent ${agentId}`);
    if ("start" in script) return error(script.status, script.message ?? `HTTP ${script.status}`);
    const taskId = `00000000-0000-4000-8000-${String(++this.counter).padStart(12, "0")}`;
    record.taskId = taskId;
    this.runs.set(taskId, {
      taskId,
      agentId,
      workspaceId: previous?.workspaceId ?? `ws-${taskId}`,
      state: "TASK_STATE_SUBMITTED",
      statusReason: null,
      failure: null,
      polls: 0,
      script,
      files: {},
      workspaceState: "active",
      ended: false,
    });
    return HttpResponse.json({
      taskId,
      state: "TASK_STATE_SUBMITTED",
      ...(previous ? { sessionId: previous.workspaceId } : {}),
    });
  }

  private advance(run: FakeRun) {
    if (run.ended) return;
    run.polls++;
    const { script } = run;
    if (script.end === "never") {
      run.state = "TASK_STATE_WORKING";
      return;
    }
    if (run.polls < (script.polls ?? 2)) {
      run.state = "TASK_STATE_WORKING";
      return;
    }
    run.state = script.end;
    run.ended = true;
    run.workspaceState = "idle";
    if (script.end === "TASK_STATE_COMPLETED") {
      run.files = Object.fromEntries(
        Object.entries(script.files).map(([name, value]) => [name, typeof value === "string" ? value : JSON.stringify(value)]),
      );
    } else if (script.end === "TASK_STATE_FAILED") {
      run.statusReason = script.statusReason;
      run.failure = script.failure ?? null;
    } else {
      run.statusReason = script.statusReason ?? null;
    }
  }
}

function error(status: number, message: string) {
  return HttpResponse.json({ error: { message, type: "api_error" } }, { status });
}
