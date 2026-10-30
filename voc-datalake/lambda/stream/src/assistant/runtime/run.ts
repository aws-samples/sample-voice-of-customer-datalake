/**
 * One assistant run, end to end:
 *
 *   body → RunAgentInput → RUN_STARTED → identity → forwardedProps + limits →
 *   toolset + model → CUSTOM assistant.context → Bedrock messages (flattened
 *   history + structured tail) → agent loop (polling Stop) → [CUSTOM assistant.stopped] → CUSTOM assistant.sources →
 *   RUN_FINISHED (success | interrupt)
 *
 * Any error becomes RUN_ERROR{message, code} and the run ends; the HTTP status
 * stays 200 because the SSE headers are already sent.
 */
import type { Message as AguiMessage, ResumeEntry, UserMessage } from '@ag-ui/core';
import type { Message } from '@aws-sdk/client-bedrock-runtime';
import { AGUI_PROTOCOL_VERSION, CUSTOM_EVENTS, type ForwardedProps } from '../contract.js';
import type {
  AssistantRunContext,
  AssistantToolset,
  FeedbackSource,
  ToolsetOptions,
  WebSourceRef,
} from '../types.js';
import { resolveChatModelId } from '../../bedrock/converse-stream.js';
import { profiledModelId } from '../../bedrock/model-profile.js';
import { ValidationError } from '../../lib/errors.js';
import { ProjectAccessLedger } from '../tools/project-access.js';
import { withoutDocumentGeneration, withoutProjectWrites } from '../tools/registry.js';
import { events, type Emitter } from './emitter.js';
import { isClientError, toRunError } from './errors.js';
import { extractCallerClaims, getBodyText, isAdminCaller, type LambdaEvent } from './event.js';
import { flatTurnsToBedrock, flattenHistory } from './flatten.js';
import { enforceLimits, isUserMessage, lastUserIndex, parseForwardedProps, parseRunAgentInput, textOfParts } from './input.js';
import { runAgentLoop, type ConverseFn } from './loop.js';
import { briefForRun, buildCompanyBlock, type LoadCompanyBrief } from './company-brief.js';
import { restrictionForRun, type LoadCategoryRestriction } from './category-restriction.js';
import { aiWritingForRun, type AiWritingPolicy, type LoadAiWritingPolicy } from './ai-writing.js';
import { buildMemoryBlock, recallForRun, type RecallMemory } from './memory-recall.js';
import { buildPageContextBlock, withDataBlocks } from './page-context.js';
import { preloadDefaultProject, type ProjectPreload } from './preload.js';
import { buildDynamicPrompt, buildStaticPrompt } from './system-prompt.js';
import { buildTail, inspectTail } from './tail.js';
import { logUsage, toAguiUsage } from './usage.js';
import { createSessionEmitter, startRunSession, type SessionEmitter, type SessionPersistence } from '../session/run-session.js';
import { watchForStop } from '../session/cancel.js';
import type { PersonaRound } from './persona-round.js';

