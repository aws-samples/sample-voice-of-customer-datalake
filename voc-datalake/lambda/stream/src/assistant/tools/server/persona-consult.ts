/**
 * Asking project personas, shared by the `consult_personas` tool (the model asks) and the
 * persona round (the user @mentions personas, runtime/persona-round.ts).
 *
 * One NON-streaming Bedrock Converse call per persona, the run's model (the `chat` surface),
 * no tools, bounded tokens: a persona can only answer in text, never write anything. Progress
 * is surfaced as AG-UI STEP_STARTED / STEP_FINISHED (`persona:<name>`). Personas answer
 * independently (each sees the tagged documents, not the other personas' answers), in batches
 * of PERSONA_CONCURRENCY.
 */
import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { EventType, type StepFinishedEvent, type StepStartedEvent } from '@ag-ui/core';
import { answerText } from '../../../bedrock/answer-text.js';
import { invocationModelId, usesAdaptiveThinking } from '../../../bedrock/model-override.js';
import { isSupportedLanguage, type SupportedLanguage } from '../../../context/language.js';
import { buildSinglePersonaPrompt } from '../../../context/persona-prompt.js';
import { MENTION_LIMITS } from '../../contract.js';
import type { AssistantRunContext } from '../../types.js';
import type { ToolDeps } from '../deps.js';
import { clip } from '../format.js';
import type { ChatContextDocument, ChatContextPersona } from './chat-context.js';
import { renderDocument } from './project-shape.js';

export const MAX_CONSULTED_PERSONAS = MENTION_LIMITS.maxPersonas;
/** Personas answered concurrently (bounded to stay clear of Bedrock throttling). */
const PERSONA_CONCURRENCY = 3;
const PERSONA_MAX_TOKENS = 1200;
/** Non-adaptive models get a small explicit thinking budget (Bedrock minimum 1024). */
const PERSONA_THINKING_BUDGET = 1024;
const MAX_ANSWER_CHARS = 4000;
/** Text of the tagged documents in each persona's prompt, all of them together (≤ 3 documents). */
const REFERENCED_DOCUMENTS_BUDGET = 30_000;
/** Untagged documents named (title only) in the prompt. */
const MAX_OTHER_DOCUMENTS = 5;
const FAILED_ANSWER = '(No answer — this persona could not be consulted right now.)';
/** Appended to the question: a persona reviews, it never writes. */
const REVIEW_ONLY_NOTE = '\n\n(Answer as yourself with your honest feedback. You only review and comment: do not '
  + 'rewrite or draft documents for the team.)';

export interface PersonaResponse {
  persona_id: string;
  name: string;
  avatar_url?: string;
  answer: string;
}

/** `pt-BR` → `pt`; unsupported → undefined (English, no instruction). */
export function normalizeLanguage(value: string | undefined): SupportedLanguage | undefined {
  const base = value?.split('-')[0]?.toLowerCase();
  return isSupportedLanguage(base) ? base : undefined;
}

/** "Title (v2)": the stored title, with the version added when the title does not carry it yet. */
export function documentLabel(document: Pick<ChatContextDocument, 'title' | 'version'>): string {
  const title = (document.title ?? '').trim() || 'Untitled';
  if (document.version === undefined) return title;
  const suffix = `(v${String(document.version)})`;
  return title.endsWith(suffix) ? title : `${title} ${suffix}`;
}

/** What every persona of one consultation reads besides its own profile. */
export interface PersonaBriefing {
  /** The tagged documents' text (REFERENCED DOCUMENTS), '' when none. */
  referenced: string;
  /** Titles of the project's other documents (named only). */
  others: string[];
}

/** The briefing for these tagged documents: their text shares one budget; the others are named. */
export function briefingFor(tagged: readonly ChatContextDocument[], all: readonly ChatContextDocument[]): PersonaBriefing {
  const taggedIds = new Set(tagged.map((document) => document.document_id));
  const share = tagged.length === 0 ? 0 : Math.floor(REFERENCED_DOCUMENTS_BUDGET / tagged.length);
  return {
    referenced: tagged.map((document) => renderDocument({ ...document, title: documentLabel(document) }, share)).join('\n\n---\n\n'),
    others: all.filter((document) => !taggedIds.has(document.document_id)).slice(0, MAX_OTHER_DOCUMENTS)
      .map((document) => `- ${documentLabel(document)}`),
  };
}

