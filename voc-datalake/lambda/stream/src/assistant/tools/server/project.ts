/**
 * `project` pack server tools — read a project's documents, personas, product
 * context and jobs. Every tool defaults `project_id` to the project on screen.
 */
import { z } from 'zod';
import type { ServerToolDefinition } from '../../types.js';
import type { ToolDeps } from '../deps.js';
import { AssistantToolError } from '../errors.js';
import { clip, isRecord, jsonResult, pick, withinBudget } from '../format.js';
import { idProperty, idSchema, parseToolInput, resolveId, toolSpec } from '../spec.js';
import { parseProjectAccess } from '../project-access.js';
import { loadChatContext, type ChatContextDocument } from './chat-context.js';
import { getProjectRoute, serverTool } from './common.js';
import { recordsAt } from './feedback-shape.js';
import { createConsultPersonasTool } from './consult-personas.js';
import { isPrototype, parseProjectPayload, PERSONA_DETAIL_FIELDS } from './project-shape.js';

const MAX_DOCUMENTS_PER_READ = 5;
/** get_documents exists to hand the model document text, so its budget is larger than the default. */
const DOCUMENTS_BUDGET = 40_000;
const MAX_RESEARCH_NOTES = 10;
const DEFAULT_JOB_LIMIT = 20;

const PROJECT_ID_PROPERTY = idProperty('Project id; omit to use the project on screen.');

const documentsInput = z.object({
  project_id: idSchema.optional(),
  document_ids: z.array(idSchema).min(1).max(MAX_DOCUMENTS_PER_READ),
}).strict();

const personaInput = z.object({ project_id: idSchema.optional(), persona_id: idSchema }).strict();
const projectOnlyInput = z.object({ project_id: idSchema.optional() }).strict();
const jobsInput = z.object({
  project_id: idSchema.optional(),
  limit: z.number().int().min(1).max(50).optional(),
}).strict();

const productContextSchema = z.object({ context: z.record(z.string(), z.unknown()) }).loose();

function renderDocument(document: ChatContextDocument, share: number): string {
  const header = `## ${document.title ?? 'Untitled'} (${(document.document_type ?? 'doc').toUpperCase()}) [ID: ${document.document_id}]`;
  if (isPrototype(document)) {
    return `${header}\nPrototype HTML is not available as text.`;
  }
  if (document.content === undefined) return `${header}\n(No text content.)`;
  return `${header}\n\n${withinBudget(document.content, share)}`;
}

function getDocumentsTool(deps: ToolDeps): ServerToolDefinition {
  const spec = toolSpec(
    'get_documents',
    `Read the full text of up to ${MAX_DOCUMENTS_PER_READ} project documents (PRDs, PR/FAQs, research, custom). `
      + 'Get the ids from get_project. Read a document before proposing changes to it.',
    {
      project_id: PROJECT_ID_PROPERTY,
      document_ids: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: MAX_DOCUMENTS_PER_READ,
        description: 'Document ids to read.',
      },
    },
    ['document_ids'],
  );
  return serverTool('get_documents', 'project', spec, async (input, ctx) => {
    const args = parseToolInput(documentsInput, input);
    const projectId = resolveId(args.project_id, ctx.page.projectId, 'project_id');
    const requested = [...new Set(args.document_ids)];
    const context = await loadChatContext(deps.invoke, projectId, requested, ctx.claims);
    ctx.projectAccess.record(projectId, context.access);
    const byId = new Map(context.documents.map((document) => [document.document_id, document]));
    const share = Math.floor(DOCUMENTS_BUDGET / requested.length);
    const sections = requested.map((id) => {
      const document = byId.get(id);
      return document ? renderDocument(document, share) : `## [ID: ${id}]\nNot found in this project.`;
    });
    return { content: `Project "${context.projectName}" (${projectId}):\n\n${sections.join('\n\n---\n\n')}` };
  });
}

