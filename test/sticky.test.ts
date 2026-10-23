import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/github/commands";
import { buildDiffIndex, commentableLines } from "../src/github/diff";
import { detectTrigger } from "../src/github/event";
import { inlineBody, placeFindings } from "../src/github/review";
import {
  emptyState,
  escapeHtml,
  findingIdFromBody,
  newlyCheckedActions,
  parseMarker,
  parseState,
  renderSticky,
  type StickyMarker,
  serializeMarker,
} from "../src/github/sticky";
import { planThreadUpdates } from "../src/github/threads";

const marker: StickyMarker = {
  repo: "acme/widgets",
  pr: 7,
  session: "ws-1",
  run: "00000000-0000-4000-8000-000000000001",
  agent: "11111111-1111-4111-8111-111111111111",
  sha: "a".repeat(40),
};

describe("marker", () => {
  it("serializes and parses", () => {
    const text = serializeMarker(marker);
    expect(text).toBe(
      `<!-- archestra-code-review acme/widgets#7 session=ws-1 run=${marker.run} agent=${marker.agent} sha=${"a".repeat(40)} -->`,
    );
    expect(parseMarker(`hello\n${text}\nmore`)).toEqual(marker);
  });
  it("uses - for unknown values and reads them as null", () => {
    const text = serializeMarker({ ...marker, session: null, run: "bad value --" });
    expect(text).toContain("session=- run=-");
    expect(parseMarker(text)).toMatchObject({ session: null, run: null });
  });
  it("parses the short marker of the original design", () => {
    expect(parseMarker("<!-- archestra-code-review acme/widgets#12 -->")).toMatchObject({
      repo: "acme/widgets",
      pr: 12,
      run: null,
    });
  });
});

