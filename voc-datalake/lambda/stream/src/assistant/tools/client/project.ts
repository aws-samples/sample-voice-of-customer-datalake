/**
 * `project` pack client (write) tools. Each carries an explicit required
 * `project_id`, filled from the page during validation when the model omits
 * it, so the approval card always names the project touched.
 */
import { z } from 'zod';
import type { ClientToolDefinition } from '../../types.js';
import { idProperty, idSchema } from '../spec.js';
import { personaUpdatesSchema, productContextUpdatesSchema } from './allowlists.js';
import { defineClientTool, idListProperty, idListSchema, presentParts, q, stringProperty } from './define.js';

const PROJECT_ID = idProperty('Project id (defaults to the project on screen).');
const MAX_CONTENT_CHARS = 200_000;
const MAX_LINKED_IDS = 20;

const updateDocument = defineClientTool({
  name: 'update_document',
  pack: 'project',
  description: 'Replace the content of a textual project document (PRD, PR/FAQ, research, custom). Read it with '
    + 'get_documents first and send the COMPLETE new markdown, not a diff. Prototypes cannot be edited this way. '
    + 'Every edit is saved as a NEW version (the previous one stays in the document\'s Versions list); a PRD or '
    + 'PR/FAQ version gets a new document id, which the result reports — use that id for any further edit.',
  properties: {
    project_id: PROJECT_ID,
    document_id: idProperty('Document to update.'),
    content: stringProperty('The full new document content (markdown).', MAX_CONTENT_CHARS),
    title: stringProperty('New title (research/custom documents only).', 200),
    change_summary: stringProperty('One-line description of what changed, shown to the user.', 500),
  },
  required: ['project_id', 'document_id', 'content', 'change_summary'],
  projectScoped: true,
  schema: z.object({
    project_id: idSchema,
    document_id: idSchema,
    content: z.string().min(1).max(MAX_CONTENT_CHARS),
    title: z.string().trim().min(1).max(200).optional(),
    change_summary: z.string().trim().min(1).max(500),
  }).strict(),
  summarize: (args) => `Update document ${q(args.title ?? args.document_id)} in project ${args.project_id}: ${args.change_summary}`,
});

const createDocument = defineClientTool({
  name: 'create_document',
  pack: 'project',
  description: 'Create a new custom markdown document in the project (e.g. a summary of this conversation).',
  properties: {
    project_id: PROJECT_ID,
    title: stringProperty('Document title.', 200),
    content: stringProperty('Document content (markdown).', MAX_CONTENT_CHARS),
  },
  required: ['project_id', 'title', 'content'],
  projectScoped: true,
  schema: z.object({
    project_id: idSchema,
    title: z.string().trim().min(1).max(200),
    content: z.string().min(1).max(MAX_CONTENT_CHARS),
  }).strict(),
  summarize: (args) => `Create document ${q(args.title)} in project ${args.project_id} (${args.content.length} characters).`,
});

const deleteDocument = defineClientTool({
  name: 'delete_document',
  pack: 'project',
  description: 'Permanently delete a project document. Destructive — only when the user explicitly asks.',
  properties: {
    project_id: PROJECT_ID,
    document_id: idProperty('Document to delete.'),
    reason: stringProperty('Why it is being deleted, shown to the user.', 500),
  },
  required: ['project_id', 'document_id', 'reason'],
  projectScoped: true,
  schema: z.object({
    project_id: idSchema,
    document_id: idSchema,
    reason: z.string().trim().min(1).max(500),
  }).strict(),
  summarize: (args) => `DELETE document ${args.document_id} from project ${args.project_id}: ${args.reason}`,
});

