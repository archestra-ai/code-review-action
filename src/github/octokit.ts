import { setTimeout as sleep } from "node:timers/promises";
import * as github from "@actions/github";

export type Octokit = ReturnType<typeof github.getOctokit>;

export interface OctokitOptions {
  baseUrl?: string;
  /**
   * The fetch implementation. The default is the proxy-aware fetch of
   * `@actions/github`, which does not go through the global `fetch`. Tests
   * pass the global `fetch` so that msw can intercept the requests.
   */
  fetch?: typeof globalThis.fetch;
  /** The waits before each retry of a request that failed on the way; the default is 2, 5 and 10 seconds. */
  retryDelaysMs?: readonly number[];
}

export const DEFAULT_REQUEST_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000];

export function createOctokit(token: string, options: OctokitOptions = {}): Octokit {
  const octokit = github.getOctokit(token, {
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.fetch ? { request: { fetch: options.fetch } } : {}),
  });
  const delays = options.retryDelaysMs ?? DEFAULT_REQUEST_RETRY_DELAYS_MS;
  octokit.hook.wrap("request", async (request, requestOptions) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await request(requestOptions);
      } catch (error) {
        const delay = delays[attempt];
        if (delay === undefined || !isTransient(error, requestOptions.method)) throw error;
        await sleep(delay);
      }
    }
  });
  return octokit;
}

/**
 * A request failure worth another try. A connection that never reached GitHub (a name that did not
 * resolve, a refused connection, a certificate for another host) is safe to repeat for every method.
 * A read is also repeated after a dropped connection or a 502, 503 or 504; a write is not, because
 * GitHub may have done it.
 */
export function isTransient(error: unknown, method: string | undefined): boolean {
  const text = errorChain(error);
  if (/altnames|certificate|getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/i.test(text)) return true;
  if (method !== "GET" && method !== "HEAD") return false;
  const status = httpStatus(error);
  return (
    status === 502 ||
    status === 503 ||
    status === 504 ||
    /ECONNRESET|socket hang up|fetch failed|other side closed/i.test(text)
  );
}

/** The messages and codes of an error and its causes. */
function errorChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (typeof current !== "object") {
      parts.push(String(current));
      break;
    }
    const { message, code, cause } = current as { message?: unknown; code?: unknown; cause?: unknown };
    if (typeof message === "string") parts.push(message);
    if (typeof code === "string") parts.push(code);
    current = cause;
  }
  return parts.join(" ");
}

/** The HTTP status of an Octokit request error, or null. */
export function httpStatus(error: unknown): number | null {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status: unknown }).status;
    return typeof status === "number" ? status : null;
  }
  return null;
}