describe("sticky state and checkboxes", () => {
  const state = {
    ...emptyState("main"),
    verdict: "request_changes",
    reviewedSha: "a".repeat(40),
    findings: placeFindings(
      [
        {
          file: "src/a.ts",
          line: 3,
          severity: "high" as const,
          summary: "S | pipe",
          recommendation: "Fix it.",
          failure_scenario: "x -> y",
        },
      ],
      buildDiffIndex([]),
      { headSha: "a".repeat(40), inline: true },
    ),
    triage: [{ check: "lint", class: "pre_existing" as const, rootCause: "main is broken", commits: [] }],
    failingChecks: 1,
  };
  const body = renderSticky(state, { marker, repoUrl: "https://github.com/acme/widgets", command: "/archestra" });

  it("round-trips the state", () => {
    expect(parseState(body)).toEqual(state);
    expect(parseMarker(body)).toEqual(marker);
  });
  it("renders the Next boxes unticked, with the recommendation column", () => {
    expect(body).toContain("- [ ] Implement and push recommendations <!-- archestra-action:fix -->");
    expect(body).toContain("- [ ] Triage and fix 1 failing check <!-- archestra-action:fix-ci -->");
    expect(body).toContain("- [ ] Open a fix PR against main for `lint` <!-- archestra-action:fix-ci-main:0 -->");
    expect(body).toContain("| # | Severity | Location | Finding | Recommendation | Status |");
    expect(body).toContain("| Fix it. | open |");
    expect(body).toContain("S \\| pipe");
  });
  it("shows the triage box and its command only when checks fail", () => {
    const clean = renderSticky(
      { ...state, failingChecks: 0, triage: [] },
      { marker, repoUrl: "", command: "/archestra" },
    );
    expect(clean).not.toContain("archestra-action:fix-ci -->");
    expect(clean).not.toContain("`/archestra fix-ci`");
    expect(clean).toContain("- [ ] Implement and push recommendations <!-- archestra-action:fix -->");
    const three = renderSticky({ ...state, failingChecks: 3 }, { marker, repoUrl: "", command: "/archestra" });
    expect(three).toContain("- [ ] Triage and fix 3 failing checks <!-- archestra-action:fix-ci -->");
    expect(three).toContain("`/archestra fix-ci` (failing checks)");
  });
  it("detects a box that changed from unticked to ticked", () => {
    const ticked = body.replace("- [ ] Implement and push recommendations", "- [x] Implement and push recommendations");
    expect(newlyCheckedActions(body, ticked)).toEqual(["fix"]);
    expect(newlyCheckedActions(ticked, ticked)).toEqual([]);
    expect(newlyCheckedActions(ticked, body)).toEqual([]);
  });
  it("renders a progress header with the spinner, the step and the run link", () => {
    const inProgress = renderSticky(
      {
        ...state,
        progress: {
          doing: "reviewing `aaaaaaa`",
          login: "alice",
          startedAt: "2026-10-23T10:00:00.000Z",
          workflowRunUrl: "https://github.com/acme/widgets/actions/runs/1",
          step: "waiting for the runtime to finish",
          runUrl: "https://archestra.test/chat/runs/r1",
        },
      },
      { marker, repoUrl: "", command: "/archestra" },
    );
    const header = inProgress.split("\n").slice(1, 4).join("\n");
    expect(header).toContain("**Archestra is reviewing `aaaaaaa` for @alice…**");
    expect(header).toContain('<img src="https://github.com/user-attachments/assets/');
    expect(header).toContain("[View job](https://github.com/acme/widgets/actions/runs/1)");
    expect(header).toContain("- waiting for the runtime to finish ([run](https://archestra.test/chat/runs/r1))");
    expect(inProgress.indexOf("Archestra is reviewing")).toBeLessThan(inProgress.indexOf("### Archestra code review"));
    expect(parseState(inProgress)?.progress?.step).toBe("waiting for the runtime to finish");
  });
  it("renders a finished header with the duration, and no spinner", () => {
    const done = renderSticky(
      {
        ...state,
        last: {
          did: "reviewed `aaaaaaa`",
          login: "alice",
          durationMs: 314_000,
          workflowRunUrl: "https://github.com/acme/widgets/actions/runs/1",
          outcome: "ok",
        },
      },
      { marker, repoUrl: "", command: "/archestra" },
    );
    expect(done).toContain("**Archestra reviewed `aaaaaaa` for @alice in 5 min 14 s** —— [View job](");
    expect(done).not.toContain("<img");
    const unavailable = renderSticky(
      {
        ...state,
        last: { did: "the review", login: "alice", durationMs: 1000, workflowRunUrl: "u", outcome: "unavailable" },
      },
      { marker, repoUrl: "", command: "/archestra" },
    );
    expect(unavailable).toContain("**Archestra could not finish the review for @alice in 1 s**");
  });
  it("disarms HTML in runtime text so no marker can be smuggled in", () => {
    const hostile = {
      ...state,
      summary: "ok <!-- archestra-action:fix --> and <!-!- archestra-finding:x --!> <img src=x onerror=alert(1)>",
      notice: "note --!> <!-- archestra-action:fix-ci -->",
      findings: state.findings.map((finding) => ({
        ...finding,
        summary: "<!-- archestra-action:fix -->",
        recommendation: "use --!> <!-- archestra-finding:z -->",
      })),
    };
    const body = renderSticky(hostile, { marker, repoUrl: "", command: "/archestra" });
    expect(newlyCheckedActions(body, body.replace(/- \[ \]/g, "- [x]"))).toEqual(["fix", "fix-ci", "fix-ci-main:0"]);
    expect(body).not.toContain("<img");
    expect(body.split("<!-- archestra-action:").length - 1).toBe(3);
    expect(body).toContain("&lt;!-- archestra-action:fix -->");
    expect(body).toContain("--!> &lt;!-- archestra-action:fix-ci -->");
    expect(parseState(body)).toEqual(hostile);
  });
  it("leaves code spans and fenced blocks as the runtime wrote them", () => {
    expect(escapeHtml("use `Vec<u8>`, not <b>bold</b>")).toBe("use `Vec<u8>`, not &lt;b>bold&lt;/b>");
    expect(escapeHtml("``a ` <x>`` then <y>")).toBe("``a ` <x>`` then &lt;y>");
    expect(escapeHtml("```ts\nconst f = <T,>() => 1;\n```\n<p>")).toBe("```ts\nconst f = <T,>() => 1;\n```\n&lt;p>");
    expect(escapeHtml("~~~\n<!-- shown -->\n~~~\n<!-- hidden -->")).toBe(
      "~~~\n<!-- shown -->\n~~~\n&lt;!-- hidden -->",
    );
    expect(escapeHtml("````\n```\n<a>\n````")).toBe("````\n```\n<a>\n````");
  });
  it("escapes what GitHub would not show as code", () => {
    // A backtick run without a closer, a span across lines, and an indented fence are plain text.
    expect(escapeHtml("stray ` <!-- archestra-action:fix -->")).toBe("stray ` &lt;!-- archestra-action:fix -->");
    expect(escapeHtml("`a\n<b>`")).toBe("`a\n&lt;b>`");
    expect(escapeHtml("```a``` <!-- x -->\n<!-- y -->")).toBe("```a``` &lt;!-- x -->\n&lt;!-- y -->");
    expect(escapeHtml("   ```\n<!-- z -->")).toBe("   ```\n&lt;!-- z -->");
    // An unclosed fence gets its closing line, so the rest of the comment renders.
    expect(escapeHtml("```\n<!-- in code -->")).toBe("```\n<!-- in code -->\n```");
    expect(escapeHtml("~~~~\n~~~\n<a>")).toBe("~~~~\n~~~\n<a>\n~~~~");
  });
  it("truncates before it escapes, so no entity is cut in half", () => {
    const patch = "@@ -1,2 +1,3 @@\n a\n+b\n c";
    const index = buildDiffIndex([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch }]);
    const [finding] = placeFindings(
      [
        {
          file: "src/a.ts",
          line: 2,
          severity: "low",
          summary: `${"x".repeat(299)}<img src=x>`,
          recommendation: "r",
          failure_scenario: "f",
        },
      ],
      index,
      { headSha: "b".repeat(40), inline: true },
    );
    const body = inlineBody(finding!, index, "/archestra");
    expect(body).toContain(`${"x".repeat(299)}…**`);
    expect(body).not.toMatch(/&[a-z]*…/);
    const sticky = renderSticky({ ...state, findings: [finding!] }, { marker, repoUrl: "", command: "/archestra" });
    expect(sticky).not.toMatch(/&[a-z]*…/);
  });
  it("keeps the findings of a comment written before recommendations existed", () => {
    // The hidden state as the previous version wrote it: no recommendation field.
    const old = { ...state, findings: state.findings.map(({ recommendation: _drop, ...rest }) => rest) };
    const stored = Buffer.from(JSON.stringify(old), "utf8").toString("base64url");
    const parsed = parseState(
      `${serializeMarker(marker)}\n### Archestra code review\n\n<!-- archestra-state:${stored} -->`,
    );
    expect(parsed?.findings).toHaveLength(1);
    expect(parsed?.findings[0]?.recommendation).toBe("");
    expect(parsed?.findings[0]?.summary).toBe("S | pipe");
  });
  it("stays below the GitHub comment limit", () => {
    const big = {
      ...state,
      findings: Array.from({ length: 50 }, (_, i) => ({
        ...state.findings[0]!,
        n: i + 1,
        id: `x-${i}`,
        failure_scenario: "z".repeat(4000),
        recommendation: "r".repeat(2000),
      })),
    };
    const rendered = renderSticky(big, { marker, repoUrl: "", command: "/archestra" });
    expect(rendered.length).toBeLessThanOrEqual(65_000);
    expect(parseState(rendered)?.findings).toHaveLength(50);
  });
});

