// The Registry, the quality gates and the templates' source text (7.52.00; lambda/shared/
// agents_engineering_registry_routes.py, engineering/registry/{views,cards}.py), in their wire shape, for `npm run dev`.
// The roles, gate packs, briefs and sources are the repository's own orchestration bundle
// (voc-datalake/templates/orchestration/bundle.json), so the screens read real templates:
//   GET  /agents/engineering/registry?connection=          {month, connection, cards}: every role's card, then the made ones
//   GET  /agents/engineering/registry/<card>?connection=   {card, versions, events}; 404 for none
//   POST /agents/engineering/registry/cards                {from_skill, slug, purpose, title?, caps?} → 201 {card}
//   GET  /agents/engineering/gates?connection=             the packs (steps with their messages and vacuous-pass rule),
//                                                          the briefs WITHOUT their text (gap N), the stops, the defaults
//   GET  /agents/engineering/gates/briefs/<id>             one brief with its text; 404 for none
//   GET  /agents/engineering/templates/<kind>/<id>/source  a SKILL.md, agent.yaml, flow YAML or brief (gap S)
// The skill a role card runs: the shared fixer's v3 (as mock-engineering-skills.js holds it), else the template.
// MOCK_AGENTS_NON_ADMIN=1 makes the caller a non-admin: 403 on every route, as the server answers.
// Wired into mock-server.js by handleDomainModules, before the engineering runs' routes (which would read
// `registry`, `gates` and `templates` as a run id).
import { readFileSync } from 'node:fs';

const BUNDLE = JSON.parse(readFileSync(new URL('../templates/orchestration/bundle.json', import.meta.url), 'utf8'));
const isAdmin = () => process.env.MOCK_AGENTS_NON_ADMIN !== '1';
const CONNECTION = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const CARD_ID = /^[a-z][a-z0-9-]{0,63}$/;
const GATE_ROLES = new Set(['gate-runner', 'final-go']);
const month = () => new Date().toISOString().slice(0, 7);
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

/** The skill a scope runs of a role (the fixer's shared v3 and storefront's v1; the template elsewhere). */
const HEADS = {
  '': { fixer: { version: 3, provenance: 'person', template_version: 1 } },
  storefront: { fixer: { version: 1, provenance: 'coach', template_version: 1 } },
};

function skillOf(template, connection) {
  const head = HEADS[connection]?.[template.id] ?? (connection === '' ? undefined : HEADS['']?.[template.id]);
  if (!head) {
    return { source: 'template', label: template.label, connection: null, version: null, status: null, provenance: 'template',
      template_version: template.version, template_newer: false };
  }
  const scope = HEADS[connection]?.[template.id] ? connection : '';
  return { source: 'store', label: `${template.id}@${scope || 'shared'}/${head.version}`, connection: scope, version: head.version,
    status: 'accepted', provenance: head.provenance, template_version: head.template_version,
    template_newer: head.template_version < template.version };
}

function roleCard(template, connection) {
  const launchable = template.skill !== null && template.skill !== undefined;
  const skill = skillOf(template, connection);
  return {
    kind: 'role', id: template.id, base_role: template.id, title: template.id, purpose: template.purpose, launchable,
    template: { version: template.version, label: template.label, digest: template.digest },
    skill, model: template.model, tools: [...template.tools], harness: template.harness, broker_ops: [...template.broker_ops],
    pending_tools: [...template.pending_tools], gates: GATE_ROLES.has(template.id) ? { packs: BUNDLE.gates.packs.map((p) => p.id) } : null,
    inputs: template.inputs, outputs: template.outputs, caps: { ...template.caps }, trust: { ...template.trust }, evals: [...template.evals],
    scorecard: connection === '' ? null : { label: skill.label, runs: 6, pass_rate: 0.67, tasks_done: 4, tasks_failed: 2, needs_human: 1,
      cost_usd: 2.46, since: daysAgo(14), until: daysAgo(0) },
    spend: { month: month(), usd: template.id === 'fixer' ? 3.2 : 0, tokens_in: 0, tokens_out: 0, microvm_seconds: 0 },
    node: launchable ? { type: 'agent', data: { title: template.id, params: { role: template.id, skill_version: 'latest' } } } : null,
  };
}

/** The cards an administrator made from a skill: each card's versions, oldest first. */
const MADE = {
  'fixer-careful': [madeRecord({ id: 'fixer-careful', version: 1, role: 'fixer', title: 'Careful fixer',
    purpose: 'The fixer on shared v3, held to fewer turns for small repositories.', skillVersion: 3, caps: { max_turns: 80 },
    by: 'admin-demo', at: daysAgo(4) })],
};

