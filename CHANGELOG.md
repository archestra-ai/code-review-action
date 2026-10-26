# Changelog

## 0.3.1 (2026-10-26)

- The in-progress header shows an animated Archestra mark (the logo in a badge with a turning arc, `assets/progress.gif`, served from this repository at the revision the workflow pins) instead of the organisation avatar, a black mark on a transparent background that GitHub's dark theme did not show. Seen on archestra-ai/archestra#9660.

## 0.3.0 (2026-10-24)

- Change map: `review.json` can list the places a rule of the change reached (`changes`: file, line, what changed), and the comment shows them as a table after the summary, so a reader sees at once that a rule applied in several places reached all of them.
- The in-progress header shows the Archestra logo instead of the Claude spinner that claude-code-action uses: the action does not know which model an agent runs, so it shows no provider's logo.
- The brief asks for a shorter review: checks within about five minutes (the dependency installation starts in the background before the reading; then the type check of the changed packages, the linter on the changed files, and the test files of the diff, no longer the test suites of whole packages), `reviewed` entries of one line with at most three files, up to eight one-sentence observations, test focus of at most 80 characters with the concrete values the test pins, limitations as a list with commands by their essentials, and small inconsistencies (order, names, dates, copy) as `nit` findings. The comment caps the lines of those lists.

## 0.2.2 (2026-10-24)

- When the token may not resolve a review thread (GitHub does not let a workflow's installation token do it), the action replies under the thread instead: "Fixed in `<sha>`" after a re-review, "Applied in `<sha>`" after a fix. Before, the first failure stopped every thread update with one warning. Seen on the first review of archestra-ai/archestra#9568.

## 0.2.1 (2026-10-24)

- A review no longer fails the contract when a `reviewed` entry, an observation, a test focus or a closing section is longer than the brief asks for: the limits in `review.json` only stop pathological output, and the comment shortens long texts. The first live review on a large repository lost an attempt to a 201-character `reviewed` entry.

## 0.2.0 (2026-10-23)

- The review comment reads like a reviewer's write-up. New parts, in reading order: the title of the pull request in the heading; **Reviewed**, the areas and files the review covered; an assessment of the change before the diagrams; a section for each finding with its location, severity, a link to its inline comment, the code at its lines quoted from the diff, the problem, the reasoning and the recommendation; **Observations**, what the change does right and what needs no change; **Test coverage**, a table of the test files in the diff with their line counts and what they cover; **Limitations**; and **Verdict**, the closing paragraph with the most actionable finding. The findings table keeps the number, severity, location and status, and shows the title of each finding.
- `review.json` has new optional fields: `reviewed`, `observations`, `tests`, `coverage`, `limitations`, `conclusion`, and `title` for each finding. The brief asks the runtime for them, and for targeted checks of the changed code (about ten minutes at most) instead of a whole test suite.
- Inline comments start with the title of the finding, and the sentence that states the problem follows.
- The default `timeout-minutes` is 30 (was 20): a review attempt now includes up to ten minutes of checks.
- New input `fix-commands`: `false` when no workflow listens to the comment commands. The review comment and the inline comments then show no commands.
- The sections of the review comment are `###` headings; a finding is a `####` heading. Locations show the line range of a finding.

## 0.1.0 (2026-10-23)

- Review mode: start a one-shot review run on one of several Archestra agents with dedicated runtimes. Rotate, ordered or random selection. Retry temporary failures on the same runtime; go to the next runtime after a permanent failure; a finite number of attempts.
- Text the runtime wrote (summaries, findings, recommendations, reasons) is HTML-escaped in the comment instead of having comment markers stripped, so no `archestra-finding` or state marker can be smuggled in through a crafted diff. Comments written before the recommendation field existed still parse. Long recommendations are budgeted when a comment is shrunk to GitHub's size limit.
- Each inline comment ends with how to have its fix implemented: reply `/archestra fix` to the comment, or comment `/archestra fix` on the pull request for all findings.
- Each finding carries a recommendation: what to change, in one or two sentences. It is a column of the findings table, a line of the inline comment, and what the fix mode implements.
- Progress in the review comment: the comment is posted when the job starts, with a header that names the person the job acts for, the current step (preparing inputs, starting a run on agent n of m, waiting for the runtime, retrying, moving to the next agent) with a link to the run, and a spinner. The final write turns it into a finished header with the duration. The same comment is used by every later job.
- Post the review: a sticky review comment with the verdict, the findings, the job history and the "Next" commands, and inline comments with `suggestion` blocks for findings inside the diff.
- Fix mode: `/archestra fix`, `/archestra fix 2,5 <note>`, or a reply under an inline finding. The runtime continues the review workspace and pushes commits authored by the person who asked. The action verifies the commits and resolves the threads of applied findings.
- CI triage mode: `/archestra fix-ci`, offered in the review comment only when the reviewed commit has failing checks. The action collects the failing jobs, log tails and annotations; the runtime classifies each failure and fixes the ones that the pull request causes.
- Fix on the base branch: `/archestra fix-ci-main n` opens a separate fix pull request for row `n` of the CI triage table; `/archestra fix-ci-main` opens one for all pre-existing failures.
- The review comment keeps a history of every job on the pull request (the last 20): start time, job with a link to the workflow run, agent, run (marked continued), result and duration.
- A re-review keeps the findings it reported before (`previous_id` in `review.json`, or the same file and summary): their inline comments are rewritten in place, and only new findings get new inline comments.
- In the findings table, the number links to the finding's inline comment and the location to the diff at those lines (to the file at the reviewed commit for a finding outside the diff).
- The review text opens with what the change does, a plain ASCII architecture diagram and sequence diagrams of the main affected flows.
- Post step: cancels the live run when the job is canceled or times out.
- Transport: the action is a client of an Archestra MCP gateway and calls the Remote Agents tools (`start_agent_run`, `get_agent_run`, `steer_agent_run`, `cancel_agent_run`, `read_workspace_file`, `write_workspace_file`, `transfer_credential`), directly or through `run_tool`. Inputs `archestra-gateway-url` and `archestra-token` replace `archestra-url` and `archestra-api-key`; service accounts are no longer used.
- Identity: each run acts as the person who caused the event, with that person's platform token. The reusable workflow `resolve-actor-token.yml` gives the name of the person's token secret; the example workflows pass only that secret to a reusable job workflow, so no job gets the whole secrets context. Optional `fallback-token` and `fallback-agents` for people without a token. Optional `clone-token`: a read-only token that review mode stores as the actor's `GITHUB_TOKEN` for private repositories.
- The example job workflow checks the actor's token first and skips the review with a notice when there is none, like the Claude review workflow, instead of failing the job.
- Continuations write their input files into the workspace and list them in the message. A sentinel in the result file stops a turn from returning the result of the turn before it.
