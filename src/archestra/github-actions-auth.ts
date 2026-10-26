import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { errorMessage } from "../util";

// Signs the job in to Archestra with its GitHub Actions identity instead of a
// stored token. The job's OIDC token proves which repository, pull request and
// workflow it runs for; Archestra answers with a short-lived token of the pull
// request author's Archestra user, who must have connected GitHub there, and
// with a GitHub token of the review App for this repository.

export type AccessRefusal = "not_linked" | "ambiguous_link" | "not_trusted" | "forbidden" | "unavailable";

export type ExchangeResult =
  | {
      ok: true;
      accessToken: string;
      /** The review App's token for this repository; null when the deployment returns none. */
      githubToken: string | null;
      githubLogin: string | null;
    }
  | { ok: false; reason: AccessRefusal; message: string; login: string | null };

const GrantSchema = z.object({
  access_token: z.string().min(1),
  github_token: z.string().min(1).nullable().optional(),
  github_login: z.string().nullable().optional(),
});

const RefusalSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  error_description: z.string().optional(),
  login: z.string().optional(),
});

const REFUSALS: ReadonlySet<string> = new Set(["not_linked", "ambiguous_link", "not_trusted", "forbidden"]);

/** The token endpoint of the deployment that serves the gateway. */
export function tokenEndpoint(gatewayUrl: string): string {
  return `${new URL(gatewayUrl).origin}/api/github-actions/token`;
}

export async function exchangeGitHubActionsToken(p: {
  gatewayUrl: string;
  /** core.getIDToken: the job's OIDC token for an audience. */
  getIdToken: (audience: string) => Promise<string>;
  fetch?: typeof fetch;
  retryDelaysMs?: readonly number[];
}): Promise<ExchangeResult> {
  const audience = new URL(p.gatewayUrl).origin;
  let idToken: string;
  try {
    idToken = await p.getIdToken(audience);
  } catch (error) {
    return {
      ok: false,
      reason: "unavailable",
      message: `The job has no GitHub Actions identity token (it needs the id-token: write permission): ${errorMessage(error)}`,
      login: null,
    };
  }
  const doFetch = p.fetch ?? fetch;
  const delays = p.retryDelaysMs ?? [2_000, 5_000];
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await doFetch(tokenEndpoint(p.gatewayUrl), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ token: idToken, resource: p.gatewayUrl }),
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      });
    } catch (error) {
      const delay = delays[attempt];
      if (delay === undefined) {
        return {
          ok: false,
          reason: "unavailable",
          message: `Archestra did not answer: ${errorMessage(error)}`,
          login: null,
        };
      }
      await sleep(delay);
      continue;
    }
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) {
      const grant = GrantSchema.safeParse(body);
      if (!grant.success) {
        return { ok: false, reason: "unavailable", message: "Archestra answered without a token.", login: null };
      }
      return {
        ok: true,
        accessToken: grant.data.access_token,
        githubToken: grant.data.github_token ?? null,
        githubLogin: grant.data.github_login ?? null,
      };
    }
    const refusal = RefusalSchema.safeParse(body);
    const message = refusal.success ? (refusal.data.message ?? refusal.data.error_description ?? "") : "";
    if (response.status === 403 && refusal.success && REFUSALS.has(refusal.data.error)) {
      return {
        ok: false,
        reason: refusal.data.error as AccessRefusal,
        message: message || "Archestra refused the review.",
        login: refusal.data.login ?? null,
      };
    }
    const delay = delays[attempt];
    if (response.status >= 500 && delay !== undefined) {
      await sleep(delay);
      continue;
    }
    return {
      ok: false,
      reason: "unavailable",
      message: `Archestra refused the sign-in (HTTP ${response.status})${message ? `: ${message}` : "."}`,
      login: null,
    };
  }
}