function personaConverseCommand(modelId: string, systemPrompt: string, question: string): ConverseCommand {
  const adaptive = usesAdaptiveThinking(modelId);
  return new ConverseCommand({
    modelId: invocationModelId(modelId),
    system: [{ text: systemPrompt }],
    messages: [{ role: 'user', content: [{ text: question }] }],
    // Temperature is never sent (adaptive models reject it; it is not needed here).
    inferenceConfig: { maxTokens: adaptive ? PERSONA_MAX_TOKENS : PERSONA_MAX_TOKENS + PERSONA_THINKING_BUDGET },
    ...(adaptive
      ? {}
      : { additionalModelRequestFields: { thinking: { type: 'enabled', budget_tokens: PERSONA_THINKING_BUDGET } } }),
  });
}

function step(type: EventType.STEP_STARTED | EventType.STEP_FINISHED, name: string): StepStartedEvent | StepFinishedEvent {
  return type === EventType.STEP_STARTED
    ? { type: EventType.STEP_STARTED, stepName: `persona:${name}` }
    : { type: EventType.STEP_FINISHED, stepName: `persona:${name}` };
}

/** Everything one consultation needs besides the persona. */
export interface Consultation {
  deps: ToolDeps;
  ctx: AssistantRunContext;
  modelId: string;
  projectName: string;
  question: string;
  briefing: PersonaBriefing;
}

async function consultOne(job: Consultation, persona: ChatContextPersona): Promise<PersonaResponse> {
  const { deps, ctx, briefing } = job;
  const name = persona.name ?? 'Persona';
  ctx.emit(step(EventType.STEP_STARTED, name));
  const systemPrompt = buildSinglePersonaPrompt(
    job.projectName, persona, briefing.referenced, briefing.others, '', [], [], [],
    normalizeLanguage(ctx.props.responseLanguage),
  );
  const [answer, avatarUrl] = await Promise.all([
    deps.converse(personaConverseCommand(job.modelId, systemPrompt, `${job.question}${REVIEW_ONLY_NOTE}`))
      .then((output) => clip(answerText(output), MAX_ANSWER_CHARS) || FAILED_ANSWER)
      .catch((err: unknown) => {
        // Persona id and error name only — never the prompt or the question.
        console.warn(`consult_personas: persona ${persona.persona_id} failed (${err instanceof Error ? err.name : 'unknown'})`);
        return FAILED_ANSWER;
      }),
    deps.resolveAvatar(persona.avatar_url).catch((err: unknown) => {
      // A card without an avatar still carries the answer; persona id and error name only.
      console.warn(`consult_personas: avatar for persona ${persona.persona_id} failed (${err instanceof Error ? err.name : 'unknown'})`);
      return null;
    }),
  ]);
  ctx.emit(step(EventType.STEP_FINISHED, name));
  return { persona_id: persona.persona_id, name, ...(avatarUrl ? { avatar_url: avatarUrl } : {}), answer };
}

export interface ConsultOptions {
  /** Called as each persona answers (the persona round emits its result right away). */
  onAnswer?: (response: PersonaResponse) => void;
  /** Aborted (the user stopped the run): no further batch starts. */
  signal?: AbortSignal;
}

/** Batches of PERSONA_CONCURRENCY, run one batch after another, order preserved. */
export async function consultPersonas(
  job: Consultation,
  personas: readonly ChatContextPersona[],
  options: ConsultOptions = {},
): Promise<PersonaResponse[]> {
  const batches = Array.from(
    { length: Math.ceil(personas.length / PERSONA_CONCURRENCY) },
    (_, index) => personas.slice(index * PERSONA_CONCURRENCY, (index + 1) * PERSONA_CONCURRENCY),
  );
  const answer = async (persona: ChatContextPersona) => {
    const response = await consultOne(job, persona);
    options.onAnswer?.(response);
    return response;
  };
  return batches.reduce<Promise<PersonaResponse[]>>(async (previous, batch) => {
    const done = await previous;
    if (options.signal?.aborted === true) return done;
    return [...done, ...await Promise.all(batch.map(answer))];
  }, Promise.resolve([]));
}
