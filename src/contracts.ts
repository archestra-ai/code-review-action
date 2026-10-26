import { z } from "zod";

// Result files that the runtime agent writes into /home/node/workspace.
// The action reads them through the workspace file API and validates them
// with these schemas. `npm run schemas` writes the JSON Schema files under
// schemas/ from these definitions.

const sha = z.string().regex(/^[0-9a-f]{40}$/, "must be a full 40-character lowercase commit SHA");

export const SeveritySchema = z.enum(["critical", "high", "medium", "low", "nit"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const ReviewFindingSchema = z.object({
  file: z.string().min(1).max(500).describe("Path relative to the repository root"),
  line: z.number().int().positive().describe("Line in the head version of the file"),
  end_line: z.number().int().positive().optional().describe("Last line of a multi-line finding"),
  severity: SeveritySchema,
  title: z.string().min(1).max(300).optional().describe("A short name for the finding, used as its heading"),
  summary: z.string().min(1).max(500).describe("One sentence"),
  failure_scenario: z
    .string()
    .min(1)
    .max(4000)
    .describe("Input or state, the incorrect result, and the reasoning a maintainer needs"),
  recommendation: z
    .string()
    .min(1)
    .max(2000)
    .describe("What to change, in one or two sentences; the fix mode implements it"),
  suggestion: z.string().max(4000).optional().describe("Full replacement text for lines line..end_line"),
  previous_id: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("The id from previous-findings.json when this finding was reported before"),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const PreviousFindingStatusSchema = z.enum(["fixed", "still_present", "regressed"]);

export const ReviewResultSchema = z
  .object({
    // The action derives the verdict from the severities; a runtime that still writes one is accepted.
    verdict: z.enum(["approve", "comment", "request_changes"]).optional(),
    // The brief asks for 8000 characters at most; the contract leaves room for a runtime that overshoots.
    summary: z.string().max(12_000),
    // The brief asks for short entries and few of them; the limits here only stop pathological output,
    // because a review that fails the contract costs a whole attempt. The comment shortens long texts.
    reviewed: z
      .array(z.string().min(1).max(1000))
      .max(40)
      .optional()
      .describe("What the review covered, in order: an area and its key files for each entry"),
    findings: z.array(ReviewFindingSchema).max(50),
    changes: z
      .array(
        z.object({
          file: z.string().min(1).max(500).describe("Path relative to the repository root"),
          line: z.number().int().positive().optional().describe("The line that matters, when one does"),
          what: z.string().min(1).max(300).describe("What changed there, in one line"),
        }),
      )
      .max(60)
      .optional()
      .describe("The places a rule of the change reached, for the change map"),
    observations: z
      .array(z.string().min(1).max(2000))
      .max(40)
      .optional()
      .describe("What the change does right, and facts a maintainer should know that need no change"),
    tests: z
      .array(
        z.object({
          file: z.string().min(1).max(500).describe("Path relative to the repository root"),
          focus: z.string().min(1).max(1000).describe("What the file covers, in one line"),
        }),
      )
      .max(100)
      .optional()
      .describe("The test files of the change"),
    coverage: z.string().max(6000).optional().describe("What the tests cover and what they leave out"),
    limitations: z.string().max(6000).optional().describe("What the review could not do, and why"),
    conclusion: z.string().max(6000).optional().describe("The closing judgement, naming the most actionable finding"),
    previous: z
      .array(
        z.object({
          id: z.string().min(1).max(100),
          status: PreviousFindingStatusSchema,
          note: z.string().max(1000).optional().describe("For fixed: the file and line that show the fix"),
        }),
      )
      .max(100)
      .optional(),
  })
  .refine(
    (review) => review.findings.every((finding) => finding.end_line === undefined || finding.end_line >= finding.line),
    { message: "end_line must not be less than line", path: ["findings"] },
  );
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export const FixResultSchema = z.object({
  applied: z.array(z.object({ finding: z.string().min(1).max(100), commit: sha })).max(100),
  skipped: z
    .array(
      z.object({
        finding: z.string().min(1).max(100),
        reason: z.string().min(1).max(2000),
      }),
    )
    .max(100),
  notes: z.string().max(8000),
});
export type FixResult = z.infer<typeof FixResultSchema>;

export const TriageClassSchema = z.enum(["pr_caused", "flaky", "pre_existing", "infrastructure", "needs_human"]);
export type TriageClass = z.infer<typeof TriageClassSchema>;

export const CiTriageSchema = z.object({
  failures: z
    .array(
      z.object({
        check: z.string().min(1).max(300).describe("Name of the failing check, as in ci-failure.json"),
        class: TriageClassSchema,
        root_cause: z.string().max(4000),
        commits: z.array(sha).max(50).default([]),
        reproduction: z.string().max(4000).optional(),
        notes: z.string().max(4000).optional(),
      }),
    )
    .max(50),
  notes: z.string().max(8000),
});
export type CiTriage = z.infer<typeof CiTriageSchema>;

export const FIX_CI_BRANCH_PREFIX = "archestra/fix-ci-";

export const CiMainFixSchema = z.object({
  branch: z.string().regex(/^archestra\/fix-ci-[a-z0-9][a-z0-9-]{0,80}$/, "must be archestra/fix-ci-<slug>"),
  commits: z.array(sha).min(1).max(50),
  title: z.string().min(1).max(200).optional(),
  summary: z.string().min(1).max(8000),
  root_cause: z.string().max(4000).optional(),
  reproduction: z.string().min(1).max(4000),
});
export type CiMainFix = z.infer<typeof CiMainFixSchema>;

/**
 * The progress file the runtime keeps up to date while it reviews: its plan as a checklist. The
 * action shows it in the progress header. The head commit tells it apart from the file of an
 * earlier turn in the same workspace.
 */
export const ProgressFileSchema = z.object({
  sha: z.string(),
  steps: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        status: z.enum(["todo", "doing", "done"]),
      }),
    )
    .max(20),
});
export type ProgressFile = z.infer<typeof ProgressFileSchema>;
export const PROGRESS_FILE = "progress.json";

export const CONTRACTS = {
  review: { file: "review.json", schema: ReviewResultSchema },
  fix: { file: "fix-result.json", schema: FixResultSchema },
  "fix-ci": { file: "ci-triage.json", schema: CiTriageSchema },
  "fix-ci-main": { file: "ci-main-fix.json", schema: CiMainFixSchema },
} as const;
