# Changelog

## 0.9.0 (2026-10-31)

- A run killed for memory (`pod.oom_killed`, or "out of memory" in the reason of a deployment without failure codes) is tried again at once on the same agent with more memory than it had: one GiB above half the memory limit the reason names, which is the next tier up, or twice the memory the request implied when the reason names none. At most twice per agent, and only while the gateway puts the retry on a different tier than the one it killed; an Agent with no tier that large refuses the request, which ends that agent's attempts. Before, the failure went to the next agent, sized the same, which died the same way.
- New `min-cpu` and `min-memory-gib` inputs for a repository whose checks need more than the smallest tier with two CPUs.
- Each attempt records the name of the tier its run got; the attempts table and the comment's history show it next to the run link.

## 0.8.0 (2026-10-31)

- A review asks for the smallest runtime tier with at least two CPUs (`min_cpu: 2`) instead of a tier named `S`: organizations name their tiers themselves now. An Agent none of whose allowed tiers has two CPUs refuses the request, and that run starts with the Agent's own limits, as before.
- A review asks for a bounded run: a 10-minute idle timeout and a one-hour maximum duration, each at or below the Agent's own limits. An Agent whose limits are lower refuses them; that run takes the Agent's own limits, and the other Agents still get the request.
- Once a review is complete, posted or not, the action deletes the workspaces of every run it started, so their volumes do not stay reserved until they expire.

## 0.7.0 (2026-10-29)

- New `archestra-connect-to` input: a local `host:port`, such as a tunnel's `127.0.0.1:18443`, that the action dials for the gateway instead of the gateway's own address. The gateway's hostname stays the TLS server name, so its certificate is still checked, and nothing else is dialed there. The system resolver is no longer involved for the gateway, so a job needs no `/etc/hosts` entry or packet redirect for it. On GitHub-hosted runners, that routing intermittently made the job resolve `api.github.com` to the tunnel's loopback address, and every GitHub API call then failed TLS against the staging certificate.

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
