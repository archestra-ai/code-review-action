import { type ArchestraClient, isTerminalState } from "./archestra/client";
import { errorMessage, type Logger } from "./util";

/** Cancels the run when it is still live. Never throws. */
export async function cancelIfLive(
  client: ArchestraClient,
  runId: string,
  log: Logger,
): Promise<"canceled" | "not-live" | "failed"> {
  try {
    const run = await client.getRun(runId);
    if (isTerminalState(run.state)) {
      log.info(`Run ${runId} is already ${run.state}.`);
      return "not-live";
    }
    await client.cancelRun(runId);
    log.info(`Canceled the live run ${runId}.`);
    return "canceled";
  } catch (error) {
    log.warning(`Could not cancel run ${runId}: ${errorMessage(error)}`);
    return "failed";
  }
}