function madeRecord({ id, version, role, title, purpose, skillVersion, connection = '', caps = {}, by, at }) {
  const template = BUNDLE.agents.find((agent) => agent.id === role);
  return {
    schema: 'voc-registry-card/1', id, version, base_role: role, title, purpose,
    skill: { connection, version: skillVersion, label: `${role}@${connection || 'shared'}/${skillVersion}`, provenance: 'person', template_version: 1 },
    model: template.model, tools: [...template.tools], harness: template.harness, caps: { ...template.caps, ...caps },
    inputs: template.inputs, outputs: template.outputs, trust: { ...template.trust },
    template: { version: template.version, label: template.label, digest: template.digest }, created_by: by, created_at: at,
  };
}

const cardView = (record) => ({ kind: 'card', ...record, node: { type: 'agent', data: { title: record.title, params: {
  role: record.base_role, skill_version: `v${record.skill.version}`, model: record.model, card: `${record.id}@v${record.version}` } } } });

function registry(connection) {
  const cards = BUNDLE.agents.map((template) => roleCard(template, connection));
  return [200, { month: month(), connection, cards: [...cards, ...Object.values(MADE).map((versions) => cardView(versions.at(-1)))] }];
}

function card(id, connection) {
  const template = BUNDLE.agents.find((agent) => agent.id === id);
  if (template) return [200, { card: roleCard(template, connection), versions: [], events: [] }];
  const versions = MADE[id];
  if (!versions) return [404, { error: `the Registry has no card ${id.slice(0, 64)}` }];
  return [200, { card: cardView(versions.at(-1)), versions: [...versions].reverse().map(cardView),
    events: [...versions].reverse().map((record) => ({ version: record.version, event: 'created', by: record.created_by, at: record.created_at })) }];
}

function create(body) {
  const skill = body.from_skill;
  const template = BUNDLE.agents.find((agent) => agent.id === skill?.role && agent.skill);
  if (!skill || !template) return [400, { error: 'the body is {from_skill: {role, connection?, version}, slug, purpose, title?, model?, caps?, expected_version?}' }];
  if (typeof body.slug !== 'string' || !SLUG.test(body.slug)) return [400, { error: 'slug is 1 to 40 lowercase letters, digits and dashes (not at either end)' }];
  const purpose = typeof body.purpose === 'string' ? body.purpose.trim() : '';
  if (purpose === '' || purpose.length > 300) return [400, { error: 'purpose is 1 to 300 characters of plain text' }];
  const head = HEADS[skill.connection ?? '']?.[skill.role];
  if (!head || head.version !== skill.version) return [404, { error: `no accepted version ${skill.version} of the ${skill.role} skill in that scope` }];
  const id = `${skill.role}-${body.slug}`;
  const versions = MADE[id];
  if (versions && body.expected_version !== versions.at(-1).version) {
    return [409, { error: 'a card with that id exists: name the version you read (expected_version) to make its next version, or pick another slug' }];
  }
  for (const [name, value] of Object.entries(body.caps ?? {})) {
    if (!(name in template.caps) || typeof value !== 'number' || value <= 0 || value > template.caps[name]) {
      return [400, { error: `caps.${name} is above 0 and at most the template's ${template.caps[name] ?? '(none)'}` }];
    }
  }
  const record = madeRecord({ id, version: (versions?.length ?? 0) + 1, role: skill.role, title: (body.title ?? '').trim() || id, purpose,
    skillVersion: skill.version, connection: skill.connection ?? '', caps: body.caps ?? {}, by: 'admin-demo', at: new Date().toISOString() });
  MADE[id] = [...(versions ?? []), record];
  return [201, { card: cardView(record) }];
}

/** A step's vacuous-pass rule in words (views.py looked_at_nothing). */
function lookedAtNothing(step) {
  const rules = [];
  if (step.empty_exit_codes.length > 0) rules.push(`an exit ${step.empty_exit_codes.join(', ')} says it found nothing to check, and fails`);
  if (step.expect_output) rules.push(`its output must show that it checked something (it matches ${step.expect_output}), else it fails`);
  return rules.join('; ') || null;
}

const STOPS = [
  { code: 'check_failed', decision: 'loop_exhausted', text: 'A check failed, and the fixes did not make it pass' },
  { code: 'looked_at_nothing', decision: 'verification', text: 'The gate looked at nothing: no check covers the repository, or a check found nothing to check' },
  { code: 'own_gate_changed', decision: 'verification', text: `The change touches the repository's own gate (${BUNDLE.gates.own_gate.file})` },
  { code: 'review_blocked', decision: 'no_fail_path', text: 'A review blocked it: the final go said NO-GO' },
  { code: 'rounds_used_up', decision: 'loop_exhausted', text: 'Blocking findings were left after the last round' },
];
/** The tools' versions storefront's newest gate record holds (with `?connection=storefront`). */
const RECORDED = { python: { ruff: '0.7.2', pytest: '8.4.2' } };

