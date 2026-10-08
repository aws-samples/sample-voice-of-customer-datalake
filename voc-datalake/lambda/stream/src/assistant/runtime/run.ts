/**
 * One assistant run, end to end:
 *
 *   body → RunAgentInput → RUN_STARTED → identity → forwardedProps + limits →
 *   toolset + model → CUSTOM assistant.context → Bedrock messages (flattened
 *   history + structured tail) → agent loop → CUSTOM assistant.sources →
 *   RUN_FINISHED (success | interrupt)
 *
 * Any error becomes RUN_ERROR{message, code} and the run ends; the HTTP status
 * stays 200 because the SSE headers are already sent.
 */
import type { Message as AguiMessage, ResumeEntry, UserMessage } from '@ag-ui/core';
import type { Message } from '@aws-sdk/client-bedrock-runtime';
import { AGUI_PROTOCOL_VERSION, CUSTOM_EVENTS } from '../contract.js';
import type {
  AssistantRunContext,
  AssistantToolset,
  FeedbackSource,
  ToolsetOptions,
  WebSourceRef,
} from '../types.js';
import { resolveChatModelId } from '../../bedrock/converse-stream.js';
import { ValidationError } from '../../lib/errors.js';
import { ProjectAccessLedger } from '../tools/project-access.js';
import { withoutProjectWrites } from '../tools/registry.js';
import { events, type Emitter } from './emitter.js';
import { isClientError, toRunError } from './errors.js';
import { extractCallerClaims, getBodyText, isAdminCaller, type LambdaEvent } from './event.js';
import { flatTurnsToBedrock, flattenHistory } from './flatten.js';
import { enforceLimits, isUserMessage, lastUserIndex, parseForwardedProps, parseRunAgentInput, textOfParts } from './input.js';
import { runAgentLoop, type ConverseFn } from './loop.js';
import { buildMemoryBlock, recallForRun, type RecallMemory } from './memory-recall.js';
import { buildPageContextBlock, withDataBlocks } from './page-context.js';
import { preloadDefaultProject, type ProjectPreload } from './preload.js';
import { buildDynamicPrompt, buildStaticPrompt } from './system-prompt.js';
import { buildTail, inspectTail } from './tail.js';
import { logUsage, toAguiUsage } from './usage.js';
import { createSessionEmitter, startRunSession, type SessionEmitter, type SessionPersistence } from '../session/run-session.js';

export interface RuntimeDeps {
  converse: ConverseFn;
  getToolset: (options: ToolsetOptions) => AssistantToolset;
  toolGuidance: (toolset: AssistantToolset) => string;
  /** Admin override for the `chat` surface, or undefined. */
  resolveModel: () => Promise<string | undefined>;
  webSearchConfigured: () => boolean;
  /** Memory recall for the newest user message (fails open in recallForRun). */
  recallMemory: RecallMemory;
  now: () => Date;
  /**
   * Server-side session persistence (session/run-session.ts): the run's
   * conversation is saved to the caller's own conversations partition while
   * it streams. Absent = not saved (the SPA's own saves still run).
   */
  sessions?: SessionPersistence;
}

export function dedupeFeedback(sources: readonly FeedbackSource[]): FeedbackSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (!source.feedback_id || seen.has(source.feedback_id)) return false;
    seen.add(source.feedback_id);
    return true;
  });
}

