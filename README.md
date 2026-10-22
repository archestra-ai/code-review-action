# Archestra code review action

This GitHub Action reviews pull requests on [Archestra](https://archestra.ai) Agent Runtimes. When a maintainer asks, the same runtime applies the findings, triages failing checks, and prepares a fix pull request for failures that are already on the base branch.

- **Review.** The action starts a one-shot run on one of your Archestra agents. The agent clones the repository at the head commit, reviews the change and writes `review.json`. The action posts a review comment and inline comments.
- **Balancing and fallback.** You give a list of agents. Each agent has a dedicated runtime and its own model provider. The action selects the first agent from the list (rotation by default). It tries the same agent again after a temporary failure and goes to the next agent after a permanent failure. The number of attempts is finite.
- **Fixes on request.** A maintainer ticks a box in the review comment or writes a command. The action continues the retained workspace of the review. The runtime pushes the fix to the pull request branch. The commits have the maintainer as the author.
- **No GitHub write token in the review.** The runtime never posts to GitHub. The action posts with the job token. Only the fix modes give the runtime a short-lived GitHub App token for pushes.

## How it works

```text
pull_request ──► action ──► POST /api/agents/:id/runs (one_shot) ──► runtime writes review.json
                   │  poll GET /api/agent-runs/:taskId (state only)
                   │  read  GET /api/agent-runs/:taskId/workspace/files?path=review.json
                   └──► review comment (sticky) + inline comments

/archestra fix  ──► action ──► PUT GITHUB_TOKEN credential ──► POST /api/agent-runs/:taskId/continue
or a ticked box     │                                               runtime commits and pushes
                    └──► verify commits (compare API) ──► resolve threads, update the review comment
```

The review comment keeps the state between workflow runs. A hidden marker line holds the workspace, the last run, the agent and the reviewed commit:

```text
<!-- archestra-code-review owner/repo#N session=<workspace> run=<task> agent=<agent> sha=<commit> -->
```

## Setup

### 1. Archestra service account

1. In Archestra, create a service account and an API key for it.
2. Give its role permission to **use** the review agents and to **read** their runs. The key is sent as `Authorization: <key>` (no `Bearer` prefix).
3. Store the key as a repository secret, for example `ARCHESTRA_REVIEW_API_KEY`.

### 2. Review agents

Create one Archestra agent for each runtime that you want to use. Use different model providers, so that the action can rotate the cost and fall back when one provider is not available.

- Each agent must have a **dedicated runtime** that the service account can use.
- Use provider authentication, not a personal subscription: Claude Code with `claudeCode.authentication = provider`, or OpenCode, Hermes or OpenClaw with a provider key. Personal sign-ins (Claude Pro/Max, Codex with ChatGPT) do not work from CI.
- Declare `GITHUB_TOKEN` as a **per-user runtime credential** (not a vault secret). The action stores a fresh token before each fix turn. Set its TTL long enough for a person to click later (for example 72 hours).
- Set a short idle timeout. The action resumes the workspace when it needs it.
- For private repositories, the runtime clones with the `GITHUB_TOKEN` credential. For the review, give it a read-only value; the fix modes replace it with the App token.

### 3. GitHub App for pushes (fix modes only)

Pushes with the job `GITHUB_TOKEN` do not start new workflow runs, so CI and the next review would not run. Use a GitHub App:

1. Create a GitHub App with these repository permissions: **Contents: write**, **Pull requests: write**, **Actions: read** (and **Actions: write** if you set `ci-rerun: true`).
2. Install it on the repository. Store its app ID and private key as secrets.
3. Protect your important branches with rulesets, so that the App can push only to pull request branches and to `archestra/fix-ci-*` branches.
4. In the workflow, mint an installation token with `actions/create-github-app-token` and give it to the action as `fix-token`.

The App pushes the commits, but the commit author is the person who asked for the fix (`<id>+<login>@users.noreply.github.com`). The commits are not signed. If your repository requires signed commits, the fix modes do not work in this version.

### 4. Workflow

```yaml
name: Archestra review
on:
  pull_request:
    types: [opened, synchronize, ready_for_review, reopened]
  issue_comment:
    types: [created, edited]
  pull_request_review_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  actions: read

jobs:
  review:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    concurrency:
      group: archestra-review-${{ github.event.pull_request.number }}
      cancel-in-progress: true
    steps:
      - uses: archestra-ai/code-review-action@v1
        with:
          archestra-url: https://archestra.example.com
          archestra-api-key: ${{ secrets.ARCHESTRA_REVIEW_API_KEY }}
          agents: |
            11111111-1111-4111-8111-111111111111
            22222222-2222-4222-8222-222222222222

  fix:
    if: github.event_name != 'pull_request' && contains(github.event.comment.body, 'archestra')
    runs-on: ubuntu-latest
    concurrency:
      group: archestra-fix-${{ github.event.issue.number || github.event.pull_request.number }}
      cancel-in-progress: false
    steps:
      - id: app-token
        uses: actions/create-github-app-token@v2
        with:
          app-id: ${{ secrets.REVIEW_APP_ID }}
          private-key: ${{ secrets.REVIEW_APP_PRIVATE_KEY }}
      - uses: archestra-ai/code-review-action@v1
        with:
          archestra-url: https://archestra.example.com
          archestra-api-key: ${{ secrets.ARCHESTRA_REVIEW_API_KEY }}
          agents: |
            11111111-1111-4111-8111-111111111111
            22222222-2222-4222-8222-222222222222
          fix-token: ${{ steps.app-token.outputs.token }}
```

See [examples/archestra-runtime-review.yml](examples/archestra-runtime-review.yml) for a complete workflow with filters.

## Commands and boxes

Only users with **write**, **maintain** or **admin** access can start a fix. The action checks this with the collaborator permission API. It ignores comments and edits by bots (also its own edits of the review comment), and it never starts a fix without a person.

| You do | The action does |
| --- | --- |
| Tick **Apply the findings** in the review comment | Applies all open findings. |
| Comment `/archestra fix` | Applies all open findings. |
| Comment `/archestra fix 2,5 <note>` | Applies findings 2 and 5. The note (1000 characters maximum) goes to the runtime as data. |
| Reply `/archestra fix` under an inline finding | Applies that finding only. |
| Tick **Triage and fix failing checks**, or comment `/archestra fix-ci` | Collects the failing checks of the head commit, and gives the runtime the log tails and annotations. The runtime classifies each failure and fixes the ones that the pull request causes. |
| Tick **Open a fix PR against main for &lt;job&gt;**, or comment `/archestra fix-ci-main [n]` | For a failure that also occurs on the base branch: the runtime fixes it on a new `archestra/fix-ci-<slug>` branch, and the action opens a pull request. Queue the fix PR first, then rebase your pull request. |
| Click **Commit suggestion** on an inline comment | GitHub applies a small fix directly. No runtime is used. |

After a fix, the action checks each reported commit: it must be on the branch and its author email must be the noreply address of the person who asked. Only verified commits are shown as applied. The threads of applied findings are resolved. Skipped findings get a reply with the reason. A later review that finds a resolved problem again reopens its thread.

CI triage classes:

| Class | Meaning | Result |
| --- | --- | --- |
| `pr_caused` | The change breaks the check. | The runtime pushes a fix. |
| `flaky` | The check passes when it runs again. | With `ci-rerun: true`, the action re-runs the failed jobs. |
| `pre_existing` | The check also fails on the base branch. | The review comment offers a separate fix pull request. |
| `infrastructure` | The runner, a registry or a quota failed. | Re-run the job. |
| `needs_human` | The runtime cannot find the cause or a safe fix. | The notes are in the reply. |

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `archestra-url` | required | The base URL of the Archestra deployment. |
| `archestra-api-key` | required | The service account API key. |
| `agents` | required | Agent IDs, one for each line. |
| `strategy` | `rotate` | `rotate`: (PR number + run attempt) mod N. `ordered`: the list order. `random`. |
| `retries` | `1` | Attempts on the same agent after a temporary failure (after 30 s, then 60 s). |
| `max-fallbacks` | all | More agents to try after a permanent failure. |
| `timeout-minutes` | `20` | Time limit for one review attempt. |
| `overall-timeout-minutes` | `120` | Time limit for all attempts. |
| `instructions`, `instructions-file` | none | More review rules, given to the runtime as `instructions.md`. |
| `github-token` | `github.token` | Posts the review. Needs `pull-requests: write`. |
| `post` | `review` | `review`, `comment` or `none`. |
| `fail-on` | `never` | `never`, `findings` or `error`. |
| `mode` | `auto` | `auto`, `review`, `fix`, `fix-ci`, `fix-ci-main`. Use with `pr-number` for `workflow_dispatch`. |
| `fix-command` | `/archestra` | The command prefix. |
| `fix-token` | none | GitHub App installation token for the fix modes. |
| `fix-timeout-minutes` | `45` | Time limit for one fix or triage attempt. |
| `ci-rerun` | `false` | Re-run jobs that the triage finds flaky. |
| `max-auto-fix-rounds` | `0` | Only `0` is supported: each fix needs a person. |
| `incremental-review` | `true` | Continue the workspace of the last review of the same pull request. |

Outputs: `status`, `mode`, `agent-id`, `run-id`, `run-url`, `findings-count`, `attempts`, `pushed-commits`, `applied`, `skipped`, `triage` (JSON values where the type is a list).

## Failure handling

| Signal | Class | Next step |
| --- | --- | --- |
| HTTP 429, 5xx or a network error from the Archestra API | temporary | Same agent |
| HTTP 401 | fatal | Stop all attempts (all agents use the same key) |
| HTTP 403, 404 or 409 when the run starts | permanent | Next agent |
| Run failure with `retriable: true` | temporary | Same agent |
| Run failure with `retriable: false` | permanent | Next agent |
| Run ended canceled, rejected, waiting for input or authentication | permanent | Next agent |
| Attempt time limit | permanent | Cancel the run, next agent |
| Result file missing or not valid | permanent | Next agent |

Older Archestra deployments do not send the `failure` field. Then the action classifies the failure from its message, and the log says so.

When the workspace of the last run is busy, a fix waits until it is free. When the workspace is no longer retained, the fix starts a fresh run on the same agent with all inputs again.

The `post` step cancels the live run when the job is canceled (for example by `cancel-in-progress`) or times out.

## Limits

- The message to the runtime is less than 8 KB. The diff (5 MB maximum), the pull request data, CI logs (200 KB tail for each job, 15 jobs maximum) and other inputs go as attachments (20 maximum).
- 50 findings for each review. GitHub limits a comment to 65,536 characters; the action shortens long texts in the review comment.
- No fixes for pull requests from forks. No reviews of drafts, `[WIP]` titles, forks or pull requests opened by bots.
- Commits made by the runtime are not signed.
- The result files have JSON Schemas in [schemas/](schemas/).

## Development

```sh
npm ci
npm run lint        # Biome and TypeScript
npm test            # Vitest, with msw fakes of the Archestra and GitHub APIs
npm run build       # bundles dist/ (committed)
npm run local-run   # runs all modes against fake servers and prints the payloads
npm run schemas     # writes schemas/ from src/contracts.ts
```

## License

Apache License 2.0. See [LICENSE](LICENSE).
