# Archestra code review action

This GitHub Action reviews pull requests on [Archestra](https://archestra.ai) Agent Runtimes. When a maintainer asks, the same runtime applies the findings, triages failing checks, and prepares a fix pull request for failures that are already on the base branch.
- **Review.** The action starts a one-shot run on one of your Archestra agents. The agent clones the repository at the head commit, reviews the change and writes `review.json`. The action posts a review comment and inline comments.
- **Your identity, your costs.** Each run acts as the person who caused the event: the pull request author, the pusher, or the maintainer who asked for a fix. The run uses that person's Archestra credentials and Claude account, the cost goes to that person, and only that person can answer a Guardrails review on the run page.
- **Balancing and fallback.** You give a list of agents. Each agent has a dedicated runtime and its own model provider. The action selects the first agent from the list (rotation by default). It tries the same agent again after a temporary failure and goes to the next agent after a permanent failure. The number of attempts is finite.
- **Fixes on request.** A maintainer ticks a box in the review comment or writes a command. The action continues the retained workspace of the review. The runtime pushes the fix to the pull request branch. The commits have the maintainer as the author.
- **No GitHub write token in the review.** The runtime never posts to GitHub. The action posts with the job token. Only the fix modes give the runtime a short-lived GitHub App token for pushes.

## How it works

The action is a client of an Archestra MCP gateway. It calls the Remote Agents tools with the actor's platform token.

```text
pull_request ──► action ──► start_agent_run (pr.json, pr.diff) ──► runtime writes review.json
                   │  poll get_agent_run (state only)
                   │  read read_workspace_file review.json
                   └──► review comment (sticky) + inline comments

/archestra fix  ──► action ──► transfer_credential GITHUB_TOKEN ──► write_workspace_file (inputs)
or a ticked box     │          ──► steer_agent_run (same run, next turn)  runtime commits and pushes
                    └──► verify commits (compare API) ──► resolve threads, update the review comment
```

The review comment keeps the state between workflow runs. A hidden marker line holds the run (its ID is also the workspace ID), the agent and the reviewed commit:

```text
<!-- archestra-code-review owner/repo#N session=<run> run=<run> agent=<agent> sha=<commit> -->
```

A run belongs to the person whose token started it. When another person asks for a fix, the action starts a fresh run with that person's token, and gives it all the inputs again.

## Setup

### 1. Archestra gateway

1. In Archestra, create an MCP gateway for the action, for example `code-review`. Its endpoint is `https://<your Archestra>/v1/mcp/code-review`.
2. Add these tools to it: `start_agent_run`, `get_agent_run`, `steer_agent_run`, `cancel_agent_run`, `read_workspace_file`, `write_workspace_file`, `transfer_credential`. A gateway that gives only `search_tools` and `run_tool` also works: the action calls the tools through `run_tool`.
3. Share the gateway with the organization, or with the teams of the people who use the action.
4. If Guardrails is on, let it accept clients that it does not recognize. Otherwise it refuses the runs that the action starts. Guardrails still checks the tool calls in each run.

### 2. Review agents

Create one Archestra agent for each runtime that you want to use. Use different model providers, so that the action can spread the cost and fall back when one provider is not available.
- Each agent must have a **dedicated runtime**. Share it with the same people as the gateway, with the **Can use** permission.
- Claude Code in subscription mode uses the Claude account of the person that the run acts as. Each person connects their Claude account on the agent once. OpenCode, Hermes, OpenClaw, or Claude Code in provider mode use the agent's provider key.
- Declare `GITHUB_TOKEN` as a **per-user runtime credential**. The fix modes store a fresh App token in it before each turn. For a private repository, give the review job a read-only token as `clone-token`; the action stores it before each review.
- Set the maximum run duration long enough for a person to click later (for example 72 hours), and a short idle timeout. The action resumes the workspace when it needs it.

### 3. Platform tokens

Each person who opens pull requests or asks for fixes:
1. Creates a platform token in Archestra (Personal Settings).
2. Stores it as an organization or repository secret named `ARCHESTRA_TOKEN_<LOGIN>`: the GitHub login in upper case, with `-` changed to `_`. For example, `octo-cat` uses `ARCHESTRA_TOKEN_OCTO_CAT`.

The reusable workflow [resolve-actor-token.yml](.github/workflows/resolve-actor-token.yml) gives the secret name for the actor of each event. The workflow below passes only that secret to the job that runs the action. A person without a token gets no review, and the job log says why. Optionally, set `fallback-token` to a shared team token: the runs of people without a token then act as the team token's owner, who pays for them. Use `fallback-agents` to leave out agents that need a person's own Claude account.

### 4. GitHub App for pushes (fix modes only)

Pushes with the job `GITHUB_TOKEN` do not start new workflow runs, so CI and the next review would not run. Use a GitHub App:
1. Create a GitHub App with these repository permissions: **Contents: write**, **Pull requests: write**, **Actions: read** (and **Actions: write** if you set `ci-rerun: true`).
2. Install it on the repository. Store its app ID and private key as secrets.
3. Protect your important branches with rulesets, so that the App can push only to pull request branches and to `archestra/fix-ci-*` branches.
4. In the workflow, mint an installation token with `actions/create-github-app-token` and give it to the action as `fix-token`.

The App pushes the commits, but the commit author is the person who asked for the fix (`<id>+<login>@users.noreply.github.com`). The commits are not signed. If your repository requires signed commits, the fix modes do not work in this version.

### 5. Workflow

Use two workflow files. The entry workflow finds the actor's token secret and calls a reusable job workflow in the same repository. Each call passes only the one token that the job needs, so no job gets the whole secrets context. Keep the job workflow in your repository, not in this one: a reusable workflow cannot find its own commit, so it could not pin this action to the same version. Pin `archestra-ai/code-review-action` and its reusable workflow to a commit SHA when your organization requires it; the tag `v1` moves with releases.

`.github/workflows/archestra-review.yml`:

```yaml
name: Archestra review
on:
  pull_request:
    types: [opened, synchronize, ready_for_review, reopened]
  issue_comment:
    types: [created, edited]
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
    uses: ./.github/workflows/archestra-review-run.yml
    with:
      kind: review
    # GitHub resolves this lookup before it starts the called job and passes only this token.
    secrets:
      ARCHESTRA_TOKEN: ${{ secrets[needs.actor.outputs.secret_name] }}

  fix:
    needs: actor
    if: github.event_name != 'pull_request' && contains(github.event.comment.body, 'archestra')
    permissions:
      contents: read
      pull-requests: write
      actions: read
    concurrency:
      group: archestra-fix-${{ github.event.issue.number || github.event.pull_request.number }}
      cancel-in-progress: false
    uses: ./.github/workflows/archestra-review-run.yml
    with:
      kind: fix
    secrets:
      ARCHESTRA_TOKEN: ${{ secrets[needs.actor.outputs.secret_name] }}
      APP_ID: ${{ secrets.REVIEW_APP_ID }}
      APP_PRIVATE_KEY: ${{ secrets.REVIEW_APP_PRIVATE_KEY }}
```

`.github/workflows/archestra-review-run.yml`:

```yaml
name: Archestra review run
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
      - id: app-token
        if: inputs.kind == 'fix'
        uses: actions/create-github-app-token@v2
        with:
          app-id: ${{ secrets.APP_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}
      - uses: archestra-ai/code-review-action@v1
        with:
          archestra-gateway-url: https://archestra.example.com/v1/mcp/code-review
          archestra-token: ${{ secrets.ARCHESTRA_TOKEN }}
          agents: |
            11111111-1111-4111-8111-111111111111
            22222222-2222-4222-8222-222222222222
          fix-token: ${{ steps.app-token.outputs.token }}
```

The job workflow gets its `GITHUB_TOKEN` permissions from the calling job, so a review gets no `actions` permission. See [examples/archestra-runtime-review.yml](examples/archestra-runtime-review.yml) for a complete workflow with filters.

## Commands and boxes

Only users with **write**, **maintain** or **admin** access can start a fix. The action checks this with the collaborator permission API. It ignores comments and edits by bots (also its own edits of the review comment), and it never starts a fix without a person.

| You do                                                                                       | The action does                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tick **Apply the findings** in the review comment                                            | Applies all open findings.                                                                                                                                                                                     |
| Comment `/archestra fix`                                                                     | Applies all open findings.                                                                                                                                                                                     |
| Comment `/archestra fix 2,5 <note>`                                                          | Applies findings 2 and 5. The note (1000 characters maximum) goes to the runtime as data.                                                                                                                      |
| Reply `/archestra fix` under an inline finding                                               | Applies that finding only.                                                                                                                                                                                     |
| Tick **Triage and fix failing checks**, or comment `/archestra fix-ci`                       | Collects the failing checks of the head commit, and gives the runtime the log tails and annotations. The runtime classifies each failure and fixes the ones that the pull request causes.                      |
| Tick **Open a fix PR against main for &lt;job&gt;**, or comment `/archestra fix-ci-main [n]` | For a failure that also occurs on the base branch: the runtime fixes it on a new `archestra/fix-ci-<slug>` branch, and the action opens a pull request. Queue the fix PR first, then rebase your pull request. |
| Click **Commit suggestion** on an inline comment                                             | GitHub applies a small fix directly. No runtime is used.                                                                                                                                                       |

After a fix, the action checks each reported commit: it must be on the branch and its author email must be the noreply address of the person who asked. Only verified commits are shown as applied. The threads of applied findings are resolved. Skipped findings get a reply with the reason. A later review that finds a resolved problem again reopens its thread.

CI triage classes:

| Class            | Meaning                                          | Result                                                     |
| ---------------- | ------------------------------------------------ | ---------------------------------------------------------- |
| `pr_caused`      | The change breaks the check.                     | The runtime pushes a fix.                                  |
| `flaky`          | The check passes when it runs again.             | With `ci-rerun: true`, the action re-runs the failed jobs. |
| `pre_existing`   | The check also fails on the base branch.         | The review comment offers a separate fix pull request.     |
| `infrastructure` | The runner, a registry or a quota failed.        | Re-run the job.                                            |
| `needs_human`    | The runtime cannot find the cause or a safe fix. | The notes are in the reply.                                |

## Inputs

| Input                               | Default        | Description                                                                                     |
| ----------------------------------- | -------------- | ----------------------------------------------------------------------------------------------- |
| `archestra-gateway-url`             | required       | The MCP gateway endpoint, `https://<your Archestra>/v1/mcp/<gateway>`.                          |
| `archestra-token`                   | none           | The actor's platform token. Empty skips the event, unless `fallback-token` is set.              |
| `fallback-token`                    | none           | A shared token for actors without their own. Its owner pays for those runs.                     |
| `agents`                            | required       | Agent IDs, one for each line.                                                                   |
| `fallback-agents`                   | `agents`       | The agents to use with `fallback-token`.                                                        |
| `strategy`                          | `rotate`       | `rotate`: (PR number + run attempt) mod N. `ordered`: the list order. `random`.                 |
| `retries`                           | `1`            | Attempts on the same agent after a temporary failure (after 30 s, then 60 s).                   |
| `max-fallbacks`                     | all            | More agents to try after a permanent failure.                                                   |
| `timeout-minutes`                   | `20`           | Time limit for one review attempt.                                                              |
| `overall-timeout-minutes`           | `120`          | Time limit for all attempts.                                                                    |
| `instructions`, `instructions-file` | none           | More review rules, given to the runtime as `instructions.md`.                                   |
| `github-token`                      | `github.token` | Posts the review. Needs `pull-requests: write`.                                                 |
| `post`                              | `review`       | `review`, `comment` or `none`.                                                                  |
| `fail-on`                           | `never`        | `never`, `findings` or `error`.                                                                 |
| `mode`                              | `auto`         | `auto`, `review`, `fix`, `fix-ci`, `fix-ci-main`. Use with `pr-number` for `workflow_dispatch`. |
| `fix-command`                       | `/archestra`   | The command prefix.                                                                             |
| `fix-token`                         | none           | GitHub App installation token for the fix modes.                                                |
| `clone-token`                       | none           | Read-only GitHub token for reviews of a private repository.                                     |
| `fix-timeout-minutes`               | `45`           | Time limit for one fix or triage attempt.                                                       |
| `ci-rerun`                          | `false`        | Re-run jobs that the triage finds flaky.                                                        |
| `max-auto-fix-rounds`               | `0`            | Only `0` is supported: each fix needs a person.                                                 |
| `incremental-review`                | `true`         | Continue the workspace of the last review of the same pull request.                             |

Outputs: `status`, `mode`, `agent-id`, `run-id`, `run-url`, `findings-count`, `attempts`, `pushed-commits`, `applied`, `skipped`, `triage` (JSON values where the type is a list).

## Failure handling

| Signal                                                             | Class     | Next step                                                 |
| ------------------------------------------------------------------ | --------- | --------------------------------------------------------- |
| HTTP 408, 429, 5xx, or a network error from the gateway            | temporary | Same agent                                                |
| "An internal error occurred" from a tool                           | temporary | Same agent                                                |
| HTTP 401, 403 or 404 from the gateway                              | fatal     | Stop all attempts (all agents use the same gateway token) |
| The gateway does not give the Remote Agents tools                  | fatal     | Stop all attempts                                         |
| Guardrails refuses the start, missing credentials, agent not found | permanent | Next agent                                                |
| Run failure with `retriable: true`                                 | temporary | Same agent                                                |
| Run failure with `retriable: false`                                | permanent | Next agent                                                |
| Run ended canceled, rejected, waiting for input or authentication  | permanent | Next agent                                                |
| Attempt time limit                                                 | permanent | Cancel the run, next agent                                |
| Result file missing, not written in this turn, or not valid        | permanent | Next agent                                                |
| A continued run still shows its previous turn after 3 minutes      | temporary | Same agent                                                |

The failure code stays visible when Guardrails withholds the status reason of a run. Older Archestra deployments do not send the `failure` field. Then the action classifies the failure from its message, and the log says so.

When the workspace of the last run is busy, a fix waits until it is free. When the workspace is no longer retained, or the run belongs to another person, the fix starts a fresh run on the same agent with all inputs again.

The `post` step cancels the live run when the job is canceled (for example by `cancel-in-progress`) or times out.

## Limits

- The message to the runtime is less than 8 KB. The diff (5 MB maximum), the pull request data, CI logs (200 KB tail for each job, 15 jobs maximum) and other inputs go as attachments (20 maximum). A continuation cannot take attachments, so the action writes the same files into the workspace (4 MiB each) and lists their paths in the message.
- 50 findings for each review. GitHub limits a comment to 65,536 characters; the action shortens long texts in the review comment.
- No fixes for pull requests from forks. No reviews of drafts, `[WIP]` titles, forks or pull requests opened by bots.
- Commits made by the runtime are not signed.
- The result files have JSON Schemas in [schemas/](schemas/).

## Development

```sh
npm ci
npm run lint        # Biome and TypeScript
npm test            # Vitest, with msw fakes of the Archestra MCP gateway and the GitHub API
npm run build       # bundles dist/ (committed)
npm run local-run   # runs all modes against fake servers and prints the payloads
npm run schemas     # writes schemas/ from src/contracts.ts
```

## License

Apache License 2.0. See [LICENSE](LICENSE).
