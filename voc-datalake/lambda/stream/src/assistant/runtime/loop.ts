/**
 * The agent loop: Bedrock turn → tools → Bedrock turn … until the model
 * answers, a write needs approval, or MAX_TOOL_ROUNDS is reached.
 *
 * MAX_TOOL_ROUNDS = 15: each round is one Bedrock call plus tool execution
 * (~6–15 s observed), so the real ceiling is the Lambda's 300 s timeout; 15
 * rounds (~225 s worst case) leaves headroom while letting multi-step questions
 * converge. Broad questions are answered by aggregate tools in one round.
 */
import { randomUUID } from 'node:crypto';
import type { ConverseStreamOutput, Message, Tool } from '@aws-sdk/client-bedrock-runtime';
import type { Interrupt, RunFinishedOutcome } from '@ag-ui/core';
import {
  INTERRUPT_ID_PREFIX,
  INTERRUPT_REASON_TOOL_APPROVAL,
  INTERRUPT_TTL_MINUTES,
} from '../contract.js';
import type { AssistantRunContext, AssistantToolset, FeedbackSource, WebSourceRef } from '../types.js';
import type { ConverseStreamParams } from '../../bedrock/converse-stream.js';
import type { TurnState } from '../../bedrock/stream-processor.js';
import {
  fallbackChain,
  fallbackReason,
  isModelUnavailable,
  markUnavailable,
  orderForAttempt,
  recordFallback,
} from '../../bedrock/model-fallback.js';
import { events, type Emitter } from './emitter.js';
import { encodeReasoning } from './reasoning.js';
import { runToolCalls, type PendingApproval } from './tool-calls.js';
import { streamTurn } from './turn.js';
import { addUsage, emptyUsage, type UsageTotals } from './usage.js';

export const MAX_TOOL_ROUNDS = 15;
export const MAX_ROUNDS_NOTICE = '_Reached the maximum number of tool steps. Please ask a more specific question._';

export type ConverseFn = (params: ConverseStreamParams) => AsyncIterable<ConverseStreamOutput>;

export interface LoopInput {
  converse: ConverseFn;
  messages: Message[];
  /** Same conversation with the tail rendered as text; tried once if Bedrock rejects `messages`. */
  fallbackMessages?: Message[];
  cacheMessageIndex?: number;
  toolset: AssistantToolset;
  systemPrompt: string;
  systemSuffix: string;
  modelId: string;
  ctx: AssistantRunContext;
  emitter: Emitter;
  now: () => Date;
}

export interface LoopResult {
  outcome: RunFinishedOutcome;
  usage: UsageTotals;
  sources: FeedbackSource[];
  webSources: WebSourceRef[];
  rounds: number;
  /** The model that answered the last turn (differs from LoopInput.modelId after a fallback). */
  modelId: string;
}

function isBedrockValidationError(err: unknown): boolean {
  return err instanceof Error && err.name === 'ValidationException';
}

/** A string project_id; an empty one is dropped by the metadata spread below. */
function projectIdOf(args: Record<string, unknown>): string | undefined {
  const value = args.project_id;
  return typeof value === 'string' ? value : undefined;
}

function summarize(pending: PendingApproval): string {
  try {
    return pending.tool.summarize(pending.args);
  } catch {
    return `Run ${pending.tool.name}`;
  }
}

function buildInterrupt(pending: PendingApproval, now: Date): Interrupt {
  const projectId = projectIdOf(pending.args);
  return {
    id: `${INTERRUPT_ID_PREFIX}${pending.toolCallId}`,
    reason: INTERRUPT_REASON_TOOL_APPROVAL,
    toolCallId: pending.toolCallId,
    message: summarize(pending),
    expiresAt: new Date(now.getTime() + INTERRUPT_TTL_MINUTES * 60_000).toISOString(),
    metadata: {
      toolName: pending.tool.name,
      risk: pending.tool.risk,
      ...(projectId ? { projectId } : {}),
    },
  };
}

interface TurnRequest {
  input: LoopInput;
  messages: Message[];
  tools: Tool[];
  messageId: string;
}

/** The model the run is on; moves down the fallback chain when a model cannot serve. */
interface ModelSelection {
  modelId: string;
}

interface TurnOutcome {
  state: TurnState;
  messages: Message[];
  /** The assistant message id the turn's events actually used. */
  messageId: string;
}

type CountingEmitter = ReturnType<typeof countingEmitter>;

/** Wrap the emitter so the caller can tell whether anything reached the client. */
function countingEmitter(emitter: Emitter): { emitter: Emitter; emitted: () => boolean } {
  const seen = { count: 0 };
  return {
    emitter: {
      emit(event) {
        seen.count += 1;
        emitter.emit(event);
      },
    },
    emitted: () => seen.count > 0,
  };
}

function startTurn({ input, messages, tools, messageId }: TurnRequest, modelId: string, emitter: Emitter): Promise<TurnState> {
  const stream = input.converse({
    messages,
    systemPrompt: input.systemPrompt,
    systemSuffix: input.systemSuffix,
    tools,
    modelId,
    cache: true,
    cacheMessageIndex: input.cacheMessageIndex,
  });
  return streamTurn(stream, emitter, { messageId });
}