const updatePersona = defineClientTool({
  name: 'update_persona',
  pack: 'project',
  description: 'Change fields of a persona. Allowed keys in `updates`: name, tagline, confidence (low|medium|high), '
    + 'identity, goals_motivations, pain_points, behaviors, context_environment, scenario (objects with their '
    + 'persona-schema keys), quotes (list of {text, context?}). '
    + 'A section you send REPLACES the stored one — read it with get_persona and send the whole merged section.',
  properties: {
    project_id: PROJECT_ID,
    persona_id: idProperty('Persona to update.'),
    updates: { type: 'object', description: 'Fields to replace (see the allowed keys).' },
  },
  required: ['project_id', 'persona_id', 'updates'],
  projectScoped: true,
  schema: z.object({ project_id: idSchema, persona_id: idSchema, updates: personaUpdatesSchema }).strict(),
  summarize: (args) => `Update persona ${args.persona_id} in project ${args.project_id}: ${Object.keys(args.updates).join(', ')}.`,
});

const addPersonaNote = defineClientTool({
  name: 'add_persona_note',
  pack: 'project',
  description: 'Append a research note to a persona.',
  properties: {
    project_id: PROJECT_ID,
    persona_id: idProperty('Persona to annotate.'),
    text: stringProperty('Note text.', 2000),
  },
  required: ['project_id', 'persona_id', 'text'],
  projectScoped: true,
  schema: z.object({ project_id: idSchema, persona_id: idSchema, text: z.string().trim().min(1).max(2000) }).strict(),
  summarize: (args) => `Add a note to persona ${args.persona_id} in project ${args.project_id}: ${q(args.text, 120)}`,
});

const updateProject = defineClientTool({
  name: 'update_project',
  pack: 'project',
  description: 'Rename the project and/or change its description.',
  properties: {
    project_id: PROJECT_ID,
    name: stringProperty('New project name.', 200),
    description: stringProperty('New project description.', 2000),
  },
  required: ['project_id'],
  projectScoped: true,
  schema: z.object({
    project_id: idSchema,
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
  }).strict().refine((args) => args.name !== undefined || args.description !== undefined, 'give a name or a description'),
  summarize: (args) => `Update project ${args.project_id}: ${presentParts([
    args.name !== undefined && `name → ${q(args.name)}`,
    args.description !== undefined && 'new description',
  ])}.`,
});

const updateProductContext = defineClientTool({
  name: 'update_product_context',
  pack: 'project',
  description: 'Fill in or change the project\u2019s product context. Allowed keys in `updates` (all strings): '
    + 'product_name, one_liner, target_users, problem_solved, key_features, differentiators, known_limitations, '
    + 'non_goals, success_metrics, free_form_notes; and current_state (idea|mvp|beta|ga|mature).',
  properties: {
    project_id: PROJECT_ID,
    updates: { type: 'object', description: 'Fields to set (see the allowed keys).' },
  },
  required: ['project_id', 'updates'],
  projectScoped: true,
  schema: z.object({ project_id: idSchema, updates: productContextUpdatesSchema }).strict(),
  summarize: (args) => `Update the product context of project ${args.project_id}: ${Object.keys(args.updates).join(', ')}.`,
});

const startResearch = defineClientTool({
  name: 'start_research',
  pack: 'project',
  description: 'Start a background research job that analyses the feedback (and optionally the web) to answer a '
    + 'question; it produces a research document. Track it with list_project_jobs.',
  properties: {
    project_id: PROJECT_ID,
    question: stringProperty('The research question.', 2000),
    title: stringProperty('Title of the research document.', 200),
    persona_ids: idListProperty('Personas to take into account.', MAX_LINKED_IDS),
    document_ids: idListProperty('Documents to use as context.', MAX_LINKED_IDS),
    use_web_search: { type: 'boolean', description: 'Also search the public web.' },
  },
  required: ['project_id', 'question'],
  projectScoped: true,
  schema: z.object({
    project_id: idSchema,
    question: z.string().trim().min(1).max(2000),
    title: z.string().trim().min(1).max(200).optional(),
    persona_ids: idListSchema(MAX_LINKED_IDS).optional(),
    document_ids: idListSchema(MAX_LINKED_IDS).optional(),
    use_web_search: z.boolean().optional(),
  }).strict(),
  summarize: (args) => `Start research in project ${args.project_id}: ${q(args.question, 120)}${args.use_web_search ? ' (with web search)' : ''}.`,
});

