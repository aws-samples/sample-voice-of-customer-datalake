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

const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'global.anthropic.claude-sonnet-4-6';

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

export interface ConverseStreamParams {
  messages: Message[];
  systemPrompt: string;
  tools?: Tool[];
  maxTokens?: number;
  thinkingBudget?: number;
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
  } = params;

  const system: SystemContentBlock[] = [{ text: systemPrompt }];

  const command = new ConverseStreamCommand({
    modelId: MODEL_ID,
    messages,
    system,
    toolConfig: tools && tools.length > 0 ? { tools } : undefined,
    inferenceConfig: { maxTokens },
    additionalModelRequestFields: {
      thinking: { type: 'enabled', budget_tokens: thinkingBudget },
    },
  });

  const bedrockClient = getBedrockClient();
  const response = await bedrockClient.send(command);

  if (response.stream) {
    for await (const event of response.stream) {
      yield event;
    }
  }
}
