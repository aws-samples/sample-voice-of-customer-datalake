/**
 * One case per plan-able write tool: validated arguments, the env, and the REST
 * request the SPA executor sends for them. Read by write-requests.test.ts and
 * meant for the SPA's lockstep spec (`frontend/src/assistant/plan/
 * writeRequests.lockstep.test.ts`), which runs the same arguments through the
 * SPA executor with a spy on fetchApi.
 */
import { SAMPLE_WORKFLOW } from '../tools/client/new-tools-fixtures.js';
import { storedScraperRecord } from './scraper-records.js';
import type { WriteEnv, WriteRequest } from './write-routes.js';

export interface WriteRequestCase {
  tool: string;
  args: Record<string, unknown>;
  request: WriteRequest;
}

export const CASE_ENV: WriteEnv = { days: 30, responseLanguage: 'es', dateBasis: 'review', author: 'jane', editId: 'edit-1' };

const P = 'proj_1';
const projects = (method: WriteRequest['method'], rest: string, body?: unknown): WriteRequest => ({
  fn: 'projects', method, path: `/projects/${rest}`, resource: '/projects/{proxy+}', pathParameters: { proxy: rest }, ...(body === undefined ? {} : { body }),
});
const proxied = (fn: WriteRequest['fn'], method: WriteRequest['method'], root: string, rest: string, body?: unknown): WriteRequest => ({
  fn, method, path: `/${root}/${rest}`, resource: `/${root}/{proxy+}`, pathParameters: { proxy: rest }, ...(body === undefined ? {} : { body }),
});
const JOB = { days: 30, response_language: 'es' };

const PROJECT_CASES: WriteRequestCase[] = [
  { tool: 'create_project', args: { name: 'Ancillaries', description: 'Hotels, cars, eSIM' }, request: { fn: 'projects', method: 'POST', path: '/projects', resource: '/projects', body: { name: 'Ancillaries', description: 'Hotels, cars, eSIM' } } },
  { tool: 'update_project', args: { project_id: P, name: 'Renamed' }, request: projects('PUT', P, { name: 'Renamed' }) },
  { tool: 'update_document', args: { project_id: P, document_id: 'prd_1', content: '# PRD', change_summary: 'Scope' }, request: projects('PUT', `${P}/documents/prd_1`, { content: '# PRD', edit_id: 'edit-1' }) },
  { tool: 'create_document', args: { project_id: P, title: 'Notes', content: 'Body' }, request: projects('POST', `${P}/documents`, { title: 'Notes', content: 'Body', document_type: 'custom' }) },
  { tool: 'delete_document', args: { project_id: P, document_id: 'doc_1', reason: 'Duplicate' }, request: projects('DELETE', `${P}/documents/doc_1`) },
  { tool: 'update_persona', args: { project_id: P, persona_id: 'pe_1', updates: { tagline: 'Busy' } }, request: projects('PUT', `${P}/personas/pe_1`, { tagline: 'Busy' }) },
  { tool: 'add_persona_note', args: { project_id: P, persona_id: 'pe_1', text: 'Pricing' }, request: projects('POST', `${P}/personas/pe_1/notes`, { text: 'Pricing', author: 'jane' }) },
  { tool: 'update_product_context', args: { project_id: P, updates: { one_liner: 'Fast' } }, request: projects('PUT', `${P}/product-context`, { one_liner: 'Fast' }) },
  {
    tool: 'start_research', args: { project_id: P, question: 'Why churn?' },
    request: projects('POST', `${P}/research`, { date_basis: 'review', question: 'Why churn?', title: 'Why churn?', sources: [], categories: [], sentiments: [], selected_persona_ids: [], selected_document_ids: [], use_web_search: true, ...JOB }),
  },
  {
    tool: 'generate_document', args: { project_id: P, doc_type: 'prfaq', title: 'Ancillaries', feature_idea: 'Bundles', persona_ids: ['pe_1'], sources: ['ExampleAir_iOS', 'ExampleAir_Android'] },
    request: projects('POST', `${P}/document`, {
      date_basis: 'review', doc_type: 'prfaq', title: 'Ancillaries', feature_idea: 'Bundles',
      data_sources: { feedback: true, personas: true, documents: false, research: false },
      selected_persona_ids: ['pe_1'], selected_document_ids: [], feedback_sources: ['ExampleAir_iOS', 'ExampleAir_Android'], feedback_categories: [], ...JOB,
    }),
  },
  {
    tool: 'generate_personas', args: { project_id: P, persona_count: 4, custom_instructions: 'Example Air customers only', sources: ['ExampleAir_iOS'] },
    request: projects('POST', `${P}/personas/generate`, { date_basis: 'review', sources: ['ExampleAir_iOS'], categories: [], sentiments: [], persona_count: 4, custom_instructions: 'Example Air customers only', ...JOB }),
  },
  {
    tool: 'merge_documents', args: { project_id: P, output_type: 'prd', title: 'Merged', instructions: 'Combine', document_ids: ['d1', 'd2'] },
    request: projects('POST', `${P}/documents/merge`, {
      output_type: 'prd', title: 'Merged', instructions: 'Combine', selected_document_ids: ['d1', 'd2'], selected_persona_ids: [],
      use_feedback: false, feedback_sources: [], feedback_categories: [], ...JOB,
    }),
  },
  { tool: 'build_prototype', args: { project_id: P, title: 'Proto', source_prfaq_id: 'pf_1' }, request: projects('POST', `${P}/build-prototype`, { title: 'Proto', source_prfaq_id: 'pf_1', response_language: 'es' }) },
];

