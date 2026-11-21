/**
 * The relay's log line: one JSON object per event on stdout, which AgentCore Runtime sends to the runtime's log group.
 * Ids, counts and error names only (TENETS.md D8): never audio, a transcript's text, the prompt or the evidence, so the
 * fields are primitives and every caller passes an id, a number or an error's name.
 */
export function logEvent(event: string, fields: Readonly<Record<string, string | number | boolean>> = {}): void {
  console.log(JSON.stringify({ voice: event, ...fields }));
}
