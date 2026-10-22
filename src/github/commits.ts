import type { RepoRef } from "../util";
import type { Octokit } from "./octokit";

export interface AuthorIdentity {
  login: string;
  name: string;
  email: string;
}

/**
 * The commit identity of the user who triggered the fix: the display name
 * from the users API, and the noreply address. GitHub attributes commits
 * with this address to the user even when the user's email is private.
 */
export async function userIdentity(gh: Octokit, login: string): Promise<AuthorIdentity> {
  const { data } = await gh.rest.users.getByUsername({ username: login });
  const name = (data.name ?? "").replace(/["\n\r]/g, "").trim() || data.login;
  return { login: data.login, name, email: `${data.id}+${data.login}@users.noreply.github.com` };
}

export interface CommitCheck {
  verified: string[];
  rejected: Array<{ commit: string; reason: string }>;
}

/**
 * Checks commits that the runtime reported against GitHub: each one must be
 * between `base` and `head` (compare API) and have the expected author
 * email. Only verified commits are reported as applied.
 */
export async function verifyCommits(
  gh: Octokit,
  repo: RepoRef,
  params: { base: string; head: string; expectedEmail: string; commits: string[] },
): Promise<CommitCheck> {
  const result: CommitCheck = { verified: [], rejected: [] };
  if (params.commits.length === 0) return result;
  const { data } = await gh.rest.repos.compareCommitsWithBasehead({
    ...repo,
    basehead: `${params.base}...${params.head}`,
    per_page: 250,
  });
  const bySha = new Map(data.commits.map((commit) => [commit.sha, commit]));
  for (const sha of new Set(params.commits)) {
    const commit = bySha.get(sha);
    if (!commit) {
      result.rejected.push({ commit: sha, reason: `commit is not on the branch after ${params.base.slice(0, 7)}` });
      continue;
    }
    const email = commit.commit.author?.email?.toLowerCase();
    if (email !== params.expectedEmail.toLowerCase()) {
      result.rejected.push({
        commit: sha,
        reason: `commit author is ${email ?? "unknown"}, not ${params.expectedEmail}`,
      });
      continue;
    }
    result.verified.push(sha);
  }
  return result;
}
