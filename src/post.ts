import * as core from "@actions/core";
import { ArchestraClient } from "./archestra/client";
import { cancelIfLive } from "./cancel";
import { errorMessage } from "./util";

// The post step runs after the job, also when the main step was canceled
// (cancel-in-progress) or timed out. It cancels the run that the main step
// recorded as live, so a canceled workflow does not leave a runtime working.

async function post(): Promise<void> {
  const taskId = core.getState("live-task-id");
  if (!taskId) return;
  const archestraUrl = core.getInput("archestra-url");
  const apiKey = core.getInput("archestra-api-key");
  if (!archestraUrl || !apiKey) return;
  core.setSecret(apiKey);
  const client = new ArchestraClient({ baseUrl: archestraUrl, apiKey, requestTimeoutMs: 20_000 });
  await cancelIfLive(client, taskId, {
    info: (message) => core.info(message),
    warning: (message) => core.warning(message),
    error: (message) => core.error(message),
    debug: (message) => core.debug(message),
  });
}

post().catch((error) => {
  // The post step never fails the job.
  core.warning(`Post step: ${errorMessage(error)}`);
});
