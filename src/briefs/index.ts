import ciMainFix from "./ci-main-fix.md";
import ciTriage from "./ci-triage.md";
import fix from "./fix.md";
import review from "./review.md";

export const BRIEFS = {
  review,
  fix,
  "fix-ci": ciTriage,
  "fix-ci-main": ciMainFix,
} as const;

export type BriefName = keyof typeof BRIEFS;

/** The platform passes the message to a terminal; keep it well below 16 KB. */
export const MAX_MESSAGE_BYTES = 8 * 1024;

/**
 * Replaces each {{name}} placeholder. A placeholder without a value is an
 * error, so a template change cannot send an incomplete brief.
 */
export function renderBrief(
  name: BriefName,
  values: Record<string, string | number>,
): string {
  const text = BRIEFS[name].replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new Error(`Brief "${name}" needs a value for {{${key}}}`);
    }
    return String(value);
  });
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_MESSAGE_BYTES) {
    throw new Error(
      `Brief "${name}" is ${bytes} bytes; the limit is ${MAX_MESSAGE_BYTES}`,
    );
  }
  return text;
}
