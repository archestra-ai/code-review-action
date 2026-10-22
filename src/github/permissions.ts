import type { RepoRef } from "../util";
import { httpStatus, type Octokit } from "./octokit";

const WRITE_ROLES = new Set(["admin", "maintain", "write"]);

/**
 * True when the user has write, maintain or admin access to the repository.
 * Workflow event filters cannot check this, so the action asks the
 * collaborator permission API.
 */
export async function hasWriteAccess(gh: Octokit, repo: RepoRef, username: string): Promise<boolean> {
  try {
    const { data } = await gh.rest.repos.getCollaboratorPermissionLevel({ ...repo, username });
    const role = (data as { role_name?: string }).role_name ?? data.permission;
    return WRITE_ROLES.has(role);
  } catch (error) {
    if (httpStatus(error) === 404) return false;
    throw error;
  }
}
