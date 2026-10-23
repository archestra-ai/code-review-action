import { z } from "zod";
import type { AttemptRecord } from "../attempts";
import { ReviewFindingSchema, TriageClassSchema } from "../contracts";
import { fullName, isBotUser, type RepoRef, shortSha, truncate } from "../util";
import type { Octokit } from "./octokit";

// The sticky comment is the durable state between workflow runs: a visible
// summary for people, a hidden marker line for the action, and a hidden
// JSON state block that the action renders the comment from.

// ===== Marker =====

export interface StickyMarker {
  repo: string;
  pr: number;
  session: string | null;
  run: string | null;
  agent: string | null;
  sha: string | null;
}

const MARKER_PATTERN = /<!-- archestra-code-review (\S+?)#(\d+)((?: [a-z]+=\S*)*) -->/;
const MARKER_VALUE = /^[\w.-]{1,100}$/;

export function serializeMarker(marker: StickyMarker): string {
  const field = (value: string | null) => (value && MARKER_VALUE.test(value) ? value : "-");
  return `<!-- archestra-code-review ${marker.repo}#${marker.pr} session=${field(marker.session)} run=${field(marker.run)} agent=${field(marker.agent)} sha=${field(marker.sha)} -->`;
}

export function parseMarker(body: string): StickyMarker | null {
  const match = MARKER_PATTERN.exec(body);
  if (!match) return null;
  const fields = new Map<string, string>();
  for (const pair of (match[3] ?? "").trim().split(" ").filter(Boolean)) {
    const at = pair.indexOf("=");
    fields.set(pair.slice(0, at), pair.slice(at + 1));
  }
  const field = (name: string) => {
    const value = fields.get(name);
    return value && value !== "-" && MARKER_VALUE.test(value) ? value : null;
  };
  return {
    repo: match[1] as string,
    pr: Number(match[2]),
    session: field("session"),
    run: field("run"),
    agent: field("agent"),
    sha: field("sha"),
  };
}

export function markerPrefix(repo: RepoRef, pr: number): string {
  return `<!-- archestra-code-review ${fullName(repo)}#${pr} `;
}

// ===== Finding markers =====

export function findingMarker(id: string): string {
  return `<!-- archestra-finding:${id} -->`;
}

/**
 * Escapes `<` and a bare `&` in text the runtime wrote, so that no HTML and no hidden comment marker
 * reaches GitHub. Markdown code spans and fenced code blocks stay as written: GitHub shows their text
 * literally, entities included.
 */
export function escapeHtml(text: string): string {
  let out = "";
  let position = 0;
  for (const block of text.matchAll(FENCED_BLOCK)) {
    const fence = block[1] ?? block[2] ?? "";
    // GitHub shows an unclosed fence to the end of the text; close it so the rest of the comment still renders.
    const closed = new RegExp(`\\n {0,3}${fence}${fence[0]}*[ \\t]*$`).test(block[0]);
    out += escapeProse(text.slice(position, block.index)) + block[0] + (closed ? "" : `\n${fence}`);
    position = block.index + block[0].length;
  }
  return out + escapeProse(text.slice(position));
}

/**
 * A fenced code block at the left margin: the opening fence line, the content, and the closing fence
 * (at least as long, same character) or the end of the text. A backtick fence's info string has no backtick.
 */
const FENCED_BLOCK =
  /^(?:(`{3,})[^`\n]*\n[\s\S]*?(?:^ {0,3}\1`*[ \t]*$|$(?![\s\S]))|(~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\2~*[ \t]*$|$(?![\s\S])))/gm;

function escapeProse(text: string): string {
  return text.split("\n").map(escapeLine).join("\n");
}

/** Escapes one line of prose. A code span, a backtick run closed by a run of the same length, stays as written. */
function escapeLine(line: string): string {
  const runs = [...line.matchAll(/`+/g)].map((run) => ({ start: run.index, end: run.index + run[0].length }));
  let out = "";
  let position = 0;
  for (const open of runs) {
    if (open.start < position) continue;
    const length = open.end - open.start;
    const close = runs.find((run) => run.start >= open.end && run.end - run.start === length);
    if (close === undefined) continue;
    out += escapeText(line.slice(position, open.start)) + line.slice(open.start, close.end);
    position = close.end;
  }
  return out + escapeText(line.slice(position));
}

