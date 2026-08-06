/**
 * Guard for the us-east-1 AI-enablement stack (VocWebSearchStack), which hosts
 * two independently switchable halves: the web-search AgentCore Gateway and
 * Bedrock model access.
 *
 * Both halves off is a REACHABLE combination in the normal deploy path — an
 * account that already has Bedrock access omits `anthropicUseCase` from
 * cdk.context.json, and an operator who does not want web search passes
 * `-c enableWebSearch=false`. Constructing the stack in that case produces a
 * stack with no resources, and `scripts/convert-template.mjs` strips
 * CDKMetadata, so the workshop artifact would be an invalid `Resources: {}`.
 *
 * Hence: decide whether to construct the stack at all, rather than letting it
 * synthesize empty. Kept as a named function so the hazard is greppable and
 * covered by a test, instead of an unexplained `||` in bin/voc-datalake.ts.
 */
export function shouldDeployAiEnablement(
  deployWebSearch: boolean,
  anthropicUseCase: unknown,
): boolean {
  return deployWebSearch || anthropicUseCase !== undefined;
}
