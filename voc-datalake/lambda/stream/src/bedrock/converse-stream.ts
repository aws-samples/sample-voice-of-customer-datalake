/**
 * Bedrock ConverseStreamCommand wrapper.
 *
 * ## Prompt caching
 *
 * With `cache: true` (and a model that supports it) up to three Converse cache
 * checkpoints are placed, all with the default (5-minute) TTL:
 *
 *   1. after the tool specs (`toolConfig.tools`) — the toolset is deterministic
 *      for a page's pack list, so it is the most reusable prefix;
 *   2. after the static system block — base rules + tool guidance;
 *   3. at the end of the message at `cacheMessageIndex` — the last flattened
 *      history turn, so a follow-up question re-reads the conversation prefix
 *      from cache.
 *
 * Bedrock allows four checkpoints per request; three leaves one spare. The
 * dynamic system suffix (page, date, time window) sits AFTER checkpoint 2 so a
 * page change does not invalidate the cached base prompt.
 */
import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type ContentBlock,
  type Message,
  type SystemContentBlock,
  type Tool,
  type ConverseStreamOutput,
} from '@aws-sdk/client-bedrock-runtime';
import { invocationModelId, usesAdaptiveThinking } from './model-override.js';
import { CHAT_SURFACE_DEFAULT } from './model-fallback.js';
import { MAX_OUTPUT_TOKENS } from '../history-budget.js';

/**
 * Fallback when no per-surface override is configured and no env is set.
 * The 'chat' surface default is Sonnet 5.5 (kept in sync with model_config.py).
 */
const DEFAULT_CHAT_MODEL_ID = CHAT_SURFACE_DEFAULT;

const DEFAULT_THINKING_BUDGET = 5000;

const clientHolder: { instance?: BedrockRuntimeClient } = {};

export function getBedrockClient(): BedrockRuntimeClient {
  clientHolder.instance ??= new BedrockRuntimeClient({
    requestHandler: {
      // 5 min
      requestTimeout: 300_000,
    },
  });
  return clientHolder.instance;
}

/** The model a call will actually use: explicit override > env > default. */
export function resolveChatModelId(modelId?: string): string {
  return modelId ?? process.env.BEDROCK_MODEL_ID ?? DEFAULT_CHAT_MODEL_ID;
}

/**
 * True when the model accepts Converse `cachePoint` blocks. Every allowlisted
 * model is an Anthropic Claude model, all of which support prompt caching; the
 * check stays local and simple so a non-Claude id never gets a cache block.
 */
export function supportsPromptCache(modelId: string): boolean {
  return modelId.includes('anthropic.claude');
}

export interface ConverseStreamParams {
  messages: Message[];
  /** Static system prompt (cached when `cache` is on). */
  systemPrompt: string;
  /** Per-request system text placed after the static block's cache checkpoint. */
  systemSuffix?: string;
  tools?: Tool[];
  maxTokens?: number;
  thinkingBudget?: number;
  /** Admin-configured model override (per-surface); falls back to the env default. */
  modelId?: string;
  /** Place prompt-cache checkpoints (ignored for models without cache support). */
  cache?: boolean;
  /** Index of the message whose end gets the conversation-prefix checkpoint. */
  cacheMessageIndex?: number;
}

const CACHE_POINT = { cachePoint: { type: 'default' } } as const;

function buildSystem(params: ConverseStreamParams, cache: boolean): SystemContentBlock[] {
  const system: SystemContentBlock[] = [{ text: params.systemPrompt }];
  if (cache) system.push(CACHE_POINT);
  if (params.systemSuffix) system.push({ text: params.systemSuffix });
  return system;
}

function buildTools(tools: Tool[] | undefined, cache: boolean): Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return cache ? [...tools, CACHE_POINT] : tools;
}

/** Copy-on-write: the caller's message array is never mutated. */
function withMessageCachePoint(messages: Message[], index: number | undefined): Message[] {
  if (index === undefined || index < 0 || index >= messages.length) return messages;
  return messages.map((message, i) => {
    if (i !== index) return message;
    const content: ContentBlock[] = [...(message.content ?? []), CACHE_POINT];
    return { ...message, content };
  });
}

export async function* converseStream(
  params: ConverseStreamParams,
): AsyncGenerator<ConverseStreamOutput> {
  const {
    messages,
    tools,
    maxTokens = MAX_OUTPUT_TOKENS,
    thinkingBudget = DEFAULT_THINKING_BUDGET,
  } = params;

  const resolvedModel = resolveChatModelId(params.modelId);
  const cache = params.cache === true && supportsPromptCache(resolvedModel);
  const toolList = buildTools(tools, cache);

  const command = new ConverseStreamCommand({
    // Scoped on the wire only (`eu.` for an EU deployment); everything else uses the canonical id.
    modelId: invocationModelId(resolvedModel),
    messages: cache ? withMessageCachePoint(messages, params.cacheMessageIndex) : messages,
    system: buildSystem(params, cache),
    toolConfig: toolList ? { tools: toolList } : undefined,
    inferenceConfig: { maxTokens },
    // Models with always-on adaptive thinking (Sonnet 5 / 5.5) reject an
    // explicit budget — omit the field and let their thinking run automatically.
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
