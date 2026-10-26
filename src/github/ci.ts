import { errorMessage, type Logger, type RepoRef, slug, tailBytes } from "../util";
import type { Octokit } from "./octokit";

export interface CiAnnotation {
  path: string;
  startLine: number;
  endLine: number;
  level: string;
  title: string | null;
  message: string;
}

export interface CiFailure {
  name: string;
  app: string;
  checkRunId: number;
  conclusion: string;
  url: string | null;
  summary: string | null;
  annotations: CiAnnotation[];
  /** GitHub Actions jobs only. */
  jobId: number | null;
  runId: number | null;
  workflow: string | null;
  workflowPath: string | null;
  /** Name of the log attachment, when the action could read the log. */
  log: string | null;
  logTruncated: boolean;
  /** The latest completed result of the same job on the base branch. */
  baseBranchResult: { conclusion: string | null; url: string | null } | null;
}

export interface CiEvidence {
  headSha: string;
  baseBranch: string;
  failures: CiFailure[];
  omitted: number;
}

export interface CiLog {
  name: string;
  content: Buffer;
}

export const FAILING_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);
export const DEFAULT_LOG_CAP_BYTES = 200 * 1024;
const MAX_ANNOTATIONS = 50;

/** One check of the reviewed commit, as the review sees it at the start. */
export interface CheckSnapshotEntry {
  name: string;
  /** queued, in_progress or completed. */
  status: string;
  conclusion: string | null;
  url: string | null;
  /** For a failing check: its summary and annotations, bounded. */
  summary?: string;
  annotations?: CiAnnotation[];
}

/**
 * The checks of the reviewed commit, for the reviewer: every check's state, and the summary and
 * annotations of the failing ones, so that a failure the pull request causes becomes a finding.
 * Cheap: one listing, and the annotations of at most five failing checks; no logs. A failure to
 * read the checks gives an empty list, so the review still runs.
 */
export async function checkSnapshot(
  gh: Octokit,
  repo: RepoRef,
  ref: string,
  log: Logger,
): Promise<{ failing: number; checks: CheckSnapshotEntry[] }> {
  try {
    const runs = await gh.paginate(gh.rest.checks.listForRef, { ...repo, ref, filter: "latest", per_page: 100 });
    let detailed = 0;
    const checks = await Promise.all(
      runs.slice(0, 100).map(async (run): Promise<CheckSnapshotEntry> => {
        const entry: CheckSnapshotEntry = {
          name: run.name,
          status: run.status,
          conclusion: run.conclusion ?? null,
          url: run.html_url ?? null,
        };
        if (run.conclusion && FAILING_CONCLUSIONS.has(run.conclusion) && detailed < 5) {
          detailed++;
          if (run.output?.summary) entry.summary = run.output.summary.slice(0, 2000);
          if ((run.output?.annotations_count ?? 0) > 0) {
            entry.annotations = (await annotations(gh, repo, run.id, log)).slice(0, 10);
          }
        }
        return entry;
      }),
    );
    const failing = runs.filter((run) => run.conclusion && FAILING_CONCLUSIONS.has(run.conclusion)).length;
    return { failing, checks };
  } catch (error) {
    log.warning(`Could not read the checks of ${ref.slice(0, 7)}: ${errorMessage(error)}`);
    return { failing: 0, checks: [] };
  }
}

/**
 * Collects the evidence for the triage: failing check runs of the head
 * commit, their annotations and, for GitHub Actions jobs, the log tail and
 * the latest result of the same job on the base branch. Non-Actions checks
 * give annotations and the summary only.
 */
