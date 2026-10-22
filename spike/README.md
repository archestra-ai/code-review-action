# Prototype spike

Eight pass/fail checks that confirm the platform and GitHub behave as the design expects. Run them in a **throwaway repository** before you adopt the action.

## Prerequisites

- A throwaway repository with a `main` branch and one open pull request from a branch of the same repository.
- Two test users: one with **write** access, one with **read** access.
- A GitHub App installed on the repository (contents: write, pull-requests: write, actions: read). Secrets `SPIKE_APP_ID`, `SPIKE_APP_PRIVATE_KEY`.
- An Archestra agent with a dedicated runtime and a declared per-user `GITHUB_TOKEN` credential, and a service account key. Secrets `SPIKE_ARCHESTRA_API_KEY`; variables `SPIKE_ARCHESTRA_URL`, `SPIKE_AGENT_ID`.

## Steps

1. Copy `spike-workflow.yml` to `.github/workflows/spike.yml` in the throwaway repository, on `main`.
2. Run **Spike** with `workflow_dispatch`, `step: setup`, and the pull request number. It posts a bot comment with `- [ ] Apply` and a review thread, and pushes one commit with the App token and one with the job token.
3. As the **write** user, tick the box. As the **read** user, try to tick it (checks 1, 2).
4. Run `step: rewrite` (the bot rewrites its comment with the same text: check 3).
5. Look at the pull request: which pushes started the `synchronize` job (check 4), and the avatar of the noreply commit (check 5).
6. Run `step: resolve` (check 6) and `step: runtime` (checks 7, 8).
7. Run `step: report`. It prints the checklist from the job logs and the results that the jobs recorded.

| # | Check | How the workflow records it |
| --- | --- | --- |
| 1 | A write user ticks the box; `issue_comment.edited` fires; `sender` = the user; `changes.body.from` has the unticked box. | The `edited` job logs `sender`, and whether `from` contains `- [ ] Apply`. |
| 2 | A read user cannot tick the box, or the permission check rejects the sender. | The `edited` job logs the collaborator permission of the sender. |
| 3 | The bot's own rewrite does not start a fix (sender = github-actions[bot] is ignored). | The `edited` job logs `ignored: bot sender`. |
| 4 | A push with the App token starts `pull_request: synchronize`; a push with the job token does not. | The `synchronize` job logs the head commit message (`spike: app push` or `spike: job push`). |
| 5 | A commit with the user's noreply email shows the user's avatar. | Manual: look at the commit list of the pull request. |
| 6 | `resolveReviewThread` works with the App token on a thread the bot created. | The `resolve` step prints `isResolved`. |
| 7 | After a one-shot run exits, the workspace is `idle` and `/continue` accepts a new turn. | The `runtime` step prints the workspace state and the continue response. Suspend the workspace in Archestra and run it again. |
| 8 | `PUT /api/agents/:id/runtime/credentials/GITHUB_TOKEN` and then `/continue` give the new value to the next turn. | The runtime writes `token-check.json` with the SHA-256 of `$GITHUB_TOKEN`; the step compares it with the SHA-256 of the stored value. The token itself is never printed. |