const WORKSPACE_CASES: WriteRequestCase[] = [
  { tool: 'remember', args: { scope: 'personal', statement: 'Short answers.', kind: 'working_style' }, request: { fn: 'memory', method: 'POST', path: '/memory', resource: '/memory', body: { scope: 'personal', statement: 'Short answers.', kind: 'working_style' } } },
  { tool: 'update_company_memory', args: { memory_id: 'mem_1', previous_statement: 'Per seat.', statement: 'SSO.', kind: 'product', supporters: 3, reason: 'Changed' }, request: proxied('memory', 'PUT', 'memory', 'mem_1', { statement: 'SSO.' }) },
  { tool: 'set_problem_resolved', args: { problem_key: 'delivery::late', resolved: true }, request: proxied('settings', 'PUT', 'settings', 'resolved-problems', { key: 'delivery::late', resolved: true }) },
  { tool: 'set_feedback_category', args: { feedback_id: 'fb:1', category: 'delivery' }, request: { fn: 'feedbackEdit', method: 'PUT', path: '/feedback/fb%3A1/category', resource: '/feedback/{id}/category', pathParameters: { id: 'fb:1' }, body: { category: 'delivery' } } },
  { tool: 'update_feedback_form', args: { form_id: 'abc12345', updates: { enabled: true } }, request: { fn: 'feedbackForms', method: 'PUT', path: '/feedback-forms/abc12345', resource: '/feedback-forms/{form_id}', pathParameters: { form_id: 'abc12345' }, body: { enabled: true } } },
  { tool: 'run_scraper', args: { scraper_id: 'sc_1' }, request: proxied('scrapers', 'POST', 'scrapers', 'sc_1/run') },
  {
    tool: 'create_scraper', args: { id: 'acme', name: 'Acme', extraction_method: 'jsonld', base_url: 'https://www.acme.example/r' },
    request: { fn: 'scrapers', method: 'POST', path: '/scrapers', resource: '/scrapers', body: { scraper: {
      id: 'acme', name: 'Acme', extraction_method: 'jsonld', base_url: 'https://www.acme.example/r', enabled: false, urls: [], frequency_minutes: 0,
      container_selector: '', text_selector: '', pagination: { enabled: false, param: 'page', max_pages: 1, start: 1 },
    } } },
  },
  {
    tool: 'create_app_connector', args: { source: 'app_reviews_ios', app_name: 'ExampleAir iOS', app_id: '1234567890' },
    request: { fn: 'integrations', method: 'POST', path: '/integrations/app_reviews_ios/apps', resource: '/integrations/{source}/{proxy+}', pathParameters: { source: 'app_reviews_ios', proxy: 'apps' }, body: { app: { app_name: 'ExampleAir iOS', app_id: '1234567890', sort_by: 'most_recent', max_reviews_per_run: '500', frequency_minutes: '0' } } },
  },
  { tool: 'run_source', args: { source: 'app_reviews_ios' }, request: { fn: 'integrations', method: 'POST', path: '/sources/app_reviews_ios/run', resource: '/sources/{source}/{proxy+}', pathParameters: { source: 'app_reviews_ios', proxy: 'run' } } },
  { tool: 'set_source_enabled', args: { source: 'webscraper', enabled: false }, request: { fn: 'integrations', method: 'PUT', path: '/sources/webscraper/disable', resource: '/sources/{source}/{proxy+}', pathParameters: { source: 'webscraper', proxy: 'disable' } } },
  { tool: 'forget_memory', args: { memory_id: 'mem_1', statement: 'Old.', reason: 'Wrong' }, request: proxied('memory', 'POST', 'memory', 'mem_1/forget') },
  { tool: 'merge_memories', args: { memory_ids: ['mem_1', 'mem_2'], statement: 'SSO and SCIM.' }, request: proxied('memory', 'POST', 'memory', 'merge', { ids: ['mem_1', 'mem_2'], statement: 'SSO and SCIM.' }) },
  { tool: 'confirm_memory', args: { memory_id: 'mem_1', statement: 'SSO.' }, request: proxied('memory', 'POST', 'memory', 'mem_1/confirm') },
  { tool: 'resolve_memory_conflict', args: { memory_id: 'mem_1', action: 'keep', winner_id: 'mem_2' }, request: proxied('memory', 'POST', 'memory', 'review/mem_1/resolve', { action: 'keep', winner_id: 'mem_2' }) },
  {
    tool: 'create_agent', args: { name: 'Watcher', scope: { all: false, categories: ['checkout'], subcategories: [] } },
    request: { fn: 'agents', method: 'POST', path: '/agents', resource: '/agents', body: { name: 'Watcher', scope: { all: false, categories: ['checkout'], subcategories: [] } } },
  },
  { tool: 'update_agent', args: { agent_id: 'ag_1', updates: { instructions: 'Mobile.' }, change_summary: 'Mobile' }, request: proxied('agents', 'PUT', 'agents', 'ag_1', { instructions: 'Mobile.' }) },
  { tool: 'enable_agent', args: { agent_id: 'ag_1' }, request: proxied('agents', 'POST', 'agents', 'ag_1/enable') },
  { tool: 'disable_agent', args: { agent_id: 'ag_1' }, request: proxied('agents', 'POST', 'agents', 'ag_1/disable') },
  { tool: 'run_agent', args: { agent_id: 'ag_1' }, request: proxied('agents', 'POST', 'agents', 'ag_1/run') },
  { tool: 'cancel_agent_run', args: { agent_id: 'ag_1', run_id: 'ar_1' }, request: proxied('agents', 'POST', 'agents', 'ag_1/runs/ar_1/cancel') },
  { tool: 'create_workflow', args: { definition: SAMPLE_WORKFLOW }, request: { fn: 'agents', method: 'POST', path: '/workflows', resource: '/workflows', body: { definition: SAMPLE_WORKFLOW } } },
  { tool: 'update_workflow', args: { workflow_id: 'wf_1', expected_revision: 2, definition: SAMPLE_WORKFLOW, change_summary: 'Loop' }, request: proxied('agents', 'PUT', 'workflows', 'wf_1', { definition: SAMPLE_WORKFLOW, expected_revision: 2 }) },
  { tool: 'duplicate_workflow', args: { workflow_id: 'wf_1' }, request: proxied('agents', 'POST', 'workflows', 'wf_1/duplicate', {}) },
  { tool: 'update_company_context', args: { vision: 'V', objectives: [] }, request: proxied('settings', 'PUT', 'settings', 'company-context', { vision: 'V', objectives: [] }) },
  { tool: 'update_my_context', args: { objectives: [] }, request: proxied('settings', 'PUT', 'settings', 'my-context', { objectives: [] }) },
  { tool: 'update_design_system', args: { tokens: { colors: [], typography: [] }, guidelines: 'G' }, request: proxied('settings', 'PUT', 'settings', 'design-system', { tokens: { colors: [], typography: [] }, guidelines: 'G' }) },
];

