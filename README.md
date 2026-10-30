# Archestra Code Review Action

GitHub Action that reviews pull requests using [Archestra](https://archestra.ai) Agent Runtimes. When requested by maintainers, agents can also apply fixes directly to the branch, triage failing CI checks, and open fix PRs for base-branch failures.

## Features

- **Automated PR Reviews** - Runs Archestra agents to review pull requests, execute targeted checks (lint, types, tests), and post structured review comments with inline diff annotations.
- **Interactive Fixes** - Maintainers trigger fixes via PR comments (`/archestra fix`). The agent implements the recommendations and pushes commits directly to the branch.
- **CI Failure Triage** - Categorizes failing checks with `/archestra fix-ci` and resolves PR-caused failures automatically.
- **Per-Actor Identity and Billing** - Runs execute using the platform token of the actor who triggered the event, routing costs and credentials to that specific user.
- **Agent Failover** - Automatically retries temporary errors on the same agent and falls back to alternate agents on permanent errors.

## Workflow Setup

Add two workflow files to `.github/workflows/`:

### 1. Caller Workflow (`.github/workflows/archestra-review.yml`)

Resolves the actor's Archestra token and invokes the review job:

```yaml
name: Archestra Review

on:
  pull_request:
    types: [opened, synchronize, ready_for_review, reopened]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

permissions: {}

jobs:
  actor:
    uses: archestra-ai/code-review-action/.github/workflows/resolve-actor-token.yml@v1

  review:
    needs: actor
    if: github.event_name == 'pull_request'
    permissions:
      contents: read
      pull-requests: write
    concurrency:
      group: archestra-review-${{ github.event.pull_request.number }}
      cancel-in-progress: true
    uses: $/.github/workflows/archestra-review-run.yml
    with:
      kind: review
    secrets:
      ARCHESTRA_TOKEN: ${{ secrets[needs.actor.outputs.secret_name] }}

  fix:
    needs: actor
    if: github.event_name != 'pull_request' && contains(github.event.comment.body, '/archestra')
    permissions:
      contents: read
      pull-requests: write
      actions: read
    concurrency:
      group: archestra-fix-${{ github.event.issue.number || github.event.pull_request.number }}
      cancel-in-progress: false
    uses: $/.github/workflows/archestra-review-run.yml
    with:
      kind: fix
    secrets:
      ARCHESTRA_TOKEN: ${{ secrets[needs.actor.outputs.secret_name] }}
      APP_ID: ${{ secrets.REVIEW_APP_ID }}
      APP_PRIVATE_KEY: ${{ secrets.REVIEW_APP_PRIVATE_KEY }}
```

### 2. Job Workflow (`.github/workflows/archestra-review-run.yml`)

Runs the review or fix action. Passes only the scoped token required for the job:

```yaml
name: Archestra Review Run

on:
  workflow_call:
    inputs:
      kind:
        type: string
        required: true
    secrets:
      ARCHESTRA_TOKEN:
        required: false
      APP_ID:
        required: false
      APP_PRIVATE_KEY:
        required: false

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - id: token
        env:
          ARCHESTRA_TOKEN: ${{ secrets.ARCHESTRA_TOKEN }}
        run: |
          if [[ -n "$ARCHESTRA_TOKEN" ]]; then
            echo "available=true" >> "$GITHUB_OUTPUT"
          else
            echo "::notice::No Archestra token for this actor. Store platform token as ARCHESTRA_TOKEN_<LOGIN>."
          fi

      - id: app-token
        if: steps.token.outputs.available == 'true' && inputs.kind == 'fix'
        uses: actions/create-github-app-token@v1
        with:
          app-id: ${{ secrets.APP_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}

      - if: steps.token.outputs.available == 'true'
        uses: archestra-ai/code-review-action@v1
        with:
          archestra-gateway-url: https://archestra.example.com/v1/mcp/code-review
          archestra-token: ${{ secrets.ARCHESTRA_TOKEN }}
          agents: |
            11111111-1111-4111-8111-111111111111
            22222222-2222-4222-8222-222222222222
          fix-token: ${{ steps.app-token.outputs.token }}
```

See [examples/archestra-runtime-review.yml](examples/archestra-runtime-review.yml) for a full setup with filters.

## Commands

Maintainers with write access can trigger fixes and CI triage via pull request comments:

| Command                         | Description                                                             |
| ------------------------------- | ----------------------------------------------------------------------- |
| `/archestra fix`                | Implements recommendations for all open findings and pushes commits.    |
| `/archestra fix 2,5 [note]`     | Implements findings 2 and 5, with an optional instruction note.         |
| `/archestra fix` (inline reply) | Implements the specific finding under that review comment.              |
| `/archestra fix-ci`             | Triages failing checks on the head commit and fixes PR-caused failures. |
| `/archestra fix-ci-main [row]`  | Opens a fix PR for failures that pre-date the PR on the base branch.    |

### CI Triage Categories

When `/archestra fix-ci` runs, it classifies failing checks into categories:

| Category         | Meaning                                            | Action Taken                                             |
| ---------------- | -------------------------------------------------- | -------------------------------------------------------- |
| `pr_caused`      | The pull request broke the check.                  | Agent fixes the code and pushes commits to the branch.   |
| `flaky`          | The check passed on immediate re-run.              | Re-runs failed jobs if `ci-rerun: true`.                 |
| `pre_existing`   | The check also fails on the base branch.           | Suggests a separate fix PR via `/archestra fix-ci-main`. |
| `infrastructure` | Runner, container registry, or quota failure.      | Reported in summary; manual re-run required.             |
| `needs_human`    | Cause unclear or fix requires manual intervention. | Diagnostic notes posted in comment.                      |

## Prerequisites

### 1. Archestra Gateway

Create an MCP gateway in Archestra (e.g. `https://<your-archestra>/v1/mcp/code-review`) with these Remote Agents tools:
- `start_agent_run`, `get_agent_run`, `steer_agent_run`, `cancel_agent_run`
- `read_workspace_file`, `write_workspace_file`, `transfer_credential`, `delete_workspace`

A review asks for a medium container (tier `M`), a 10-minute idle timeout and a 3-hour maximum duration; a deployment that predates run limits ignores or rejects the argument and gives the Agent's defaults instead. An Agent whose own limits are lower, or that sizes its runs with explicit CPU and memory, refuses them; that run then starts with the Agent's own limits. Once the review is complete, posted or not, the action deletes the workspaces of every run it started, so their volumes do not stay reserved until they expire. The next review of the pull request receives the previous findings as an input file and clones again, and so does a `/archestra fix` after a review: it starts a fresh run on the review's agent.

If Guardrails is enabled, configure it to allow external client connections from the action.

### 2. Review Agents

Create one or more Archestra agents with dedicated runtimes:
- Configure different model providers across agents to enable failover.
- Grant **Can use** permissions to members or teams using the action.
- For private repositories, provide a read-only token via `clone-token`.

### 3. Who the Runs Act As

Choose one of two ways.

**Sign in with the job's identity (`archestra-auth: github-actions`).** No tokens in GitHub. The job sends its GitHub Actions identity token to Archestra. Archestra runs the review as the GitHub user who started the run, and only when that user has connected GitHub to Archestra through your organization's GitHub App. It also returns that App's token for this repository, so reviews post as the App, which can resolve review threads. Older Archestra versions accept only the pull request author.
1. In Archestra, add the GitHub App as a credential and let users connect their GitHub accounts to it.
2. On the review gateway, turn on GitHub Actions access: pick the App, and list the repositories and the trusted workflow (the `job_workflow_ref` of the job that runs this action).
3. Give the job `id-token: write` and set `archestra-auth: github-actions`.

An author who has not connected GitHub gets a short note in the review comment instead of a review. A run that someone else started (a push to the author's branch, a bot updating it) is skipped without a note; the author's next push gets the review.

**Personal platform tokens (`archestra-auth: token`, the default).** Each user creating PRs or triggering commands needs an Archestra platform token:
1. Generate a platform token in Archestra Personal Settings.
2. Add it as an organization or repository secret: `ARCHESTRA_TOKEN_<LOGIN>` (uppercase GitHub username with hyphens replaced by underscores, e.g. `ARCHESTRA_TOKEN_OCTO_CAT`).

_Optional_: Configure `fallback-token` with a shared team token to support contributors without individual platform tokens.

### 4. GitHub App (Fix Modes)

To allow agents to push fixes and trigger follow-up CI runs:
1. Create a GitHub App with repository permissions:
   - **Contents: write**
   - **Pull requests: write**
   - **Actions: read** (or **Actions: write** if `ci-rerun: true`)
2. Install the app on the repository and save `APP_ID` and `APP_PRIVATE_KEY` as secrets.
3. Pass the minted installation token as `fix-token`. Pushed commits are authored using the requester's GitHub noreply email address.

## Inputs & Outputs

### Inputs

| Input                     | Default               | Description                                                                                                                                          |
| ------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `archestra-gateway-url`   | _required_            | Archestra MCP gateway endpoint.                                                                                                                      |
| `archestra-token`         | `""`                  | Actor platform token. If empty, the action skips execution unless `fallback-token` is set.                                                           |
| `fallback-token`          | `""`                  | Shared platform token used when actor token is missing.                                                                                              |
| `agents`                  | _required_            | Agent IDs, one per line.                                                                                                                             |
| `fallback-agents`         | `agents`              | Agent IDs to use with `fallback-token`.                                                                                                              |
| `strategy`                | `rotate`              | Agent selection: `rotate`, `ordered`, or `random`.                                                                                                   |
| `retries`                 | `1`                   | Retries on the same agent after a temporary failure.                                                                                                 |
| `max-fallbacks`           | _all_                 | Number of alternative agents to try after permanent failure.                                                                                         |
| `timeout-minutes`         | `30`                  | Timeout per review attempt.                                                                                                                          |
| `overall-timeout-minutes` | `120`                 | Total timeout across all attempts.                                                                                                                   |
| `instructions`            | `""`                  | Additional review instructions passed to the agent.                                                                                                  |
| `instructions-file`       | `""`                  | Path to a workspace file containing review instructions.                                                                                             |
| `github-token`            | `${{ github.token }}` | GitHub token for posting comments (`pull-requests: write`).                                                                                          |
| `post`                    | `review`              | Posting mode: `review` (sticky comment + inline), `comment` (sticky only), or `none`.                                                                |
| `archestra-auth`          | `token`               | `token` (use `archestra-token`), or `github-actions`: sign in with the job's identity and review as the PR author (needs `id-token: write`).         |
| `archestra-connect-to`    | `""`                  | Local `host:port` to dial the gateway at (a tunnel); its hostname stays the TLS server name. Nothing else is dialed there.                           |
| `review-event`            | `comment`             | `comment`, or `request-changes`: a finding of medium or above requests changes, dismissed and marked resolved once nothing blocks.                   |
| `fail-on`                 | `error`               | Step failure condition: `error` (the review could not finish), `findings` (also on findings), or `never`.                                            |
| `mode`                    | `auto`                | Execution mode: `auto`, `review`, `fix`, `fix-ci`, or `fix-ci-main`.                                                                                 |
| `pr-number`               | `""`                  | Pull request number (required for manual `workflow_dispatch`).                                                                                       |
| `fix-command`             | `/archestra`          | Comment command prefix.                                                                                                                              |
| `fix-commands`            | `true`                | Set `false` to hide command instructions when fix workflows are not configured.                                                                      |
| `fix-token`               | `""`                  | GitHub App token for pushing fixes.                                                                                                                  |
| `clone-token`             | `""`                  | Read-only GitHub token for cloning private repositories.                                                                                             |
| `fix-timeout-minutes`     | `45`                  | Timeout per fix or CI triage attempt.                                                                                                                |
| `ci-rerun`                | `false`               | Automatically re-run failed jobs classified as flaky.                                                                                                |
| `incremental-review`      | `true`                | Give a re-review the previous findings, so it reports what was fixed. The previous workspace is deleted after each review; a re-review clones again. |

### Outputs

| Output           | Description                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `status`         | Execution status: `success`, `skipped`, `nothing-to-do`, `unauthorized`, `unavailable`, `aborted`, or `error`. |
| `mode`           | Mode executed (`review`, `fix`, `fix-ci`, `fix-ci-main`).                                                      |
| `agent-id`       | Agent ID that completed the run.                                                                               |
| `run-id`         | Archestra task/run ID.                                                                                         |
| `run-url`        | URL to the Archestra run dashboard.                                                                            |
| `findings-count` | Number of review findings.                                                                                     |
| `attempts`       | JSON array of attempt history (agent, run, result, duration).                                                  |
| `pushed-commits` | JSON array of commit SHAs pushed by fix mode.                                                                  |
| `applied`        | JSON array of applied findings `[{finding, commit}]`.                                                          |
| `skipped`        | JSON array of skipped findings `[{finding, reason}]`.                                                          |
| `triage`         | JSON object containing CI triage results.                                                                      |

## How It Works

```text
pull_request     ──► action ──► start_agent_run ──► runtime writes review.json
                                 │ poll status
                                 │ read review.json
                                 └──► post sticky review comment + inline diff comments

/archestra fix   ──► action ──► transfer_credential (CODE_REVIEW_GITHUB_TOKEN)
                                 ──► steer_agent_run (runtime commits & pushes)
                                 └──► verify commits ──► resolve threads & update comment
```

### Review Comments

- The action keeps one review comment on the pull request. While a run works, it shows the runtime's plan as a checklist. When the run ends, it shows the verdict, what to do first and the findings table. A re-review leads with what changed since the last reviewed commit. What the review read, its tests and its limits fold into "Review notes".
- Findings inside the diff get inline comments, updated in place across re-reviews; the table links to them.
- The threads of fixed findings are resolved, with no reply. Resolving needs a token with `contents: write` besides `pull-requests: write`; without it the thread stays open, and the review comment still lists the finding as fixed.
- The reviewer gets the checks of the head commit: a failing check the pull request causes becomes a finding.

### Reliability & Failover

- **Temporary Failures** (HTTP 429/5xx, timeouts, network interruptions): Retried on the same agent up to `retries` times.
- **Permanent Failures** (agent unavailable, runtime errors, execution timeouts): Fails over to the next agent in the list.
- **Fatal Errors** (invalid gateway credentials, missing required tools): Execution halts immediately.

### Security

- **Review Mode**: Read-only. The agent runtime receives no GitHub write credentials; comments are posted by the action runner using the job `github-token`.
- **Fix Mode**: The runtime receives a short-lived GitHub App token scoped to repository write permissions.
- **Branch Scope**: Draft PRs, `[WIP]` titles, PRs from forks, and bot PRs are skipped by default. Commits pushed by the runtime are attributed to the requester's GitHub identity.

## Development

```sh
npm ci
npm run lint        # Run Biome and TypeScript checks
npm test            # Run Vitest test suite
npm run build       # Bundle dist/ artifacts
npm run local-run   # Run modes locally against mock servers
npm run schemas     # Generate JSON schemas from TypeScript contracts
```

## License

[Apache 2.0](LICENSE)