function gates(connection) {
  const packs = BUNDLE.gates.packs.map((pack) => ({
    ...pack,
    steps: pack.steps.map((step) => ({ ...step, messages: [{ status: 'fail', reason: 'the check exited <code>' }], looked_at_nothing: lookedAtNothing(step) })),
    recorded: connection === 'storefront' && RECORDED[pack.id] ? { tool_versions: RECORDED[pack.id], run_id: 'RUN-SAMPLE', at: daysAgo(1) } : null,
  }));
  return [200, {
    packs, aliases: BUNDLE.gates.aliases, own_gate: BUNDLE.gates.own_gate,
    briefs: BUNDLE.gates.briefs.map(({ id, path, packs: briefPacks, digest, bytes }) => ({ id, path, packs: briefPacks, digest, bytes })),
    runners: [...GATE_ROLES].sort(), defaults: { runner: 'gate-runner@latest', final_go: 'final-go@latest' },
    stops: STOPS.map((stop) => ({ ...stop, text_key: `gates.stops.${stop.code}`, actions: ['retry', 'stop'] })),
    connection: connection || null,
  }];
}

function brief(id) {
  const found = BUNDLE.gates.briefs.find((entry) => entry.id === id);
  if (!found) return [404, { error: `no gate brief ${id.slice(0, 64)}` }];
  const { path, packs, digest, bytes, text } = found;
  return [200, { id, path, packs, digest, bytes, text }];
}

const SOURCE_KINDS = ['skill', 'card', 'flow', 'brief'];
function source(kind, id) {
  if (!SOURCE_KINDS.includes(kind)) return [400, { error: `kind is one of ${SOURCE_KINDS.join(', ')}` }];
  if (kind === 'brief') {
    const found = BUNDLE.gates.briefs.find((entry) => entry.id === id);
    return found ? [200, { kind, id, path: found.path, text: found.text, digest: found.digest, template_version: null }]
      : [404, { error: `no brief template ${id.slice(0, 64)}` }];
  }
  const found = BUNDLE.sources.find((entry) => entry.kind === kind && entry.id === id);
  return found ? [200, { ...found }] : [404, { error: `no ${kind} template ${id.slice(0, 64)}` }];
}

const REGISTRY_PATH = /^\/agents\/engineering\/registry$/;
const CARD_PATH = /^\/agents\/engineering\/registry\/([^/]+)$/;
const GATES_PATH = /^\/agents\/engineering\/gates$/;
const BRIEF_PATH = /^\/agents\/engineering\/gates\/briefs\/([^/]+)$/;
const SOURCE_PATH = /^\/agents\/engineering\/templates\/([^/]+)\/([^/]+)\/source$/;

/** The GET routes: the answer for the path (null: not this module's). */
function read(path, connection) {
  if (REGISTRY_PATH.test(path)) return registry(connection);
  if (GATES_PATH.test(path)) return gates(connection);
  const briefMatch = BRIEF_PATH.exec(path);
  if (briefMatch) return brief(decodeURIComponent(briefMatch[1]));
  const sourceMatch = SOURCE_PATH.exec(path);
  if (sourceMatch) return source(decodeURIComponent(sourceMatch[1]), decodeURIComponent(sourceMatch[2]));
  const cardMatch = CARD_PATH.exec(path);
  if (cardMatch) {
    const id = decodeURIComponent(cardMatch[1]);
    return CARD_ID.test(id) ? card(id, connection) : [404, { error: 'the Registry has no such card' }];
  }
  return null;
}

export function handleEngineeringRegistryRoutes(req, res, url, send, shared) {
  const path = url.pathname;
  const creating = path === '/agents/engineering/registry/cards';
  const known = creating || [REGISTRY_PATH, CARD_PATH, GATES_PATH, BRIEF_PATH, SOURCE_PATH].some((pattern) => pattern.test(path));
  if (!known) return false;
  const connection = url.searchParams.get('connection') ?? '';
  if (req.method !== (creating ? 'POST' : 'GET')) send(405, { message: 'Method not allowed' });
  else if (!isAdmin()) send(403, { message: 'Admin access required' });
  else if (connection !== '' && !CONNECTION.test(connection)) send(400, { error: 'connection is a connection id, or empty for the shared skills' });
  else if (creating) shared.collectJson(req, res, (body) => send(...create(body ?? {})));
  else send(...read(path, connection));
  return true;
}
