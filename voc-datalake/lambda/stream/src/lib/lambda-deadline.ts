/**
 * The epoch-ms instant this Lambda invocation is cut off, read from the
 * runtime's context object (`getRemainingTimeInMillis`). Undefined when the
 * context is absent or not shaped like the Lambda context (tests, local runs):
 * callers then fall back to their own bounded cap.
 */
export function invocationDeadlineMs(context: unknown, nowMs: number): number | undefined {
  if (typeof context !== 'object' || context === null || !('getRemainingTimeInMillis' in context)) return undefined;
  const remaining = context.getRemainingTimeInMillis;
  if (typeof remaining !== 'function') return undefined;
  const value: unknown = remaining.call(context);
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? nowMs + value : undefined;
}
