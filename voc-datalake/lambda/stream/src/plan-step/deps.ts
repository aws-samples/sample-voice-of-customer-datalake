/**
 * What a plan step needs from the outside, injected so every path runs in
 * tests with stubs (no module mocking, no AWS):
 *
 *   - `invoke`: one route on a domain function as the step's claims, ANY method
 *     (writes too) — the plan-step write invoker; reads of think-step tools go
 *     through the catalogue's own read-only invoker instead;
 *   - `catalogue`: the assistant tool catalogue (tool definitions exist once);
 *   - `converse` + `resolveModel`: Bedrock Converse on the `agent_worker` surface;
 *   - `lookupStoreApp`: does an App Store id / Google Play package exist (create_app_connector, #38).
 */
import { ConverseCommand, type ConverseCommandOutput, type Message, type SystemContentBlock, type Tool } from '@aws-sdk/client-bedrock-runtime';
import type { AssistantToolDefinition, CallerClaims } from '../assistant/types.js';
import type { ApiCall } from '../assistant/tools/internal-api.js';
import { invocationModelId } from '../bedrock/model-override.js';
import type { StoreLookupFn } from '../assistant/tools/client/store-app-check.js';

export interface PlanStepDeps {
  invoke(call: ApiCall, claims: CallerClaims): Promise<unknown>;
  catalogue: readonly AssistantToolDefinition[];
  converse(command: ConverseCommand): Promise<ConverseCommandOutput>;
  /** The `agent_worker` model (admin override, else the surface default). */
  resolveModel(): Promise<string>;
  lookupStoreApp: StoreLookupFn;
}

/** The step agents' surface in the admin model picker (shared/model_config.py). */
export const PLAN_STEP_SURFACE = 'agent_worker';

export interface ConverseRequest {
  modelId: string;
  system: string;
  messages: Message[];
  maxTokens: number;
  tools?: Tool[];
}

/**
 * One Converse command. No `temperature` and no thinking budget: the current
 * allowlisted models reject both (docs: shared/converse.py), and the older ones
 * run fine without.
 */
export function converseCommand(request: ConverseRequest): ConverseCommand {
  const system: SystemContentBlock[] = [{ text: request.system }];
  return new ConverseCommand({
    modelId: invocationModelId(request.modelId),
    system,
    messages: request.messages,
    inferenceConfig: { maxTokens: request.maxTokens },
    ...(request.tools === undefined || request.tools.length === 0 ? {} : { toolConfig: { tools: request.tools } }),
  });
}

