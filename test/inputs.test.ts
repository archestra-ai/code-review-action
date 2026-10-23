import { describe, expect, it } from "vitest";
import { InputError, readInputs } from "../src/inputs";
import { AGENT_A, AGENT_B } from "./helpers";

const read = (values: Record<string, string>) =>
  readInputs(
    (name) =>
      ({
        "archestra-gateway-url": "https://archestra.example.com/v1/mcp/code-review",
        "archestra-token": "token",
        agents: `${AGENT_A}, ${AGENT_A}\n${AGENT_B}`,
        "github-token": "ghs_job",
        ...values,
      })[name] ?? "",
    () => "",
  );

describe("readInputs", () => {
  it("reads the gateway, the actor's token and the agents without duplicates", () => {
    expect(read({})).toMatchObject({
      gatewayUrl: "https://archestra.example.com/v1/mcp/code-review",
      token: "token",
      tokenSource: "actor",
      agents: [AGENT_A, AGENT_B],
      maxFallbacks: 1,
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
    expect(read({ "fallback-token": "shared", "fallback-agents": AGENT_B })).toMatchObject({
      token: "token",
      tokenSource: "actor",
      agents: [AGENT_A, AGENT_B],
    });
  });

  it("uses the fallback token and its agents when the actor has no token", () => {
    expect(read({ "archestra-token": "", "fallback-token": "shared", "fallback-agents": AGENT_B })).toMatchObject({
      token: "shared",
      tokenSource: "fallback",
      agents: [AGENT_B],
    });
  });

  it("accepts no token at all; the run skips later", () => {
    expect(read({ "archestra-token": "" })).toMatchObject({ token: "", tokenSource: null });
  });

  it("rejects an agent value that is not an ID", () => {
    expect(() => read({ agents: "claude-code" })).toThrow(InputError);
    expect(() => read({ "archestra-token": "", "fallback-token": "x", "fallback-agents": "x" })).toThrow(
      /fallback-agents/,
    );
  });

  it("reads fix-commands, and rejects a value that is not a boolean", () => {
    expect(read({}).fixCommands).toBe(true);
    expect(read({ "fix-commands": "false" }).fixCommands).toBe(false);
    expect(read({ "fix-commands": "true" }).fixCommands).toBe(true);
    expect(() => read({ "fix-commands": "maybe" })).toThrow(InputError);
  });
});