function escapeText(text: string): string {
  return text.replace(/&(?!(?:[a-z]+|#\d+|#x[0-9a-f]+);)/gi, "&amp;").replace(/</g, "&lt;");
}

export function findingIdFromBody(body: string): string | null {
  return /<!-- archestra-finding:([\w.-]{1,100}) -->/.exec(body)?.[1] ?? null;
}

// ===== State =====

const FindingStatusSchema = z.enum(["open", "applied", "skipped", "fixed"]);

const StoredFindingSchema = ReviewFindingSchema.extend({
  id: z.string(),
  n: z.number().int(),
  inline: z.boolean(),
  status: FindingStatusSchema,
  failure_scenario: z.string().max(4000),
  /** Comments written before recommendations existed have none; keep their findings. */
  recommendation: z.string().max(2000).default(""),
});
export type StoredFinding = z.infer<typeof StoredFindingSchema>;

const AttemptRecordSchema = z.object({
  agentId: z.string(),
  runId: z.string().nullable(),
  runUrl: z.string().nullable(),
  result: z.enum(["completed", "retriable", "non_retriable", "fatal"]),
  reason: z.string(),
  source: z.enum(["api", "failure-field", "message-pattern", "state", "timeout", "contract"]).nullable(),
  durationMs: z.number(),
});

const ProgressSchema = z.object({
  /** What the job does, in a few words: "reviewing", "applying 2 findings". */
  doing: z.string().max(200),
  /** The GitHub login the job acts for. */
  login: z.string(),
  startedAt: z.string(),
  workflowRunUrl: z.string(),
  /** The current step: "starting a run on agent 1 of 2", "waiting for the run". */
  step: z.string().max(300).nullable(),
  runUrl: z.string().nullable(),
});

const LastJobSchema = z.object({
  /** What the job did, in a few words: "reviewed", "applied 2 findings". */
  did: z.string().max(200),
  login: z.string(),
  durationMs: z.number(),
  workflowRunUrl: z.string(),
  /** "ok", "unavailable" or "error": picks the header's wording. */
  outcome: z.enum(["ok", "unavailable", "error"]),
});

const StateSchema = z.object({
  v: z.literal(1),
  status: z.enum(["reviewed", "unavailable"]),
  verdict: z.string().nullable(),
  summary: z.string(),
  reviewedSha: z.string().nullable(),
  baseBranch: z.string(),
  findings: z.array(StoredFindingSchema),
  attempts: z.array(AttemptRecordSchema),
  operation: z.string().nullable(),
  applied: z.array(
    z.object({
      finding: z.string().nullable(),
      check: z.string().nullable(),
      commit: z.string(),
      login: z.string(),
      runUrl: z.string().nullable(),
    }),
  ),
  skipped: z.array(z.object({ finding: z.string(), reason: z.string() })),
  triage: z.array(
    z.object({
      check: z.string(),
      class: TriageClassSchema,
      rootCause: z.string(),
      commits: z.array(z.string()),
    }),
  ),
  triageSha: z.string().nullable(),
  fixPrs: z.array(z.object({ checks: z.array(z.string()), number: z.number(), url: z.string() })),
  notice: z.string().nullable(),
  /** Failing check runs on the reviewed commit, counted at review time; drives the triage box. */
  failingChecks: z.number().int().nonnegative().default(0),
  /** The job in progress; null when no job runs. Rendered as the header. */
  progress: ProgressSchema.nullable().default(null),
  /** The last finished job: the header when nothing is in progress. */
  last: LastJobSchema.nullable().default(null),
});
export type StickyState = z.infer<typeof StateSchema>;
export type Progress = z.infer<typeof ProgressSchema>;
export type LastJob = z.infer<typeof LastJobSchema>;
export type AppliedEntry = StickyState["applied"][number];
export type TriageEntry = StickyState["triage"][number];

export function emptyState(baseBranch: string): StickyState {
  return {
    v: 1,
    status: "reviewed",
    verdict: null,
    summary: "",
    reviewedSha: null,
    baseBranch,
    findings: [],
    attempts: [],
    operation: null,
    applied: [],
    skipped: [],
    triage: [],
    triageSha: null,
    fixPrs: [],
    notice: null,
    failingChecks: 0,
    progress: null,
    last: null,
  };
}

const STATE_PATTERN = /<!-- archestra-state:([A-Za-z0-9_-]+) -->/;

export function parseState(body: string): StickyState | null {
  const match = STATE_PATTERN.exec(body);
  if (!match) return null;
  try {
    const json = JSON.parse(Buffer.from(match[1] as string, "base64url").toString("utf8"));
    const parsed = StateSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function encodeState(state: StickyState): string {
  return `<!-- archestra-state:${Buffer.from(JSON.stringify(state), "utf8").toString("base64url")} -->`;
}

// ===== Checkboxes =====

export type ActionId = "fix" | "fix-ci" | `fix-ci-main:${number}` | "fix-ci-main:all";

const ACTION_LINE = /^\s*[-*] \[([ xX])\] .*?<!-- archestra-action:([a-z0-9:-]{1,40}) -->\s*$/gm;

export function actionCheckboxes(body: string): Map<string, boolean> {
  const result = new Map<string, boolean>();
  for (const match of body.matchAll(ACTION_LINE)) {
    result.set(match[2] as string, (match[1] as string).toLowerCase() === "x");
  }
  return result;
}

/** Action ids that are ticked in `after` and were not ticked in `before`. */
export function newlyCheckedActions(before: string, after: string): string[] {
  const previous = actionCheckboxes(before);
  return [...actionCheckboxes(after)].filter(([id, checked]) => checked && previous.get(id) !== true).map(([id]) => id);
}

// ===== Rendering =====

export interface RenderContext {
  marker: StickyMarker;
  repoUrl: string;
  command: string;
}

const MAX_BODY_CHARS = 65_000;

export function renderSticky(state: StickyState, context: RenderContext): string {
  let fitted = state;
  for (let level = 0; level <= 3; level++) {
    const body = renderBody(fitted, context);
    if (body.length <= MAX_BODY_CHARS || level === 3) return body;
    fitted = shrink(state, level + 1);
  }
  return renderBody(fitted, context);
}

/** The spinner next to the in-progress header; the same picture GitHub bots use. */
const SPINNER =
  '<img src="https://github.com/user-attachments/assets/5ac382c7-e004-429b-8e35-7feb3e8f9c6f" width="14px" height="14px" style="vertical-align: middle; margin-left: 4px;" />';

/**
 * The first line: who the job acts for and where it is. A job in progress
 * shows a spinner and its current step; a finished job shows its duration.
 */
export function renderHeader(state: StickyState): string[] {
  const { progress, last } = state;
  if (progress) {
    const lines = [
      `**Archestra is ${oneLine(progress.doing, 200)} for @${progress.login}…** ${SPINNER} —— [View job](${progress.workflowRunUrl})`,
      "",
    ];
    const step = progress.step ? oneLine(progress.step, 300) : null;
    if (step || progress.runUrl) {
      lines.push(
        [step ? `- ${step}` : "- Working.", progress.runUrl ? `([run](${progress.runUrl}))` : ""].join(" ").trim(),
        "",
      );
    }
    return lines;
  }
  if (last) {
    const verb =
      last.outcome === "ok"
        ? `Archestra ${oneLine(last.did, 200)} for @${last.login}`
        : last.outcome === "unavailable"
          ? `Archestra could not finish ${oneLine(last.did, 200)} for @${last.login}`
          : `Archestra stopped ${oneLine(last.did, 200)} for @${last.login} with an error`;
    return [`**${verb} in ${formatDuration(last.durationMs)}** —— [View job](${last.workflowRunUrl})`, ""];
  }
  return [];
}

function renderBody(state: StickyState, context: RenderContext): string {
  const { command, repoUrl } = context;
  const out: string[] = [serializeMarker(context.marker), ...renderHeader(state), "### Archestra code review", ""];

  if (state.status === "unavailable") {
    out.push("**Review unavailable.** No runtime completed the review. The attempts are listed below.", "");
  } else if (state.verdict) {
    out.push(
      `**Verdict:** ${verdictLabel(state.verdict)} · reviewed \`${shortSha(state.reviewedSha)}\` · ${state.findings.length} finding${state.findings.length === 1 ? "" : "s"}`,
      "",
    );
  }
  if (state.notice) out.push(`> ${oneLine(state.notice, 1000)}`, "");
  // The summary keeps its Markdown; only HTML is disarmed.
  if (state.summary) out.push(escapeHtml(state.summary).trim(), "");

  if (state.findings.length > 0) {
    out.push(
      "#### Findings",
      "",
      "| # | Severity | Location | Finding | Recommendation | Status |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const finding of state.findings) {
      const location = `\`${cell(finding.file, 120).replace(/`/g, "'")}:${finding.line}\`${finding.inline ? "" : " (outside the diff)"}`;
      out.push(
        `| ${finding.n} | ${finding.severity} | ${location} | ${cell(finding.summary, 300)} | ${cell(finding.recommendation, 400)} | ${finding.status} |`,
      );
    }
    out.push("");
    const outside = state.findings.filter((finding) => !finding.inline && finding.status === "open");
    if (outside.length > 0) {
      out.push("<details><summary>Findings outside the diff</summary>", "");
      for (const finding of outside) {
        out.push(
          `**${finding.n}. ${oneLine(finding.summary, 300)}** (\`${oneLine(finding.file, 200).replace(/`/g, "'")}:${finding.line}\`)`,
          "",
          quote(finding.failure_scenario),
          "",
        );
      }
      out.push("</details>", "");
    }
  }

  const triageRows = state.triage;
  if (triageRows.length > 0) {
    out.push(
      `#### CI triage (\`${shortSha(state.triageSha)}\`)`,
      "",
      "| Check | Class | Root cause |",
      "| --- | --- | --- |",
    );
    for (const row of triageRows) {
      out.push(`| ${cell(row.check, 120)} | ${row.class} | ${cell(row.rootCause, 400)} |`);
    }
    out.push("");
  }

  // "Next": one-click follow-ups. The boxes are always rendered unticked.
  const next: string[] = [];
  if (state.findings.some((finding) => finding.status === "open" || finding.status === "skipped")) {
    next.push("- [ ] Implement and push recommendations <!-- archestra-action:fix -->");
  }
  // Only when the reviewed commit has failing checks; otherwise the box is noise.
  if (state.failingChecks > 0) {
    next.push(
      `- [ ] Triage and fix ${state.failingChecks} failing check${state.failingChecks === 1 ? "" : "s"} <!-- archestra-action:fix-ci -->`,
    );
  }
  const openPreExisting = state.triage
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.class === "pre_existing" && !state.fixPrs.some((pr) => pr.checks.includes(row.check)));
  for (const { row, index } of openPreExisting) {
    next.push(
      `- [ ] Open a fix PR against ${state.baseBranch} for \`${oneLine(row.check, 120).replace(/`/g, "'")}\` <!-- archestra-action:fix-ci-main:${index} -->`,
    );
  }
  if (openPreExisting.length > 1) {
    next.push(
      `- [ ] Open one fix PR against ${state.baseBranch} for all pre-existing failures <!-- archestra-action:fix-ci-main:all -->`,
    );
  }
  if (next.length > 0) {
    const commands = [
      `\`${command} fix\` (all recommendations)`,
      `\`${command} fix 2,5 <note>\` (selected ones)`,
      ...(state.failingChecks > 0 ? [`\`${command} fix-ci\` (failing checks)`] : []),
    ];
    out.push(
      "#### Next",
      "",
      ...next,
      "",
      `Or comment ${commands.join(", ")}. Reply \`${command} fix\` under an inline finding to implement only that one. Only users with write access can start a fix.`,
      "",
    );
  }

  if (state.fixPrs.length > 0) {
    out.push("#### Fix pull requests", "");
    for (const pr of state.fixPrs) {
      out.push(
        `- [#${pr.number}](${pr.url}) for ${pr.checks.map((check) => `\`${oneLine(check, 120).replace(/`/g, "'")}\``).join(", ")}. Queue the fix PR first, then rebase this pull request.`,
      );
    }
    out.push("");
  }

  if (state.applied.length > 0) {
    out.push("#### Applied", "");
    for (const entry of state.applied) {
      const what = entry.finding
        ? `finding ${findingNumber(state, entry.finding)}`
        : `check \`${oneLine(entry.check ?? "", 120).replace(/`/g, "'")}\``;
      out.push(
        `- [\`${shortSha(entry.commit)}\`](${repoUrl}/commit/${entry.commit}) ${what}: pushed by the review runtime on behalf of @${entry.login}${entry.runUrl ? ` ([run](${entry.runUrl}))` : ""}`,
      );
    }
    out.push("");
  }

  if (state.skipped.length > 0) {
    out.push("<details><summary>Skipped by the last fix</summary>", "");
    for (const entry of state.skipped) {
      out.push(`- finding ${findingNumber(state, entry.finding)}: ${oneLine(entry.reason, 500)}`);
    }
    out.push("", "</details>", "");
  }

  if (state.attempts.length > 0) {
    out.push(
      `<details><summary>Attempts${state.operation ? ` (${state.operation})` : ""}: ${state.attempts.length}</summary>`,
      "",
      attemptsTable(state.attempts),
      "",
      "</details>",
      "",
    );
  }
  out.push(encodeState(state));
  return out.join("\n");
}

