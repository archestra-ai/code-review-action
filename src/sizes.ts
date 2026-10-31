import type { RunLimits } from "./archestra/client";

/**
 * The memory limit a run's failure reason names, in GiB. The platform writes
 * "reached its memory limit of 8 GiB" for a kill inside the pod and
 * "memory limit 8Gi" for a container the kernel took down; older deployments
 * name none.
 */
export function memoryLimitGib(reason: string): number | null {
  const match = reason.match(/memory limit(?: of)? (\d+(?:\.\d+)?) ?(GiB|Gi|MiB|Mi)\b/i);
  if (!match) return null;
  const amount = Number(match[1]);
  return /^Mi/i.test(match[2] as string) ? amount / 1024 : amount;
}

/** Without a figure in the reason, the retry asks for twice what the killed run asked for. */
const DEFAULT_REQUEST_GIB = 4;

/**
 * The limits to ask for after a memory kill: the same request with more memory
 * than the killed run had. A tier's memory request is half its limit (the
 * platform gives a tier twice its request as the limit, or less under a CPU
 * limit), so one GiB above half the limit named in the reason is the smallest
 * tier that holds more. Without a figure, twice the memory the previous request
 * implied: its `minMemoryGib`, else 2 GiB per requested CPU.
 */
export function largerLimits(previous: RunLimits | null, reason: string): RunLimits {
  const limitGib = memoryLimitGib(reason);
  const implied = previous?.minMemoryGib ?? (previous?.minCpu ? previous.minCpu * 2 : DEFAULT_REQUEST_GIB);
  const minMemoryGib = limitGib !== null ? Math.floor(limitGib / 2) + 1 : implied * 2;
  const { tier: _tier, ...rest } = previous ?? {};
  return { ...rest, minMemoryGib: Math.max(minMemoryGib, (previous?.minMemoryGib ?? 0) + 1) };
}
