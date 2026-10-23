import type { ReviewFinding } from "../contracts";
import { errorMessage, type Logger, type RepoRef, truncate } from "../util";
import { type DiffIndex, isRangeInDiff } from "./diff";
import { httpStatus, type Octokit } from "./octokit";
import { escapeHtml, findingIdFromBody, findingMarker, type StoredFinding } from "./sticky";
import type { FindingThread } from "./threads";

export interface InlineComment {
  path: string;
  line: number;
  side: "RIGHT";
  start_line?: number;
  start_side?: "RIGHT";
  body: string;
}

/**
 * Gives each finding an id and a number, and decides where it goes: a
 * finding whose lines are inside the diff gets an inline comment; the other
 * findings go only into the sticky summary. A finding that repeats one of
 * the last review (`previous`) keeps that finding's id.
 */
export function placeFindings(
  findings: ReviewFinding[],
  index: DiffIndex,
  options: { headSha: string; inline: boolean; previous?: StoredFinding[]; reservedIds?: Iterable<string> },
): StoredFinding[] {
  const previous = options.previous ?? [];
  const links = linkPrevious(findings, previous);
  // A fresh id must not repeat the id of an earlier finding or of an existing thread (`reservedIds`):
  // the old inline comment would be taken for the new finding.
  const used = new Set([...previous.map((finding) => finding.id), ...links.values(), ...(options.reservedIds ?? [])]);
  const prefix = options.headSha.slice(0, 7);
  return findings.map((finding, i) => {
    const end = finding.end_line ?? finding.line;
    const { previous_id: _link, ...rest } = finding;
    return {
      ...rest,
      id: links.get(i) ?? freshId(prefix, i + 1, used),
      n: i + 1,
      inline: options.inline && isRangeInDiff(index, finding.file, finding.line, end),
      status: "open" as const,
      commentId: null,
    };
  });
}

/**
 * Pairs each finding with the finding of the last review that it repeats,
 * so that it keeps that id and its inline comment: by `previous_id` when
 * the runtime set it and the file agrees, else by the same file and the
 * same summary.
 */
export function linkPrevious(findings: ReviewFinding[], previous: StoredFinding[]): Map<number, string> {
  const links = new Map<number, string>();
  const taken = new Set<string>();
  const byId = new Map(previous.map((finding) => [finding.id, finding]));
  for (const [i, finding] of findings.entries()) {
    const id = finding.previous_id;
    // A wrong id must not take the thread of another finding: the file has to agree.
    if (id && !taken.has(id) && byId.get(id)?.file === finding.file) {
      links.set(i, id);
      taken.add(id);
    }
  }
  for (const [i, finding] of findings.entries()) {
    if (links.has(i)) continue;
    const match = previous.find(
      (candidate) =>
        !taken.has(candidate.id) && candidate.file === finding.file && sameText(candidate.summary, finding.summary),
    );
    if (match) {
      links.set(i, match.id);
      taken.add(match.id);
    }
  }
  return links;
}

/** `<sha>-<n>`, or the next free number when a kept id has it (a second review of the same commit). */
function freshId(prefix: string, n: number, used: Set<string>): string {
  let candidate = `${prefix}-${n}`;
  for (let k = n; used.has(candidate); k++) candidate = `${prefix}-${k + 1}`;
  used.add(candidate);
  return candidate;
}

function sameText(a: string, b: string): boolean {
  const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim().replace(/\.$/, "");
  return normalize(a) === normalize(b);
}

/** True when the thread sits on the lines of the finding, so that a suggestion in it applies to them. */
export function coversFinding(thread: FindingThread, finding: StoredFinding): boolean {
  const end = finding.end_line ?? finding.line;
  return thread.path === finding.file && thread.line === end && (thread.startLine ?? thread.line) === finding.line;
}

/** Rewrites the inline comment of a finding reported before; the thread, its replies and its resolution stay. */
export async function updateInlineComment(gh: Octokit, repo: RepoRef, commentId: number, body: string): Promise<void> {
  await gh.rest.pulls.updateReviewComment({ ...repo, comment_id: commentId, body });
}

export function inlineComments(findings: StoredFinding[], index: DiffIndex, command: string): InlineComment[] {
  return findings
    .filter((finding) => finding.inline)
    .map((finding) => {
      const end = finding.end_line ?? finding.line;
      const multiLine = end > finding.line;
      return {
        path: finding.file,
        line: end,
        side: "RIGHT" as const,
        ...(multiLine ? { start_line: finding.line, start_side: "RIGHT" as const } : {}),
        body: inlineBody(finding, index, command),
      };
    });
}

/**
 * One inline comment: the finding, why it fails, what to change, and how to
 * have it implemented (a reply with the fix command).
 */
export function inlineBody(
  finding: StoredFinding,
  index: DiffIndex,
  command: string,
  options: { suggestion?: boolean } = {},
): string {
  const parts = [
    `**${finding.n}. [${finding.severity}] ${escapeHtml(truncate(finding.summary.replace(/\s+/g, " "), 300))}**`,
    "",
    escapeHtml(truncate(finding.failure_scenario, 3000)),
    "",
    // Its own paragraph at the margin, so the escaper and the marker reader see the same fences.
    "**Recommendation:**",
    "",
    escapeHtml(truncate(finding.recommendation, 1500)),
    "",
    `To implement and push this fix, reply \`${command} fix\` to this comment. For all findings, comment \`${command} fix\` on the pull request.`,
  ];
  const end = finding.end_line ?? finding.line;
  if (
    options.suggestion !== false &&
    finding.suggestion !== undefined &&
    isRangeInDiff(index, finding.file, finding.line, end)
  ) {
    // A fence longer than any backtick run in the text keeps the block intact.
    const longest = Math.max(2, ...[...finding.suggestion.matchAll(/`+/g)].map((m) => m[0].length));
    const fence = "`".repeat(longest + 1);
    parts.push("", `${fence}suggestion`, finding.suggestion.replace(/\n$/, ""), fence);
  }
  parts.push("", findingMarker(finding.id));
  return parts.join("\n");
}

/**
 * Posts one review with the inline comments. `posted` is false when GitHub
 * rejects the comments (for example, a line that is no longer in the diff);
 * the caller then moves those findings into the summary. `reviewId` names
 * the posted review; null when there was nothing to post.
 */
export async function postReview(
  gh: Octokit,
  repo: RepoRef,
  params: { pr: number; headSha: string; body: string; comments: InlineComment[]; log: Logger },
): Promise<{ posted: boolean; reviewId: number | null }> {
  if (params.comments.length === 0) return { posted: true, reviewId: null };
  try {
    const { data } = await gh.rest.pulls.createReview({
      ...repo,
      pull_number: params.pr,
      commit_id: params.headSha,
      event: "COMMENT",
      body: params.body,
      comments: params.comments,
    });
    return { posted: true, reviewId: data.id };
  } catch (error) {
    if (httpStatus(error) === 422) {
      params.log.warning(
        `GitHub rejected the inline comments; the findings go into the summary: ${errorMessage(error)}`,
      );
      return { posted: false, reviewId: null };
    }
    throw error;
  }
}

/** The inline comments of a posted review, by finding id. */
export async function reviewCommentIds(
  gh: Octokit,
  repo: RepoRef,
  pr: number,
  reviewId: number,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  for await (const page of gh.paginate.iterator(gh.rest.pulls.listCommentsForReview, {
    ...repo,
    pull_number: pr,
    review_id: reviewId,
    per_page: 100,
  })) {
    for (const comment of page.data) {
      const id = findingIdFromBody(comment.body);
      if (id) result.set(id, comment.id);
    }
  }
  return result;
}