export interface RuntimeDeps {
  converse: ConverseFn;
  getToolset: (options: ToolsetOptions) => AssistantToolset;
  toolGuidance: (toolset: AssistantToolset) => string;
  /** Admin override for the `chat` surface, or undefined. */
  resolveModel: () => Promise<string | undefined>;
  webSearchConfigured: () => boolean;
  /** Memory recall for the newest user message (fails open in recallForRun). */
  recallMemory: RecallMemory;
  /** Short company context + the caller's own objectives (fails open in briefForRun). Absent = none. */
  loadCompanyBrief?: LoadCompanyBrief;
  /** Whether the caller's category access is restricted (fails open in restrictionForRun). Absent = not read. */
  loadCategoryRestriction?: LoadCategoryRestriction;
  /** The caller's way of working with AI (fails closed in aiWritingForRun). Absent = AI-driven. */
  loadAiWriting?: LoadAiWritingPolicy;
  now: () => Date;
  /**
   * Server-side session persistence (session/run-session.ts): the run's
   * conversation is saved to the caller's own conversations partition while
   * it streams. Absent = not saved (the SPA's own saves still run).
   */
  sessions?: SessionPersistence;
  /** The @persona / @all round before the model's turn (persona-round.ts). Absent = mentions only name documents. */
  personaRound?: PersonaRound;
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

/** Mentions name a project's personas and documents, so they are refused off a project page. */
function enforceMentionsPage(props: ForwardedProps): void {
  if (props.mentions === undefined) return;
  if (props.page.kind !== 'project' || props.page.projectId === undefined) {
    throw new ValidationError('Mentions (@persona, #document) are only available on a project page');
  }
}

interface MentionRoundInput {
  deps: RuntimeDeps;
  props: ForwardedProps;
  question: string;
  ctx: AssistantRunContext;
  signal: AbortSignal | undefined;
}

/** The `<mentions>` block: the persona round when personas were mentioned, else the tagged documents only. */
async function mentionsForRun({ deps, props, question, ctx, signal }: MentionRoundInput): Promise<string | undefined> {
  if (props.mentions === undefined || deps.personaRound === undefined) return undefined;
  // The round fails open itself; this keeps a rejecting injection from skipping the stop-watch cleanup.
  try {
    return await deps.personaRound({ mentions: props.mentions, question, ctx, ...(signal === undefined ? {} : { signal }) });
  } catch (err) {
    console.warn(`persona round rejected (${err instanceof Error ? err.name : 'unknown'})`);
    return undefined;
  }
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

/**
 * A view-only project on screen: no project write tools this run (reads stay, order kept).
 * No PR/FAQ or PRD the AI may write with this person: no `generate_document` (ai-writing.ts).
 */
function toolsetForRun(toolset: AssistantToolset, preload: ProjectPreload | undefined, aiWriting: AiWritingPolicy): AssistantToolset {
  const writable = preload?.status === 'loaded' && preload.readOnly ? withoutProjectWrites(toolset) : toolset;
  return aiWriting.interactive.size === 0 ? withoutDocumentGeneration(writable) : writable;
}

async function execute(event: LambdaEvent, emitter: SessionEmitter, deps: RuntimeDeps, limits: RunLimits): Promise<void> {
  const input = parseRunAgentInput(getBodyText(event));
  emitter.emit(events.runStarted(input.threadId, input.runId, AGUI_PROTOCOL_VERSION));

  const claims = extractCallerClaims(event);
  const props = parseForwardedProps(input);
  enforceLimits(input);
  enforceMentionsPage(props);
  const isAdmin = isAdminCaller(claims);
  const { page } = props;

  const split = splitThread(input.messages);
  const webSearch = props.useWebSearch === true && deps.webSearchConfigured();
  const pageToolset = deps.getToolset({ page, isAdmin, webSearch, alsoInclude: split.toolNames });
  // An e2e test user (Cognito group `e2e`, verified claims) runs on the profile's model (bedrock/model-profile.ts).
  const modelId = profiledModelId(resolveChatModelId(await deps.resolveModel()), claims['cognito:groups'], 'chat');
  // Packs never change below (only project write tools can be dropped), so the context event goes out first.
  emitter.emit(events.custom(CUSTOM_EVENTS.context, { page, packs: pageToolset.packs, model: modelId, webSearch }));

  const ctx: AssistantRunContext = {
    claims, isAdmin, page, props, modelId, emit: (e) => emitter.emit(e), projectAccess: new ProjectAccessLedger(),
    ...(limits.deadlineMs === undefined ? {} : { deadlineMs: limits.deadlineMs }),
  };
  const now = deps.now();
  // Independent work before the first turn: the project on screen, the memories
  // for this message, and starting the server-side save of this run (its
  // partition is the verified caller's sub from the authorizer claims, never
  // anything in the body).
  const [projectPreload, memories, companyBrief, categoryRestricted, aiWriting] = await Promise.all([
    preloadDefaultProject(pageToolset, ctx),
    recallForRun(deps.recallMemory, textOfParts(split.user.content), ctx),
    briefForRun(deps.loadCompanyBrief, ctx),
    restrictionForRun(deps.loadCategoryRestriction, ctx),
    aiWritingForRun(deps.loadAiWriting, claims.sub),
    startRunSession(emitter, deps.sessions, { callerSub: claims.sub, input, page }),
  ]);
  ctx.aiWriting = aiWriting;
  // Stop in the SPA (session/cancel.ts): polled for the rest of the run (persona round included), ended with it.
  const stopWatch = watchForStop(deps.sessions, { callerSub: claims.sub, threadId: input.threadId, runId: input.runId });
  // Review-only persona answers, allowed in every way of working (the model's own turn keeps its mode).
  const mentionsBlock = await mentionsForRun({ deps, props, question: textOfParts(split.user.content), ctx, signal: stopWatch?.signal });
  const toolset = toolsetForRun(pageToolset, projectPreload, aiWriting);
  const conversation = buildConversation({
    split,
    resume: input.resume ?? [],
    toolset,
    dataBlocks: [
      buildCompanyBlock(companyBrief), buildPageContextBlock({ page, projectPreload }), buildMemoryBlock(memories), mentionsBlock,
    ],
  });
  console.log(JSON.stringify({
    event: 'assistant_run', page: page.kind, packs: toolset.packs, model: modelId,
    tools: toolset.tools.length, messages: input.messages.length, resumed: (input.resume ?? []).length > 0,
    projectPreload: projectPreload?.status ?? 'none', memories: memories.length, aiMode: aiWriting.mode,
    mentions: props.mentions === undefined ? 'none' : 'present',
  }));

  const result = await runAgentLoop({
    converse: deps.converse,
    ...conversation,
    toolset,
    systemPrompt: buildStaticPrompt(deps.toolGuidance(toolset)),
    systemSuffix: buildDynamicPrompt({ page, props, isAdmin, now, projectPreload, categoryRestricted, aiWriting }),
    modelId,
    ctx,
    emitter,
    now: deps.now,
    ...(stopWatch === undefined ? {} : { signal: stopWatch.signal }),
  }).finally(() => stopWatch?.stop());

  if (result.stopped) emitter.emit(events.custom(CUSTOM_EVENTS.stopped, {}));
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
    // A refused request (bad input, over a limit) is the API working as designed: INFO keeps
    // WARN meaningful for operators, matching the Python APIs' 400/404/409/413 handlers.
    console.info(`Assistant run rejected: ${name}`);
    return;
  }
  const detail = err instanceof Error ? err.message.slice(0, MAX_LOGGED_ERROR_CHARS) : '';
  console.error(`Assistant run failed: ${name} ${detail}`);
}

export interface RunOutcome {
  /** Every server-side session write of the run has landed or failed. Never rejects. */
  persisted: Promise<void>;
}

export interface RunLimits {
  /** Epoch ms the Lambda invocation is cut off (handler.ts reads it from the Lambda context). */
  deadlineMs?: number;
}

/**
 * Run the assistant; never throws — failures end the stream with RUN_ERROR.
 * Resolves when the stream's last event is emitted; the session writes still
 * in flight are `persisted`, for the handler to await AFTER ending the stream.
 */
export async function runAssistant(event: LambdaEvent, emitter: Emitter, deps: RuntimeDeps, limits: RunLimits = {}): Promise<RunOutcome> {
  const out = createSessionEmitter(emitter);
  try {
    await execute(event, out, deps, limits);
  } catch (err) {
    logRunFailure(err);
    const { message, code } = toRunError(err);
    out.emit(events.runError(message, code));
  }
  return { persisted: out.settled() };
}
