import { createHash } from "node:crypto";
import { z } from "zod";
import type { AttemptRecord } from "../attempts";
import { ReviewFindingSchema, TriageClassSchema } from "../contracts";
import { DEFAULT_PROGRESS_IMAGE_URL } from "../env";
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
  const match = MARKER_PATTERN.exec(stripCode(body));
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
export function escapeHtml(text: string, options: { fences?: boolean } = {}): string {
  return mapCode(text, escapeText, (code) => code, { fences: options.fences ?? true, closeFences: true });
}

/**
 * Replaces code spans and fenced blocks with a space. The action reads its markers from the
 * result: the runtime's text is escaped everywhere else, so no marker it wrote can pass as ours.
 */
export function stripCode(text: string): string {
  return mapCode(
    text,
    (prose) => prose,
    () => " ",
    { fences: true, closeFences: false },
  );
}

type Mapper = (segment: string) => string;

/**
 * The escaper runs on each field and the reader on the whole comment, so a field must keep its
 * code the same after the renderer places it: a field placed alone at the left margin keeps its
 * fences (`fences: true`); a field that gets a prefix or shares a line with other fields has no
 * fences (`fences: false`) and, in a table cell, no stray backtick (`balanceBackticks`).
 */
function mapCode(
  text: string,
  prose: Mapper,
  code: Mapper,
  options: { fences: boolean; closeFences: boolean },
): string {
  if (!options.fences) return mapProse(text, prose, code);
  let out = "";
  let position = 0;
  for (const block of text.matchAll(FENCED_BLOCK)) {
    const fence = block[1] ?? block[2] ?? "";
    // GitHub shows an unclosed fence to the end of the text; close it so the rest of the comment still renders.
    const closed = new RegExp(`\\n {0,3}${fence}${fence[0]}*[ \\t]*$`).test(block[0]);
    out += mapProse(text.slice(position, block.index), prose, code) + code(block[0]);
    if (options.closeFences && !closed) out += `\n${fence}`;
    position = block.index + block[0].length;
  }
  return out + mapProse(text.slice(position), prose, code);
}

/**
 * A fenced code block indented by at most three spaces: the opening fence line, the content, and the closing fence
 * (at least as long, same character) or the end of the text. A backtick fence's info string has no backtick. An
 * opening fence that ends the text is a block too: the renderer puts more lines after each field, so the reader
 * would see a fence where the escaper saw prose; the escaper closes it instead.
 */
