import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vitest/config";

// The bundle loads src/briefs/*.md as text (esbuild "text" loader). This
// plugin gives the tests the same behavior.
const markdownAsText: Plugin = {
  name: "markdown-as-text",
  load(id) {
    if (!id.endsWith(".md")) return null;
    return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
  },
};

export default defineConfig({
  plugins: [markdownAsText],
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
