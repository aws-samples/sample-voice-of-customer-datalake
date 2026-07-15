/**
 * Bedrock ConverseStreamCommand wrapper.
 */
import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type Message,
  type SystemContentBlock,
  type Tool,
  type ConverseStreamOutput,
} from '@aws-sdk/client-bedrock-runtime';
import { usesAdaptiveThinking } from './model-override.js';

// Fallback when no per-surface override is configured and no env is set.
// The 'chat' surface default is Sonnet 5 (kept in sync with model_config.py).
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'global.anthropic.claude-sonnet-5';

const clientHolder: { instance: BedrockRuntimeClient | null } = { instance: null };

export function getBedrockClient(): BedrockRuntimeClient {
  if (!clientHolder.instance) {
    clientHolder.instance = new BedrockRuntimeClient({
      requestHandler: {
        requestTimeout: 300_000, // 5 min
      },
    });
  }
  return clientHolder.instance;
}

interface ConverseStreamParams {
  messages: Message[];
  systemPrompt: string;
  tools?: Tool[];
  maxTokens?: number;
  thinkingBudget?: number;
  /** Admin-configured model override (per-surface); falls back to the env default. */
  modelId?: string;
}

export async function* converseStream(
  params: ConverseStreamParams,
): AsyncGenerator<ConverseStreamOutput> {
  const {
    messages,
    systemPrompt,
    tools,
    maxTokens = 16000,
    thinkingBudget = 5000,
    modelId,
  } = params;

  const resolvedModel = modelId ?? MODEL_ID;
  const system: SystemContentBlock[] = [{ text: systemPrompt }];

  const command = new ConverseStreamCommand({
    modelId: resolvedModel,
    messages,
    system,
    toolConfig: tools && tools.length > 0 ? { tools } : undefined,
    inferenceConfig: { maxTokens },
    // Models with always-on adaptive thinking (Sonnet 5) reject an explicit
    // budget — omit the field and let their thinking run automatically.
    ...(usesAdaptiveThinking(resolvedModel)
      ? {}
      : {
          additionalModelRequestFields: {
            thinking: { type: 'enabled', budget_tokens: thinkingBudget },
          },
        }),
  });

  const bedrockClient = getBedrockClient();
  const response = await bedrockClient.send(command);

  if (response.stream) {
    for await (const event of response.stream) {
      yield event;
    }
  }
}
