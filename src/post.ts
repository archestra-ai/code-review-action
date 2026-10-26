import { readFileSync } from "node:fs";
import * as core from "@actions/core";
import { ArchestraClient } from "./archestra/client";
import { cancelIfLive } from "./cancel";
import { readEnvironment } from "./env";
import { createOctokit } from "./github/octokit";
import { parseSavedJob, recordStoppedJob } from "./stopped";
import { errorMessage } from "./util";

// The post step runs after the job, also when the main step was canceled
// (cancel-in-progress) or timed out. The main step stops the live run and
// records itself when the runner signals the cancel; this step repeats what
// did not happen: it cancels the live run, and it records the stopped job in
// the review comment. A private gateway behind a tunnel step of the job may
// be gone by now; the comment is still reachable.

const log = {
  info: (message: string) => core.info(message),
  warning: (message: string) => core.warning(message),
  error: (message: string) => core.error(message),
  debug: (message: string) => core.debug(message),
};

async function post(): Promise<void> {
  if (core.getState("done") === "true") return;
  const runId = core.getState("live-run-id");
  const gatewayUrl = core.getInput("archestra-gateway-url");
  // The same choice as the main step: the actor's token, else the fallback.
  const token = core.getInput("archestra-token") || core.getInput("fallback-token");
  if (runId && gatewayUrl && token) {
    core.setSecret(token);
    const client = new ArchestraClient({ gatewayUrl, token, requestTimeoutMs: 20_000 });
    await cancelIfLive(client, runId, log);
  }
  const job = parseSavedJob(core.getState("job"));
  const githubToken = core.getInput("github-token");
  if (!job || !githubToken) return;
  core.setSecret(githubToken);
  const environment = readEnvironment(process.env, (path) => readFileSync(path, "utf8"));
  const fixCommands = !/^(false|no|0)$/i.test(core.getInput("fix-commands").trim());
  await recordStoppedJob({
    gh: createOctokit(githubToken, { baseUrl: environment.apiUrl, retryDelaysMs: [1_000] }),
    repo: environment.repo,
    job,
    render: {
      repoUrl: `${environment.serverUrl}/${environment.repo.owner}/${environment.repo.repo}`,
      command: fixCommands ? core.getInput("fix-command").trim() || "/archestra" : null,
      progressImageUrl: environment.progressImageUrl,
    },
    now: Date.now(),
    log,
  });
}

post().catch((error) => {
  // The post step never fails the job.
  core.warning(`Post step: ${errorMessage(error)}`);
});
