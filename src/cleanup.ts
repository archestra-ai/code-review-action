import type { ArchestraClient } from "./archestra/client";
import { errorMessage, type Logger } from "./util";

/**
 * Deletes the workspaces of the runs a job started, once their work is done:
 * a review's files have no reader after the review posts, and a kept
 * workspace holds its volume until it expires. A run that is still stopping
 * cannot be deleted yet; that is logged, and the run's own limits end it.
 */
export async function deleteRunWorkspaces(
  client: ArchestraClient,
  runIds: Array<string | null | undefined>,
  log: Logger,
): Promise<string[]> {
  const deleted: string[] = [];
  for (const runId of new Set(runIds.filter((runId): runId is string => Boolean(runId)))) {
    try {
      await client.deleteWorkspace(runId);
      deleted.push(runId);
      log.info(`Deleted the workspace of run ${runId}.`);
    } catch (error) {
      log.warning(`Could not delete the workspace of run ${runId}: ${errorMessage(error)}`);
    }
  }
  return deleted;
}