const generateDocument = defineClientTool({
  name: 'generate_document',
  pack: 'project',
  description: 'Start a background job that writes a PRD or PR/FAQ for a feature idea from the feedback, personas '
    + 'and selected documents.',
  properties: {
    project_id: PROJECT_ID,
    doc_type: { type: 'string', enum: ['prd', 'prfaq'], description: 'Document type.' },
    title: stringProperty('Document title.', 200),
    feature_idea: stringProperty('The feature idea to write up.', 4000),
    persona_ids: idListProperty('Personas to write for.', MAX_LINKED_IDS),
    document_ids: idListProperty('Documents to use as context.', MAX_LINKED_IDS),
  },
  required: ['project_id', 'doc_type', 'title', 'feature_idea'],
  projectScoped: true,
  schema: z.object({
    project_id: idSchema,
    doc_type: z.enum(['prd', 'prfaq']),
    title: z.string().trim().min(1).max(200),
    feature_idea: z.string().trim().min(1).max(4000),
    persona_ids: idListSchema(MAX_LINKED_IDS).optional(),
    document_ids: idListSchema(MAX_LINKED_IDS).optional(),
  }).strict(),
  summarize: (args) => `Generate a ${args.doc_type === 'prd' ? 'PRD' : 'PR/FAQ'} ${q(args.title)} in project ${args.project_id}.`,
});

const generatePersonas = defineClientTool({
  name: 'generate_personas',
  pack: 'project',
  description: 'Start a background job that derives new personas from the feedback in the page time window.',
  properties: {
    project_id: PROJECT_ID,
    persona_count: { type: 'integer', minimum: 1, maximum: 8, description: 'How many personas (1-8).' },
    custom_instructions: stringProperty('Extra guidance for the generator.', 2000),
  },
  required: ['project_id', 'persona_count'],
  projectScoped: true,
  schema: z.object({
    project_id: idSchema,
    persona_count: z.number().int().min(1).max(8),
    custom_instructions: z.string().max(2000).optional(),
  }).strict(),
  summarize: (args) => `Generate ${args.persona_count} persona${args.persona_count === 1 ? '' : 's'} in project ${args.project_id}.`,
});

const mergeDocuments = defineClientTool({
  name: 'merge_documents',
  pack: 'project',
  description: 'Start a background job that merges 2-10 project documents into a new PRD, PR/FAQ or custom document.',
  properties: {
    project_id: PROJECT_ID,
    output_type: { type: 'string', enum: ['prd', 'prfaq', 'custom'], description: 'Type of the merged document.' },
    title: stringProperty('Title of the merged document.', 200),
    instructions: stringProperty('How to merge.', 4000),
    document_ids: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 10, description: 'Documents to merge.' },
    persona_ids: idListProperty('Personas to take into account.', MAX_LINKED_IDS),
  },
  required: ['project_id', 'output_type', 'title', 'instructions', 'document_ids'],
  projectScoped: true,
  schema: z.object({
    project_id: idSchema,
    output_type: z.enum(['prd', 'prfaq', 'custom']),
    title: z.string().trim().min(1).max(200),
    instructions: z.string().trim().min(1).max(4000),
    document_ids: idListSchema(10).min(2),
    persona_ids: idListSchema(MAX_LINKED_IDS).optional(),
  }).strict(),
  summarize: (args) => `Merge ${args.document_ids.length} documents into ${q(args.title)} (${args.output_type}) in project ${args.project_id}.`,
});

export function createProjectClientTools(): ClientToolDefinition[] {
  return [
    updateDocument,
    createDocument,
    deleteDocument,
    updatePersona,
    addPersonaNote,
    updateProject,
    updateProductContext,
    startResearch,
    generateDocument,
    generatePersonas,
    mergeDocuments,
  ];
}
