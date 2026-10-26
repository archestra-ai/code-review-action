import type { RepoRef } from "./util";

/** The published action. The header image comes from it, never from a fork, which may be private. */
const PUBLISHED_ACTION = "archestra-ai/code-review-action";

/** The header image on the published action's main branch, for a job that cannot pin a revision. */
export const DEFAULT_PROGRESS_IMAGE_URL = `https://raw.githubusercontent.com/${PUBLISHED_ACTION}/main/assets/progress.gif`;

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
    progressImageUrl: progressImageUrl(env, serverUrl),
  };
}

/**
 * `assets/progress.gif` at the revision the workflow pins (`GITHUB_ACTION_REF`: a SHA, a tag or a
 * branch) when the job runs the published action on github.com. A fork may be private and a GitHub
 * Enterprise server has no raw.githubusercontent.com, so those jobs show the default image.
 */
function progressImageUrl(env: NodeJS.ProcessEnv, serverUrl: string): string {
  const ref = env.GITHUB_ACTION_REF ?? "";
  if (serverUrl !== "https://github.com" || env.GITHUB_ACTION_REPOSITORY !== PUBLISHED_ACTION || !isRef(ref)) {
    return DEFAULT_PROGRESS_IMAGE_URL;
  }
  return `https://raw.githubusercontent.com/${PUBLISHED_ACTION}/${ref}/assets/progress.gif`;
}

/** A SHA, a tag or a branch name: at most three slash-separated segments of word characters, dots and dashes, none only dots. */
function isRef(value: string): boolean {
  const parts = value.split("/");
  return parts.length <= 3 && parts.every((part) => /^[\w.-]+$/.test(part) && !/^\.+$/.test(part));
}
