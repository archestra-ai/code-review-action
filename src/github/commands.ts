export type Command =
  | { kind: "fix"; findings: number[] | "all"; note: string }
  | { kind: "fix-ci" }
  | { kind: "fix-ci-main"; target: number | "all" };

export const MAX_NOTE_CHARS = 1000;

/**
 * Parses a comment command. The command must be the first non-empty line:
 * - `/archestra fix`              all open findings
 * - `/archestra fix 2,5 <note>`   findings 2 and 5, with a maintainer note
 * - `/archestra fix <note>`       all open findings, with a note
 * - `/archestra fix-ci`           triage and fix the failing checks
 * - `/archestra fix-ci-main [n]`  open a fix PR against the base branch
 * Text on the next lines is part of the note of `fix`.
 */
export function parseCommand(body: string, prefix: string): Command | null {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first < 0) return null;
  const head = (lines[first] as string).trim();
  if (!head.startsWith(`${prefix} `) && head !== prefix) return null;
  const rest = head.slice(prefix.length).trim();
  const [verb = "", ...words] = rest.split(/\s+/);
  const tail = lines
    .slice(first + 1)
    .join("\n")
    .trim();

  switch (verb) {
    case "fix": {
      let findings: number[] | "all" = "all";
      let noteWords = words;
      const selector = words[0];
      if (selector && /^\d+(,\d+)*,?$/.test(selector)) {
        const numbers = selector
          .split(",")
          .filter(Boolean)
          .map(Number)
          .filter((n) => Number.isSafeInteger(n) && n > 0);
        findings = [...new Set(numbers)].slice(0, 100);
        noteWords = words.slice(1);
      }
      const note = [noteWords.join(" "), tail].filter(Boolean).join("\n").slice(0, MAX_NOTE_CHARS);
      return { kind: "fix", findings, note };
    }
    case "fix-ci":
      return { kind: "fix-ci" };
    case "fix-ci-main": {
      const target = words[0];
      if (!target || target === "all") return { kind: "fix-ci-main", target: "all" };
      if (/^\d+$/.test(target)) return { kind: "fix-ci-main", target: Number(target) };
      return null;
    }
    default:
      return null;
  }
}
