import { setupServer } from "msw/node";
import { ArchestraClient } from "../src/archestra/client";
import type { ActionContext } from "../src/context";
import { createOctokit } from "../src/github/octokit";
import { type Inputs, readInputs } from "../src/inputs";
import type { Logger } from "../src/util";
import { FakeArchestra } from "./fakes/archestra";
import { FakeGitHub } from "./fakes/github";

/** An Octokit whose requests go through the global fetch, which msw intercepts. */
export function testOctokit(token: string) {
  return createOctokit(token, { fetch: (input, init) => globalThis.fetch(input, init) });
}

export const AGENT_A = "11111111-1111-4111-8111-111111111111";
export const AGENT_B = "22222222-2222-4222-8222-222222222222";
export const AGENT_C = "33333333-3333-4333-8333-333333333333";

/** A clock that advances only when the code sleeps. */
export class FakeClock {
  time = 1_700_000_000_000;
  readonly sleeps: number[] = [];
  now = () => this.time;
  sleep = async (ms: number) => {
    this.sleeps.push(ms);
    this.time += ms;
  };
}

export class MemoryLogger implements Logger {
  readonly lines: string[] = [];
  info = (message: string) => void this.lines.push(`info: ${message}`);
  warning = (message: string) => void this.lines.push(`warning: ${message}`);
  error = (message: string) => void this.lines.push(`error: ${message}`);
  debug = (message: string) => void this.lines.push(`debug: ${message}`);
}

export function testInputs(overrides: Record<string, string> = {}, archestra = new FakeArchestra()): Inputs {
  const values: Record<string, string> = {
    "archestra-gateway-url": archestra.gatewayUrl,
    "archestra-token": archestra.token,
    agents: [AGENT_A, AGENT_B, AGENT_C].join("\n"),
    strategy: "ordered",
    "github-token": "ghs_job_token",
    "fix-token": "ghs_app_token",
    ...overrides,
  };
  return readInputs(
    (name) => values[name] ?? "",
    () => "",
  );
}

export interface Harness {
  archestra: FakeArchestra;
  github: FakeGitHub;
  clock: FakeClock;
  log: MemoryLogger;
  live: Array<string | null>;
  context(eventName: string, payload: unknown, inputOverrides?: Record<string, string>): ActionContext;
}

export function createHarness(): Harness {
  const archestra = new FakeArchestra();
  const github = new FakeGitHub();
  const clock = new FakeClock();
  const log = new MemoryLogger();
  const live: Array<string | null> = [];
  return {
    archestra,
    github,
    clock,
    log,
    live,
    context(eventName, payload, inputOverrides = {}) {
      const inputs = testInputs(inputOverrides, archestra);
      return {
        inputs,
        repo: { owner: github.owner, repo: github.repo },
        eventName,
        payload,
        runAttempt: 1,
        serverUrl: "https://github.com",
        workflowRunUrl: `https://github.com/${github.fullName}/actions/runs/1`,
        gh: testOctokit(inputs.githubToken),
        ghFix: inputs.fixToken ? testOctokit(inputs.fixToken) : null,
        archestra: new ArchestraClient({ gatewayUrl: inputs.gatewayUrl, token: inputs.token }),
        log,
        clock,
        random: () => 0.5,
        saveLiveRun: (runId) => void live.push(runId),
        startedAt: clock.now(),
      };
    },
  };
}

/** One msw server for a test file; handlers are set per test. */
export function mockServer() {
  return setupServer();
}

export function prEvent(github: FakeGitHub, action = "opened") {
  return { action, pull_request: { number: github.pr.number }, sender: { login: "alice", id: 1002, type: "User" } };
}

export function issueCommentEvent(github: FakeGitHub, body: string, sender = "maria", id = 9001) {
  return {
    action: "created",
    issue: { number: github.pr.number, pull_request: { url: "x" } },
    comment: { id, body, user: { login: sender, id: 1, type: "User" } },
    sender: { login: sender, id: github.users[sender]?.id ?? 1, type: "User" },
  };
}

export function reviewJson(findings: unknown[] = [], extra: Record<string, unknown> = {}) {
  return {
    verdict: findings.length ? "request_changes" : "approve",
    summary: "Looks fine apart from the findings.",
    findings,
    ...extra,
  };
}

export const FINDING_IN_DIFF = {
  file: "src/upload.ts",
  line: 12,
  end_line: 14,
  severity: "high",
  summary: "Retries do not wait between attempts.",
  failure_scenario: "A 503 from the server -> three requests in one millisecond -> rate limit.",
  suggestion: "  for (let i = 0; i < 3; i++) {\n    await sleep(100 * i);\n    send(a);",
};

export const FINDING_OUTSIDE = {
  file: "src/other.ts",
  line: 3,
  severity: "medium",
  summary: "The timeout is not configurable.",
  failure_scenario: "A slow network -> every upload fails after 1 s.",
};
