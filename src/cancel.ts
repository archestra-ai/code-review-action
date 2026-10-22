import { type ArchestraClient, isTerminalState } from "./archestra/client";
import { errorMessage, type Logger } from "./util";

/** Cancels the run when it is still live. Never throws. */
export async function cancelIfLive(
  client: ArchestraClient,
  taskId: string,
  log: Logger,
): Promise<"canceled" | "not-live" | "failed"> {
  try {
    const run = await client.getRun(taskId);
    if (isTerminalState(run.state)) {
      log.info(`Run ${taskId} is already ${run.state.replace("TASK_STATE_", "")}.`);
      return "not-live";
    }
    await client.cancelRun(taskId);
    log.info(`Canceled the live run ${taskId}.`);
    return "canceled";
  } catch (error) {
    log.warning(`Could not cancel run ${taskId}: ${errorMessage(error)}`);
    return "failed";
  }
}