export function attemptsTable(attempts: AttemptRecord[]): string {
  const rows = attempts.map(
    (attempt, index) =>
      `| ${index + 1} | \`${attempt.agentId.slice(0, 8)}\` | ${attempt.runUrl ? `[run](${attempt.runUrl})` : "-"} | ${attempt.result}${attempt.source ? ` (${attempt.source})` : ""}: ${cell(attempt.reason, 300)} | ${formatDuration(attempt.durationMs)} |`,
  );
  return ["| # | Agent | Run | Result | Duration |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
}

function findingNumber(state: StickyState, id: string): string {
  const finding = state.findings.find((candidate) => candidate.id === id);
  return finding ? String(finding.n) : `\`${id.replace(/`/g, "")}\``;
}

function shrink(state: StickyState, level: number): StickyState {
  const limit = level === 1 ? 1000 : level === 2 ? 300 : 80;
  return {
    ...state,
    summary: truncate(state.summary, level === 1 ? 4000 : 1000),
    findings: state.findings.map((finding) => {
      const { suggestion: _drop, ...rest } = finding;
      return {
        ...rest,
        failure_scenario: truncate(finding.failure_scenario, limit),
        recommendation: truncate(finding.recommendation, Math.max(limit, 120)),
        summary: truncate(finding.summary, Math.max(limit, 120)),
      };
    }),
    attempts: state.attempts.slice(-10),
    applied: state.applied.slice(-50),
    skipped: state.skipped.slice(-20),
  };
}