export function dedupeWeb(sources: readonly WebSourceRef[]): WebSourceRef[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (!source.url || seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
}

interface Conversation {
  messages: Message[];
  fallbackMessages?: Message[];
  cacheMessageIndex?: number;
}

interface ThreadSplit {
  user: UserMessage;
  before: readonly AguiMessage[];
  after: readonly AguiMessage[];
  toolNames: string[];
  idsValid: boolean;
}

/** Split at the newest user message: flattened history before, live tail after. */
function splitThread(thread: readonly AguiMessage[]): ThreadSplit {
  const index = lastUserIndex(thread);
  const user = thread[index];
  if (!isUserMessage(user)) throw new ValidationError('The run must contain a user message');
  const after = thread.slice(index + 1);
  return { user, before: thread.slice(0, index), after, ...inspectTail(after) };
}

interface ConversationInput {
  split: ThreadSplit;
  resume: readonly ResumeEntry[];
  toolset: AssistantToolset;
  /** Data blocks for the newest user message, in order: `<context>` (page-context.ts), `<memory>` (memory-recall.ts). */
  dataBlocks: readonly (string | undefined)[];
}

function buildConversation({ split, resume, toolset, dataBlocks }: ConversationInput): Conversation {
  const history = flatTurnsToBedrock(flattenHistory(split.before));
  const structured = split.idsValid && split.toolNames.every((name) => toolset.byName.has(name));
  const tail = buildTail(split.user, split.after, resume, structured ? 'structured' : 'text');
  const fallback = structured && tail.hasToolCalls ? buildTail(split.user, split.after, resume, 'text') : undefined;
  // The tail opens on the newest user message, right after the flattened history.
  const userIndex = history.length;
  return {
    messages: withDataBlocks([...history, ...tail.messages], userIndex, dataBlocks),
    ...(fallback ? { fallbackMessages: withDataBlocks([...history, ...fallback.messages], userIndex, dataBlocks) } : {}),
    ...(history.length > 0 ? { cacheMessageIndex: history.length - 1 } : {}),
  };
}

/** A view-only project on screen: no project write tools this run (reads stay, order kept). */
function toolsetForPreload(toolset: AssistantToolset, preload: ProjectPreload | undefined): AssistantToolset {
  return preload?.status === 'loaded' && preload.readOnly ? withoutProjectWrites(toolset) : toolset;
}

async function execute(event: LambdaEvent, emitter: SessionEmitter, deps: RuntimeDeps): Promise<void> {
  const input = parseRunAgentInput(getBodyText(event));
  emitter.emit(events.runStarted(input.threadId, input.runId, AGUI_PROTOCOL_VERSION));

  const claims = extractCallerClaims(event);
  const props = parseForwardedProps(input);
  enforceLimits(input);
  const isAdmin = isAdminCaller(claims);
  const { page } = props;

  const split = splitThread(input.messages);
  const webSearch = props.useWebSearch === true && deps.webSearchConfigured();
  const pageToolset = deps.getToolset({ page, isAdmin, webSearch, alsoInclude: split.toolNames });
  const modelId = resolveChatModelId(await deps.resolveModel());
  // Packs never change below (only project write tools can be dropped), so the context event goes out first.
  emitter.emit(events.custom(CUSTOM_EVENTS.context, { page, packs: pageToolset.packs, model: modelId, webSearch }));

  const ctx: AssistantRunContext = {
    claims, isAdmin, page, props, modelId, emit: (e) => emitter.emit(e), projectAccess: new ProjectAccessLedger(),
  };
  const now = deps.now();
  // Independent work before the first turn: the project on screen, the memories
  // for this message, and starting the server-side save of this run (its
  // partition is the verified caller's sub from the authorizer claims, never
  // anything in the body).
  const [projectPreload, memories] = await Promise.all([
    preloadDefaultProject(pageToolset, ctx),
    recallForRun(deps.recallMemory, textOfParts(split.user.content), ctx),
    startRunSession(emitter, deps.sessions, { callerSub: claims.sub, input, page }),
  ]);
  const toolset = toolsetForPreload(pageToolset, projectPreload);
  const conversation = buildConversation({
    split,
    resume: input.resume ?? [],
    toolset,
    dataBlocks: [buildPageContextBlock({ page, projectPreload }), buildMemoryBlock(memories)],
  });
  console.log(JSON.stringify({
    event: 'assistant_run', page: page.kind, packs: toolset.packs, model: modelId,
    tools: toolset.tools.length, messages: input.messages.length, resumed: (input.resume ?? []).length > 0,
    projectPreload: projectPreload?.status ?? 'none', memories: memories.length,
  }));

  const result = await runAgentLoop({
    converse: deps.converse,
    ...conversation,
    toolset,
    systemPrompt: buildStaticPrompt(deps.toolGuidance(toolset)),
    systemSuffix: buildDynamicPrompt({ page, props, isAdmin, now, projectPreload }),
    modelId,
    ctx,
    emitter,
    now: deps.now,
  });

  emitter.emit(events.custom(CUSTOM_EVENTS.sources, {
    feedback: dedupeFeedback(result.sources),
    web: dedupeWeb(result.webSources),
  }));
  logUsage(result.usage, result.modelId);
  emitter.emit(events.runFinished(input.threadId, input.runId, result.outcome, toAguiUsage(result.usage, result.modelId)));
}

const MAX_LOGGED_ERROR_CHARS = 300;

/** Error class always; message only for service errors (they describe structure, not content). */
function logRunFailure(err: unknown): void {
  const name = err instanceof Error ? err.name : 'UnknownError';
  if (isClientError(err)) {
    console.warn(`Assistant run rejected: ${name}`);
    return;
  }
  const detail = err instanceof Error ? err.message.slice(0, MAX_LOGGED_ERROR_CHARS) : '';
  console.error(`Assistant run failed: ${name} ${detail}`);
}

export interface RunOutcome {
  /** Every server-side session write of the run has landed or failed. Never rejects. */
  persisted: Promise<void>;
}

/**
 * Run the assistant; never throws — failures end the stream with RUN_ERROR.
 * Resolves when the stream's last event is emitted; the session writes still
 * in flight are `persisted`, for the handler to await AFTER ending the stream.
 */
export async function runAssistant(event: LambdaEvent, emitter: Emitter, deps: RuntimeDeps): Promise<RunOutcome> {
  const out = createSessionEmitter(emitter);
  try {
    await execute(event, out, deps);
  } catch (err) {
    logRunFailure(err);
    const { message, code } = toRunError(err);
    out.emit(events.runError(message, code));
  }
  return { persisted: out.settled() };
}
