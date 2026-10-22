import * as github from "@actions/github";

export type Octokit = ReturnType<typeof github.getOctokit>;

export function createOctokit(token: string, baseUrl?: string): Octokit {
  return github.getOctokit(token, baseUrl ? { baseUrl } : {});
}

/** The HTTP status of an Octokit request error, or null. */
export function httpStatus(error: unknown): number | null {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status: unknown }).status;
    return typeof status === "number" ? status : null;
  }
  return null;
}