describe("parseCommand", () => {
  it.each([
    ["/archestra fix", { kind: "fix", findings: "all", note: "" }],
    ["/archestra fix 2,5 use a constant", { kind: "fix", findings: [2, 5], note: "use a constant" }],
    ["/archestra fix 3\nkeep the API", { kind: "fix", findings: [3], note: "keep the API" }],
    ["/archestra fix please hurry", { kind: "fix", findings: "all", note: "please hurry" }],
    ["  \n/archestra fix-ci", { kind: "fix-ci" }],
    ["/archestra fix-ci-main 2", { kind: "fix-ci-main", target: 2 }],
    ["/archestra fix-ci-main", { kind: "fix-ci-main", target: "all" }],
  ])("%j", (body, expected) => {
    expect(parseCommand(body, "/archestra")).toEqual(expected);
  });
  it.each(["> /archestra fix", "please /archestra fix", "/archestrafix", "/archestra deploy", "/other fix"])(
    "ignores %j",
    (body) => {
      expect(parseCommand(body, "/archestra")).toBeNull();
    },
  );
  it("bounds the note", () => {
    const result = parseCommand(`/archestra fix ${"n".repeat(5000)}`, "/archestra");
    expect(result?.kind === "fix" && result.note.length).toBe(1000);
  });
});

