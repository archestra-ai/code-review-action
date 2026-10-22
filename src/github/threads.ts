import type { RepoRef } from "../util";
import type { Octokit } from "./octokit";
import { findingIdFromBody } from "./sticky";

export interface FindingThread {
  findingId: string;
  threadId: string;
  isResolved: boolean;
  /** Database id of the first comment, for REST replies. */
  commentId: number;
}

export interface ThreadUpdate {
  findingId: string;
  threadId: string;
  commentId: number;
  action: "resolve" | "unresolve";
}

const MAX_PAGES = 10;

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved comments(first: 1) { nodes { databaseId body } } }
      }
    }
  }
}`;

interface ThreadsResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          id: string;
          isResolved: boolean;
          comments: { nodes: Array<{ databaseId: number | null; body: string }> };
        }>;
      };
    } | null;
  } | null;
}

/** Maps each `<!-- archestra-finding:<id> -->` marker to its review thread. */
export async function listFindingThreads(gh: Octokit, repo: RepoRef, pr: number): Promise<Map<string, FindingThread>> {
  const result = new Map<string, FindingThread>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data: ThreadsResponse = await gh.graphql<ThreadsResponse>(THREADS_QUERY, {
      owner: repo.owner,
      name: repo.repo,
      number: pr,
      cursor,
    });
    const threads = data.repository?.pullRequest?.reviewThreads;
    if (!threads) break;
    for (const thread of threads.nodes) {
      const first = thread.comments.nodes[0];
      if (!first || first.databaseId === null) continue;
      const findingId = findingIdFromBody(first.body);
      if (!findingId) continue;
      result.set(findingId, {
        findingId,
        threadId: thread.id,
        isResolved: thread.isResolved,
        commentId: first.databaseId,
      });
    }
    if (!threads.pageInfo.hasNextPage) break;
    cursor = threads.pageInfo.endCursor;
  }
  return result;
}

/**
 * Which threads to change: resolve the threads of applied (or fixed)
 * findings that are open; reopen the threads of regressed findings that are
 * resolved. Findings without a thread (outside the diff) are not changed.
 */
export function planThreadUpdates(
  threads: Map<string, FindingThread>,
  wanted: { resolve: string[]; unresolve: string[] },
): ThreadUpdate[] {
  const updates: ThreadUpdate[] = [];
  for (const findingId of new Set(wanted.resolve)) {
    const thread = threads.get(findingId);
    if (thread && !thread.isResolved) updates.push({ ...pick(thread), action: "resolve" });
  }
  for (const findingId of new Set(wanted.unresolve)) {
    const thread = threads.get(findingId);
    if (thread?.isResolved) updates.push({ ...pick(thread), action: "unresolve" });
  }
  return updates;
}

export async function applyThreadUpdate(gh: Octokit, update: ThreadUpdate): Promise<void> {
  const mutation =
    update.action === "resolve"
      ? "mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }"
      : "mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }";
  await gh.graphql(mutation, { id: update.threadId });
}

export async function replyToThread(gh: Octokit, repo: RepoRef, pr: number, commentId: number, body: string): Promise<void> {
  await gh.rest.pulls.createReplyForReviewComment({ ...repo, pull_number: pr, comment_id: commentId, body });
}

function pick(thread: FindingThread) {
  return { findingId: thread.findingId, threadId: thread.threadId, commentId: thread.commentId };
}
