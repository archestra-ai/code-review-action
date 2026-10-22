import { isBotUser, type RepoRef } from "../util";
import type { Octokit } from "./octokit";

export interface PullRequestInfo {
  number: number;
  title: string;
  body: string;
  draft: boolean;
  state: string;
  authorLogin: string;
  authorType: string;
  headSha: string;
  headRef: string;
  headRepoFullName: string | null;
  baseSha: string;
  baseRef: string;
  baseRepoFullName: string;
  htmlUrl: string;
}

export interface ChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  previousFilename?: string;
  patch?: string;
}

export const MAX_DIFF_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 3000;

export async function loadPullRequest(gh: Octokit, repo: RepoRef, number: number): Promise<PullRequestInfo> {
  const { data } = await gh.rest.pulls.get({ ...repo, pull_number: number });
  return {
    number: data.number,
    title: data.title,
    body: data.body ?? "",
    draft: data.draft ?? false,
    state: data.state,
    authorLogin: data.user?.login ?? "",
    authorType: data.user?.type ?? "User",
    headSha: data.head.sha,
    headRef: data.head.ref,
    headRepoFullName: data.head.repo?.full_name ?? null,
    baseSha: data.base.sha,
    baseRef: data.base.ref,
    baseRepoFullName: data.base.repo.full_name,
    htmlUrl: data.html_url,
  };
}

export async function loadChangedFiles(gh: Octokit, repo: RepoRef, number: number): Promise<ChangedFile[]> {
  const files: ChangedFile[] = [];
  for await (const page of gh.paginate.iterator(gh.rest.pulls.listFiles, {
    ...repo,
    pull_number: number,
    per_page: 100,
  })) {
    for (const file of page.data) {
      files.push({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        ...(file.previous_filename ? { previousFilename: file.previous_filename } : {}),
        ...(file.patch ? { patch: file.patch } : {}),
      });
    }
    if (files.length >= MAX_FILES) break;
  }
  return files;
}

/** The unified diff of the pull request, cut at MAX_DIFF_BYTES. */
export async function loadDiff(
  gh: Octokit,
  repo: RepoRef,
  number: number,
): Promise<{ diff: string; truncated: boolean }> {
  const response = await gh.rest.pulls.get({
    ...repo,
    pull_number: number,
    mediaType: { format: "diff" },
  });
  const diff = String(response.data as unknown);
  const bytes = Buffer.from(diff, "utf8");
  if (bytes.byteLength <= MAX_DIFF_BYTES) return { diff, truncated: false };
  return {
    diff: `${bytes.subarray(0, MAX_DIFF_BYTES).toString("utf8")}\n[diff truncated]\n`,
    truncated: true,
  };
}

/** Why the action does not work on this pull request, or null. */
export function skipReason(pr: PullRequestInfo): string | null {
  if (pr.state !== "open") return "the pull request is not open";
  if (pr.draft) return "the pull request is a draft";
  if (/\[wip\]/i.test(pr.title)) return 'the title contains "[WIP]"';
  if (isFork(pr)) return "the pull request comes from a fork";
  if (isBotUser({ login: pr.authorLogin, type: pr.authorType })) {
    return "a bot opened the pull request";
  }
  return null;
}

export function isFork(pr: PullRequestInfo): boolean {
  return pr.headRepoFullName !== pr.baseRepoFullName;
}

/** The pr.json attachment: what the runtime needs to know about the PR. */
export function prAttachmentData(pr: PullRequestInfo, repo: RepoRef, files: ChangedFile[], diffTruncated: boolean) {
  return {
    repository: `${repo.owner}/${repo.repo}`,
    number: pr.number,
    url: pr.htmlUrl,
    title: pr.title,
    body: pr.body.slice(0, 20_000),
    author: pr.authorLogin,
    base: { ref: pr.baseRef, sha: pr.baseSha },
    head: { ref: pr.headRef, sha: pr.headSha },
    diffTruncated,
    changedFiles: files.map((file) => ({
      path: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      ...(file.previousFilename ? { previousPath: file.previousFilename } : {}),
    })),
  };
}