function verdictLabel(verdict: string): string {
  return { approve: "approve", comment: "comment", request_changes: "changes requested" }[verdict] ?? verdict;
}

function cell(text: string, max: number): string {
  return oneLine(text, max).replace(/\|/g, "\\|");
}

function oneLine(text: string, max: number): string {
  return escapeHtml(truncate(text.replace(/\s+/g, " ").trim(), max));
}

function quote(text: string): string {
  return escapeHtml(truncate(text, 2000))
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

// ===== GitHub =====

export interface StickyComment {
  id: number;
  body: string;
  marker: StickyMarker;
  state: StickyState | null;
}

/** Finds the sticky comment of this pull request (a bot comment with the marker). */
export async function findSticky(gh: Octokit, repo: RepoRef, pr: number): Promise<StickyComment | null> {
  const prefix = markerPrefix(repo, pr);
  for await (const page of gh.paginate.iterator(gh.rest.issues.listComments, {
    ...repo,
    issue_number: pr,
    per_page: 100,
  })) {
    for (const comment of page.data) {
      const body = comment.body ?? "";
      if (!body.includes(prefix)) continue;
      if (comment.user && !isBotUser(comment.user)) continue;
      const marker = parseMarker(body);
      if (!marker) continue;
      return { id: comment.id, body, marker, state: parseState(body) };
    }
  }
  return null;
}

export async function writeSticky(
  gh: Octokit,
  repo: RepoRef,
  pr: number,
  existingId: number | null,
  body: string,
): Promise<number> {
  if (existingId !== null) {
    await gh.rest.issues.updateComment({ ...repo, comment_id: existingId, body });
    return existingId;
  }
  const { data } = await gh.rest.issues.createComment({ ...repo, issue_number: pr, body });
  return data.id;
}
