import { describe, expect, it } from "vitest";
import { DEFAULT_PROGRESS_IMAGE_URL, readEnvironment } from "../src/env";

const base = {
  GITHUB_REPOSITORY: "acme/widgets",
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_EVENT_PATH: "/event.json",
  GITHUB_RUN_ID: "7",
  GITHUB_ACTION_REPOSITORY: "archestra-ai/code-review-action",
  GITHUB_ACTION_REF: "57f545b3f6874a3876039e8d8239ee780b15a5c7",
};
const readFile = () => "{}";

describe("readEnvironment", () => {
  it("serves the progress image from the published action at the pinned revision", () => {
    const env = readEnvironment(base, readFile);
    expect(env.progressImageUrl).toBe(
      "https://raw.githubusercontent.com/archestra-ai/code-review-action/57f545b3f6874a3876039e8d8239ee780b15a5c7/assets/progress.gif",
    );
    expect(env.workflowRunUrl).toBe("https://github.com/acme/widgets/actions/runs/7");
    expect(readEnvironment({ ...base, GITHUB_ACTION_REF: "v1" }, readFile).progressImageUrl).toBe(
      "https://raw.githubusercontent.com/archestra-ai/code-review-action/v1/assets/progress.gif",
    );
    expect(readEnvironment({ ...base, GITHUB_ACTION_REF: "fix/header" }, readFile).progressImageUrl).toBe(
      "https://raw.githubusercontent.com/archestra-ai/code-review-action/fix/header/assets/progress.gif",
    );
  });

  it("shows the default image for a fork, an enterprise server, a local action or an odd ref", () => {
    const cases: NodeJS.ProcessEnv[] = [
      { ...base, GITHUB_ACTION_REPOSITORY: "acme/review-fork" },
      { ...base, GITHUB_SERVER_URL: "https://ghe.corp" },
      { ...base, GITHUB_ACTION_REPOSITORY: undefined, GITHUB_ACTION_REF: undefined },
      { ...base, GITHUB_ACTION_REF: "a/b/c/d" },
      { ...base, GITHUB_ACTION_REF: "../../main" },
      { ...base, GITHUB_ACTION_REF: 'x" onerror="y' },
    ];
    for (const env of cases) {
      expect(readEnvironment(env, readFile).progressImageUrl).toBe(DEFAULT_PROGRESS_IMAGE_URL);
    }
    expect(DEFAULT_PROGRESS_IMAGE_URL).toBe(
      "https://raw.githubusercontent.com/archestra-ai/code-review-action/main/assets/progress.gif",
    );
  });
});
