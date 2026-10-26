# Changelog

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
