/**
 * consult_personas — ask the project's personas a question; each answers in its
 * own voice from its own system prompt.
 *
 * One NON-streaming Bedrock Converse call per persona, same model as the run,
 * no tools, bounded tokens. Progress is surfaced as AG-UI STEP_STARTED /
 * STEP_FINISHED (`persona:<name>`). The result content is the JSON the SPA
 * renders as persona cards: `{"responses":[{persona_id,name,avatar_url?,answer}]}`.
 */
import { ConverseCommand, type ContentBlock } from '@aws-sdk/client-bedrock-runtime';
import { EventType, type StepFinishedEvent, type StepStartedEvent } from '@ag-ui/core';
import { z } from 'zod';
import { invocationModelId, usesAdaptiveThinking } from '../../../bedrock/model-override.js';
import { isSupportedLanguage, type SupportedLanguage } from '../../../context/language.js';
import { buildSinglePersonaPrompt } from '../../../context/persona-prompt.js';
import type { AssistantRunContext, ServerToolDefinition } from '../../types.js';
import type { ToolDeps } from '../deps.js';
import { AssistantToolError } from '../errors.js';
import { clip } from '../format.js';
import { idProperty, idSchema, parseToolInput, resolveId, toolSpec } from '../spec.js';
import { loadChatContext, type ChatContextPersona } from './chat-context.js';
import { serverTool } from './common.js';

const MAX_CONSULTED_PERSONAS = 6;
/** Personas answered concurrently (bounded to stay clear of Bedrock throttling). */
const PERSONA_CONCURRENCY = 3;
const PERSONA_MAX_TOKENS = 1200;
/** Non-adaptive models get a small explicit thinking budget (Bedrock minimum 1024). */
const PERSONA_THINKING_BUDGET = 1024;
const MAX_ANSWER_CHARS = 4000;
const FAILED_ANSWER = '(No answer — this persona could not be consulted right now.)';

const consultInput = z.object({
  project_id: idSchema.optional(),
  question: z.string().trim().min(1).max(2000),
  persona_ids: z.array(idSchema).min(1).max(MAX_CONSULTED_PERSONAS).optional(),
}).strict();

interface PersonaResponse {
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

function selectPersonas(personas: ChatContextPersona[], requested: string[] | undefined): ChatContextPersona[] {
  if (!requested) return personas.slice(0, MAX_CONSULTED_PERSONAS);
  const byId = new Map(personas.map((persona) => [persona.persona_id, persona]));
  const unknown = requested.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new AssistantToolError('not_found', `Unknown persona id(s) in this project: ${unknown.join(', ')}.`);
  }
  return [...new Set(requested)].flatMap((id) => {
    const persona = byId.get(id);
    return persona ? [persona] : [];
  });
}

function converseCommand(modelId: string, systemPrompt: string, question: string): ConverseCommand {
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

function answerText(content: ContentBlock[] | undefined): string {
  return (content ?? [])
    .map((block) => block.text ?? '')
    .join('')
    .trim();
}

function step(type: EventType.STEP_STARTED | EventType.STEP_FINISHED, name: string): StepStartedEvent | StepFinishedEvent {
  return type === EventType.STEP_STARTED
    ? { type: EventType.STEP_STARTED, stepName: `persona:${name}` }
    : { type: EventType.STEP_FINISHED, stepName: `persona:${name}` };
}

/** Everything one consultation needs besides the persona. */
interface Consultation {
  deps: ToolDeps;
  ctx: AssistantRunContext;
  modelId: string;
  projectName: string;
  question: string;
}

async function consultOne(job: Consultation, persona: ChatContextPersona): Promise<PersonaResponse> {
  const { deps, ctx } = job;
  const name = persona.name ?? 'Persona';
  ctx.emit(step(EventType.STEP_STARTED, name));
  const systemPrompt = buildSinglePersonaPrompt(
    job.projectName, persona, '', [], '', [], [], [], normalizeLanguage(ctx.props.responseLanguage),
  );
  const [answer, avatarUrl] = await Promise.all([
    deps.converse(converseCommand(job.modelId, systemPrompt, job.question))
      .then((output) => clip(answerText(output.output?.message?.content), MAX_ANSWER_CHARS) || FAILED_ANSWER)
      .catch((err: unknown) => {
        // Persona id and error name only — never the prompt or the question.
        console.warn(`consult_personas: persona ${persona.persona_id} failed (${err instanceof Error ? err.name : 'unknown'})`);
        return FAILED_ANSWER;
      }),
    deps.resolveAvatar(persona.avatar_url).catch(() => null),
  ]);
  ctx.emit(step(EventType.STEP_FINISHED, name));
  return { persona_id: persona.persona_id, name, ...(avatarUrl ? { avatar_url: avatarUrl } : {}), answer };
}

/** Batches of PERSONA_CONCURRENCY, run one batch after another, order preserved. */
async function consultAll(job: Consultation, personas: ChatContextPersona[]): Promise<PersonaResponse[]> {
  const batches = Array.from(
    { length: Math.ceil(personas.length / PERSONA_CONCURRENCY) },
    (_, index) => personas.slice(index * PERSONA_CONCURRENCY, (index + 1) * PERSONA_CONCURRENCY),
  );
  return batches.reduce<Promise<PersonaResponse[]>>(
    async (previous, batch) => [...await previous, ...await Promise.all(batch.map((persona) => consultOne(job, persona)))],
    Promise.resolve([]),
  );
}

export function createConsultPersonasTool(deps: ToolDeps): ServerToolDefinition {
  const spec = toolSpec(
    'consult_personas',
    `Ask the project\u2019s personas a question; each persona (up to ${MAX_CONSULTED_PERSONAS}) answers in its own `
      + 'voice. Use for "what would our users think of …", concept tests and roundtables. The answers are shown to '
      + 'the user as persona cards — summarise agreements and disagreements instead of repeating them.',
    {
      project_id: idProperty('Project id; omit to use the project on screen.'),
      question: { type: 'string', maxLength: 2000, description: 'The question or concept to put to the personas.' },
      persona_ids: {
        type: 'array',
        items: { type: 'string' },
        maxItems: MAX_CONSULTED_PERSONAS,
        description: `Personas to ask (default: the first ${MAX_CONSULTED_PERSONAS}).`,
      },
    },
    ['question'],
  );
  return serverTool('consult_personas', 'project', spec, async (input, ctx) => {
    const args = parseToolInput(consultInput, input);
    const projectId = resolveId(args.project_id, ctx.page.projectId, 'project_id');
    const modelId = ctx.modelId ?? deps.fallbackModelId;
    if (!modelId) throw new AssistantToolError('not_configured', 'No model is configured for persona answers.');
    const context = await loadChatContext(deps.invoke, projectId, [], ctx.claims);
    const personas = selectPersonas(context.personas, args.persona_ids);
    if (personas.length === 0) {
      return { content: JSON.stringify({ responses: [], note: 'This project has no personas yet.' }) };
    }
    const responses = await consultAll(
      { deps, ctx, modelId, projectName: context.projectName, question: args.question },
      personas,
    );
    return { content: JSON.stringify({ responses }) };
  });
}
