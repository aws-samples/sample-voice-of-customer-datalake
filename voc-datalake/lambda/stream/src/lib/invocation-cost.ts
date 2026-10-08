/**
 * One `invocation_cost` log line per invocation: the CPU the run used.
 *
 * The sizing policy (docs/lambda-sizing.md) caps every function at 70 % of its
 * CPU share, and Lambda's REPORT line has no CPU figure. Every Python Lambda
 * emits this line through `lambda/shared/invocation_cost.py`; this is the same
 * line with the SAME field names, so one Logs Insights query
 * (`filter message = "invocation_cost"`, scripts/capacity/capacity-query.sh)
 * covers the stream too. Numbers only — never the event, a prompt or an answer.
 *
 * `process.cpuUsage()` is the whole process (user + system), which is right
 * here: a Lambda execution environment runs one invocation at a time.
 */

/** The message Logs Insights filters on. */
export const COST_LINE = 'invocation_cost';

/** Lambda allocates one full vCPU at 1,769 MB. */
export const MB_PER_VCPU = 1769;

export interface InvocationCostFields {
  message: typeof COST_LINE;
  cpu_ms: number;
  wall_ms: number;
  function_memory_size?: number;
  cpu_pct_of_allocation?: number;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** The configured MB from `AWS_LAMBDA_FUNCTION_MEMORY_SIZE`, or undefined when absent or not a positive integer. */
export function memoryMb(raw: string | undefined): number | undefined {
  // String(undefined) is 'undefined', which the pattern rejects like any other non-integer.
  if (!/^\d+$/.test(String(raw))) return undefined;
  const value = Number(raw);
  return value > 0 ? value : undefined;
}

/** The line for one invocation (pure; mirrors `invocation_cost_fields` in Python). */
export function invocationCostFields(memory: number | undefined, cpuMs: number, wallMs: number): InvocationCostFields {
  const fields: InvocationCostFields = { message: COST_LINE, cpu_ms: round1(cpuMs), wall_ms: round1(wallMs) };
  if (memory === undefined) return fields;
  fields.function_memory_size = memory;
  if (wallMs > 0) fields.cpu_pct_of_allocation = round1((cpuMs / (wallMs * (memory / MB_PER_VCPU))) * 100);
  return fields;
}

export interface CostClock {
  cpuUsage: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage;
  nowMs: () => number;
  memoryMb: () => number | undefined;
  log: (line: string) => void;
}

const realClock: CostClock = {
  cpuUsage: (previous) => process.cpuUsage(previous),
  nowMs: () => performance.now(),
  memoryMb: () => memoryMb(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE),
  log: (line) => console.log(line),
};

/** Wrap a handler so each invocation logs one cost line, also when it throws. */
export function measureInvocationCost<A extends unknown[], R>(
  handler: (...args: A) => Promise<R>,
  clock: CostClock = realClock,
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    const cpuStart = clock.cpuUsage();
    const wallStart = clock.nowMs();
    try {
      return await handler(...args);
    } finally {
      const cpu = clock.cpuUsage(cpuStart);
      const cpuMs = (cpu.user + cpu.system) / 1000;
      clock.log(JSON.stringify(invocationCostFields(clock.memoryMb(), cpuMs, clock.nowMs() - wallStart)));
    }
  };
}
