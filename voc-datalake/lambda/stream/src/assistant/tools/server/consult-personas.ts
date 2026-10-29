/**
 * consult_personas — ask the project's personas a question; each answers in its
 * own voice from its own system prompt (persona-consult.ts), optionally grounded
 * on up to MENTION_LIMITS.maxDocuments project documents.
 *
 * The result content is the JSON the SPA renders as persona cards:
 * `{"responses":[{persona_id,name,avatar_url?,answer}]}`. The persona round
 * (runtime/persona-round.ts) emits the same shape, one persona per call.
 */
import { z } from 'zod';
import { MENTION_LIMITS } from '../../contract.js';
import type { ServerToolDefinition } from '../../types.js';
import type { ToolDeps } from '../deps.js';
import { AssistantToolError } from '../errors.js';
import { idProperty, idSchema, parseToolInput, resolveId, toolSpec } from '../spec.js';
import { loadChatContext, type ChatContextDocument, type ChatContextPersona } from './chat-context.js';
import { serverTool } from './common.js';
import { briefingFor, consultPersonas, MAX_CONSULTED_PERSONAS } from './persona-consult.js';

const consultInput = z.object({
  project_id: idSchema.optional(),
  question: z.string().trim().min(1).max(2000),
  persona_ids: z.array(idSchema).min(1).max(MAX_CONSULTED_PERSONAS).optional(),
  document_ids: z.array(idSchema).min(1).max(MENTION_LIMITS.maxDocuments).optional(),
}).strict();

/** The requested rows in request order (duplicates dropped); an id this project does not have is a not_found. */
function selectKnown<T>(rows: readonly T[], idOf: (row: T) => string, requested: readonly string[], noun: string): T[] {
  const byId = new Map(rows.map((row) => [idOf(row), row]));
  const unknown = requested.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new AssistantToolError('not_found', `Unknown ${noun} id(s) in this project: ${unknown.join(', ')}.`);
  }
  return [...new Set(requested)].flatMap((id) => {
    const row = byId.get(id);
    return row === undefined ? [] : [row];
  });
}

function selectPersonas(personas: ChatContextPersona[], requested: string[] | undefined): ChatContextPersona[] {
  if (!requested) return personas.slice(0, MAX_CONSULTED_PERSONAS);
  return selectKnown(personas, (persona) => persona.persona_id, requested, 'persona');
}

function selectDocuments(documents: ChatContextDocument[], requested: readonly string[]): ChatContextDocument[] {
  return selectKnown(documents, (document) => document.document_id, requested, 'document');
}

export function createConsultPersonasTool(deps: ToolDeps): ServerToolDefinition {
  const spec = toolSpec(
    'consult_personas',
    `Ask the project\u2019s personas a question; each persona (up to ${MAX_CONSULTED_PERSONAS}) answers in its own `
      + 'voice, as review and feedback only. Use for "what would our users think of …", concept tests and roundtables. '
      + 'The answers are shown to the user as persona cards — summarise agreements and disagreements instead of '
      + 'repeating them.',
    {
      project_id: idProperty('Project id; omit to use the project on screen.'),
      question: { type: 'string', maxLength: 2000, description: 'The question or concept to put to the personas.' },
      persona_ids: {
        type: 'array',
        items: { type: 'string' },
        maxItems: MAX_CONSULTED_PERSONAS,
        description: `Personas to ask (default: the first ${MAX_CONSULTED_PERSONAS}).`,
      },
      document_ids: {
        type: 'array',
        items: { type: 'string' },
        maxItems: MENTION_LIMITS.maxDocuments,
        description: 'Project documents every persona reads before answering (e.g. a PR/FAQ to review).',
      },
    },
    ['question'],
  );
  return serverTool('consult_personas', 'project', spec, async (input, ctx) => {
    const args = parseToolInput(consultInput, input);
    const projectId = resolveId(args.project_id, ctx.page.projectId, 'project_id');
    const modelId = ctx.modelId ?? deps.fallbackModelId;
    if (!modelId) throw new AssistantToolError('not_configured', 'No model is configured for persona answers.');
    const documentIds = [...new Set(args.document_ids ?? [])];
    const context = await loadChatContext(deps.invoke, projectId, documentIds, ctx.claims);
    ctx.projectAccess.record(projectId, context.access);
    const personas = selectPersonas(context.personas, args.persona_ids);
    if (personas.length === 0) {
      return { content: JSON.stringify({ responses: [], note: 'This project has no personas yet.' }) };
    }
    const briefing = briefingFor(selectDocuments(context.documents, documentIds), context.documents);
    const responses = await consultPersonas(
      { deps, ctx, modelId, projectName: context.projectName, question: args.question, briefing },
      personas,
    );
    return { content: JSON.stringify({ responses }) };
  });
}
