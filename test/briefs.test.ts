import { describe, expect, it } from "vitest";
import { BRIEFS, type BriefName, MAX_MESSAGE_BYTES, renderBrief } from "../src/briefs";

describe("briefs", () => {
  it.each(Object.keys(BRIEFS) as BriefName[])("renders %s under the message limit with the longest values", (name) => {
    // Every placeholder gets a value as long as the action allows (a title is at most 200 characters).
    const placeholders = [...new Set([...BRIEFS[name].matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1] as string))];
    const values = Object.fromEntries(placeholders.map((key) => [key, "x".repeat(200)]));
    const text = renderBrief(name, values);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(text).not.toContain("{{");
  });
});
