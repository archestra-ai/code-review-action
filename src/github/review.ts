import type { ReviewFinding } from "../contracts";
import { errorMessage, type Logger, type RepoRef, truncate } from "../util";
import { type DiffIndex, isRangeInDiff } from "./diff";
import { httpStatus, type Octokit } from "./octokit";
import { findingMarker, type StoredFinding } from "./sticky";

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
 * findings go only into the sticky summary.
 */
export function placeFindings(
  findings: ReviewFinding[],
  index: DiffIndex,
  options: { headSha: string; inline: boolean },
): StoredFinding[] {
  return findings.map((finding, i) => {
    const end = finding.end_line ?? finding.line;
    return {
      ...finding,
      id: `${options.headSha.slice(0, 7)}-${i + 1}`,
      n: i + 1,
      inline: options.inline && isRangeInDiff(index, finding.file, finding.line, end),
      status: "open" as const,
    };
  });
}

export function inlineComments(findings: StoredFinding[], index: DiffIndex): InlineComment[] {
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
        body: inlineBody(finding, index),
      };
    });
}

export function inlineBody(finding: StoredFinding, index: DiffIndex): string {
  const parts = [
    `**${finding.n}. [${finding.severity}] ${truncate(finding.summary.replace(/\s+/g, " "), 300)}**`,
    "",
    truncate(finding.failure_scenario, 3000).replace(/<!--|-->/g, ""),
  ];
  const end = finding.end_line ?? finding.line;
  if (finding.suggestion !== undefined && isRangeInDiff(index, finding.file, finding.line, end)) {
    // A fence longer than any backtick run in the text keeps the block intact.
    const longest = Math.max(2, ...[...finding.suggestion.matchAll(/`+/g)].map((m) => m[0].length));
    const fence = "`".repeat(longest + 1);
    parts.push("", `${fence}suggestion`, finding.suggestion.replace(/\n$/, ""), fence);
  }
  parts.push("", findingMarker(finding.id));
  return parts.join("\n");
}

/**
 * Posts one review with the inline comments. Returns false when GitHub
 * rejects the comments (for example, a line that is no longer in the diff);
 * the caller then moves those findings into the summary.
 */
export async function postReview(
  gh: Octokit,
  repo: RepoRef,
  params: { pr: number; headSha: string; body: string; comments: InlineComment[]; log: Logger },
): Promise<boolean> {
  if (params.comments.length === 0) return true;
  try {
    await gh.rest.pulls.createReview({
      ...repo,
      pull_number: params.pr,
      commit_id: params.headSha,
      event: "COMMENT",
      body: params.body,
      comments: params.comments,
    });
    return true;
  } catch (error) {
    if (httpStatus(error) === 422) {
      params.log.warning(
        `GitHub rejected the inline comments; the findings go into the summary: ${errorMessage(error)}`,
      );
      return false;
    }
    throw error;
  }
}
