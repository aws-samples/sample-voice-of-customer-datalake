/**
 * A persona focus group (docs/project-workspace.md "Persona focus groups"): `forwardedProps.focusGroup` on a project
 * page runs it instead of the model's own turn. Deterministic, like the persona round (persona-round.ts):
 *
 * 1. the personas, the project documents they read (chat context), the library items' best passages for the topic,
 *    and each persona's evidence pack (`POST /projects/{id}/personas/evidence-pack`, as the person: their category and
 *    source access);
 * 2. round 1: every persona answers on its own (no anchoring), one `consult_personas` call per persona on one
 *    assistant message (ids `focus_r1_…`), each answered by its TOOL_CALL_RESULT as soon as it has replied;
 * 3. rounds 2 and 3: the moderator (one call) asks one follow-up, emitted as its own message, then every persona
 *    reads an anonymised digest of the others' last answers and agrees, disagrees or builds on them (`focus_rN_…`);
 * 4. the synthesis (one call): agreements, disagreements and open questions, the run's last message and the
 *    `assistant.focus_group` event that the synthesis card and Save read.
 *
 * Every answer and point is stripped of any `[fb:<id>]` outside the speaker's pack (the synthesis: outside every
 * pack) before it is emitted, so a citation always names a review the person may open. The cited reviews are the
 * run's feedback sources. Stop ends it between batches: every call still gets a result and the event says `stopped`.
 * Fails open: an unreadable pack means personas speak from their profiles and cite nothing; a failed persona call is
 * that persona's "no answer"; a failed moderator call asks a fixed follow-up; a failed synthesis says so.
 */
import { randomUUID } from 'node:crypto';
import { EventType } from '@ag-ui/core';
import {
  CUSTOM_EVENTS, FOCUS_GROUP_LIMITS, FOCUS_GROUP_TOOL_CALL_PREFIX, PERSONA_READING_CHARS, type FocusGroup,
  type FocusGroupEvent, type FocusGroupSynthesis,
} from '../contract.js';
import type { AssistantRunContext, FeedbackSource, LibrarySourceRef } from '../types.js';
import type { ToolDeps } from '../tools/deps.js';
import { clip } from '../tools/format.js';
import { getLanguageInstruction } from '../../context/language.js';
import { buildSinglePersonaPrompt } from '../../context/persona-prompt.js';
import { answerText } from '../../bedrock/answer-text.js';
import { ValidationError } from '../../lib/errors.js';
import { loadChatContext, type ChatContext, type ChatContextPersona } from '../tools/server/chat-context.js';
import { loadEvidencePack, type EvidenceItem, type EvidencePack } from '../tools/server/evidence-pack.js';
import { citationMarker, librarySources, loadLibraryContext } from '../tools/server/library.js';
import {
  briefingFor, FAILED_ANSWER, normalizeLanguage, PERSONA_CONCURRENCY, personaConverseCommand, personaStep,
  REVIEW_ONLY_NOTE, type PersonaBriefing,
} from '../tools/server/persona-consult.js';
import { addUsage, emptyUsage, type UsageTotals } from './usage.js';
import { emitToolCall, events } from './emitter.js';
import {
  citedIds, digestFor, followUpOf, keepCitations, moderatorPrompt, MODERATOR_SYSTEM, parseSynthesis, personaTurn,
  roundQuestion, synthesisMarkdown, synthesisPrompt, SYNTHESIS_SYSTEM, type FocusAnswer, type FocusRound,
} from './focus-group-prompts.js';
import { neutralise } from './page-context.js';

