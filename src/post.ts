import * as core from "@actions/core";
import { ArchestraClient } from "./archestra/client";
import { cancelIfLive } from "./cancel";
import { errorMessage } from "./util";

// The post step runs after the job, also when the main step was canceled
// (cancel-in-progress) or timed out. It cancels the run that the main step
// recorded as live, so a canceled workflow does not leave a runtime working.

async function post(): Promise<void> {
  const runId = core.getState("live-run-id");
  if (!runId) return;
  const gatewayUrl = core.getInput("archestra-gateway-url");
  // The same choice as the main step: the actor's token, else the fallback.
  const token = core.getInput("archestra-token") || core.getInput("fallback-token");
  if (!gatewayUrl || !token) return;
  core.setSecret(token);
  const client = new ArchestraClient({ gatewayUrl, token, requestTimeoutMs: 20_000 });
  await cancelIfLive(client, runId, {
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
