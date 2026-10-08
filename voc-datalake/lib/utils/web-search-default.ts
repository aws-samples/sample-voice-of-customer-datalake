import type { InferenceScope } from './inference-scope';

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

/**
 * `enableWebSearch` under an inference scope (docs/eu-deployment.md). The
 * web-search connector exists only in us-east-1, so an EU deployment never
 * deploys it: absent → off, `false` → off, an explicit `true` throws rather than
 * quietly sending queries out of the EU. `global` keeps the default-on semantics
 * of {@link shouldDeployWebSearch}.
 */
export function shouldDeployWebSearchInScope(contextValue: unknown, scope: InferenceScope): boolean {
  const requested = shouldDeployWebSearch(contextValue);
  if (scope !== 'eu') return requested;
  // Absent means "the default", which is on for global — only an explicit true is a conflict.
  const explicitlyEnabled = requested && contextValue !== undefined && contextValue !== null;
  if (explicitlyEnabled) {
    throw new Error(
      'enableWebSearch=true cannot be combined with inferenceScope=eu: the web-search connector runs only in ' +
      'us-east-1. Drop -c enableWebSearch (it is off by default for eu) — see docs/eu-deployment.md.',
    );
  }
  return false;
}
