import { z } from "zod";

// Result files that the runtime agent writes into /home/node/workspace.
// The action reads them through the workspace file API and validates them
// with these schemas. `npm run schemas` writes the JSON Schema files under
// schemas/ from these definitions.

const sha = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "must be a full 40-character lowercase commit SHA");

export const SeveritySchema = z.enum(["critical", "high", "medium", "low", "nit"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const ReviewFindingSchema = z.object({
  file: z.string().min(1).max(500).describe("Path relative to the repository root"),
  line: z.number().int().positive().describe("Line in the head version of the file"),
  end_line: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Last line of a multi-line finding"),
  severity: SeveritySchema,
  summary: z.string().min(1).max(500).describe("One sentence"),
  failure_scenario: z
    .string()
    .min(1)
    .max(4000)
    .describe("Input or state, and the incorrect result"),
  suggestion: z
    .string()
    .max(4000)
    .optional()
    .describe("Full replacement text for lines line..end_line"),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const PreviousFindingStatusSchema = z.enum([
  "fixed",
  "still_present",
  "regressed",
]);

export const ReviewResultSchema = z
  .object({
    verdict: z.enum(["approve", "comment", "request_changes"]),
    summary: z.string().max(8000),
    findings: z.array(ReviewFindingSchema).max(50),
    previous: z
      .array(
        z.object({
          id: z.string().min(1).max(100),
          status: PreviousFindingStatusSchema,
          note: z.string().max(1000).optional(),
        }),
      )
      .max(100)
      .optional(),
  })
  .refine(
    (review) =>
      review.findings.every(
        (finding) => finding.end_line === undefined || finding.end_line >= finding.line,
      ),
    { message: "end_line must not be less than line", path: ["findings"] },
  );
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export const FixResultSchema = z.object({
  applied: z
    .array(z.object({ finding: z.string().min(1).max(100), commit: sha }))
    .max(100),
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

export const TriageClassSchema = z.enum([
  "pr_caused",
  "flaky",
  "pre_existing",
  "infrastructure",
  "needs_human",
]);
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
  branch: z
    .string()
    .regex(/^archestra\/fix-ci-[a-z0-9][a-z0-9-]{0,80}$/, "must be archestra/fix-ci-<slug>"),
  commits: z.array(sha).min(1).max(50),
  title: z.string().min(1).max(200).optional(),
  summary: z.string().min(1).max(8000),
  root_cause: z.string().max(4000).optional(),
  reproduction: z.string().min(1).max(4000),
});
export type CiMainFix = z.infer<typeof CiMainFixSchema>;

export const CONTRACTS = {
  review: { file: "review.json", schema: ReviewResultSchema },
  fix: { file: "fix-result.json", schema: FixResultSchema },
  "fix-ci": { file: "ci-triage.json", schema: CiTriageSchema },
  "fix-ci-main": { file: "ci-main-fix.json", schema: CiMainFixSchema },
} as const;
