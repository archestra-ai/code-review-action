import type { Octokit } from "./github/octokit";
import { addJob, findSticky, type RenderContext, renderSticky, writeSticky } from "./github/sticky";
import { type Logger, type RepoRef, shortSha } from "./util";

/** The job in progress, saved when it starts, so that a canceled job can still say what it was doing. */
export interface SavedJob {
  pr: number;
  /** The head commit the job worked on; null when it did not work on one commit. */
  sha: string | null;
  /** The history label: "review of 1234567". */
  label: string;
  /** What the job did, for the header: "reviewing `1234567`". */
  doing: string;
  login: string;
  startedAt: string;
  workflowRunUrl: string;
}

export function parseSavedJob(text: string): SavedJob | null {
  try {
    const job = JSON.parse(text) as Partial<SavedJob>;
    if (typeof job.pr !== "number" || typeof job.label !== "string" || typeof job.doing !== "string") return null;
    if (typeof job.login !== "string" || typeof job.startedAt !== "string" || typeof job.workflowRunUrl !== "string") {
      return null;
    }
    return { ...job, sha: typeof job.sha === "string" ? job.sha : null } as SavedJob;
  } catch {
    return null;
  }
}

/**
 * Records a job that was stopped before it finished: a newer push replaced it ("superseded"), or a
 * person or a time limit canceled it. The job gets a row in the history. Its progress header becomes
 * a finished header, unless a newer job has already put up its own. Never throws.
 */
export async function recordStoppedJob(p: {
  gh: Octokit;
  repo: RepoRef;
  job: SavedJob;
  render: Omit<RenderContext, "marker">;
  now: number;
  log: Logger;
}): Promise<"superseded" | "canceled" | "skipped"> {
  const { gh, repo, job, log } = p;
  try {
    const sticky = await findSticky(gh, repo, job.pr);
    if (!sticky?.state) return "skipped";
    const state = sticky.state;
    // A second call for the same job (the post step after the signal handler) changes nothing.
    if (state.jobs.some((entry) => entry.workflowRunUrl === job.workflowRunUrl && entry.startedAt === job.startedAt)) {
      return "skipped";
    }
    const { data: pull } = await gh.rest.pulls.get({ ...repo, pull_number: job.pr });
    const superseded = job.sha !== null && pull.head.sha !== job.sha;
    const outcome = superseded ? "superseded" : "canceled";
    const started = Date.parse(job.startedAt);
    const durationMs = Number.isFinite(started) ? Math.max(0, p.now - started) : 0;
    if (state.progress?.workflowRunUrl === job.workflowRunUrl) {
      state.progress = null;
      state.last = {
        did: job.doing,
        login: job.login,
        durationMs,
        startedAt: job.startedAt,
        workflowRunUrl: job.workflowRunUrl,
        outcome: "error",
        stop: outcome,
      };
    }
    addJob(state, {
      label: job.label,
      startedAt: job.startedAt,
      workflowRunUrl: job.workflowRunUrl,
      outcome: superseded ? `superseded by ${shortSha(pull.head.sha)}` : "canceled",
      attempts: [],
      durationMs,
    });
    await writeSticky(
      gh,
      repo,
      job.pr,
      { id: sticky.id, author: sticky.author },
      renderSticky(state, { ...p.render, marker: sticky.marker }),
    );
    return outcome;
  } catch (error) {
    log.warning(
      `Could not record the stopped job in the review comment: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "skipped";
  }
}
