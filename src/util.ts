export interface Logger {
  info(message: string): void;
  warning(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export interface RepoRef {
  owner: string;
  repo: string;
}

export const SHA_PATTERN = /^[0-9a-f]{40}$/;

export function fullName(repo: RepoRef): string {
  return `${repo.owner}/${repo.repo}`;
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "-";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Cuts text to at most `max` characters and marks the cut. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Keeps the last `maxBytes` bytes of a buffer. */
export function tailBytes(
  data: Buffer,
  maxBytes: number,
): { data: Buffer; truncated: boolean } {
  if (data.byteLength <= maxBytes) return { data, truncated: false };
  return { data: data.subarray(data.byteLength - maxBytes), truncated: true };
}

export function slug(text: string, max = 60): string {
  const value = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return value || "job";
}

export function toBase64(text: string | Buffer): string {
  return (typeof text === "string" ? Buffer.from(text, "utf8") : text).toString(
    "base64",
  );
}

export function jsonAttachment(name: string, value: unknown): Attachment {
  return {
    name,
    contentType: "application/json",
    contentBase64: toBase64(`${JSON.stringify(value, null, 2)}\n`),
  };
}

export function textAttachment(
  name: string,
  text: string | Buffer,
  contentType = "text/plain",
): Attachment {
  // The platform rejects empty attachments.
  const content = text.length === 0 ? "\n" : text;
  return { name, contentType, contentBase64: toBase64(content) };
}

export interface Attachment {
  name: string;
  contentType: string;
  contentBase64: string;
}

export function isBotUser(user: { login: string; type?: string }): boolean {
  return user.type === "Bot" || user.login.endsWith("[bot]");
}
