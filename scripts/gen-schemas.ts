// Writes the JSON Schema files of the runtime result contracts to schemas/.
// Run with `npm run schemas`; CI checks that the files are up to date.
import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { CONTRACTS } from "../src/contracts";

mkdirSync("schemas", { recursive: true });
for (const { file, schema } of Object.values(CONTRACTS)) {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" });
  const name = file.replace(/\.json$/, ".schema.json");
  writeFileSync(`schemas/${name}`, `${JSON.stringify({ $id: name, title: file, ...json }, null, 2)}\n`);
  console.log(`schemas/${name}`);
}