export async function collectCiEvidence(
  gh: Octokit,
  repo: RepoRef,
  options: { headSha: string; baseBranch: string; log: Logger; logCapBytes?: number; maxFailures?: number },
): Promise<{ evidence: CiEvidence; logs: CiLog[] }> {
  const cap = options.logCapBytes ?? DEFAULT_LOG_CAP_BYTES;
  const maxFailures = options.maxFailures ?? 15;
  const checkRuns = await gh.paginate(gh.rest.checks.listForRef, {
    ...repo,
    ref: options.headSha,
    filter: "latest",
    per_page: 100,
  });
  const failing = checkRuns.filter((run) => run.conclusion && FAILING_CONCLUSIONS.has(run.conclusion));
  const failures: CiFailure[] = [];
  const logs: CiLog[] = [];
  const usedNames = new Set<string>();

  for (const run of failing.slice(0, maxFailures)) {
    const failure: CiFailure = {
      name: run.name,
      app: run.app?.slug ?? "unknown",
      checkRunId: run.id,
      conclusion: run.conclusion ?? "unknown",
      url: run.html_url ?? null,
      summary: run.output?.summary ? run.output.summary.slice(0, 4000) : null,
      annotations: [],
      jobId: null,
      runId: null,
      workflow: null,
      workflowPath: null,
      log: null,
      logTruncated: false,
      baseBranchResult: null,
    };
    if ((run.output?.annotations_count ?? 0) > 0) {
      failure.annotations = await annotations(gh, repo, run.id, options.log);
    }
    if (failure.app === "github-actions") {
      // For GitHub Actions, the check run id is the job id.
      await addJobDetails(gh, repo, failure, options, cap, logs, usedNames);
    }
    failures.push(failure);
  }
  return {
    evidence: {
      headSha: options.headSha,
      baseBranch: options.baseBranch,
      failures,
      omitted: Math.max(0, failing.length - maxFailures),
    },
    logs,
  };
}

async function annotations(gh: Octokit, repo: RepoRef, checkRunId: number, log: Logger): Promise<CiAnnotation[]> {
  try {
    const { data } = await gh.rest.checks.listAnnotations({
      ...repo,
      check_run_id: checkRunId,
      per_page: MAX_ANNOTATIONS,
    });
    return data.slice(0, MAX_ANNOTATIONS).map((annotation) => ({
      path: annotation.path,
      startLine: annotation.start_line,
      endLine: annotation.end_line,
      level: annotation.annotation_level ?? "failure",
      title: annotation.title ?? null,
      message: (annotation.message ?? "").slice(0, 2000),
    }));
  } catch (error) {
    log.warning(`Could not read the annotations of check run ${checkRunId}: ${errorMessage(error)}`);
    return [];
  }
}

async function addJobDetails(
  gh: Octokit,
  repo: RepoRef,
  failure: CiFailure,
  options: { baseBranch: string; log: Logger },
  cap: number,
  logs: CiLog[],
  usedNames: Set<string>,
): Promise<void> {
  const jobId = failure.checkRunId;
  failure.jobId = jobId;
  try {
    const { data: job } = await gh.rest.actions.getJobForWorkflowRun({ ...repo, job_id: jobId });
    failure.runId = job.run_id;
    failure.workflow = job.workflow_name ?? null;
    const { data: workflowRun } = await gh.rest.actions.getWorkflowRun({ ...repo, run_id: job.run_id });
    failure.workflowPath = workflowRun.path ?? null;
    failure.baseBranchResult = await baseBranchResult(gh, repo, workflowRun.workflow_id, job.name, options.baseBranch);
  } catch (error) {
    options.log.warning(`Could not read job ${jobId}: ${errorMessage(error)}`);
  }
  try {
    const response = await gh.rest.actions.downloadJobLogsForWorkflowRun({ ...repo, job_id: jobId });
    const raw = response.data as unknown;
    const buffer =
      typeof raw === "string"
        ? Buffer.from(raw, "utf8")
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw)
          : Buffer.from(String(raw ?? ""), "utf8");
    const { data, truncated } = tailBytes(buffer, cap);
    let name = `ci-log-${slug(failure.name, 60)}.log`;
    for (let n = 2; usedNames.has(name); n++) name = `ci-log-${slug(failure.name, 55)}-${n}.log`;
    usedNames.add(name);
    logs.push({ name, content: data });
    failure.log = name;
    failure.logTruncated = truncated;
  } catch (error) {
    options.log.warning(`Could not read the log of job ${jobId}: ${errorMessage(error)}`);
  }
}

async function baseBranchResult(
  gh: Octokit,
  repo: RepoRef,
  workflowId: number,
  jobName: string,
  baseBranch: string,
): Promise<CiFailure["baseBranchResult"]> {
  const { data } = await gh.rest.actions.listWorkflowRuns({
    ...repo,
    workflow_id: workflowId,
    branch: baseBranch,
    status: "completed",
    per_page: 1,
  });
  const latest = data.workflow_runs[0];
  if (!latest) return null;
  const jobs = await gh.rest.actions.listJobsForWorkflowRun({
    ...repo,
    run_id: latest.id,
    filter: "latest",
    per_page: 100,
  });
  const job = jobs.data.jobs.find((candidate) => candidate.name === jobName);
  return job
    ? { conclusion: job.conclusion ?? null, url: job.html_url ?? null }
    : { conclusion: latest.conclusion ?? null, url: latest.html_url };
}
