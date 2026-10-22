import * as github from "@actions/github";

export type Octokit = ReturnType<typeof github.getOctokit>;

export interface OctokitOptions {
  baseUrl?: string;
  /**
   * The fetch implementation. The default is the proxy-aware fetch of
   * `@actions/github`, which does not go through the global `fetch`. Tests
   * pass the global `fetch` so that msw can intercept the requests.
   */
  fetch?: typeof globalThis.fetch;
}

export function createOctokit(token: string, options: OctokitOptions = {}): Octokit {
  return github.getOctokit(token, {
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.fetch ? { request: { fetch: options.fetch } } : {}),
  });
}

/** The HTTP status of an Octokit request error, or null. */
export function httpStatus(error: unknown): number | null {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status: unknown }).status;
    return typeof status === "number" ? status : null;
  }
  return null;
}
