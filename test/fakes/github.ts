import { HttpResponse, http } from "msw";

// An in-memory GitHub REST and GraphQL API for tests and the local harness.
// It keeps one repository with one pull request.

export interface FakeComment {
  id: number;
  body: string;
  user: { login: string; id: number; type: string };
}

export interface FakeReviewComment extends FakeComment {
  path: string;
  line: number;
  startLine: number | null;
  inReplyTo: number | null;
  /** The review that created the comment; null for a reply. */
  reviewId: number | null;
}

export interface FakeCommit {
  sha: string;
  authorEmail: string;
}

export interface FakeCheckRun {
  id: number;
  name: string;
  app: string;
  conclusion: string;
  summary?: string;
  annotations?: Array<{
    path: string;
    start_line: number;
    end_line: number;
    annotation_level: string;
    message: string;
    title?: string;
  }>;
  log?: string;
  runId?: number;
  workflowId?: number;
  workflowPath?: string;
  baseBranchConclusion?: string;
}

const BOT = { login: "github-actions[bot]", id: 41898282, type: "Bot" };

export class FakeGitHub {
  readonly api = "https://api.github.com";
  readonly owner = "acme";
  readonly repo = "widgets";
  pr = {
    number: 7,
    title: "Add retry to the uploader",
    body: "Retries uploads on 503.",
    draft: false,
    state: "open",
    user: { login: "alice", type: "User" },
    head: { sha: "a".repeat(40), ref: "feature/retry", repoFullName: "acme/widgets" },
    base: { sha: "b".repeat(40), ref: "main", repoFullName: "acme/widgets" },
  };
  files = [
    {
      filename: "src/upload.ts",
      status: "modified",
      additions: 3,
      deletions: 1,
      patch:
        "@@ -10,4 +10,6 @@ export function upload() {\n   const a = 1;\n-  send(a);\n+  for (let i = 0; i < 3; i++) {\n+    send(a);\n+  }\n   return a;\n }",
    },
  ];
  diff = "diff --git a/src/upload.ts b/src/upload.ts\n--- a/src/upload.ts\n+++ b/src/upload.ts\n@@ -10,4 +10,6 @@\n";
  readonly comments = new Map<number, FakeComment>();
  readonly reviewComments = new Map<number, FakeReviewComment>();
  readonly reviews: Array<{ body: string; commit_id: string; event: string; comments: unknown[] }> = [];
  readonly resolved = new Set<number>();
  /** The ids of the reviews the action dismissed. */
  readonly dismissed: number[] = [];
  /** Review comments whose lines changed after they were written (GitHub's isOutdated). */
  readonly outdated = new Set<number>();
  /** Review comments rewritten in place, in order. */
  readonly reviewCommentUpdates: number[] = [];
  /** Review comments a person deleted: still listed as threads, but a PATCH answers 404. */
  readonly goneComments = new Set<number>();
  readonly graphqlMutations: Array<{ action: "resolve" | "unresolve"; threadId: string }> = [];
  /** True makes thread mutations fail as they do for a workflow's installation token. */
  threadMutationsForbidden = false;
  readonly reactions: Array<{ commentId: number; content: string }> = [];
  readonly reruns: number[] = [];
  readonly createdPulls: Array<{ number: number; head: string; base: string; title: string; body: string }> = [];
  readonly assignees: Array<{ number: number; assignees: string[] }> = [];
  readonly reviewRequests: Array<{ number: number; reviewers: string[] }> = [];
  collaborators: Record<string, string> = { maria: "maintain", alice: "write", reader: "read" };
  users: Record<string, { id: number; name: string | null }> = {
    maria: { id: 1001, name: "Maria Lopez" },
    alice: { id: 1002, name: null },
    reader: { id: 1003, name: "Read Only" },
  };
  /** Commits after the base of a compare, keyed by the head ref or SHA. */
  branchCommits = new Map<string, FakeCommit[]>();
  checkRuns: FakeCheckRun[] = [];
  /** When set, the next GET of the PR returns this head SHA (after a push). */
  headAfterPush: string | null = null;
  rejectReview = false;
  /** An HTTP status that every new review gets, as a server error would. */
  reviewError: number | null = null;
  /** GitHub refuses a change request on a pull request that the token's identity opened. */
  refuseChangeRequests = false;
  /** The status of every compare: "ahead", or "diverged" after a force-push. */
  compareStatus = "ahead";
  private nextId = 5000;

  get fullName() {
    return `${this.owner}/${this.repo}`;
  }

