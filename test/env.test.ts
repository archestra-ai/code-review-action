import { describe, expect, it } from "vitest";
import { readEnvironment } from "../src/env";

const base = {
  GITHUB_REPOSITORY: "acme/widgets",
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_EVENT_PATH: "/event.json",
  GITHUB_RUN_ID: "7",
};
const readFile = () => "{}";

describe("readEnvironment", () => {
  it("serves the progress image from the action's repository at the pinned revision", () => {
    const env = readEnvironment(
      {
        ...base,
        GITHUB_ACTION_REPOSITORY: "archestra-ai/code-review-action",
        GITHUB_ACTION_REF: "57f545b3f6874a3876039e8d8239ee780b15a5c7",
      },
      readFile,
    );
    expect(env.progressImageUrl).toBe(
      "https://raw.githubusercontent.com/archestra-ai/code-review-action/57f545b3f6874a3876039e8d8239ee780b15a5c7/assets/progress.gif",
    );
    expect(env.workflowRunUrl).toBe("https://github.com/acme/widgets/actions/runs/7");
  });

  it("keeps a fork's repository and a tag", () => {
    const env = readEnvironment(
      { ...base, GITHUB_ACTION_REPOSITORY: "acme/review-fork", GITHUB_ACTION_REF: "v1" },
      readFile,
    );
    expect(env.progressImageUrl).toBe("https://raw.githubusercontent.com/acme/review-fork/v1/assets/progress.gif");
  });

  it("falls back to the published action's main branch outside a uses step or with an odd value", () => {
    expect(readEnvironment(base, readFile).progressImageUrl).toBe(
      "https://raw.githubusercontent.com/archestra-ai/code-review-action/main/assets/progress.gif",
    );
    const odd = readEnvironment(
      { ...base, GITHUB_ACTION_REPOSITORY: "../evil", GITHUB_ACTION_REF: 'x" onerror="y' },
      readFile,
    );
    expect(odd.progressImageUrl).toBe(
      "https://raw.githubusercontent.com/archestra-ai/code-review-action/main/assets/progress.gif",
    );
  });
});
