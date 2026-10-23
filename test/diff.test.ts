import { describe, expect, it } from "vitest";
import { buildDiffIndex, excerptFor, MAX_EXCERPT_LINES } from "../src/github/diff";

describe("excerpts", () => {
  const patch =
    "@@ -10,4 +10,6 @@ export function upload() {\n   const a = 1;\n-  send(a);\n+  for (let i = 0; i < 3; i++) {\n+    send(a);\n+  }\n   return a;\n }";
  const file = { filename: "src/upload.ts", status: "modified", additions: 3, deletions: 1, patch };
  const files = buildDiffIndex([file]);

  it("quotes the head-side lines of a finding from the patch", () => {
    expect(excerptFor(files, { file: "src/upload.ts", line: 11, end_line: 13 })).toBe(
      "for (let i = 0; i < 3; i++) {\n    send(a);\n  }".replace(/^/, "  "),
    );
    expect(excerptFor(files, { file: "src/upload.ts", line: 10 })).toBe("  const a = 1;");
  });

  it("gives no excerpt for a file or a line outside the diff", () => {
    expect(excerptFor(files, { file: "src/other.ts", line: 1 })).toBeNull();
    expect(excerptFor(files, { file: "src/upload.ts", line: 9, end_line: 11 })).toBeNull();
    expect(excerptFor(files, { file: "src/upload.ts", line: 15, end_line: 16 })).toBeNull();
  });

  it("keeps the first lines of a long range and marks the rest", () => {
    const long = ["@@ -1,0 +1,20 @@", ...Array.from({ length: 20 }, (_, i) => `+line ${i + 1}`)].join("\n");
    const excerpt = excerptFor(buildDiffIndex([{ ...file, patch: long }]), {
      file: "src/upload.ts",
      line: 1,
      end_line: 20,
    });
    expect(excerpt?.split("\n")).toHaveLength(MAX_EXCERPT_LINES + 1);
    expect(excerpt?.endsWith("\nline 12\n…")).toBe(true);
  });
});