const FENCED_BLOCK =
  /^ {0,3}(?:(`{3,})[^`\n]*(?:\n|$(?![\s\S]))[\s\S]*?(?:^ {0,3}\1`*[ \t]*$|$(?![\s\S]))|(~{3,})[^\n]*(?:\n|$(?![\s\S]))[\s\S]*?(?:^ {0,3}\2~*[ \t]*$|$(?![\s\S])))/gm;

/** A fence longer than any backtick run in the text, so that the text cannot close the block. */
export function fenceFor(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  return "`".repeat(longest + 1);
}

function mapProse(text: string, prose: Mapper, code: Mapper): string {
  return text
    .split("\n")
    .map((line) => mapLine(line, prose, code))
    .join("\n");
}

type Run = { start: number; end: number };

function backtickRuns(line: string): Run[] {
  return [...line.matchAll(/`+/g)].map((run) => ({ start: run.index, end: run.index + run[0].length }));
}

/** The code spans of one line: a backtick run closed by the next run of the same length. */
function codeSpans(line: string): Array<[Run, Run]> {
  const runs = backtickRuns(line);
  const spans: Array<[Run, Run]> = [];
  let position = 0;
  for (const open of runs) {
    if (open.start < position) continue;
    const length = open.end - open.start;
    const close = runs.find((run) => run.start >= open.end && run.end - run.start === length);
    if (close === undefined) continue;
    spans.push([open, close]);
    position = close.end;
  }
  return spans;
}

function mapLine(line: string, prose: Mapper, code: Mapper): string {
  let out = "";
  let position = 0;
  for (const [open, close] of codeSpans(line)) {
    out += prose(line.slice(position, open.start)) + code(line.slice(open.start, close.end));
    position = close.end;
  }
  return out + prose(line.slice(position));
}

/**
 * Replaces each backtick run outside a code span with apostrophes. A cell with no stray backtick
 * keeps its spans when the row joins it with other cells.
 */
export function balanceBackticks(line: string): string {
  const spans = codeSpans(line);
  let out = "";
  let position = 0;
  for (const run of backtickRuns(line)) {
    if (spans.some(([open, close]) => run.start >= open.start && run.end <= close.end)) continue;
    out += line.slice(position, run.start) + "'".repeat(run.end - run.start);
    position = run.end;
  }
  return out + line.slice(position);
}

function escapeText(text: string): string {
  return text.replace(/&(?!(?:[a-z]+|#\d+|#x[0-9a-f]+);)/gi, "&amp;").replace(/</g, "&lt;");
}

export function findingIdFromBody(body: string): string | null {
  return [...stripCode(body).matchAll(/<!-- archestra-finding:([\w.-]{1,100}) -->/g)].at(-1)?.[1] ?? null;
}

// ===== State =====

const FindingStatusSchema = z.enum(["open", "applied", "skipped", "fixed"]);

const StoredFindingSchema = ReviewFindingSchema.extend({
  id: z.string(),
  n: z.number().int(),
  /** True when the lines of the finding are in the diff of the pull request. */
  inline: z.boolean(),
  status: FindingStatusSchema,
  failure_scenario: z.string().max(4000),
  /** Comments written before recommendations existed have none; keep their findings. */
  recommendation: z.string().max(2000).default(""),
  /** The inline review comment of the finding; null when it has none (outside the diff, or rejected). */
  commentId: z.number().int().nullable().default(null),
  /** The head-side lines of the finding, from the diff; null when they are not in it. */
  excerpt: z.string().max(2000).nullable().default(null),
});
export type StoredFinding = z.infer<typeof StoredFindingSchema>;

const AttemptRecordSchema = z.object({
  agentId: z.string(),
  runId: z.string().nullable(),
  runUrl: z.string().nullable(),
  /** True when the attempt continued the run of an earlier job. Records written before this field have false. */
  continued: z.boolean().default(false),
  result: z.enum(["completed", "retriable", "non_retriable", "fatal"]),
  reason: z.string(),
  source: z.enum(["api", "failure-field", "message-pattern", "state", "timeout", "contract"]).nullable(),
  durationMs: z.number(),
});

/** One job of the action on the pull request: a workflow run and its attempts. */
const JobRecordSchema = z.object({
  /** What the job did: "review of 1234567", "fix", "CI triage". */
  label: z.string().max(200),
  /** ISO time; null for a job recorded before this field existed. */
  startedAt: z.string().nullable(),
  workflowRunUrl: z.string().nullable(),
  /** The result in a few words ("changes requested, 5 findings"); null when the job did not complete. */
  outcome: z.string().max(200).nullable(),
  attempts: z.array(AttemptRecordSchema),
});
export type JobRecord = z.infer<typeof JobRecordSchema>;

/** The comment keeps this many jobs; the oldest are dropped. */
export const MAX_JOBS = 20;

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
  /** ISO time of the start; null in comments written before this field existed. */
  startedAt: z.string().nullable().default(null),
  workflowRunUrl: z.string(),
  /** "ok", "unavailable" or "error": picks the header's wording. */
  outcome: z.enum(["ok", "unavailable", "error"]),
});

/** One row of the change map: a place the change reached. */
const ChangeSchema = z.object({
  file: z.string(),
  line: z.number().int().nullable(),
  what: z.string(),
  /** Where the row links: the line in the diff, the file in the diff, or nowhere. */
  link: z.enum(["line", "file", "none"]).default("none"),
});
export type ChangeEntry = z.infer<typeof ChangeSchema>;

const TestFileSchema = z.object({
  file: z.string(),
  /** Lines added and deleted in the pull request; null when the file is not in the diff. */
  additions: z.number().int().nullable(),
  deletions: z.number().int().nullable(),
  focus: z.string(),
});
export type TestFile = z.infer<typeof TestFileSchema>;

const StateSchema = z.object({
  v: z.literal(1),
  status: z.enum(["reviewed", "unavailable"]),
  verdict: z.string().nullable(),
  /** The title of the pull request at review time; null before the first review. */
  title: z.string().nullable().default(null),
  summary: z.string(),
  /** What the review covered, in order. */
  reviewed: z.array(z.string()).default([]),
  /** The places the change reached, for the change map; empty when the runtime wrote none. */
  changes: z.array(ChangeSchema).default([]),
  /** What the change does right, and facts that need no change. */
  observations: z.array(z.string()).default([]),
  tests: z.array(TestFileSchema).default([]),
  coverage: z.string().default(""),
  limitations: z.string().default(""),
  /** The closing judgement; rendered as the Verdict section. */
  conclusion: z.string().default(""),
  reviewedSha: z.string().nullable(),
  baseBranch: z.string(),
  findings: z.array(StoredFindingSchema),
  /** Every job of the action on this pull request, oldest first; at most MAX_JOBS. */
  jobs: z.array(JobRecordSchema).default([]),
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
  /** Failing check runs on the reviewed commit, counted at review time; drives the triage command. */
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
    title: null,
    summary: "",
    reviewed: [],
    changes: [],
    observations: [],
    tests: [],
    coverage: "",
    limitations: "",
    conclusion: "",
    reviewedSha: null,
    baseBranch,
    findings: [],
    jobs: [],
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

const STATE_PATTERN = /<!-- archestra-state:([A-Za-z0-9_-]+) -->/g;

export function parseState(body: string): StickyState | null {
  // The state line is the last line of the comment; a marker before it is not ours.
  const match = [...stripCode(body).matchAll(STATE_PATTERN)].at(-1);
  if (!match) return null;
  try {
    const json = JSON.parse(Buffer.from(match[1] as string, "base64url").toString("utf8"));
    const parsed = StateSchema.safeParse(json);
    return parsed.success ? withLegacyAttempts(parsed.data, json) : null;
  } catch {
    return null;
  }
}

/** Comments written before the job history held the attempts of the last job only. */
const LegacyAttemptsSchema = z.object({
  attempts: z.array(AttemptRecordSchema).default([]),
  operation: z.string().nullable().default(null),
});

/** Turns the attempts of a comment written before the job history into its one job. */
function withLegacyAttempts(state: StickyState, json: unknown): StickyState {
  if (state.jobs.length > 0) return state;
  const legacy = LegacyAttemptsSchema.safeParse(json);
  if (!legacy.success || legacy.data.attempts.length === 0) return state;
  const job: JobRecord = {
    label: legacy.data.operation ?? "earlier job",
    startedAt: null,
    workflowRunUrl: state.last?.workflowRunUrl ?? null,
    outcome: null,
    attempts: legacy.data.attempts,
  };
  return { ...state, jobs: [job] };
}

/** Appends a job to the history; the oldest jobs beyond MAX_JOBS are dropped. Texts are bounded so the state parses. */
export function addJob(state: StickyState, job: JobRecord): void {
  const bounded = {
    ...job,
    label: truncate(job.label, 200),
    outcome: job.outcome === null ? null : truncate(job.outcome, 200),
  };
  state.jobs = [...state.jobs, bounded].slice(-MAX_JOBS);
}

function encodeState(state: StickyState): string {
  return `<!-- archestra-state:${Buffer.from(JSON.stringify(state), "utf8").toString("base64url")} -->`;
}

// ===== Rendering =====

export interface RenderContext {
  marker: StickyMarker;
  repoUrl: string;
  /** The command prefix; null when no workflow listens to the commands, so the comment shows none. */
  command: string | null;
  /** The animated mark of the progress header; the published action's main-branch image when absent. */
  progressImageUrl?: string;
}

const MAX_BODY_CHARS = 65_000;

type Lines = Pick<StoredFinding, "file" | "line" | "end_line">;

/** The "Files changed" view of the pull request at a file. GitHub anchors a file by the SHA-256 of its path. */
export function fileUrl(repoUrl: string, pr: number, file: string): string {
  return `${repoUrl}/pull/${pr}/files#diff-${createHash("sha256").update(file).digest("hex")}`;
}

/** The "Files changed" view of the pull request at the lines of the finding. */
export function diffUrl(repoUrl: string, pr: number, finding: Lines): string {
  const end = finding.end_line ?? finding.line;
  return `${fileUrl(repoUrl, pr, finding.file)}R${finding.line}${end > finding.line ? `-R${end}` : ""}`;
}

/** The file at the reviewed commit, at the lines of the finding. */
export function blobUrl(repoUrl: string, sha: string, finding: Lines): string {
  const path = finding.file
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/[()]/g, (char) => (char === "(" ? "%28" : "%29")))
    .join("/");
  const end = finding.end_line ?? finding.line;
  return `${repoUrl}/blob/${sha}/${path}#L${finding.line}${end > finding.line ? `-L${end}` : ""}`;
}

/** The inline review comment in the conversation of the pull request. */
export function commentUrl(repoUrl: string, pr: number, commentId: number): string {
  return `${repoUrl}/pull/${pr}#discussion_r${commentId}`;
}

/**
 * `file:line` or `file:line-end`, linked to the diff when the finding is in it, else to the file
 * at the reviewed commit. A table cell escapes its pipes; text outside a table must not.
 */
function locationLink(state: StickyState, context: RenderContext, finding: StoredFinding, table: boolean): string {
  const path = table ? pathCell(finding.file) : oneLine(finding.file, 200).replace(/[`[\]]/g, "'");
  const end = finding.end_line ?? finding.line;
  const text = `\`${path}:${finding.line}${end > finding.line ? `-${end}` : ""}\``;
  const url = finding.inline
    ? diffUrl(context.repoUrl, context.marker.pr, finding)
    : state.reviewedSha
      ? blobUrl(context.repoUrl, state.reviewedSha, finding)
      : null;
  return url ? `[${text}](${url})` : text;
}

export function renderSticky(state: StickyState, context: RenderContext): string {
  let fitted = state;
  for (let level = 0; level <= 3; level++) {
    const body = renderBody(fitted, context);
    if (body.length <= MAX_BODY_CHARS || level === 3) return body;
    fitted = shrink(state, level + 1);
  }
  return renderBody(fitted, context);
}

/**
 * The picture next to the in-progress header: the Archestra mark in a badge with a turning arc, an
 * animated GIF (`assets/progress.gif`) served from the published action at the revision the workflow
 * pins, visible on both GitHub themes. The action does not know which model an agent runs (agent ids
 * are opaque, and the run reports only its state), so it shows no provider's logo.
 */
function progressImage(context?: Pick<RenderContext, "progressImageUrl">): string {
  const url = escapeAttribute(context?.progressImageUrl ?? DEFAULT_PROGRESS_IMAGE_URL);
  return `<img src="${url}" width="14" height="14" alt="Archestra is working" />`;
}

/** Escapes a value for a double-quoted HTML attribute. */
function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The first line: who the job acts for and where it is. A job in progress
 * shows the animated Archestra mark and its current step; a finished job shows its duration.
 */
export function renderHeader(state: StickyState, context?: Pick<RenderContext, "progressImageUrl">): string[] {
  const { progress, last } = state;
  if (progress) {
    const lines = [
      `**Archestra is ${oneLine(progress.doing, 200)} for @${progress.login}…** ${progressImage(context)} —— [View job](${progress.workflowRunUrl})`,
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
  const pr = context.marker.pr;
  const heading = state.title
    ? `### Archestra code review: #${pr} — ${oneLine(state.title, 200)}`
    : "### Archestra code review";
  const out: string[] = [serializeMarker(context.marker), ...renderHeader(state, context), heading, ""];

  if (state.status === "unavailable") {
    out.push("**Review unavailable.** No runtime completed the review. The attempts are listed below.", "");
  } else if (state.verdict) {
    out.push(
      `**${verdictLabel(state.verdict)}** · reviewed \`${shortSha(state.reviewedSha)}\` · ${state.findings.length} finding${state.findings.length === 1 ? "" : "s"}`,
      "",
    );
  }
  if (state.notice) out.push(`> ${oneLine(state.notice, 1000)}`, "");
  // What the review covered, so that a reader can check that the parts that matter were read.
  if (state.reviewed.length > 0) {
    out.push("**Reviewed**", "", ...state.reviewed.map((item) => `- ${oneLine(item, 200)}`), "");
  }
  // The summary keeps its Markdown; only HTML is disarmed.
  if (state.summary) out.push(paragraphs(state.summary), "");

  // The change map: every place a rule of the change reached, so a reader sees it reached all of them.
  if (state.changes.length > 0) {
    out.push("### Change map", "", "| File | What changed |", "| --- | --- |");
    for (const change of state.changes) {
      const text = `\`${pathCell(change.file)}${change.line === null ? "" : `:${change.line}`}\``;
      const url =
        change.link === "line" && change.line !== null
          ? diffUrl(repoUrl, pr, { file: change.file, line: change.line })
          : change.link === "file"
            ? fileUrl(repoUrl, pr, change.file)
            : null;
      const file = url ? `[${text}](${url})` : text;
      out.push(`| ${file} | ${cell(change.what, 160)} |`);
    }
    out.push("");
  }

  if (state.findings.length > 0) {
    out.push("### Findings", "", "| # | Severity | Location | Finding | Status |", "| --- | --- | --- | --- | --- |");
    for (const finding of state.findings) {
      // The number opens the inline comment; the location opens the diff.
      const number =
        finding.commentId === null
          ? String(finding.n)
          : `[${finding.n}](${commentUrl(repoUrl, pr, finding.commentId)})`;
      const location = `${locationLink(state, context, finding, true)}${finding.inline ? "" : " (outside the diff)"}`;
      out.push(
        `| ${number} | ${finding.severity} | ${location} | ${cell(findingTitle(finding), HEADING_MAX)} | ${finding.status} |`,
      );
    }
    out.push("");
    for (const finding of state.findings) out.push(...findingSection(state, context, finding));
  }

  if (state.observations.length > 0) {
    out.push("### Observations", "", ...state.observations.map((item) => `- ${oneLine(item, 600)}`), "");
  }

  if (state.tests.length > 0 || state.coverage) {
    out.push("### Test coverage", "");
    if (state.tests.length > 0) {
      out.push("| File | Lines | Focus |", "| --- | --- | --- |");
      for (const test of state.tests) {
        const path = `\`${pathCell(test.file)}\``;
        // A file in the diff links to it; its line counts come from the pull request.
        const file = test.additions === null ? path : `[${path}](${fileUrl(repoUrl, pr, test.file)})`;
        const lines = test.additions === null ? "-" : `+${test.additions} −${test.deletions ?? 0}`;
        out.push(`| ${file} | ${lines} | ${cell(test.focus, 160)} |`);
      }
      out.push("");
    }
    if (state.coverage) out.push(paragraphs(state.coverage), "");
  }

  if (state.limitations) out.push("### Limitations", "", paragraphs(state.limitations), "");
  if (state.conclusion) out.push("### Verdict", "", paragraphs(state.conclusion), "");

  const triageRows = state.triage;
  if (triageRows.length > 0) {
    out.push(
      `### CI triage (\`${shortSha(state.triageSha)}\`)`,
      "",
      "| # | Check | Class | Root cause |",
      "| --- | --- | --- | --- |",
    );
    // The number is the `n` of the fix-ci-main command.
    for (const [index, row] of triageRows.entries()) {
      out.push(`| ${index + 1} | ${cell(row.check, 120)} | ${row.class} | ${cell(row.rootCause, 400)} |`);
    }
    out.push("");
  }

  // "Next": the commands a maintainer can write, only the ones that apply now,
  // and only when a workflow listens to them.
  const next: string[] = [];
  if (command !== null) {
    if (state.findings.some((finding) => finding.status === "open" || finding.status === "skipped")) {
      next.push(
        `- Comment \`${command} fix\` to implement and push every open recommendation, or \`${command} fix 2,5 <note>\` for selected findings. Reply \`${command} fix\` under an inline finding to implement only that one.`,
      );
    }
    // Only when the reviewed commit has failing checks; otherwise the line is noise.
    if (state.failingChecks > 0) {
      next.push(
        `- Comment \`${command} fix-ci\` to triage and fix the ${state.failingChecks} failing check${state.failingChecks === 1 ? "" : "s"}.`,
      );
    }
    const openPreExisting = state.triage
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.class === "pre_existing" && !state.fixPrs.some((pr) => pr.checks.includes(row.check)));
    for (const { row, index } of openPreExisting) {
      next.push(
        `- Comment \`${command} fix-ci-main ${index + 1}\` to open a fix PR against ${state.baseBranch} for \`${oneLine(row.check, 120).replace(/`/g, "'")}\`.`,
      );
    }
    if (openPreExisting.length > 1) {
      next.push(
        `- Comment \`${command} fix-ci-main\` to open one fix PR against ${state.baseBranch} for all pre-existing failures.`,
      );
    }
  }
  if (next.length > 0) {
    out.push("### Next", "", ...next, "", "Only users with write access can start a fix.", "");
  }

  if (state.fixPrs.length > 0) {
    out.push("### Fix pull requests", "");
    for (const pr of state.fixPrs) {
      out.push(
        `- [#${pr.number}](${pr.url}) for ${pr.checks.map((check) => `\`${oneLine(check, 120).replace(/`/g, "'")}\``).join(", ")}. Queue the fix PR first, then rebase this pull request.`,
      );
    }
    out.push("");
  }

  if (state.applied.length > 0) {
    out.push("### Applied", "");
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

  if (state.jobs.length > 0) {
    const attempts = state.jobs.reduce((count, job) => count + job.attempts.length, 0);
    const jobs = `${state.jobs.length} job${state.jobs.length === 1 ? "" : "s"}`;
    out.push(
      `<details><summary>History: ${jobs}${attempts > state.jobs.length ? ` (${attempts} attempts)` : ""}</summary>`,
      "",
      historyTable(state.jobs),
      "",
      "</details>",
      "",
    );
  }
  out.push(encodeState(state));
  return out.join("\n");
}

/** The heading of a finding: its title, or its one-sentence summary for findings written without one. */
export function findingTitle(finding: Pick<StoredFinding, "title" | "summary">): string {
  return finding.title ?? finding.summary;
}

/** A heading or a table cell shows this much of a title. */
const HEADING_MAX = 160;

/**
 * The section of one finding: where it is, the code at those lines, the
 * problem, and what to change. The inline comment on the diff says the same.
 */
function findingSection(state: StickyState, context: RenderContext, finding: StoredFinding): string[] {
  const meta = [
    `**File:** ${locationLink(state, context, finding, false)}${finding.inline ? "" : " (outside the diff)"}`,
    `**Severity:** ${finding.severity}`,
  ];
  if (finding.commentId !== null) {
    meta.push(`[inline comment](${commentUrl(context.repoUrl, context.marker.pr, finding.commentId)})`);
  }
  if (finding.status !== "open") meta.push(`**Status:** ${finding.status}`);
  const lines = [`#### ${finding.n}. ${oneLine(findingTitle(finding), HEADING_MAX)}`, "", meta.join(" · "), ""];
  if (finding.excerpt) {
    // The code comes from the diff: the fence keeps the block intact, and the marker reader strips
    // the block before it looks for markers.
    const fence = fenceFor(finding.excerpt);
    lines.push(`${fence}${codeLanguage(finding.file)}`, finding.excerpt, fence, "");
  }
  // With a title in the heading, the one-sentence summary opens the text; so does a summary the heading cut.
  if (finding.title || finding.summary.length > HEADING_MAX) lines.push(marginLine(finding.summary, 500), "");
  lines.push(
    paragraphs(finding.failure_scenario),
    "",
    // Its own paragraph at the margin, so the escaper and the marker reader see the same fences.
    "**Recommendation:**",
    "",
    paragraphs(finding.recommendation),
    "",
  );
  return lines;
}

/**
 * A text placed at the margin as its own paragraphs: trimmed before it is escaped, so that the
 * escaper and the marker reader see the same fences (an indented fence is prose for both).
 */
function paragraphs(text: string): string {
  return escapeHtml(text.trim());
}

/**
 * One line placed at the margin. A fence run at its start would open a code block for the marker
 * reader but not for the escaper, so stray backtick runs and a leading tilde run become apostrophes.
 */
export function marginLine(text: string, max: number): string {
  const line = balanceBackticks(text.replace(/\s+/g, " ").trim()).replace(/^~{3,}/, (run) => "'".repeat(run.length));
  return oneLine(line, max);
}

const LANGUAGES: Record<string, string> = {
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  go: "go",
  h: "c",
  hpp: "cpp",
  html: "html",
  java: "java",
  js: "js",
  json: "json",
  jsx: "jsx",
  kt: "kotlin",
  md: "markdown",
  mjs: "js",
  php: "php",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "sh",
  sql: "sql",
  swift: "swift",
  tf: "hcl",
  toml: "toml",
  ts: "ts",
  tsx: "tsx",
  yaml: "yaml",
  yml: "yaml",
};

/** The info string of a code block, from the file extension; empty when unknown. */
export function codeLanguage(file: string): string {
  const extension = /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase();
  return extension && Object.hasOwn(LANGUAGES, extension) ? (LANGUAGES[extension] as string) : "";
}

/** Every attempt of every job, oldest first: the history in the review comment. */
export function historyTable(jobs: JobRecord[]): string {
  const rows: string[] = [];
  for (const job of jobs) {
    const label = cell(job.label, 120);
    for (const [index, attempt] of job.attempts.entries()) {
      // The label is runtime-free text, but it may hold a branch name; it stays outside the link.
      const what =
        index > 0 ? `attempt ${index + 1}` : job.workflowRunUrl ? `${label} ([job](${job.workflowRunUrl}))` : label;
      const outcome = attempt.result === "completed" && job.outcome ? ` · ${cell(job.outcome, 200)}` : "";
      rows.push(
        `| ${rows.length + 1} | ${formatTime(job.startedAt)} | ${what} | \`${attempt.agentId.slice(0, 8)}\` | ${runCell(attempt)} | ${attemptResult(attempt)}${outcome} | ${formatDuration(attempt.durationMs)} |`,
      );
    }
  }
  return [
    "| # | Started (UTC) | Job | Agent | Run | Result | Duration |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/** The attempts of one job: the step summary of the workflow run. */
export function attemptsTable(attempts: AttemptRecord[]): string {
  const rows = attempts.map(
    (attempt, index) =>
      `| ${index + 1} | \`${attempt.agentId.slice(0, 8)}\` | ${runCell(attempt)} | ${attemptResult(attempt)} | ${formatDuration(attempt.durationMs)} |`,
  );
  return ["| # | Agent | Run | Result | Duration |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
}

function runCell(attempt: AttemptRecord): string {
  if (!attempt.runUrl) return "-";
  return `[run](${attempt.runUrl})${attempt.continued ? " (continued)" : ""}`;
}

/** "completed", or the failure class, where it was classified from, and the reason. */
function attemptResult(attempt: AttemptRecord): string {
  if (attempt.result === "completed") return "completed";
  return `${attempt.result}${attempt.source ? ` (${attempt.source})` : ""}: ${cell(attempt.reason, 300)}`;
}

/** "2026-10-23 13:27" in UTC, or "-" when the time is unknown. */
function formatTime(iso: string | null): string {
  const time = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(time)) return "-";
  return new Date(time).toISOString().slice(0, 16).replace("T", " ");
}

function findingNumber(state: StickyState, id: string): string {
  const finding = state.findings.find((candidate) => candidate.id === id);
  return finding ? String(finding.n) : `\`${id.replace(/`/g, "")}\``;
}

function shrink(state: StickyState, level: number): StickyState {
  const limit = level === 1 ? 1000 : level === 2 ? 300 : 80;
  // The sections after the findings: shortened first, dropped at the last level.
  const prose = level === 1 ? 2000 : level === 2 ? 500 : 0;
  const clip = (text: string, max: number) => (max === 0 ? "" : truncate(text, max));
  return {
    ...state,
    summary: truncate(state.summary, level === 1 ? 6000 : 1000),
    // Each limit is below the render cap of its section, so that the first level already shortens.
    reviewed: level >= 3 ? [] : state.reviewed.map((item) => truncate(item, level === 1 ? 120 : 80)),
    changes: level >= 2 ? [] : state.changes.map((change) => ({ ...change, what: truncate(change.what, 100) })),
    observations: level >= 3 ? [] : state.observations.map((item) => truncate(item, level === 1 ? 300 : 150)),
    tests:
      level >= 3 ? [] : state.tests.map((test) => ({ ...test, focus: truncate(test.focus, level === 1 ? 100 : 60) })),
    coverage: clip(state.coverage, prose),
    limitations: clip(state.limitations, prose),
    conclusion: clip(state.conclusion, level === 3 ? 300 : prose),
    findings: state.findings.map((finding) => {
      const { suggestion: _drop, ...rest } = finding;
      return {
        ...rest,
        // The code keeps its first lines at the first level and goes at the next.
        excerpt: level === 1 && finding.excerpt ? shortExcerpt(finding.excerpt) : null,
        failure_scenario: truncate(finding.failure_scenario, limit),
        recommendation: truncate(finding.recommendation, Math.max(limit, 120)),
        summary: truncate(finding.summary, Math.max(limit, 120)),
      };
    }),
    jobs: state.jobs.slice(level === 1 ? -10 : level === 2 ? -5 : -2),
    applied: state.applied.slice(-50),
    skipped: state.skipped.slice(-20),
  };
}

/** The first lines of an excerpt, for a comment that is too long. */
function shortExcerpt(excerpt: string): string {
  const lines = excerpt.split("\n");
  const kept = lines.slice(0, 4);
  if (lines.length > kept.length) kept.push("…");
  return truncate(kept.join("\n"), 400);
}

function verdictLabel(verdict: string): string {
  return (
    {
      approve: "Looks good to merge.",
      comment: "Comments only; nothing blocks the merge.",
      request_changes: "Needs changes before merge.",
    }[verdict] ?? verdict
  );
}

/** A file path in a table cell, inside a code span: no backtick or bracket can end the span or the link text. */
function pathCell(file: string): string {
  return cell(file, 120).replace(/[`[\]]/g, "'");
}

/** A table cell: one line, no stray backtick, pipes escaped. */
function cell(text: string, max: number): string {
  const line = balanceBackticks(truncate(text.replace(/\s+/g, " ").trim(), max));
  return escapeHtml(line, { fences: false }).replace(/\|/g, "\\|");
}

function oneLine(text: string, max: number): string {
  return escapeHtml(truncate(text.replace(/\s+/g, " ").trim(), max));
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
