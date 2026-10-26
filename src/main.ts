import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import * as core from "@actions/core";
import { ArchestraClient } from "./archestra/client";
import { exchangeGitHubActionsToken } from "./archestra/github-actions-auth";
import { cancelIfLive } from "./cancel";
import type { AccessRefusalInfo } from "./context";
import { type ActionContext, type ActionResult, repoUrl } from "./context";
import { readEnvironment } from "./env";
import { createOctokit } from "./github/octokit";
import { InputError, readInputs } from "./inputs";
import { commentCommand } from "./modes/common";
import { run } from "./run";
import { recordStoppedJob, type SavedJob } from "./stopped";
import { errorMessage } from "./util";

export const LIVE_RUN_STATE = "live-run-id";
export const JOB_STATE = "job";
/** Set when the main step finished or recorded its own cancellation: the post step has nothing left to do. */
export const DONE_STATE = "done";
/** The Archestra token of a job that signed in with its GitHub Actions identity, for the post step. */
export const TOKEN_STATE = "archestra-token";

/**
 * The runner sends SIGINT to a canceled step and SIGTERM about 7.5 seconds later. The job's
 * private network access (a tunnel step after this one) is gone by the time the post step runs,
 * so the live run is canceled here, while it can still be reached.
 */
const STOP_BUDGET_MS = 6_500;

async function main(): Promise<void> {
  let inputs: ReturnType<typeof readInputs>;
  try {
    inputs = readInputs(
      (name) => core.getInput(name),
      (path) => readFileSync(path, "utf8"),
    );
  } catch (error) {
    if (error instanceof InputError) {
      core.setFailed(error.message);
      return;
    }
    throw error;
  }
  // Sign in with the job's GitHub Actions identity: the token of the pull request author's user,
  // and the review App's token for this repository.
  let accessRefusal: AccessRefusalInfo | null = null;
  if (inputs.archestraAuth === "github-actions") {
    const exchange = await exchangeGitHubActionsToken({
      gatewayUrl: inputs.gatewayUrl,
      getIdToken: (audience) => core.getIDToken(audience),
    });
    if (exchange.ok) {
      core.setSecret(exchange.accessToken);
      if (exchange.githubToken) core.setSecret(exchange.githubToken);
      core.saveState(TOKEN_STATE, exchange.accessToken);
      inputs = { ...inputs, token: exchange.accessToken, githubToken: exchange.githubToken ?? inputs.githubToken };
      core.info(`Signed in to Archestra as the GitHub user ${exchange.githubLogin ?? "(unknown)"}.`);
    } else {
      accessRefusal = { reason: exchange.reason, message: exchange.message, login: exchange.login };
    }
  }
  // Mask the secrets in all log output, also in error messages.
  if (inputs.token) core.setSecret(inputs.token);
  if (inputs.fixToken) core.setSecret(inputs.fixToken);
  if (inputs.cloneToken) core.setSecret(inputs.cloneToken);

  const environment = readEnvironment(process.env, (path) => readFileSync(path, "utf8"));
  const log = {
    info: (message: string) => core.info(message),
    warning: (message: string) => core.warning(message),
    error: (message: string) => core.error(message),
    debug: (message: string) => core.debug(message),
  };
  const ctx: ActionContext = {
    inputs,
    repo: environment.repo,
    eventName: environment.eventName,
    payload: environment.payload,
    runAttempt: environment.runAttempt,
    serverUrl: environment.serverUrl,
    workflowRunUrl: environment.workflowRunUrl,
    progressImageUrl: environment.progressImageUrl,
    gh: createOctokit(inputs.githubToken, { baseUrl: environment.apiUrl }),
    ghFix: inputs.fixToken ? createOctokit(inputs.fixToken, { baseUrl: environment.apiUrl }) : null,
    archestra: new ArchestraClient({ gatewayUrl: inputs.gatewayUrl, token: inputs.token }),
    log,
    clock: { now: () => Date.now(), sleep: (ms) => sleep(ms).then(() => undefined) },
    random: Math.random,
    saveLiveRun: (runId) => {
      liveRunId = runId;
      core.saveState(LIVE_RUN_STATE, runId ?? "");
    },
    saveJob: (job) => {
      savedJob = job;
      core.saveState(JOB_STATE, JSON.stringify(job));
    },
    isStopping: () => stopping,
    accessRefusal,
    startedAt: Date.now(),
  };

  let liveRunId: string | null = null;
  let savedJob: SavedJob | null = null;
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    core.warning(`The job was canceled (${signal}): stopping the live run and recording the job.`);
    const work = (async () => {
      if (liveRunId) await cancelIfLive(ctx.archestra, liveRunId, log);
      if (savedJob) {
        await recordStoppedJob({
          // Short retries: the runner kills the step a few seconds after the signal.
          gh: createOctokit(inputs.githubToken, { baseUrl: environment.apiUrl, retryDelaysMs: [500] }),
          repo: ctx.repo,
          job: savedJob,
          render: { repoUrl: repoUrl(ctx), command: commentCommand(inputs), progressImageUrl: ctx.progressImageUrl },
          now: Date.now(),
          log,
        });
      }
      core.saveState(DONE_STATE, "true");
    })();
    await Promise.race([work, sleep(STOP_BUDGET_MS)]);
    process.exit(1);
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));

  let result: ActionResult;
  try {
    result = await run(ctx);
  } finally {
    if (!stopping) core.saveState(DONE_STATE, "true");
  }
  setOutputs(result);
  if (result.summary) {
    try {
      await core.summary.addRaw(result.summary).write();
    } catch (error) {
      core.debug(`No job summary: ${errorMessage(error)}`);
    }
  }
  if (result.failure) core.setFailed(result.failure);
}

function setOutputs(result: ActionResult): void {
  core.setOutput("status", result.status);
  core.setOutput("mode", result.mode);
  core.setOutput("agent-id", result.agentId ?? "");
  core.setOutput("run-id", result.runId ?? "");
  core.setOutput("run-url", result.runUrl ?? "");
  core.setOutput("findings-count", result.findingsCount === null ? "" : String(result.findingsCount));
  core.setOutput("attempts", JSON.stringify(result.attempts));
  core.setOutput("pushed-commits", JSON.stringify(result.pushedCommits));
  core.setOutput("applied", JSON.stringify(result.applied));
  core.setOutput("skipped", JSON.stringify(result.skipped));
  core.setOutput("triage", JSON.stringify(result.triage ?? []));
}

main().catch((error) => {
  core.setFailed(`The action stopped with an error: ${errorMessage(error)}`);
});