/** A sparse legacy record as `GET /scrapers` returns it (no base_url, schedule or selectors; an unknown field). */
const SPARSE_STORED_SCRAPER = {
  id: 'sc_1', name: 'Old', enabled: true, extraction_method: 'jsonld', created_at: '2026-01-01', pagination: { enabled: true, param: 'p', max_pages: 1, start: 1 },
};

/**
 * Needs the stored scraper (`env.current`, which the precondition normalises from `stored` as the SPA
 * reads it): the merge keeps every stored field the update does not name.
 */
export const UPDATE_SCRAPER_CASE: WriteRequestCase & { stored: Record<string, unknown>; current: Record<string, unknown> } = {
  tool: 'update_scraper',
  args: { scraper_id: 'sc_1', updates: { name: 'Renamed', pagination: { enabled: true, max_pages: 3 } } },
  stored: SPARSE_STORED_SCRAPER,
  current: storedScraperRecord(SPARSE_STORED_SCRAPER),
  request: { fn: 'scrapers', method: 'POST', path: '/scrapers', resource: '/scrapers', body: { scraper: {
    id: 'sc_1', name: 'Renamed', enabled: true, extraction_method: 'jsonld', created_at: '2026-01-01', base_url: '', urls: [], frequency_minutes: 0,
    container_selector: '', text_selector: '', pagination: { enabled: true, param: 'p', max_pages: 3, start: 1 },
  } } },
};

export const WRITE_REQUEST_CASES: readonly WriteRequestCase[] = [...PROJECT_CASES, ...WORKSPACE_CASES];

/** create_app_connector for a web-review page (WRITE_REQUEST_CASES holds one case per tool: the iOS one). */
export const WEB_REVIEWS_CONNECTOR_CASE: WriteRequestCase = {
  tool: 'create_app_connector',
  args: { source: 'web_reviews', app_name: 'ExampleAir Trustpilot', url: 'https://www.trustpilot.com/review/www.example-air.com', radar_brand: 'example-air' },
  request: {
    fn: 'integrations', method: 'POST', path: '/integrations/web_reviews/apps', resource: '/integrations/{source}/{proxy+}',
    pathParameters: { source: 'web_reviews', proxy: 'apps' },
    body: { app: { app_name: 'ExampleAir Trustpilot', url: 'https://www.trustpilot.com/review/www.example-air.com', max_pages: '10', max_reviews: '0', frequency_minutes: '0', radar_brand: 'example-air' } },
  },
};
