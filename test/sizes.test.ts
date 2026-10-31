import { describe, expect, it } from "vitest";
import { largerLimits, memoryLimitGib } from "../src/sizes";

describe("memoryLimitGib", () => {
  it("reads the limit the platform names, in GiB", () => {
    expect(memoryLimitGib("The agent-runtime container reached its memory limit of 8 GiB (peak usage 8 GiB)")).toBe(8);
    expect(memoryLimitGib("Container agent-runtime: OOMKilled (exit code 137, memory limit 16Gi)")).toBe(16);
    expect(memoryLimitGib("memory limit 2048Mi")).toBe(2);
    expect(memoryLimitGib("pod.oom_killed: Details are withheld under Guardrails")).toBeNull();
  });
});

describe("largerLimits", () => {
  it("asks for one GiB more than half the limit that was hit, and keeps the rest of the request", () => {
    expect(largerLimits({ minCpu: 2, idleTimeoutMinutes: 10 }, "reached its memory limit of 8 GiB")).toEqual({
      minCpu: 2,
      idleTimeoutMinutes: 10,
      minMemoryGib: 5,
    });
    // A tier named in the request would contradict the size; it goes.
    expect(largerLimits({ tier: "S" }, "memory limit 16Gi")).toEqual({ minMemoryGib: 9 });
  });
  it("doubles the memory the previous request implied when the reason names no limit", () => {
    expect(largerLimits({ minCpu: 2 }, "run.unknown")).toEqual({ minCpu: 2, minMemoryGib: 8 });
    expect(largerLimits({ minMemoryGib: 8 }, "run.unknown")).toEqual({ minMemoryGib: 16 });
    expect(largerLimits(null, "run.unknown")).toEqual({ minMemoryGib: 8 });
  });
  it("always asks for more than the previous request", () => {
    expect(largerLimits({ minMemoryGib: 12 }, "memory limit 16Gi")).toEqual({ minMemoryGib: 13 });
  });
});