function personaDetail(persona: Record<string, unknown>): Record<string, unknown> {
  const detail = pick(persona, PERSONA_DETAIL_FIELDS, 2000);
  const notes = detail.research_notes;
  if (Array.isArray(notes)) {
    const list: unknown[] = notes;
    detail.research_notes = list.slice(-MAX_RESEARCH_NOTES).map((note) => (isRecord(note)
      ? pick(note, ['note_id', 'text', 'author', 'created_at'], 600)
      : note));
  }
  return detail;
}

function getPersonaTool(deps: ToolDeps): ServerToolDefinition {
  const spec = toolSpec(
    'get_persona',
    'Full profile of one project persona: identity, goals, pain points, behaviours, context, quotes, scenario and the '
      + 'latest research notes. Get persona ids from get_project.',
    { project_id: PROJECT_ID_PROPERTY, persona_id: idProperty('Persona id.') },
    ['persona_id'],
  );
  return serverTool('get_persona', 'project', spec, async (input, ctx) => {
    const args = parseToolInput(personaInput, input);
    const projectId = resolveId(args.project_id, ctx.page.projectId, 'project_id');
    const body = await getProjectRoute(deps, ctx, projectId);
    const payload = parseProjectPayload(body);
    ctx.projectAccess.record(projectId, parseProjectAccess(payload.project.access));
    const persona = payload.personas.find((candidate) => candidate.persona_id === args.persona_id);
    if (!persona) throw new AssistantToolError('not_found', `Persona ${args.persona_id} is not in project ${projectId}.`);
    return { content: jsonResult(personaDetail(persona)) };
  });
}

function getProductContextTool(deps: ToolDeps): ServerToolDefinition {
  const spec = toolSpec(
    'get_product_context',
    'The project\u2019s product context (product name, one-liner, target users, problem, key features, '
      + 'differentiators, limitations, non-goals, success metrics, notes, lifecycle state). Empty strings = not filled in.',
    { project_id: PROJECT_ID_PROPERTY },
  );
  return serverTool('get_product_context', 'project', spec, async (input, ctx) => {
    const args = parseToolInput(projectOnlyInput, input);
    const projectId = resolveId(args.project_id, ctx.page.projectId, 'project_id');
    const body = await getProjectRoute(deps, ctx, projectId, 'product-context');
    const parsed = productContextSchema.safeParse(body);
    if (!parsed.success) throw new AssistantToolError('unavailable', 'The product context could not be read.');
    return { content: jsonResult(parsed.data.context) };
  });
}

function jobSummary(job: Record<string, unknown>): Record<string, unknown> {
  const summary = pick(job, [
    'job_id', 'job_type', 'status', 'progress', 'current_step', 'created_at', 'updated_at', 'completed_at', 'error',
  ], 300);
  if (job.result !== undefined && job.result !== null) summary.result = clip(JSON.stringify(job.result), 300);
  return summary;
}

function listProjectJobsTool(deps: ToolDeps): ServerToolDefinition {
  const spec = toolSpec(
    'list_project_jobs',
    'Recent background jobs of the project (research, persona generation, document generation, merges), newest '
      + 'first, with status and progress. Use it to report on work started after an approval.',
    { project_id: PROJECT_ID_PROPERTY, limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max jobs (default 20).' } },
  );
  return serverTool('list_project_jobs', 'project', spec, async (input, ctx) => {
    const args = parseToolInput(jobsInput, input);
    const projectId = resolveId(args.project_id, ctx.page.projectId, 'project_id');
    const body = await getProjectRoute(deps, ctx, projectId, 'jobs');
    const jobs = recordsAt(body, 'jobs').slice(0, args.limit ?? DEFAULT_JOB_LIMIT);
    return { content: jsonResult({ count: jobs.length, jobs: jobs.map(jobSummary) }) };
  });
}

export function createProjectServerTools(deps: ToolDeps): ServerToolDefinition[] {
  return [
    getDocumentsTool(deps),
    getPersonaTool(deps),
    getProductContextTool(deps),
    listProjectJobsTool(deps),
    createConsultPersonasTool(deps),
  ];
}
