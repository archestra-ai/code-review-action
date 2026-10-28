# Changelog

## 0.6.1 (2026-10-28)

- A change request that a later review lifts now says so. GitHub shows a dismissed review as "previously requested changes" over a plain comment, which read as if the action had only commented. When the action dismisses its change request, it replaces that review's verdict with "Changes requested, resolved in `<commit>`", naming the review that found nothing blocking.

## 0.6.0 (2026-10-27)

- A fixed finding's thread is resolved, with no reply under it. When the token may not resolve threads, the thread stays as it is and the review comment still lists the finding as fixed; the job log names the missing permission. An installation token resolves review threads only with `contents: write` besides `pull-requests: write`.
- An applied fix resolves its finding's thread the same way, without an "Applied in" reply.

## 0.5.1 (2026-10-27)

- A finding number in the review's first step ("fix #1 first") links to that finding's inline comment, or reads "finding 1" when it has none. GitHub linked it to issue 1 of the repository before.

## 0.5.0 (2026-10-27)

- New `archestra-auth: github-actions`: the job signs in with its GitHub Actions identity. Archestra runs the review as the pull request author, who must have connected GitHub to Archestra, and returns its GitHub App's token for the repository, so the review posts as the App. Authors who have not connected get a note in the review comment instead of a review.
- While a run works, the progress header shows the runtime's own plan as a checklist (from its `progress.json`).
- The reviewer gets the checks of the head commit (`checks.json`), and the brief asks it to turn a failure the pull request causes into a finding. It also checks resource lifetimes, unbounded loops and retries, and images and copy against the code.
- The review comment moves to a new comment when the old one belongs to the workflow token and the job now posts as a GitHub App.
- A run that someone other than the author started is skipped without a note, and every sign-in try uses a fresh identity token.

## 0.4.0 (2026-10-27)

- Shorter review comment: the verdict and what to do first come first, then the findings table. A finding with an inline comment is written out only there; the table links to it. What the review read, the change map, observations, tests and limitations fold into "Review notes".
- A re-review leads with what changed since the last reviewed commit: fixed findings with their evidence, findings still open, and new ones.
- The verdict follows from the severities (medium or above requests changes; low and nit only comment), so the same findings always get the same verdict.
- The review body names the verdict and links the review comment as the summary.
- New `review-event` input: `request-changes` submits a change request for blocking findings and dismisses it once a later review finds nothing that blocks.
- A fixed finding's thread names the two reviewed commits and the evidence, not a single fix commit.
- The brief drops the required diagrams, gives the summary a word budget that grows with the diff, asks for evidence before a finding counts as fixed, and keeps tools, paths, input files and Guardrails out of the review.
- `fail-on` defaults to `error`: the step fails when the review is unavailable or stops with an error.
- A canceled job stops its runtime run while the job can still reach the gateway, and records itself in History ("superseded by …" or "canceled"). History has one row per job with the duration the header shows.
- GitHub requests that fail before reaching GitHub (DNS, TLS, refused connections) are retried, as are reads after a dropped connection or a 502, 503 or 504.

## 0.3.1 (2026-10-26)

- Display animated Archestra mark in the in-progress review header (`assets/progress.gif`) with dark theme support.

## 0.3.0 (2026-10-24)

- Add change map table to review comments when `changes` are present in `review.json`.
- Display Archestra logo in the progress header.
- Optimize review brief for faster runs: background dependency installation and targeted linter/type checks on changed files.

## 0.2.2 (2026-10-24)

- Post a comment reply under the review thread when GitHub App tokens cannot resolve threads directly.

## 0.2.1 (2026-10-24)

- Truncate overlength review sections in comments instead of failing schema validation.

## 0.2.0 (2026-10-23)

- Format review comments with structured sections: summary, diagrams, findings table with inline diff excerpts, observations, test coverage table, limitations, and verdict.
- Support optional structured fields in `review.json` (`reviewed`, `observations`, `tests`, `coverage`, `limitations`, `conclusion`, `title`).
- Add `fix-commands` input to toggle command hints in review comments.
- Increase default `timeout-minutes` to 30.

## 0.1.0 (2026-10-23)

- Initial release.
- Automated PR reviews via Archestra MCP gateway and dedicated agent runtimes.
- Interactive fix mode (`/archestra fix`) with branch commits authored by requester.
- CI failure triage (`/archestra fix-ci`) and base branch fix PR generation (`/archestra fix-ci-main`).
- Per-actor token routing (`resolve-actor-token.yml`) and agent rotation/failover.
- Sticky PR review comments with progress indicators and attempt history.
