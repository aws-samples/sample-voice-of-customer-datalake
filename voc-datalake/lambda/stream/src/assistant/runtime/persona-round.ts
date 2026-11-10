/**
 * The persona round: the user @mentioned personas (or @all) in a message on a project page, so
 * each of them answers BEFORE the model's own turn (docs/assistant-mentions.md).
 *
 * The round is deterministic, not a model decision: one assistant message carries one
 * `consult_personas` call per persona (ids start with MENTION_TOOL_CALL_PREFIX), each answered by
 * its own TOOL_CALL_RESULT as soon as that persona has replied. That is the shape the SPA already
 * renders as attributed persona cards (name, avatar) and the session already stores, so the
 * replies survive a reload. Personas read the #tagged documents and their own profile, answer as
 * review only, and have no tools. Their answers then reach the model as a `<mentions>` data
 * block (mentions-block.ts) for a short synthesis.
 *
 * `@all` = the project's personas in project order, capped at MENTION_LIMITS.maxPersonas; the
 * block names the ones left out. Mentioned ids that no longer exist are reported, never fatal.
 * Fails OPEN: a failed read means no persona answers and a note in the block; the run goes on.
 */
import { randomUUID } from 'node:crypto';
import { MENTION_ALL_PERSONAS, MENTION_LIMITS, MENTION_TOOL_CALL_PREFIX, type Mentions } from '../contract.js';
import type { AssistantRunContext } from '../types.js';
import type { ToolDeps } from '../tools/deps.js';
import { AssistantToolError } from '../tools/errors.js';
import { clip } from '../tools/format.js';
import { loadChatContext, type ChatContext, type ChatContextDocument, type ChatContextPersona } from '../tools/server/chat-context.js';
import { briefingFor, consultPersonas, documentLabel, type PersonaResponse } from '../tools/server/persona-consult.js';
import { emitToolCall, events } from './emitter.js';
import { buildMentionsBlock, type MentionsOutcome } from './mentions-block.js';

/** consult_personas' own question bound: the round's calls stay valid calls of that tool. */
const MAX_QUESTION_CHARS = 2000;
const DEFAULT_QUESTION = 'What do you think? Share your honest feedback.';
const STOPPED_RESULT = JSON.stringify({ responses: [], note: 'Stopped before this persona answered.' });

export interface PersonaRoundInput {
  mentions: Mentions;
  /** The text of the user's message (the question every persona answers). */
  question: string;
  ctx: AssistantRunContext;
  /** Aborted when the user stops the run: no further persona is asked. */
  signal?: AbortSignal;
}

/** Runs the round and returns the `<mentions>` block for the model (undefined: nothing to say). */
export type PersonaRound = (input: PersonaRoundInput) => Promise<string | undefined>;

interface Selection {
  personas: ChatContextPersona[];
  /** The tagged documents found in the project, in mention order. */
  tagged: ChatContextDocument[];
  notAsked: string[];
  missing: string[];
}

type PersonaSelection = Omit<Selection, 'tagged'>;

function selectPersonas(context: ChatContext, requested: Mentions['personas']): PersonaSelection {
  if (requested === undefined) return { personas: [], notAsked: [], missing: [] };
  if (requested === MENTION_ALL_PERSONAS) {
    return {
      personas: context.personas.slice(0, MENTION_LIMITS.maxPersonas),
      notAsked: context.personas.slice(MENTION_LIMITS.maxPersonas).map((persona) => persona.name ?? persona.persona_id),
      missing: [],
    };
  }
  const byId = new Map(context.personas.map((persona) => [persona.persona_id, persona]));
  const ids = [...new Set(requested)];
  return {
    personas: ids.flatMap((id) => byId.get(id) ?? []),
    notAsked: [],
    missing: ids.filter((id) => !byId.has(id)),
  };
}

function documentIdsOf(mentions: Mentions): string[] {
  return [...new Set((mentions.documents ?? []).map((document) => document.document_id))];
}

function emptyOutcome(): MentionsOutcome {
  return { documents: [], responses: [], notAsked: [], missingPersonas: [], missingDocuments: [] };
}