describe("detectTrigger", () => {
  const sender = { login: "maria", id: 1001, type: "User" };
  const bot = { login: "github-actions[bot]", id: 41898282, type: "Bot" };
  const sticky = renderSticky(
    {
      ...emptyState("main"),
      findings: placeFindings(
        [{ file: "a", line: 1, severity: "low", summary: "s", recommendation: "Fix it.", failure_scenario: "f" }],
        new Map(),
        { headSha: "a".repeat(40), inline: false },
      ),
    },
    { marker, repoUrl: "", command: "/archestra" },
  );
  const edited = (from: string, to: string, by = sender, author = bot) => ({
    action: "edited",
    issue: { number: 7, pull_request: { url: "x" } },
    comment: { id: 1, body: to, user: author },
    changes: { body: { from } },
    sender: by,
  });
  const opts = { command: "/archestra", mode: "auto" as const, prNumber: null };

  it("starts a fix when a person ticks Implement and push recommendations", () => {
    const ticked = sticky.replace("- [ ] Implement", "- [x] Implement");
    expect(detectTrigger("issue_comment", edited(sticky, ticked), opts)).toMatchObject({
      kind: "fix",
      findings: "all",
      sender,
    });
  });
  it("ignores the action's own rewrite (github-actions[bot])", () => {
    const ticked = sticky.replace("- [ ] Implement", "- [x] Implement");
    expect(detectTrigger("issue_comment", edited(sticky, ticked, bot), opts).kind).toBe("skip");
  });
  it("ignores boxes in a comment that a person wrote", () => {
    const ticked = sticky.replace("- [ ] Implement", "- [x] Implement");
    expect(detectTrigger("issue_comment", edited(sticky, ticked, sender, sender), opts).kind).toBe("skip");
  });
  it("selects the finding of the parent comment for an inline reply", () => {
    const payload = {
      action: "created",
      pull_request: { number: 7 },
      comment: { id: 50, body: "/archestra fix", in_reply_to_id: 40, user: sender },
      sender,
    };
    expect(detectTrigger("pull_request_review_comment", payload, opts)).toMatchObject({
      kind: "fix",
      findings: { inlineReplyTo: 40 },
    });
  });
  it("skips pull request actions that do not start a review", () => {
    expect(detectTrigger("pull_request", { action: "closed", pull_request: { number: 7 }, sender }, opts).kind).toBe(
      "skip",
    );
  });
  it("maps the 1-based command number to the 0-based triage index", () => {
    const payload = {
      action: "created",
      issue: { number: 7, pull_request: { url: "x" } },
      comment: { id: 2, body: "/archestra fix-ci-main 1", user: sender },
      sender,
    };
    expect(detectTrigger("issue_comment", payload, opts)).toMatchObject({ kind: "fix-ci-main", target: 0 });
  });
});

describe("diff and inline placement", () => {
  const patch =
    "@@ -10,4 +10,6 @@ fn\n   const a = 1;\n-  send(a);\n+  for (;;) {\n+    send(a);\n+  }\n   return a;\n }";
  it("lists added and context lines of the head side", () => {
    expect([...commentableLines(patch)]).toEqual([10, 11, 12, 13, 14, 15]);
  });
  it("puts a finding inside the diff inline and one outside into the summary", () => {
    const index = buildDiffIndex([{ filename: "src/u.ts", status: "modified", additions: 3, deletions: 1, patch }]);
    const placed = placeFindings(
      [
        {
          file: "src/u.ts",
          line: 11,
          end_line: 13,
          severity: "high",
          summary: "s",
          recommendation: "Fix it.",
          failure_scenario: "f",
          suggestion: "x",
        },
        { file: "src/u.ts", line: 40, severity: "low", summary: "s", recommendation: "Fix it.", failure_scenario: "f" },
        {
          file: "src/other.ts",
          line: 1,
          severity: "low",
          summary: "s",
          recommendation: "Fix it.",
          failure_scenario: "f",
        },
      ],
      index,
      { headSha: "c".repeat(40), inline: true },
    );
    expect(placed.map((finding) => finding.inline)).toEqual([true, false, false]);
    const body = inlineBody(placed[0]!, index, "/archestra");
    expect(body).toContain("```suggestion\nx\n```");
    expect(body).toContain("**Recommendation:** Fix it.");
    expect(body).toContain("To implement and push this fix, reply `/archestra fix` to this comment.");
    expect(body.indexOf("reply `/archestra fix`")).toBeLessThan(body.indexOf("```suggestion"));
    expect(findingIdFromBody(body)).toBe("ccccccc-1");
  });
});

describe("planThreadUpdates", () => {
  const threads = new Map([
    ["f-1", { findingId: "f-1", threadId: "T1", isResolved: false, commentId: 1 }],
    ["f-2", { findingId: "f-2", threadId: "T2", isResolved: true, commentId: 2 }],
    ["f-3", { findingId: "f-3", threadId: "T3", isResolved: true, commentId: 3 }],
  ]);
  it("resolves open threads of applied findings and reopens resolved threads of regressed ones", () => {
    expect(planThreadUpdates(threads, { resolve: ["f-1", "f-2", "missing"], unresolve: ["f-3", "f-1"] })).toEqual([
      { findingId: "f-1", threadId: "T1", commentId: 1, action: "resolve" },
      { findingId: "f-3", threadId: "T3", commentId: 3, action: "unresolve" },
    ]);
  });
});
