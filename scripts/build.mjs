// Bundles the action into dist/ (committed, as GitHub requires for
// JavaScript actions). With --scripts it also bundles the developer scripts
// into .build/ (not committed). The output is deterministic, so CI can check
// that dist/ is up to date with `npm run check:dist`.
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  loader: { ".md": "text" },
  logLevel: "warning",
  // Some dependencies still call require(); give them one in the ESM bundle.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
};

await build({
  ...common,
  entryPoints: { index: "src/main.ts", post: "src/post.ts" },
  outdir: "dist",
  legalComments: "eof",
});

if (process.argv.includes("--scripts")) {
  await build({
    ...common,
    entryPoints: {
      "local-run": "scripts/local-run.ts",
      "gen-schemas": "scripts/gen-schemas.ts",
    },
    outdir: ".build",
    packages: "external",
  });
}
