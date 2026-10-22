import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import * as core from "@actions/core";
import { ArchestraClient } from "./archestra/client";
import type { ActionContext, ActionResult } from "./context";
import { readEnvironment } from "./env";
import { createOctokit } from "./github/octokit";
import { InputError, readInputs } from "./inputs";
import { run } from "./run";
import { errorMessage } from "./util";

export const LIVE_TASK_STATE = "live-task-id";

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
  // Mask the secrets in all log output, also in error messages.
  core.setSecret(inputs.apiKey);
  if (inputs.fixToken) core.setSecret(inputs.fixToken);

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
    gh: createOctokit(inputs.githubToken, { baseUrl: environment.apiUrl }),
    ghFix: inputs.fixToken ? createOctokit(inputs.fixToken, { baseUrl: environment.apiUrl }) : null,
    archestra: new ArchestraClient({ baseUrl: inputs.archestraUrl, apiKey: inputs.apiKey }),
    log,
    clock: { now: () => Date.now(), sleep: (ms) => sleep(ms).then(() => undefined) },
    random: Math.random,
    saveLiveTask: (taskId) => core.saveState(LIVE_TASK_STATE, taskId ?? ""),
    startedAt: Date.now(),
  };

  const result = await run(ctx);
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