  /** Adds a bot comment, for example an existing sticky comment. */
  addComment(body: string, user = BOT): FakeComment {
    const comment = { id: ++this.nextId, body, user };
    this.comments.set(comment.id, comment);
    return comment;
  }

  /** Every body written to the sticky comment, in order (create and each update). */
  readonly stickyHistory: string[] = [];

  stickyBody(): string | null {
    for (const comment of this.comments.values()) {
      if (comment.body.includes("<!-- archestra-code-review ")) return comment.body;
    }
    return null;
  }

  handlers() {
    const base = `${this.api}/repos/${this.owner}/${this.repo}`;
    return [
      http.get(`${base}/pulls/${this.pr.number}`, ({ request }) => {
        if ((request.headers.get("accept") ?? "").includes("diff")) {
          return new HttpResponse(this.diff, { headers: { "content-type": "text/plain; charset=utf-8" } });
        }
        if (this.headAfterPush) this.pr.head.sha = this.headAfterPush;
        return HttpResponse.json(this.prJson());
      }),
      http.get(`${base}/pulls/${this.pr.number}/files`, () => HttpResponse.json(this.files)),
      http.get(`${base}/issues/${this.pr.number}/comments`, () =>
        HttpResponse.json([...this.comments.values()].map((comment) => this.commentJson(comment))),
      ),
      http.post(`${base}/issues/${this.pr.number}/comments`, async ({ request }) => {
        const { body } = (await request.json()) as { body: string };
        const comment = this.addComment(body);
        if (body.includes("<!-- archestra-code-review ")) this.stickyHistory.push(body);
        return HttpResponse.json(this.commentJson(comment), { status: 201 });
      }),
      http.patch(`${base}/issues/comments/:id`, async ({ request, params }) => {
        const comment = this.comments.get(Number(params.id));
        if (!comment) return notFound();
        comment.body = ((await request.json()) as { body: string }).body;
        if (comment.body.includes("<!-- archestra-code-review ")) this.stickyHistory.push(comment.body);
        return HttpResponse.json(this.commentJson(comment));
      }),
      http.post(`${base}/issues/comments/:id/reactions`, async ({ request, params }) => {
        const { content } = (await request.json()) as { content: string };
        this.reactions.push({ commentId: Number(params.id), content });
        return HttpResponse.json({ id: 1, content }, { status: 201 });
      }),
      http.post(`${base}/pulls/comments/:id/reactions`, async ({ request, params }) => {
        const { content } = (await request.json()) as { content: string };
        this.reactions.push({ commentId: Number(params.id), content });
        return HttpResponse.json({ id: 1, content }, { status: 201 });
      }),
      http.post(`${base}/pulls/${this.pr.number}/reviews`, async ({ request }) => {
        const body = (await request.json()) as {
          body: string;
          commit_id: string;
          event: string;
          comments: Array<{ path: string; line: number; start_line?: number; body: string }>;
        };
        if (this.refuseChangeRequests && body.event === "REQUEST_CHANGES") {
          return HttpResponse.json({ message: "Can not request changes on your own pull request" }, { status: 422 });
        }
        if (this.reviewError !== null) {
          return HttpResponse.json({ message: "Server Error" }, { status: this.reviewError });
        }
        if (this.rejectReview) {
          return HttpResponse.json({ message: "Unprocessable Entity: line must be part of the diff" }, { status: 422 });
        }
        this.reviews.push(body);
        const reviewId = 700 + this.reviews.length;
        for (const comment of body.comments ?? []) {
          const id = ++this.nextId;
          this.reviewComments.set(id, {
            id,
            body: comment.body,
            user: BOT,
            path: comment.path,
            line: comment.line,
            startLine: comment.start_line ?? null,
            inReplyTo: null,
            reviewId,
          });
        }
        return HttpResponse.json({ id: reviewId }, { status: 200 });
      }),
      http.get(`${base}/pulls/${this.pr.number}/reviews`, () =>
        HttpResponse.json(
          this.reviews.map((review, index) => {
            const id = 701 + index;
            const state = this.dismissed.includes(id)
              ? "DISMISSED"
              : review.event === "REQUEST_CHANGES"
                ? "CHANGES_REQUESTED"
                : "COMMENTED";
            return { id, body: review.body, state, user: BOT, commit_id: review.commit_id };
          }),
        ),
      ),
      http.put(`${base}/pulls/${this.pr.number}/reviews/:id/dismissals`, ({ params }) => {
        this.dismissed.push(Number(params.id));
        return HttpResponse.json({ id: Number(params.id), state: "DISMISSED" });
      }),
      http.get(`${base}/pulls/${this.pr.number}/reviews/:id/comments`, ({ params }) =>
        HttpResponse.json(
          [...this.reviewComments.values()]
            .filter((comment) => comment.reviewId === Number(params.id))
            .map((comment) => ({ id: comment.id, body: comment.body, path: comment.path, line: comment.line })),
        ),
      ),
      http.get(`${base}/pulls/comments/:id`, ({ params }) => {
        const comment = this.reviewComments.get(Number(params.id));
        if (!comment) return notFound();
        return HttpResponse.json({
          id: comment.id,
          body: comment.body,
          user: comment.user,
          path: comment.path,
          line: comment.line,
        });
      }),
      http.patch(`${base}/pulls/comments/:id`, async ({ request, params }) => {
        const comment = this.reviewComments.get(Number(params.id));
        if (!comment || this.goneComments.has(comment.id)) return notFound();
        comment.body = ((await request.json()) as { body: string }).body;
        this.reviewCommentUpdates.push(comment.id);
        return HttpResponse.json({ id: comment.id, body: comment.body });
      }),
      http.post(`${base}/pulls/${this.pr.number}/comments/:id/replies`, async ({ request, params }) => {
        const { body } = (await request.json()) as { body: string };
        const id = ++this.nextId;
        const parent = this.reviewComments.get(Number(params.id));
        this.reviewComments.set(id, {
          id,
          body,
          user: BOT,
          path: parent?.path ?? "",
          line: parent?.line ?? 0,
          startLine: null,
          inReplyTo: Number(params.id),
          reviewId: null,
        });
        return HttpResponse.json({ id, body }, { status: 201 });
      }),
      http.get(`${base}/collaborators/:user/permission`, ({ params }) => {
        const role = this.collaborators[String(params.user)];
        if (!role) return notFound();
        const permission = role === "maintain" ? "write" : role;
        return HttpResponse.json({ permission, role_name: role, user: { login: params.user } });
      }),
      http.get(`${this.api}/users/:user`, ({ params }) => {
        const user = this.users[String(params.user)];
        if (!user) return notFound();
        return HttpResponse.json({ login: String(params.user), id: user.id, name: user.name, type: "User" });
      }),
      http.get(`${base}/compare/:basehead`, ({ params }) => {
        const [, head] = String(params.basehead).split("...");
        const commits = this.branchCommits.get(head ?? "") ?? [];
        return HttpResponse.json({
          status: this.compareStatus,
          commits: commits.map((commit) => ({
            sha: commit.sha,
            commit: { author: { email: commit.authorEmail, name: "x" }, message: "fix" },
          })),
        });
      }),
      http.get(`${base}/commits/:ref/check-runs`, () =>
        HttpResponse.json({
          total_count: this.checkRuns.length,
          check_runs: this.checkRuns.map((run) => ({
            id: run.id,
            name: run.name,
            conclusion: run.conclusion,
            status: "completed",
            html_url: `https://github.com/${this.fullName}/runs/${run.id}`,
            app: { slug: run.app },
            output: { summary: run.summary ?? null, annotations_count: run.annotations?.length ?? 0 },
          })),
        }),
      ),
      http.get(`${base}/check-runs/:id/annotations`, ({ params }) => {
        const run = this.checkRuns.find((candidate) => candidate.id === Number(params.id));
        return HttpResponse.json(run?.annotations ?? []);
      }),
      http.get(`${base}/actions/jobs/:id`, ({ params }) => {
        const run = this.checkRuns.find((candidate) => candidate.id === Number(params.id));
        if (!run) return notFound();
        return HttpResponse.json({
          id: run.id,
          run_id: run.runId ?? 900,
          name: run.name,
          workflow_name: "CI",
          html_url: null,
        });
      }),
      http.get(`${base}/actions/jobs/:id/logs`, ({ params }) => {
        const run = this.checkRuns.find((candidate) => candidate.id === Number(params.id));
        if (!run?.log) return notFound();
        return new HttpResponse(run.log, { headers: { "content-type": "text/plain" } });
      }),
      http.get(`${base}/actions/runs/:id`, ({ params }) => {
        const run = this.checkRuns.find((candidate) => (candidate.runId ?? 900) === Number(params.id));
        return HttpResponse.json({
          id: Number(params.id),
          workflow_id: run?.workflowId ?? 77,
          path: run?.workflowPath ?? ".github/workflows/ci.yml",
          html_url: "",
        });
      }),
      http.get(`${base}/actions/workflows/:id/runs`, ({ params }) => {
        const run = this.checkRuns.find((candidate) => (candidate.workflowId ?? 77) === Number(params.id));
        return HttpResponse.json({
          total_count: 1,
          workflow_runs: [
            { id: 950, conclusion: run?.baseBranchConclusion ?? "success", html_url: "https://github.com/x/runs/950" },
          ],
        });
      }),
      http.get(`${base}/actions/runs/950/jobs`, () =>
        HttpResponse.json({
          total_count: this.checkRuns.length,
          jobs: this.checkRuns.map((run) => ({
            id: run.id + 10_000,
            name: run.name,
            conclusion: run.baseBranchConclusion ?? "success",
            html_url: `https://github.com/x/jobs/${run.id + 10_000}`,
          })),
        }),
      ),
      http.post(`${base}/actions/runs/:id/rerun-failed-jobs`, ({ params }) => {
        this.reruns.push(Number(params.id));
        return new HttpResponse(null, { status: 201 });
      }),
      http.post(`${base}/pulls`, async ({ request }) => {
        const body = (await request.json()) as { head: string; base: string; title: string; body: string };
        const number = 100 + this.createdPulls.length;
        this.createdPulls.push({ number, ...body });
        return HttpResponse.json(
          { number, html_url: `https://github.com/${this.fullName}/pull/${number}` },
          { status: 201 },
        );
      }),
      http.post(`${base}/issues/:number/assignees`, async ({ request, params }) => {
        const { assignees } = (await request.json()) as { assignees: string[] };
        this.assignees.push({ number: Number(params.number), assignees });
        return HttpResponse.json({}, { status: 201 });
      }),
      http.post(`${base}/pulls/:number/requested_reviewers`, async ({ request, params }) => {
        const { reviewers } = (await request.json()) as { reviewers: string[] };
        this.reviewRequests.push({ number: Number(params.number), reviewers });
        return HttpResponse.json({}, { status: 201 });
      }),
      http.post(`${this.api}/graphql`, async ({ request }) => {
        const { query, variables } = (await request.json()) as { query: string; variables: Record<string, unknown> };
        if (this.threadMutationsForbidden && query.includes("solveReviewThread")) {
          return HttpResponse.json({
            data: null,
            errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }],
          });
        }
        if (query.includes("unresolveReviewThread")) {
          const threadId = String(variables.id);
          this.resolved.delete(Number(threadId.replace("thread-", "")));
          this.graphqlMutations.push({ action: "unresolve", threadId });
          return HttpResponse.json({
            data: { unresolveReviewThread: { thread: { id: threadId, isResolved: false } } },
          });
        }
        if (query.includes("resolveReviewThread")) {
          const threadId = String(variables.id);
          this.resolved.add(Number(threadId.replace("thread-", "")));
          this.graphqlMutations.push({ action: "resolve", threadId });
          return HttpResponse.json({ data: { resolveReviewThread: { thread: { id: threadId, isResolved: true } } } });
        }
        if (query.includes("reviewThreads")) {
          const nodes = [...this.reviewComments.values()]
            .filter((comment) => comment.inReplyTo === null)
            .map((comment) => ({
              id: `thread-${comment.id}`,
              isResolved: this.resolved.has(comment.id),
              isOutdated: this.outdated.has(comment.id),
              path: comment.path,
              line: comment.line,
              startLine: comment.startLine,
              comments: { nodes: [{ databaseId: comment.id, body: comment.body }] },
            }));
          return HttpResponse.json({
            data: {
              repository: {
                pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } },
              },
            },
          });
        }
        return HttpResponse.json({ errors: [{ message: "unknown query" }] }, { status: 400 });
      }),
    ];
  }

  private prJson() {
    const pr = this.pr;
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      draft: pr.draft,
      state: pr.state,
      html_url: `https://github.com/${this.fullName}/pull/${pr.number}`,
      user: pr.user,
      head: { sha: pr.head.sha, ref: pr.head.ref, repo: { full_name: pr.head.repoFullName } },
      base: { sha: pr.base.sha, ref: pr.base.ref, repo: { full_name: pr.base.repoFullName } },
    };
  }

  private commentJson(comment: FakeComment) {
    return { id: comment.id, body: comment.body, user: comment.user, html_url: "" };
  }
}

function notFound() {
  return HttpResponse.json({ message: "Not Found" }, { status: 404 });
}
