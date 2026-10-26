import type { ReviewFinding, Severity } from "../contracts";
import type { ReviewEvent } from "../inputs";
import { errorMessage, type Logger, type RepoRef, truncate } from "../util";
import { type DiffIndex, isRangeInDiff } from "./diff";
import { httpStatus, type Octokit } from "./octokit";
import {
  escapeHtml,
  fenceFor,
  findingIdFromBody,
  findingMarker,
  findingTitle,
  marginLine,
  type StoredFinding,
} from "./sticky";
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
      excerpt: null,
    };
  });
}

/**
 * Pairs each finding with the finding of the last review that it repeats,
 * so that it keeps that id and its inline comment: by `previous_id` when
 * the runtime set it and the file agrees, else by the same file and the
 * same summary, else by the same file and the same title.
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
  const same = (pick: (finding: Pick<ReviewFinding, "title" | "summary">) => string | undefined) => {
    for (const [i, finding] of findings.entries()) {
      if (links.has(i)) continue;
      const text = pick(finding);
      if (text === undefined) continue;
      const match = previous.find((candidate) => {
        const other = pick(candidate);
        return (
          !taken.has(candidate.id) && candidate.file === finding.file && other !== undefined && sameText(other, text)
        );
      });
      if (match) {
        links.set(i, match.id);
        taken.add(match.id);
      }
    }
  };
  same((finding) => finding.summary);
  same((finding) => finding.title);
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

export function inlineComments(findings: StoredFinding[], index: DiffIndex, command: string | null): InlineComment[] {
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
 * have it implemented (a reply with the fix command, when a workflow listens
 * to it).
 */
export function inlineBody(
  finding: StoredFinding,
  index: DiffIndex,
  command: string | null,
  options: { suggestion?: boolean } = {},
): string {
  const heading = findingTitle(finding);
  const parts = [
    `**${finding.n}. [${finding.severity}] ${escapeHtml(truncate(heading.replace(/\s+/g, " "), 300))}**`,
    "",
  ];
  // With a title in the heading, the one-sentence summary opens the text.
  if (finding.title) parts.push(marginLine(finding.summary, 500), "");
  parts.push(
    escapeHtml(truncate(finding.failure_scenario, 3000)),
    "",
    // Its own paragraph at the margin, so the escaper and the marker reader see the same fences.
    "**Recommendation:**",
    "",
    escapeHtml(truncate(finding.recommendation, 1500)),
  );
  if (command !== null) {
    parts.push(
      "",
      `To implement and push this fix, reply \`${command} fix\` to this comment. For all findings, comment \`${command} fix\` on the pull request.`,
    );
  }
  const end = finding.end_line ?? finding.line;
  if (
    options.suggestion !== false &&
    finding.suggestion !== undefined &&
    isRangeInDiff(index, finding.file, finding.line, end)
  ) {
    const fence = fenceFor(finding.suggestion);
    parts.push("", `${fence}suggestion`, finding.suggestion.replace(/\n$/, ""), fence);
  }
  parts.push("", findingMarker(finding.id));
  return parts.join("\n");
}

export type Verdict = "approve" | "comment" | "request_changes";

const BLOCKING: ReadonlySet<Severity> = new Set(["critical", "high", "medium"]);

/**
 * The verdict of a set of findings: changes requested for a finding of medium or above, comments
 * for low and nit findings only, approval for none. The runtime's own verdict is not used, so the
 * same findings always get the same verdict.
 */
export function verdictFor(findings: Pick<ReviewFinding, "severity">[]): Verdict {
  if (findings.some((finding) => BLOCKING.has(finding.severity))) return "request_changes";
  return findings.length > 0 ? "comment" : "approve";
}

/** The GitHub review event: a change request only when the input allows it and a finding blocks the merge. */
export function reviewEventFor(mode: ReviewEvent, verdict: Verdict): "COMMENT" | "REQUEST_CHANGES" {
  return mode === "request-changes" && verdict === "request_changes" ? "REQUEST_CHANGES" : "COMMENT";
}

