/**
 * Writes outside the `project` pack as REST requests — the SPA executors
 * (`frontend/src/assistant/approvals/{executors,scraperExecutors,memoryExecutors,
 * agentExecutors,companyExecutors}.ts`) request for request. A write whose body
 * merges the CURRENT stored state (update_scraper, company context, design
 * system) reads it from `env.current` (`write-preconditions.ts` fetches it).
 */
import { isRecord } from '../tools/format.js';
import { appConnectorRecord, appConnectorSource, createdScraperRecord, mergedScraperRecord, scraperRecordProblem } from './scraper-records.js';
import { WriteRequestError, defined, optionalText, present, record, text, type Args } from './write-args.js';
import { enc, exact, proxied, type RequestBuilder, type WriteEnv, type WriteRequest } from './write-routes.js';

const memory = (rest: string, body?: unknown) => proxied('memory', 'POST', 'memory', rest, body);
const agents = (method: WriteRequest['method'], rest: string, body?: unknown) => proxied('agents', method, 'agents', rest, body);
const workflows = (method: WriteRequest['method'], rest: string, body?: unknown) => proxied('agents', method, 'workflows', rest, body);
const settings = (rest: string, body: unknown) => proxied('settings', 'PUT', 'settings', rest, body);
const agentId = (args: Args) => enc(text(args, 'agent_id'));

function current(env: WriteEnv): Readonly<Record<string, unknown>> {
  if (env.current === undefined) throw new WriteRequestError('this write needs the current stored state');
  return env.current;
}

/** The field from the args, else the current stored value (when it has the right shape), else `fallback`. */
function argOrCurrent(args: Args, env: WriteEnv, key: string, isShape: (value: unknown) => boolean, fallback: unknown): unknown {
  if (args[key] !== undefined) return args[key];
  const stored = current(env)[key];
  return isShape(stored) ? stored : fallback;
}

const isText = (value: unknown) => typeof value === 'string';

const CORE_AND_INSIGHTS: Readonly<Record<string, RequestBuilder>> = {
  remember: (args) => exact('memory', 'POST', '/memory', defined(args)),
  update_company_memory: (args) => proxied('memory', 'PUT', 'memory', enc(text(args, 'memory_id')), { statement: text(args, 'statement') }),
  set_problem_resolved: (args) => settings('resolved-problems', { key: text(args, 'problem_key'), resolved: args.resolved }),
  set_feedback_category: (args) => {
    const subcategory = optionalText(args, 'subcategory');
    const id = text(args, 'feedback_id');
    return {
      fn: 'feedbackEdit', method: 'PUT', path: `/feedback/${enc(id)}/category`, resource: '/feedback/{id}/category',
      pathParameters: { id }, body: { category: text(args, 'category'), ...(subcategory === undefined || subcategory === '' ? {} : { subcategory }) },
    };
  },
  update_feedback_form: (args) => {
    const formId = text(args, 'form_id');
    return { fn: 'feedbackForms', method: 'PUT', path: `/feedback-forms/${formId}`, resource: '/feedback-forms/{form_id}', pathParameters: { form_id: formId }, body: record(args, 'updates') };
  },
};

function sourceRoute(root: 'integrations' | 'sources', source: string, rest: string, body?: unknown, method: WriteRequest['method'] = 'POST'): WriteRequest {
  return {
    fn: 'integrations', method, path: `/${root}/${source}/${rest}`, resource: `/${root}/{source}/{proxy+}`,
    pathParameters: { source, proxy: rest }, ...(body === undefined ? {} : { body }),
  };
}

/** `POST /scrapers` with a record the SPA would also save (css selectors present, within the size budget). */
function saveScraper(scraper: Record<string, unknown>): WriteRequest {
  const problem = scraperRecordProblem(scraper);
  if (problem !== undefined) throw new WriteRequestError(`${problem} Nothing was saved.`);
  return exact('scrapers', 'POST', '/scrapers', { scraper });
}

const SCRAPERS: Readonly<Record<string, RequestBuilder>> = {
  run_scraper: (args) => proxied('scrapers', 'POST', 'scrapers', `${text(args, 'scraper_id')}/run`),
  create_scraper: (args) => saveScraper(createdScraperRecord(args)),
  update_scraper: (args, env) => saveScraper(mergedScraperRecord({ ...current(env) }, args)),
  create_app_connector: (args) => sourceRoute('integrations', appConnectorSource(args), 'apps', { app: appConnectorRecord(args) }),
  run_source: (args) => sourceRoute('sources', text(args, 'source'), 'run'),
  set_source_enabled: (args) => sourceRoute('sources', text(args, 'source'), args.enabled === true ? 'enable' : 'disable', undefined, 'PUT'),
};

const MEMORY: Readonly<Record<string, RequestBuilder>> = {
  forget_memory: (args) => memory(`${enc(text(args, 'memory_id'))}/forget`),
  merge_memories: (args) => memory('merge', { ids: args.memory_ids, statement: text(args, 'statement') }),
  confirm_memory: (args) => memory(`${enc(text(args, 'memory_id'))}/confirm`),
  resolve_memory_conflict: (args) => memory(`review/${enc(text(args, 'memory_id'))}/resolve`, {
    action: text(args, 'action'),
    ...present('winner_id', optionalText(args, 'winner_id')),
    ...present('statement', optionalText(args, 'statement')),
  }),
};

const AGENTS: Readonly<Record<string, RequestBuilder>> = {
  create_agent: (args) => exact('agents', 'POST', '/agents', defined(args)),
  update_agent: (args) => agents('PUT', agentId(args), record(args, 'updates')),
  enable_agent: (args) => agents('POST', `${agentId(args)}/enable`),
  disable_agent: (args) => agents('POST', `${agentId(args)}/disable`),
  run_agent: (args) => agents('POST', `${agentId(args)}/run`),
  cancel_agent_run: (args) => agents('POST', `${agentId(args)}/runs/${enc(text(args, 'run_id'))}/cancel`),
  create_workflow: (args) => exact('agents', 'POST', '/workflows', { definition: record(args, 'definition') }),
  update_workflow: (args) => workflows('PUT', enc(text(args, 'workflow_id')), { definition: record(args, 'definition'), expected_revision: args.expected_revision }),
  duplicate_workflow: (args) => workflows('POST', `${enc(text(args, 'workflow_id'))}/duplicate`, present('name', optionalText(args, 'name'))),
};

const COMPANY: Readonly<Record<string, RequestBuilder>> = {
  update_company_context: (args, env) => settings('company-context', {
    vision: argOrCurrent(args, env, 'vision', isText, ''),
    objectives: argOrCurrent(args, env, 'objectives', Array.isArray, []),
  }),
  update_my_context: (args) => settings('my-context', { objectives: args.objectives }),
  update_design_system: (args, env) => settings('design-system', {
    tokens: argOrCurrent(args, env, 'tokens', isRecord, { colors: [], typography: [] }),
    guidelines: argOrCurrent(args, env, 'guidelines', isText, ''),
  }),
};

export const WORKSPACE_WRITE_REQUESTS: Readonly<Record<string, RequestBuilder>> = {
  ...CORE_AND_INSIGHTS, ...SCRAPERS, ...MEMORY, ...AGENTS, ...COMPANY,
};

/**
 * update_company_memory as the SPA files it for a caller the PUT refuses
 * (403): a company add, stored by the memory Lambda as `proposed`.
 */
export function companyMemoryProposal(args: Args): WriteRequest {
  return exact('memory', 'POST', '/memory', { scope: 'company', statement: text(args, 'statement'), ...present('kind', optionalText(args, 'kind')) });
}
