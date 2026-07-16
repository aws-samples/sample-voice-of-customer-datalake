/**
 * Web-search deployment default (issue #205) — SINGLE SOURCE OF TRUTH for
 * the `enableWebSearch` context flag's semantics (bin/voc-datalake.ts,
 * web-search-stack.ts and docs/deployment.md defer here).
 *
 * VocWebSearchStack deploys UNLESS explicitly opted out. CLI context
 * arrives as strings, so string forms are accepted case-insensitively.
 * Anything unrecognized throws at synth: under a default-ON paradigm a
 * typo like `-c enableWebSearch=flase` must not silently deploy a stack
 * the operator tried to disable (nor silently skip one they tried to
 * force) — fail loud, not open.
 */
export function shouldDeployWebSearch(contextValue: unknown): boolean {
  if (contextValue === undefined || contextValue === null) return true;
  if (contextValue === true || contextValue === false) return contextValue;
  if (typeof contextValue === 'string') {
    const normalized = contextValue.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  throw new Error(
    `Unrecognized enableWebSearch context value: ${JSON.stringify(contextValue)}. ` +
    "Use true/false (web search deploys by default; opt out with -c enableWebSearch=false).",
  );
}
