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