/**
 * A structured tail that Bedrock refuses (most often a resumed tool loop whose
 * thinking block the client did not keep) is retried once as text. Only the
 * run's first turn may fall back, and only if nothing of the failed attempt
 * reached the client: once a delta streamed, a retry would re-open a message
 * the SPA already has. The retry gets a fresh message id for the same reason.
 * A ValidationException that names model availability is NOT a tail problem —
 * it goes to the model fallback in `runTurn`.
 */
async function runTurnOnModel(
  request: TurnRequest,
  modelId: string,
  allowFallback: boolean,
  attempt: CountingEmitter,
): Promise<TurnOutcome> {
  try {
    const state = await startTurn(request, modelId, attempt.emitter);
    return { state, messages: request.messages, messageId: request.messageId };
  } catch (err) {
    const fallback = request.input.fallbackMessages;
    const tailProblem = isBedrockValidationError(err) && !isModelUnavailable(err);
    if (!allowFallback || !fallback || !tailProblem || attempt.emitted()) throw err;
    console.warn('Bedrock rejected the structured tail; retrying with a text-rendered tail');
    const retry = { ...request, messages: fallback, messageId: randomUUID() };
    return { state: await startTurn(retry, modelId, attempt.emitter), messages: fallback, messageId: retry.messageId };
  }
}

/** Make `modelId` the run's model from here on (later turns, consult_personas, usage). */
function switchModel(input: LoopInput, models: ModelSelection, modelId: string): void {
  models.modelId = modelId;
  input.ctx.modelId = modelId;
}

/**
 * Run one turn on the current model, falling down the model chain when a model
 * cannot serve now (bedrock/model-fallback.ts) — but ONLY while nothing of this
 * turn has reached the client. Once a token streamed, the error surfaces: a
 * second model would re-answer a message the SPA already shows. When every
 * model fails, the first model's error is thrown.
 */
async function runTurn(request: TurnRequest, allowFallback: boolean, models: ModelSelection): Promise<TurnOutcome> {
  const ordered = orderForAttempt(fallbackChain(models.modelId));
  const head = ordered.at(0) ?? models.modelId;
  if (head !== models.modelId) recordFallback(models.modelId, head, 'cooldown');
  const failures: Error[] = [];
  for (const [index, modelId] of ordered.entries()) {
    const attempt = countingEmitter(request.input.emitter);
    try {
      const outcome = await runTurnOnModel(request, modelId, allowFallback, attempt);
      switchModel(request.input, models, modelId);
      return outcome;
    } catch (err) {
      if (!(err instanceof Error) || !isModelUnavailable(err) || attempt.emitted()) throw err;
      markUnavailable(modelId);
      failures.push(err);
      const next = ordered.at(index + 1);
      if (next !== undefined) recordFallback(modelId, next, fallbackReason(err));
    }
  }
  // The chain always holds the configured model, so the loop ran at least once.
  throw failures[0];
}

function emitNotice(emitter: Emitter, text: string): void {
  const messageId = randomUUID();
  emitter.emit(events.textStart(messageId));
  emitter.emit(events.textContent(messageId, text));
  emitter.emit(events.textEnd(messageId));
}

/**
 * One Bedrock turn plus its tool calls. Mutates `result` (usage, sources, outcome).
 * Returns the next turn's messages, or null when the run is done.
 */
async function runRound(input: LoopInput, messages: Message[], round: number, result: LoopResult): Promise<Message[] | null> {
  const request = { input, messages, tools: input.toolset.bedrockTools, messageId: randomUUID() };
  const turn = await runTurn(request, round === 0, result);
  const { state, messageId } = turn;
  result.usage = addUsage(result.usage, state.usage);
  result.rounds = round + 1;
  if (state.stopReason !== 'tool_use' || state.toolUses.length === 0) return null;

  console.log(`Tool round ${round + 1}/${MAX_TOOL_ROUNDS}: ${state.toolUses.map((t) => t.name).join(', ')}`);
  const encrypted = encodeReasoning(state.content);
  if (encrypted) input.emitter.emit(events.reasoningEncrypted(messageId, encrypted));

  const toolRound = await runToolCalls(state.toolUses, input.toolset, input.ctx, input.emitter, messageId);
  result.sources.push(...toolRound.sources);
  result.webSources.push(...toolRound.webSources);
  if (toolRound.pending.length > 0) {
    const now = input.now();
    result.outcome = { type: 'interrupt', interrupts: toolRound.pending.map((p) => buildInterrupt(p, now)) };
    return null;
  }
  return [
    ...turn.messages,
    { role: 'assistant', content: state.content },
    { role: 'user', content: toolRound.results },
  ];
}

const ROUNDS = Array.from({ length: MAX_TOOL_ROUNDS }, (_, i) => i);

export async function runAgentLoop(input: LoopInput): Promise<LoopResult> {
  const result: LoopResult = {
    outcome: { type: 'success' }, usage: emptyUsage(), sources: [], webSources: [], rounds: 0, modelId: input.modelId,
  };
  const conversation = { messages: input.messages, finished: false };
  for (const round of ROUNDS) {
    const next = await runRound(input, conversation.messages, round, result);
    if (next === null) {
      conversation.finished = true;
      break;
    }
    conversation.messages = next;
  }
  if (!conversation.finished) {
    console.warn(`Tool loop hit MAX_TOOL_ROUNDS=${MAX_TOOL_ROUNDS}; stopping.`);
    emitNotice(input.emitter, MAX_ROUNDS_NOTICE);
  }
  return result;
}
