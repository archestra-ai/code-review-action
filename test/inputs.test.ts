import { describe, expect, it } from "vitest";
import { InputError, readInputs } from "../src/inputs";

const read = (values: Record<string, string>) =>
  readInputs(
    (name) =>
      ({
        "archestra-gateway-url": "https://archestra.example.com/v1/mcp/code-review",
        "archestra-token": "token",
        "github-token": "ghs_job",
        ...values,
      })[name] ?? "",
    () => "",
  );

describe("readInputs", () => {
  it("reads the gateway and the actor's token", () => {
    expect(read({})).toMatchObject({
      gatewayUrl: "https://archestra.example.com/v1/mcp/code-review",
      token: "token",
      tokenSource: "actor",
    });
  });

  it.each([
    ["not a url", /not a valid URL/],
    ["ftp://archestra.example.com/v1/mcp/code-review", /https or http/],
    ["https://archestra.example.com", /MCP gateway endpoint/],
    ["https://archestra.example.com/api/agents", /MCP gateway endpoint/],
  ])("rejects the gateway URL %s", (url, message) => {
    expect(() => read({ "archestra-gateway-url": url })).toThrow(message);
  });

  it("prefers the actor's token over the fallback token", () => {
    expect(read({ "fallback-token": "shared" })).toMatchObject({
      token: "token",
      tokenSource: "actor",
    });
  });

  it("uses the fallback token when the actor has no token", () => {
    expect(read({ "archestra-token": "", "fallback-token": "shared" })).toMatchObject({
      token: "shared",
      tokenSource: "fallback",
    });
  });

  it("accepts no token at all; the run skips later", () => {
    expect(read({ "archestra-token": "" })).toMatchObject({ token: "", tokenSource: null });
  });

  it("reads fix-commands, and rejects a value that is not a boolean", () => {
    expect(read({}).fixCommands).toBe(true);
    expect(read({ "fix-commands": "false" }).fixCommands).toBe(false);
    expect(read({ "fix-commands": "true" }).fixCommands).toBe(true);
    expect(() => read({ "fix-commands": "maybe" })).toThrow(InputError);
  });
});
