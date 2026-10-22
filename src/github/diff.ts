import type { ChangedFile } from "./pr";

/**
 * Line numbers on the RIGHT (head) side that a review comment can use:
 * added lines and context lines inside the hunks of a file patch.
 */
export function commentableLines(patch: string): Set<number> {
  const lines = new Set<number>();
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
    if (line.startsWith("+")) {
      lines.add(right);
      right++;
    } else if (line.startsWith(" ") || line === "") {
      // An empty line can be a context line whose leading space was lost.
      lines.add(right);
      right++;
    }
    // "-" lines and "\ No newline at end of file" do not move the right side.
  }
  return lines;
}

export type DiffIndex = Map<string, Set<number>>;

const MAX_RANGE_LINES = 200;

export function buildDiffIndex(files: ChangedFile[]): DiffIndex {
  const index: DiffIndex = new Map();
  for (const file of files) {
    if (file.patch) index.set(file.filename, commentableLines(file.patch));
  }
  return index;
}

export function isRangeInDiff(
  index: DiffIndex,
  file: string,
  start: number,
  end: number,
): boolean {
  const lines = index.get(file);
  if (!lines || end < start || end - start > MAX_RANGE_LINES) return false;
  for (let line = start; line <= end; line++) {
    if (!lines.has(line)) return false;
  }
  return true;
}