/** Marks the reviews this action posts, so that it finds its own change requests again. */
export const REVIEW_MARKER = "<!-- archestra-review -->";

/**
 * Posts one review with the inline comments. A comment review with no new
 * inline comment is not posted: the review comment already shows the result.
 * A change request is posted without new comments too, so that the pull
 * request shows it. `posted` is false when GitHub rejects the comments (for
 * example, a line that is no longer in the diff); the caller then moves
 * those findings into the summary, and the review is posted without them.
 * `reviewId` names the posted review; null when there was nothing to post.
 */
export async function postReview(
  gh: Octokit,
  repo: RepoRef,
  params: {
    pr: number;
    headSha: string;
    body: string;
    event?: "COMMENT" | "REQUEST_CHANGES";
    comments: InlineComment[];
    log: Logger;
  },
): Promise<{ posted: boolean; reviewId: number | null }> {
  const event = params.event ?? "COMMENT";
  if (params.comments.length === 0 && event === "COMMENT") return { posted: true, reviewId: null };
  const create = async (kind: "COMMENT" | "REQUEST_CHANGES", comments: InlineComment[]) => {
    const { data } = await gh.rest.pulls.createReview({
      ...repo,
      pull_number: params.pr,
      commit_id: params.headSha,
      event: kind,
      body: `${params.body}\n\n${REVIEW_MARKER}`,
      ...(comments.length > 0 ? { comments } : {}),
    });
    return data.id;
  };
  let rejection: unknown;
  try {
    return { posted: true, reviewId: await create(event, params.comments) };
  } catch (error) {
    if (httpStatus(error) !== 422) throw error;
    rejection = error;
  }
  // GitHub refuses a change request on a pull request that the token's identity opened; post the
  // same comments as a comment review.
  if (event !== "COMMENT") {
    params.log.warning(`GitHub refused the change request; posting a comment review: ${errorMessage(rejection)}`);
    if (params.comments.length === 0) return { posted: true, reviewId: null };
    try {
      return { posted: true, reviewId: await create("COMMENT", params.comments) };
    } catch (error) {
      if (httpStatus(error) !== 422) throw error;
      rejection = error;
    }
  }
  params.log.warning(
    `GitHub rejected the inline comments; the findings go into the summary: ${errorMessage(rejection)}`,
  );
  return { posted: false, reviewId: null };
}

/**
 * Dismisses the change requests that this action posted on the pull request: the latest review
 * finds nothing that blocks the merge. A failure is logged; the review goes on.
 */
export async function dismissChangeRequests(
  gh: Octokit,
  repo: RepoRef,
  /** `self`: the login of the action's token (the author of its review comment); null when unknown. */
  params: { pr: number; message: string; self: string | null; log: Logger },
): Promise<number> {
  let dismissed = 0;
  try {
    const reviews = await gh.paginate(gh.rest.pulls.listReviews, { ...repo, pull_number: params.pr, per_page: 100 });
    for (const review of reviews) {
      if (review.state !== "CHANGES_REQUESTED" || !(review.body ?? "").includes(REVIEW_MARKER)) continue;
      // Only the action's own requests: by its login when known, else by a bot.
      if (params.self ? review.user?.login !== params.self : review.user && !isBot(review.user)) continue;
      await gh.rest.pulls.dismissReview({
        ...repo,
        pull_number: params.pr,
        review_id: review.id,
        message: params.message,
        event: "DISMISS",
      });
      dismissed++;
    }
  } catch (error) {
    params.log.warning(`Could not dismiss the earlier change requests: ${errorMessage(error)}`);
  }
  return dismissed;
}

function isBot(user: { login: string; type?: string }): boolean {
  return user.type === "Bot" || user.login.endsWith("[bot]");
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