function failureText(err: unknown): string {
  if (err instanceof AssistantToolError) return err.message;
  return 'the project could not be read right now.';
}

/** One call per persona, emitted together so the SPA shows the round at once; answers follow. */
function emitCalls(ctx: AssistantRunContext, personas: readonly ChatContextPersona[], args: Record<string, unknown>): Map<string, string> {
  const parentMessageId = randomUUID();
  const callIds = new Map<string, string>();
  for (const persona of personas) {
    const toolCallId = `${MENTION_TOOL_CALL_PREFIX}${randomUUID().replaceAll('-', '')}`;
    callIds.set(persona.persona_id, toolCallId);
    emitToolCall({ emit: ctx.emit }, {
      toolCallId, name: 'consult_personas', parentMessageId,
      argsJson: JSON.stringify({ ...args, persona_ids: [persona.persona_id] }),
    });
  }
  return callIds;
}

function emitResult(ctx: AssistantRunContext, toolCallId: string | undefined, content: string): void {
  if (toolCallId !== undefined) ctx.emit(events.toolResult(randomUUID(), toolCallId, content));
}

async function askPersonas(
  deps: ToolDeps,
  input: PersonaRoundInput,
  context: ChatContext,
  selection: Selection,
  outcome: MentionsOutcome,
): Promise<MentionsOutcome> {
  const { ctx } = input;
  const modelId = ctx.modelId ?? deps.fallbackModelId;
  if (modelId === undefined) return { ...outcome, failure: 'no model is configured for persona answers.' };
  const { tagged } = selection;
  const question = clip(input.question.trim() || DEFAULT_QUESTION, MAX_QUESTION_CHARS);
  const documentIds = tagged.map((document) => document.document_id);
  const callIds = emitCalls(ctx, selection.personas, { question, ...(documentIds.length > 0 ? { document_ids: documentIds } : {}) });
  const answered = new Set<string>();
  const responses = await consultPersonas(
    { deps, ctx, modelId, projectName: context.projectName, question, briefing: briefingFor(tagged, context.documents) },
    selection.personas,
    {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      onAnswer: (response: PersonaResponse) => {
        answered.add(response.persona_id);
        emitResult(ctx, callIds.get(response.persona_id), JSON.stringify({ responses: [response] }));
      },
    },
  );
  // Stopped mid-round: every call still gets a result, so the stored thread stays well formed.
  for (const persona of selection.personas) {
    if (!answered.has(persona.persona_id)) emitResult(ctx, callIds.get(persona.persona_id), STOPPED_RESULT);
  }
  return { ...outcome, responses };
}

async function runRound(deps: ToolDeps, input: PersonaRoundInput): Promise<MentionsOutcome> {
  const { ctx, mentions } = input;
  const projectId = ctx.page.projectId;
  if (projectId === undefined) return { ...emptyOutcome(), failure: 'there is no project on this page.' };
  const documentIds = documentIdsOf(mentions);
  const context = await loadChatContext(deps.invoke, projectId, documentIds, ctx.claims);
  ctx.projectAccess.record(projectId, context.access);
  const byId = new Map(context.documents.map((document) => [document.document_id, document]));
  const tagged = documentIds.flatMap((id) => byId.get(id) ?? []);
  const selection: Selection = { ...selectPersonas(context, mentions.personas), tagged };
  const outcome: MentionsOutcome = {
    ...emptyOutcome(),
    documents: tagged.map((document) => ({ document_id: document.document_id, label: documentLabel(document) })),
    notAsked: selection.notAsked,
    missingPersonas: selection.missing,
    missingDocuments: documentIds.filter((id) => !byId.has(id)),
  };
  return selection.personas.length === 0 ? outcome : askPersonas(deps, input, context, selection, outcome);
}

export function createPersonaRound(deps: ToolDeps): PersonaRound {
  return async (input) => {
    try {
      return buildMentionsBlock(await runRound(deps, input));
    } catch (err) {
      // Error class only: never the question, a persona or a document.
      console.warn(`persona round failed (${err instanceof Error ? err.name : 'unknown'})`);
      return buildMentionsBlock({ ...emptyOutcome(), failure: failureText(err) });
    }
  };
}
