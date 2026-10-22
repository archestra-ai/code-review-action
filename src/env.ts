import type { RepoRef } from "./util";

export interface ActionEnvironment {
  repo: RepoRef;
  eventName: string;
  payload: unknown;
  runId: string;
  runAttempt: number;
  serverUrl: string;
  apiUrl: string;
  workflowRunUrl: string;
}

/** Reads the GitHub Actions environment. Throws a clear error outside Actions. */
export function readEnvironment(env: NodeJS.ProcessEnv, readFile: (path: string) => string): ActionEnvironment {
  const repository = env.GITHUB_REPOSITORY ?? "";
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error("GITHUB_REPOSITORY is not set. Run this action in a GitHub Actions workflow.");
  }
  const eventName = env.GITHUB_EVENT_NAME ?? "";
  const eventPath = env.GITHUB_EVENT_PATH ?? "";
  if (!eventName || !eventPath) {
    throw new Error("GITHUB_EVENT_NAME or GITHUB_EVENT_PATH is not set. Run this action in a GitHub Actions workflow.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(readFile(eventPath));
  } catch {
    throw new Error(`Cannot read the event payload at ${eventPath}.`);
  }
  const serverUrl = (env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/+$/, "");
  const runId = env.GITHUB_RUN_ID ?? "0";
  return {
    repo: { owner, repo },
    eventName,
    payload,
    runId,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT ?? "1") || 1,
    serverUrl,
    apiUrl: (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, ""),
    workflowRunUrl: `${serverUrl}/${owner}/${repo}/actions/runs/${runId}`,
  };
}
