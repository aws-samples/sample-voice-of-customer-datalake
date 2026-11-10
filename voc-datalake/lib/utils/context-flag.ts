/**
 * Strict parsing of a boolean CDK context flag (`-c key=true|false` or a JSON boolean in cdk.context.json).
 *
 * CLI context arrives as strings, so `"true"`/`"false"` are accepted case-insensitively and trimmed.
 * Anything else throws at synth: a typo like `-c protectData=ture` must fail loudly rather than
 * deploy the opposite of what the operator asked for.
 */
export function booleanContextFlag(contextValue: unknown, key: string, defaultValue: boolean, usage: string): boolean {
  if (contextValue === undefined || contextValue === null) return defaultValue;
  if (contextValue === true || contextValue === false) return contextValue;
  if (typeof contextValue === 'string') {
    const normalized = contextValue.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  throw new Error(`Unrecognized ${key} context value: ${JSON.stringify(contextValue)}. ${usage}`);
}

/**
 * Strict parsing of a non-negative whole-number CDK context value (`-c key=20`, or a JSON number in
 * cdk.context.json). Absent = `defaultValue`; anything but digits (a sign, a fraction, `abc`) throws at
 * synth, so a typo never deploys a different number than the operator meant.
 */
export function nonNegativeIntegerContext(contextValue: unknown, key: string, defaultValue: number, usage: string): number {
  if (contextValue === undefined || contextValue === null) return defaultValue;
  if (typeof contextValue === 'number' && Number.isSafeInteger(contextValue) && contextValue >= 0) return contextValue;
  if (typeof contextValue === 'string' && /^\d{1,9}$/.test(contextValue.trim())) return Number(contextValue.trim());
  throw new Error(`Unrecognized ${key} context value: ${JSON.stringify(contextValue)}. ${usage}`);
}