/** Fresh reviews per persona in its pack (the projects API's ceiling). */
const FRESH_PER_PERSONA = 8;
const MAX_ANSWER_CHARS = 4000;
/** A citation the answer's bound cut in half (`[fb:ab…`): removed, never shown as text. */
const CUT_CITATION = / ?\[fb:[\w-]*…$/u;
const LIBRARY_BUDGET_CHARS = PERSONA_READING_CHARS.library;
/** A card's citations and each one's quote: a stored result stays well inside its cap (session/persona-result.ts). */
const MAX_CARD_CITATIONS = 8;
const MAX_CARD_QUOTE_CHARS = 200;
const FALLBACK_FOLLOW_UP = 'Where do you disagree with the others, and why?';
const STOPPED_RESULT = JSON.stringify({ responses: [], note: 'Stopped before this persona answered.' });
const NO_SYNTHESIS = 'The synthesis could not be written just now; the answers above are the whole focus group.';
const NO_PERSONAS = 'None of the chosen personas is in this project any more: choose them again on the Focus groups tab.';

export interface FocusGroupInput {
  focusGroup: FocusGroup;
  /** The message's text: the topic every persona discusses. */
  topic: string;
  ctx: AssistantRunContext;
  signal?: AbortSignal;
}

export interface FocusGroupOutcome {
  sources: FeedbackSource[];
  librarySources: LibrarySourceRef[];
  usage: UsageTotals;
  stopped: boolean;
}

export type FocusGroupRunner = (input: FocusGroupInput) => Promise<FocusGroupOutcome>;

/** One persona of the group, with everything it reads besides the question. */
interface Participant {
  persona: ChatContextPersona;
  name: string;
  avatarUrl?: string;
  evidence: readonly EvidenceItem[];
  allowed: ReadonlySet<string>;
}

interface Group {
  deps: ToolDeps;
  input: FocusGroupInput;
  modelId: string;
  context: ChatContext;
  briefing: PersonaBriefing;
  participants: Participant[];
  missing: string[];
  /** The library items' passages, in every persona's turn beside its evidence (never its system prompt). */
  library: string;
  /** The library items' chips. */
  libraryRefs: LibrarySourceRef[];
  usage: UsageTotals;
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** The topic, or a 400 before any model call. */
export function focusTopic(text: string): string {
  const topic = text.trim();
  if (topic === '') throw new ValidationError('A focus group needs a topic: write it as the message.');
  if (topic.length > FOCUS_GROUP_LIMITS.maxTopicChars) {
    throw new ValidationError(`A focus group's topic is at most ${String(FOCUS_GROUP_LIMITS.maxTopicChars)} characters.`);
  }
  return topic;
}

async function loadPack(deps: ToolDeps, input: FocusGroupInput, projectId: string, topic: string): Promise<EvidencePack> {
  try {
    return await loadEvidencePack(deps.invoke, projectId, {
      personaIds: input.focusGroup.persona_ids, question: topic, limit: FRESH_PER_PERSONA,
    }, input.ctx.claims);
  } catch (err) {
    // Error class only: never the topic, a persona or a review.
    console.warn(`focus group: evidence pack unavailable (${err instanceof Error ? err.name : 'unknown'})`);
    return { byPersona: new Map(), missing: [] };
  }
}

interface LibraryBrief { text: string; sources: LibrarySourceRef[] }

/** The library items' passages that best match the topic (no file is attached to a persona's call). */
async function loadLibrary(deps: ToolDeps, input: FocusGroupInput, topic: string): Promise<LibraryBrief> {
  const ids = input.focusGroup.library?.map((item) => item.item_id) ?? [];
  if (ids.length === 0) return { text: '', sources: [] };
  try {
    const context = await loadLibraryContext(deps.invoke, { itemIds: ids, query: topic, nativeSlots: 0 }, input.ctx.claims);
    const slugOf = new Map(context.items.map((item) => [item.item_id, item.slug]));
    const text = context.passages.map((passage) => `${citationMarker(slugOf.get(passage.item_id) ?? passage.item_id,
      passage.page)}\n${neutralise(passage.text)}`).join('\n\n');
    return { text: clip(text, LIBRARY_BUDGET_CHARS), sources: librarySources(context.items, context.passages) };
  } catch (err) {
    console.warn(`focus group: library unavailable (${err instanceof Error ? err.name : 'unknown'})`);
    return { text: '', sources: [] };
  }
}

async function participantOf(deps: ToolDeps, persona: ChatContextPersona, pack: EvidencePack): Promise<Participant> {
  const evidence = pack.byPersona.get(persona.persona_id)?.evidence ?? [];
  const avatarUrl = await deps.resolveAvatar(persona.avatar_url).catch((err: unknown) => {
    console.warn(`focus group: avatar for persona ${persona.persona_id} failed (${err instanceof Error ? err.name : 'unknown'})`);
    return null;
  });
  return {
    persona, name: persona.name ?? 'Persona', ...(avatarUrl ? { avatarUrl } : {}), evidence,
    allowed: new Set(evidence.map((item) => item.feedback_id)),
  };
}

async function openGroup(deps: ToolDeps, input: FocusGroupInput, modelId: string): Promise<Group> {
  const { ctx, focusGroup } = input;
  const projectId = ctx.page.projectId;
  if (projectId === undefined) throw new ValidationError('A focus group runs on a project page.');
  const topic = input.topic;
  const documentIds = focusGroup.documents?.map((document) => document.document_id) ?? [];
  const [context, pack, library] = await Promise.all([
    loadChatContext(deps.invoke, projectId, documentIds, ctx.claims), loadPack(deps, input, projectId, topic),
    loadLibrary(deps, input, topic),
  ]);
  ctx.projectAccess.record(projectId, context.access);
  const byId = new Map(context.personas.map((persona) => [persona.persona_id, persona]));
  // Each persona once (the contract refuses a repeat; a call per persona needs one id each).
  const personas = [...new Set(focusGroup.persona_ids)].flatMap((id) => byId.get(id) ?? []);
  const tagged = context.documents.filter((document) => documentIds.includes(document.document_id));
  return {
    deps, input, modelId, context, usage: emptyUsage(),
    briefing: briefingFor(tagged, context.documents), library: library.text,
    participants: await Promise.all(personas.map((persona) => participantOf(deps, persona, pack))),
    missing: focusGroup.persona_ids.filter((id) => !byId.has(id)),
    libraryRefs: library.sources,
  };
}

/** The persona's system prompt: its profile and the documents, as a mention round's (its evidence is data in its turn). */
function systemPromptFor(group: Group, participant: Participant): string {
  return buildSinglePersonaPrompt(
    group.context.projectName, participant.persona, group.briefing.referenced, group.briefing.others, '', [], [], [],
    normalizeLanguage(group.input.ctx.props.responseLanguage),
  );
}

/**
 * The persona's user turn: its evidence, the library's passages (data beside the evidence, never in the system prompt),
 * the others' anonymised digest from round 2, and the round's question.
 */
function turnFor(group: Group, participant: Participant, question: string, previous: FocusRound | undefined): string {
  const names = group.participants.map((one) => one.name);
  const digest = previous === undefined ? [] : digestFor(participant.persona.persona_id, previous, names);
  return personaTurn(participant.evidence, digest, `${question}${REVIEW_ONLY_NOTE}`, group.library);
}

/** The answer within its bound, every citation outside the pack removed, and no citation left cut in half. */
function boundedAnswer(text: string, allowed: ReadonlySet<string>): string {
  return keepCitations(clip(text, MAX_ANSWER_CHARS), allowed).replace(CUT_CITATION, '…');
}

async function answerOf(group: Group, participant: Participant, question: string, previous: FocusRound | undefined):
Promise<string> {
  const { ctx } = group.input;
  ctx.emit(personaStep(EventType.STEP_STARTED, participant.name));
  const command = personaConverseCommand(group.modelId, systemPromptFor(group, participant),
    turnFor(group, participant, question, previous));
  const answer = await group.deps.converse(command).then((output) => {
    group.usage = addUsage(group.usage, output.usage ?? null);
    return boundedAnswer(answerText(output), participant.allowed) || FAILED_ANSWER;
  }).catch((err: unknown) => {
    console.warn(`focus group: persona ${participant.persona.persona_id} failed (${err instanceof Error ? err.name : 'unknown'})`);
    return FAILED_ANSWER;
  });
  ctx.emit(personaStep(EventType.STEP_FINISHED, participant.name));
  return answer;
}

/** The citations a card shows beside an answer: the pack's reviews it cites, in the order it cites them. */
function citationsOf(participant: Participant, answer: string): EvidenceItem[] {
  const byId = new Map(participant.evidence.map((item) => [item.feedback_id, item]));
  return citedIds(answer).flatMap((id) => byId.get(id) ?? []);
}

function resultOf(participant: Participant, round: number, answer: string): string {
  return JSON.stringify({
    responses: [{
      persona_id: participant.persona.persona_id, name: participant.name,
      ...(participant.avatarUrl === undefined ? {} : { avatar_url: participant.avatarUrl }), answer, round,
      citations: citationsOf(participant, answer).slice(0, MAX_CARD_CITATIONS).map((item) => ({
        feedback_id: item.feedback_id, text: clip(item.text, MAX_CARD_QUOTE_CHARS), source_platform: item.source_platform,
        sentiment_label: item.sentiment_label, verbatim: item.verbatim,
      })),
    }],
  });
}

function batchesOf<T>(items: readonly T[]): T[][] {
  return Array.from({ length: Math.ceil(items.length / PERSONA_CONCURRENCY) },
    (_, index) => items.slice(index * PERSONA_CONCURRENCY, (index + 1) * PERSONA_CONCURRENCY));
}

/** One round: every persona's call emitted at once, then answered in batches; the round's answers. */
async function runRound(group: Group, round: number, followUp: string | undefined, previous: FocusRound | undefined):
Promise<FocusRound> {
  const { ctx, focusGroup, signal } = group.input;
  const question = roundQuestion(group.input.topic, round, followUp);
  const documentIds = focusGroup.documents?.map((document) => document.document_id) ?? [];
  const parentMessageId = randomUUID();
  const callIds = new Map(group.participants.map((participant) => {
    const toolCallId = `${FOCUS_GROUP_TOOL_CALL_PREFIX}r${String(round)}_${randomUUID().replaceAll('-', '')}`;
    emitToolCall({ emit: ctx.emit }, {
      toolCallId, name: 'consult_personas', parentMessageId,
      argsJson: JSON.stringify({ question, persona_ids: [participant.persona.persona_id],
        ...(documentIds.length > 0 ? { document_ids: documentIds } : {}) }),
    });
    return [participant.persona.persona_id, toolCallId] as const;
  }));
  const answers: FocusAnswer[] = [];
  for (const batch of batchesOf(group.participants)) {
    if (aborted(signal)) break;
    const done = await Promise.all(batch.map(async (participant) => {
      const answer = await answerOf(group, participant, question, previous);
      ctx.emit(events.toolResult(randomUUID(), callIds.get(participant.persona.persona_id) ?? '', resultOf(participant, round, answer)));
      return { persona_id: participant.persona.persona_id, name: participant.name, answer };
    }));
    answers.push(...done);
  }
  const answered = new Set(answers.map((answer) => answer.persona_id));
  // Stopped mid-round: every call still gets a result, so the stored thread stays well formed.
  for (const participant of group.participants) {
    const toolCallId = callIds.get(participant.persona.persona_id);
    if (!answered.has(participant.persona.persona_id) && toolCallId !== undefined) {
      ctx.emit(events.toolResult(randomUUID(), toolCallId, STOPPED_RESULT));
    }
  }
  return { round, ...(followUp === undefined ? {} : { followUp }), answers };
}

function emitText(group: Group, text: string): void {
  const messageId = randomUUID();
  group.input.ctx.emit(events.textStart(messageId));
  group.input.ctx.emit(events.textContent(messageId, text));
  group.input.ctx.emit(events.textEnd(messageId));
}

function languageLine(group: Group): string {
  const instruction = getLanguageInstruction(normalizeLanguage(group.input.ctx.props.responseLanguage));
  return instruction === '' ? '' : `\n\n${instruction}`;
}

/** The moderator's or the synthesis' one call: a persona call's shape (no tools, bounded), its own system prompt. */
async function quickCall(group: Group, system: string, prompt: string): Promise<string | undefined> {
  try {
    const output = await group.deps.converse(personaConverseCommand(group.modelId, `${system}${languageLine(group)}`,
      prompt));
    group.usage = addUsage(group.usage, output.usage ?? null);
    return answerText(output);
  } catch (err) {
    console.warn(`focus group: model call failed (${err instanceof Error ? err.name : 'unknown'})`);
    return undefined;
  }
}

/** The moderator's follow-up for the next round, emitted as its own message. */
async function moderate(group: Group, last: FocusRound): Promise<string> {
  const names = group.participants.map((one) => one.name);
  const text = await quickCall(group, MODERATOR_SYSTEM, moderatorPrompt(group.input.topic, last, names));
  const followUp = (text === undefined ? undefined : followUpOf(text)) ?? FALLBACK_FOLLOW_UP;
  emitText(group, followUp);
  return followUp;
}

async function synthesise(group: Group, rounds: readonly FocusRound[]): Promise<FocusGroupSynthesis | undefined> {
  const allowed = new Set(group.participants.flatMap((participant) => [...participant.allowed]));
  const text = await quickCall(group, SYNTHESIS_SYSTEM, synthesisPrompt(group.input.topic, rounds));
  return text === undefined ? undefined : parseSynthesis(text, allowed);
}

function citedSources(group: Group, rounds: readonly FocusRound[], synthesis: FocusGroupSynthesis | undefined):
{ ids: string[]; sources: FeedbackSource[] } {
  const texts = [...rounds.flatMap((round) => round.answers.map((answer) => answer.answer)),
    ...(synthesis === undefined ? [] : [...synthesis.agreements, ...synthesis.disagreements, ...synthesis.open_questions])];
  const ids = [...new Set(texts.flatMap(citedIds))].slice(0, 120);
  const byId = new Map(group.participants.flatMap((participant) => participant.evidence.map((item) => [item.feedback_id, item] as const)));
  const sources = ids.flatMap((id): FeedbackSource[] => {
    const item = byId.get(id);
    return item === undefined ? [] : [{ feedback_id: id, text: item.text, source_platform: item.source_platform,
      sentiment_label: item.sentiment_label }];
  });
  return { ids, sources };
}

function groupEvent(group: Group, status: FocusGroupEvent['status'], rounds: number, extra: Partial<FocusGroupEvent>):
FocusGroupEvent {
  return {
    status, config: group.input.focusGroup, rounds_completed: rounds, cited_feedback_ids: [],
    missing_persona_ids: group.missing, ...extra,
  };
}

async function runGroup(group: Group): Promise<FocusGroupOutcome> {
  const { ctx, focusGroup, signal } = group.input;
  ctx.emit(events.custom(CUSTOM_EVENTS.focusGroup, groupEvent(group, 'running', 0, {})));
  const rounds: FocusRound[] = [];
  for (const round of Array.from({ length: focusGroup.rounds }, (_, index) => index + 1)) {
    if (aborted(signal)) break;
    const previous = rounds.at(-1);
    const followUp = previous === undefined ? undefined : await moderate(group, previous);
    if (aborted(signal)) break;
    rounds.push(await runRound(group, round, followUp, previous));
  }
  const stopped = aborted(signal);
  const complete = rounds.filter((round) => round.answers.length === group.participants.length).length;
  const synthesis = stopped || rounds.length === 0 ? undefined : await synthesise(group, rounds);
  const cited = citedSources(group, rounds, synthesis);
  if (!stopped) emitText(group, synthesis === undefined ? NO_SYNTHESIS : synthesisMarkdown(synthesis));
  ctx.emit(events.custom(CUSTOM_EVENTS.focusGroup, groupEvent(group, stopped ? 'stopped' : 'finished', complete, {
    ...(synthesis === undefined ? {} : { synthesis }), cited_feedback_ids: cited.ids,
  })));
  return { sources: cited.sources, librarySources: group.libraryRefs, usage: group.usage, stopped };
}

export function createFocusGroupRunner(deps: ToolDeps): FocusGroupRunner {
  return async (input) => {
    const modelId = input.ctx.modelId ?? deps.fallbackModelId;
    if (modelId === undefined) throw new ValidationError('No model is configured for persona answers.');
    const group = await openGroup(deps, { ...input, topic: focusTopic(input.topic) }, modelId);
    if (group.participants.length === 0) {
      emitText(group, NO_PERSONAS);
      input.ctx.emit(events.custom(CUSTOM_EVENTS.focusGroup, groupEvent(group, 'finished', 0, {})));
      return { sources: [], librarySources: [], usage: group.usage, stopped: false };
    }
    return runGroup(group);
  };
}
