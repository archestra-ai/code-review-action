# Changelog

## 0.1.0 (not released)

- Review mode: start a one-shot review run on one of several Archestra agents with dedicated runtimes. Rotate, ordered or random selection. Retry temporary failures on the same runtime; go to the next runtime after a permanent failure; a finite number of attempts.
- Post the review: a sticky review comment with the verdict, the findings, the attempts and "Next" boxes, and inline comments with `suggestion` blocks for findings inside the diff.
- Fix mode: `/archestra fix`, `/archestra fix 2,5 <note>`, a reply under an inline finding, or the "Apply the findings" box. The runtime continues the review workspace and pushes commits authored by the person who asked. The action verifies the commits and resolves the threads of applied findings.
- CI triage mode: `/archestra fix-ci` or the "Triage and fix failing checks" box. The action collects the failing jobs, log tails and annotations; the runtime classifies each failure and fixes the ones that the pull request causes.
- Fix on the base branch: a box for each pre-existing failure opens a separate fix pull request.
- Post step: cancels the live run when the job is canceled or times out.
