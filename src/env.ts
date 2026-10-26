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
  /** The animated Archestra mark of the progress header, served from the action's repository at the running revision. */
  progressImageUrl: string;
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
    progressImageUrl: progressImageUrl(env),
  };
}

/**
 * `assets/progress.gif` at the revision the workflow pins (`GITHUB_ACTION_REF` is that SHA or tag),
 * in the repository the action runs from. Outside a `uses:` step (or with an odd value) it falls
 * back to the main branch of the published action.
 */
function progressImageUrl(env: NodeJS.ProcessEnv): string {
  const repository = env.GITHUB_ACTION_REPOSITORY ?? "";
  const ref = env.GITHUB_ACTION_REF ?? "";
  const source = isPath(repository, 2) ? repository : "archestra-ai/code-review-action";
  const revision = isPath(ref) ? ref : "main";
  return `https://raw.githubusercontent.com/${source}/${revision}/assets/progress.gif`;
}

/** Slash-separated segments of word characters, dots and dashes, none of them only dots. */
function isPath(value: string, segments?: number): boolean {
  const parts = value.split("/");
  if (segments !== undefined && parts.length !== segments) return false;
  return parts.every((part) => /^[\w.-]+$/.test(part) && !/^\.+$/.test(part));
}
