/**
 * `project` pack writes (and `create_project`) as REST requests — the SPA's
 * `frontend/src/assistant/approvals/executors.ts` + `api/projectsApi.ts`
 * request for request, body for body. Job bodies are filled as the Project
 * Detail wizards fill them (empty filters, the env's window and language).
 */
import { defined, optionalText, present, record, text, textList, type Args } from './write-args.js';
import { dateBasisOf, exact, languageOf, proxied, type RequestBuilder, type WriteEnv, type WriteRequest } from './write-routes.js';

const MAX_DERIVED_TITLE_CHARS = 100;

const projects = (method: WriteRequest['method'], rest: string, body?: unknown) => proxied('projects', method, 'projects', rest, body);
const projectId = (args: Args) => text(args, 'project_id');

/** A job body with the env's window and language; `dateBasis: false` for mergeDocuments, which projectsApi sends without one. */
function jobBody(env: WriteEnv, body: Record<string, unknown>, options: { dateBasis: boolean } = { dateBasis: true }): Record<string, unknown> {
  return { ...(options.dateBasis ? dateBasisOf(env) : {}), ...body, days: env.days, ...languageOf(env) };
}

function researchTitle(args: Args): string {
  const title = optionalText(args, 'title');
  return title === undefined || title.trim() === '' ? text(args, 'question').slice(0, MAX_DERIVED_TITLE_CHARS) : title;
}

function generateDocument(args: Args, env: WriteEnv): WriteRequest {
  const personaIds = textList(args, 'persona_ids');
  const documentIds = textList(args, 'document_ids');
  return projects('POST', `${projectId(args)}/document`, jobBody(env, {
    doc_type: text(args, 'doc_type'),
    title: text(args, 'title'),
    feature_idea: text(args, 'feature_idea'),
    // The wizard flags research and documents from the same list; the model's one list may hold either.
    data_sources: { feedback: true, personas: personaIds.length > 0, documents: documentIds.length > 0, research: documentIds.length > 0 },
    selected_persona_ids: personaIds,
    selected_document_ids: documentIds,
    feedback_sources: textList(args, 'sources'),
    feedback_categories: [],
  }));
}

export const PROJECT_WRITE_REQUESTS: Readonly<Record<string, RequestBuilder>> = {
  create_project: (args) => exact('projects', 'POST', '/projects', { name: text(args, 'name'), ...present('description', optionalText(args, 'description')) }),
  update_project: (args) => projects('PUT', projectId(args), {
    ...present('name', optionalText(args, 'name')),
    ...present('description', optionalText(args, 'description')),
  }),
  update_document: (args, env) => projects('PUT', `${projectId(args)}/documents/${text(args, 'document_id')}`, {
    content: text(args, 'content'),
    ...present('title', optionalText(args, 'title')),
    edit_id: env.editId,
  }),
  create_document: (args) => projects('POST', `${projectId(args)}/documents`, {
    title: text(args, 'title'), content: text(args, 'content'), document_type: 'custom',
  }),
  delete_document: (args) => projects('DELETE', `${projectId(args)}/documents/${text(args, 'document_id')}`),
  update_persona: (args) => projects('PUT', `${projectId(args)}/personas/${text(args, 'persona_id')}`, record(args, 'updates')),
  add_persona_note: (args, env) => projects('POST', `${projectId(args)}/personas/${text(args, 'persona_id')}/notes`, {
    text: text(args, 'text'),
    ...(env.author === undefined || env.author === '' ? {} : { author: env.author }),
  }),
  update_product_context: (args) => projects('PUT', `${projectId(args)}/product-context`, record(args, 'updates')),
  start_research: (args, env) => projects('POST', `${projectId(args)}/research`, jobBody(env, {
    question: text(args, 'question'),
    title: researchTitle(args),
    sources: [],
    categories: [],
    sentiments: [],
    selected_persona_ids: textList(args, 'persona_ids'),
    selected_document_ids: textList(args, 'document_ids'),
    // Research searches the web by default (docs/memory.md); only an explicit false opts out.
    use_web_search: args.use_web_search ?? true,
  })),
  generate_document: generateDocument,
  generate_personas: (args, env) => projects('POST', `${projectId(args)}/personas/generate`, jobBody(env, {
    sources: textList(args, 'sources'),
    categories: [],
    sentiments: [],
    persona_count: args.persona_count,
    custom_instructions: optionalText(args, 'custom_instructions') ?? '',
    // Adding is the default; only an explicit false (on the approved plan) replaces (#353).
    keep_existing_personas: args.keep_existing_personas !== false,
  })),
  merge_documents: (args, env) => projects('POST', `${projectId(args)}/documents/merge`, jobBody(env, {
    output_type: text(args, 'output_type'),
    title: text(args, 'title'),
    instructions: text(args, 'instructions'),
    selected_document_ids: textList(args, 'document_ids'),
    selected_persona_ids: textList(args, 'persona_ids'),
    use_feedback: false,
    feedback_sources: [],
    feedback_categories: [],
  }, { dateBasis: false })),
  build_prototype: (args, env) => {
    const body = Object.fromEntries(Object.entries(defined(args)).filter(([key]) => key !== 'project_id'));
    return projects('POST', `${projectId(args)}/build-prototype`, { ...body, ...languageOf(env) });
  },
};
