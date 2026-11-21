#!/usr/bin/env node
/**
 * A trial workspace from the command line (7.71.00; docs/multi-workspace.md "Trial workspaces"), what the platform
 * console's Create a trial does, for headless use at the end of a workshop:
 *
 *   1. POST /platform/workspaces {name, slug, trial: {days, pack}}: the trial (its schedule first), the caller its admin;
 *   2. each person of --people (a CSV of `email,role[,playbook]`, a header line allowed): POST
 *      /me/workspaces/current/members in the new workspace (someone with no account gets one, and Cognito emails them
 *      a temporary password);
 *   3. each --form (a form's JSON as POST /feedback-forms takes it, for instance one saved from a template in the
 *      builder): created Off;
 *   4. with --categories: the sample categories of schemas/trial-pack.json (PUT /settings/categories);
 *   then the address of its import wizard. Each is an ordinary create through the existing route, with the caller's own
 *   credentials (a platform admin's Cognito ID token: --token or VOC_ID_TOKEN, never printed), audited by its route. A
 *   step that fails is reported and the others still run. Nothing is ever deleted; at its end the trial only pauses.
 *
 *   node scripts/trial-pack.mjs --api https://<api-id>.execute-api.<region>.amazonaws.com/prod \
 *     --name "Example Trial" --slug example-trial [--days 30] [--people people.csv] [--form form.json …] [--categories]
 *   --dry-run prints the requests it would send (no token needed) and sends nothing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACK = JSON.parse(readFileSync(path.join(HERE, '..', 'schemas', 'trial-pack.json'), 'utf8'));
const DAYS = [14, 30, 60];
const ROLES = ['admin', 'editor', 'viewer'];
const PLAYBOOKS = ['product', 'scrum_master', 'qa', 'engineering'];

/**
 * The people of a CSV text: `email,role[,playbook]` per line, blank lines and a header (`email,…`) left out.
 * @param {string} text
 * @returns {{ email: string, role: string, playbook: string | null }[]}
 */
function parsePeople(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '' && !/^email\s*,/i.test(line))
    .map((line, index) => {
      const [email = '', role = 'editor', playbook = ''] = line.split(',').map((cell) => cell.trim());
      if (!email.includes('@')) throw new Error(`people line ${index + 1}: "${email}" is not an email`);
      if (!ROLES.includes(role)) throw new Error(`people line ${index + 1}: role must be ${ROLES.join(', ')}`);
      if (playbook !== '' && !PLAYBOOKS.includes(playbook)) {
        throw new Error(`people line ${index + 1}: playbook must be ${PLAYBOOKS.join(', ')} or empty`);
      }
      return { email, role, playbook: playbook === '' ? null : playbook };
    });
}

/**
 * The requests of a trial and its pack, in order (`workspace` stands for the new workspace's id until it exists).
 * @param {{ name: string, slug: string, days: number, people: ReturnType<typeof parsePeople>,
 *   forms: Record<string, unknown>[], categories: boolean }} plan
 */
function trialRequests(plan) {
  if (!DAYS.includes(plan.days)) throw new Error('--days must be 14, 30 or 60');
  const templates = plan.forms.flatMap((form) => {
    const template = /** @type {{ id?: unknown } | undefined} */ (form.template);
    return typeof template?.id === 'string' ? [template.id] : [];
  });
  return [
    { method: 'POST', path: '/platform/workspaces', inWorkspace: false, body: { name: plan.name, slug: plan.slug,
      trial: { days: plan.days, pack: { forms: templates, categories: plan.categories,
        playbooks: plan.people.some((person) => person.playbook !== null) } } } },
    ...plan.people.map((person) => ({ method: 'POST', path: '/me/workspaces/current/members', inWorkspace: true,
      body: { email: person.email, role: person.role, ...(person.playbook === null ? {} : { playbook: person.playbook }) } })),
    ...plan.forms.map((form) => ({ method: 'POST', path: '/feedback-forms', inWorkspace: true, body: { ...form, enabled: false } })),
    ...(plan.categories ? [{ method: 'PUT', path: '/settings/categories', inWorkspace: true, body: { categories: PACK.categories } }] : []),
  ];
}

/**
 * Send the requests to `api` as `token`; one line per request, and the workspace created (or null).
 * @param {string} api @param {string} token @param {ReturnType<typeof trialRequests>} requests
 */
async function runTrial(api, token, requests) {
  /** @type {{ id: string, slug: string } | null} */
  let workspace = null;
  const lines = [];
  for (const request of requests) {
    if (request.inWorkspace && workspace === null) break;
    const headers = { 'Content-Type': 'application/json', Authorization: token,
      ...(request.inWorkspace && workspace !== null ? { 'X-Workspace-Id': workspace.id } : {}) };
    const response = await fetch(`${api.replace(/\/+$/, '')}${request.path}`, { method: request.method, headers, body: JSON.stringify(request.body) });
    const answer = await response.json().catch(() => ({}));
    lines.push(`${response.ok ? 'ok    ' : 'failed'} ${request.method} ${request.path}${response.ok ? '' : `: ${response.status} ${answer.error ?? ''}`}`);
    if (!request.inWorkspace) {
      if (!response.ok) break;
      workspace = { id: answer.workspace.id, slug: answer.workspace.slug };
    }
  }
  return { workspace, lines };
}

async function main() {
  const { values } = parseArgs({ options: {
    api: { type: 'string' }, token: { type: 'string' }, name: { type: 'string' }, slug: { type: 'string' },
    days: { type: 'string', default: '30' }, people: { type: 'string' }, form: { type: 'string', multiple: true },
    categories: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false },
  } });
  if (!values.name || !values.slug) throw new Error('--name and --slug are required');
  const requests = trialRequests({ name: values.name, slug: values.slug, days: Number(values.days),
    people: values.people ? parsePeople(readFileSync(values.people, 'utf8')) : [],
    forms: (values.form ?? []).map((file) => JSON.parse(readFileSync(file, 'utf8'))), categories: values.categories });
  if (values['dry-run']) {
    console.log(JSON.stringify(requests, null, 2));
    return;
  }
  const token = values.token ?? process.env.VOC_ID_TOKEN ?? '';
  if (!values.api || token === '') throw new Error('--api and --token (or VOC_ID_TOKEN, a platform admin\'s Cognito ID token) are required');
  const { workspace, lines } = await runTrial(values.api, token, requests);
  for (const line of lines) console.log(line);
  if (workspace === null) process.exit(1);
  console.log(`Trial ready: open /workspace/${workspace.slug}/scrapers/import to import its feedback and the workshop's survey.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
