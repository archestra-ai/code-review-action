import type { Strategy } from "./attempts";

export type Mode = "review" | "fix" | "fix-ci" | "fix-ci-main";
export type PostMode = "review" | "comment" | "none";
export type FailOn = "never" | "findings" | "error";

export interface Inputs {
  archestraUrl: string;
  apiKey: string;
  agents: string[];
  strategy: Strategy;
  retries: number;
  maxFallbacks: number;
  timeoutMs: number;
  overallTimeoutMs: number;
  instructions: string;
  githubToken: string;
  post: PostMode;
  failOn: FailOn;
  mode: Mode | "auto";
  prNumber: number | null;
  fixCommand: string;
  fixToken: string;
  fixTimeoutMs: number;
  ciRerun: boolean;
  maxAutoFixRounds: number;
  incrementalReview: boolean;
}

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_INSTRUCTIONS_BYTES = 64 * 1024;

/**
 * Reads and validates the action inputs. `get` returns "" for an input that
 * is not set. The defaults here agree with action.yml, so a run without the
 * runner's defaults (for example `node dist/index.js`) behaves the same.
 */
export function readInputs(
  get: (name: string) => string,
  readFile: (path: string) => string,
): Inputs {
  const value = (name: string) => get(name).trim();
  const required = (name: string) => {
    const v = value(name);
    if (!v) throw new InputError(`Input "${name}" is required and is not set.`);
    return v;
  };

  const archestraUrl = required("archestra-url");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(archestraUrl);
  } catch {
    throw new InputError(`Input "archestra-url" is not a valid URL.`);
  }
  if (!["https:", "http:"].includes(parsedUrl.protocol)) {
    throw new InputError(`Input "archestra-url" must use https or http.`);
  }
  const apiKey = required("archestra-api-key");

  const agents = [
    ...new Set(
      required("agents")
        .split(/[\s,]+/)
        .map((agent) => agent.trim())
        .filter(Boolean),
    ),
  ];
  for (const agent of agents) {
    if (!UUID.test(agent)) {
      throw new InputError(`Input "agents" has a value that is not an agent ID: "${agent}".`);
    }
  }
  if (agents.length === 0) throw new InputError(`Input "agents" has no agent IDs.`);

  const maxFallbacksRaw = value("max-fallbacks");
  const maxFallbacks =
    maxFallbacksRaw === "" || maxFallbacksRaw === "all"
      ? agents.length - 1
      : integer("max-fallbacks", maxFallbacksRaw, 0, 100);

  let instructions = value("instructions");
  const instructionsFile = value("instructions-file");
  if (instructionsFile) {
    let fileText: string;
    try {
      fileText = readFile(instructionsFile);
    } catch {
      throw new InputError(`Input "instructions-file": cannot read "${instructionsFile}".`);
    }
    instructions = [instructions, fileText.trim()].filter(Boolean).join("\n\n");
  }
  if (Buffer.byteLength(instructions, "utf8") > MAX_INSTRUCTIONS_BYTES) {
    throw new InputError(
      `The review instructions are larger than ${MAX_INSTRUCTIONS_BYTES / 1024} KB.`,
    );
  }

  const prNumberRaw = value("pr-number");
  const maxAutoFixRounds = integer("max-auto-fix-rounds", value("max-auto-fix-rounds") || "0", 0, 0);

  return {
    archestraUrl,
    apiKey,
    agents,
    strategy: oneOf("strategy", value("strategy") || "rotate", ["rotate", "ordered", "random"]),
    retries: integer("retries", value("retries") || "1", 0, 5),
    maxFallbacks,
    timeoutMs: integer("timeout-minutes", value("timeout-minutes") || "20", 1, 360) * 60_000,
    overallTimeoutMs:
      integer("overall-timeout-minutes", value("overall-timeout-minutes") || "120", 1, 1440) *
      60_000,
    instructions,
    githubToken: required("github-token"),
    post: oneOf("post", value("post") || "review", ["review", "comment", "none"]),
    failOn: oneOf("fail-on", value("fail-on") || "never", ["never", "findings", "error"]),
    mode: oneOf("mode", value("mode") || "auto", ["auto", "review", "fix", "fix-ci", "fix-ci-main"]),
    prNumber: prNumberRaw ? integer("pr-number", prNumberRaw, 1, Number.MAX_SAFE_INTEGER) : null,
    fixCommand: commandPrefix(value("fix-command") || "/archestra"),
    fixToken: value("fix-token"),
    fixTimeoutMs: integer("fix-timeout-minutes", value("fix-timeout-minutes") || "45", 1, 360) * 60_000,
    ciRerun: boolean("ci-rerun", value("ci-rerun") || "false"),
    maxAutoFixRounds,
    incrementalReview: boolean("incremental-review", value("incremental-review") || "true"),
  };
}

function integer(name: string, raw: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw)) throw new InputError(`Input "${name}" must be a whole number.`);
  const parsed = Number(raw);
  if (parsed < min || parsed > max) {
    throw new InputError(
      min === max
        ? `Input "${name}" supports only ${min} in this version.`
        : `Input "${name}" must be from ${min} to ${max}.`,
    );
  }
  return parsed;
}

function boolean(name: string, raw: string): boolean {
  if (/^(true|yes|1)$/i.test(raw)) return true;
  if (/^(false|no|0)$/i.test(raw)) return false;
  throw new InputError(`Input "${name}" must be true or false.`);
}

function oneOf<T extends string>(name: string, raw: string, allowed: readonly T[]): T {
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new InputError(`Input "${name}" must be one of: ${allowed.join(", ")}.`);
}

function commandPrefix(raw: string): string {
  if (!/^\/[\w-]{1,40}$/.test(raw)) {
    throw new InputError(`Input "fix-command" must be a slash and a word, for example /archestra.`);
  }
  return raw;
}
