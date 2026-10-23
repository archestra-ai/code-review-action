import type { ChangedFile } from "./pr";

/**
 * The text of the RIGHT (head) side of a file patch, by line number: the
 * added lines and the context lines inside its hunks.
 */
export function headLines(patch: string): Map<number, string> {
  const lines = new Map<number, string>();
  let right = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      right = Number(header[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    // An empty line can be a context line whose leading space was lost.
    if (line.startsWith("+") || line.startsWith(" ") || line === "") {
      lines.set(right, line.slice(1));
      right++;
    }
    // "-" lines and "\ No newline at end of file" do not move the right side.
  }
  return lines;
}

/** The head-side lines of each changed file, by path. */
export type DiffIndex = Map<string, Map<number, string>>;

const MAX_RANGE_LINES = 200;

export function buildDiffIndex(files: ChangedFile[]): DiffIndex {
  const index: DiffIndex = new Map();
  for (const file of files) {
    if (file.patch) index.set(file.filename, headLines(file.patch));
  }
  return index;
}

/** True when every line of the range is in the diff, so that a review comment can sit on it. */
export function isRangeInDiff(index: DiffIndex, file: string, start: number, end: number): boolean {
  const lines = index.get(file);
  if (!lines || end < start || end - start > MAX_RANGE_LINES) return false;
  for (let line = start; line <= end; line++) {
    if (!lines.has(line)) return false;
  }
  return true;
}

/** An excerpt keeps this many lines; a longer finding shows its first lines and an ellipsis. */
export const MAX_EXCERPT_LINES = 12;
const MAX_EXCERPT_CHARS = 1500;

/**
 * The head-side text of the lines of a finding, for the review comment. Null
 * when the file or a line of the range is not in the diff.
 */
export function excerptFor(
  index: DiffIndex,
  finding: { file: string; line: number; end_line?: number },
): string | null {
  const text = index.get(finding.file);
  if (!text) return null;
  const end = finding.end_line ?? finding.line;
  const last = Math.min(end, finding.line + MAX_EXCERPT_LINES - 1);
  const lines: string[] = [];
  for (let n = finding.line; n <= last; n++) {
    const line = text.get(n);
    if (line === undefined) return null;
    lines.push(line);
  }
  if (end > last) lines.push("…");
  const excerpt = lines.join("\n");
  return excerpt.length > MAX_EXCERPT_CHARS ? `${excerpt.slice(0, MAX_EXCERPT_CHARS - 1)}…` : excerpt;
}
