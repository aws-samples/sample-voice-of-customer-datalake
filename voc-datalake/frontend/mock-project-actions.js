// Project action mocks: the async jobs (persona generation and import, research,
// PRD / PR-FAQ generation, document merge, prototype builds), persona and document
// writes, the synchronous AI helpers (research question / brief / PR-FAQ autofill
// suggestions) and prototype pins (docs/feedback-forms.md). Wire shapes follow
// lambda/api/projects_handler.py and lambda/api/projects.py, plus shared/prototype_pins.py,
// shared/jobs.py (job records) and the job Lambdas under lambda/jobs/ and
// lambda/research/ (job `result` payloads).
//
// Stateful for the life of the mock process. Every write lands in the shared
// `mockProjectDetails` store, so GET /projects/{id} shows it. A job started here
// advances one step per read (jobs list or single-job poll): running on the
// first, completed on the second, which is when its result is written into the
// project, exactly once. The mock caller is the admin of mock-server.js, so every
// project gate passes; an unknown project answers 404 like the real gate.
// Wired into mock-server.js by handleDomainModules (runs before its inline routes).

import { createHash, randomBytes } from 'node:crypto';
import { autofillPrfaq, suggestDocumentBrief } from './mock-ai-drafts.js';
import { documentSeriesKey, versionLlmView } from './mock-document-review.js';
import {
  NO_SOURCE_MESSAGE, documentRequestUse, generationMethodology, importStartMethodology, importedPersonaMarker,
  prototypeBlocked,
} from './mock-methodology.js';

// mock-server.js's MOCK_CALLER (admin-demo); its subject is what jobs and pins record.
const MOCK_CALLER_SUB = 'sub-admin-demo';
const MOCK_CALLER_NAME = 'admin-demo';

const PROJECT_PATH = /^\/projects\/([^/]+)(\/.+)$/;
const NOT_FOUND = [404, { success: false, error: 'Project not found' }];

const GENERATED_DOC_TYPES = ['prd', 'prfaq'];
const MERGE_OUTPUT_TYPES = ['prd', 'prfaq', 'custom'];
const VERSIONED_DOC_TYPES = new Set(['prd', 'prfaq', 'prototype']);
const MAX_PERSONAS_PER_GENERATION = 10;
const MAX_KEY_SEGMENT_ID_LEN = 256;
const MAX_SELECTED_RESEARCH_IDS = 10;
const MAX_SELECTED_PRODUCT_DOC_IDS = 4;
const CONVERSE_IMAGE_TYPES = ['image/gif', 'image/jpeg', 'image/png', 'image/webp'];

// ── Small pure helpers ──────────────────────────────────────────────────────

/** `n` lowercase hex characters (n even). */
const hex = (n) => randomBytes(n / 2).toString('hex');
const nowIso = () => new Date().toISOString();
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (body, key) => isPlainObject(body) && Object.hasOwn(body, key);
const stringOr = (value, fallback) => (typeof value === 'string' ? value : fallback);
const stringList = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []);
/** A deep copy of a JSON value, so stored records never alias a request body. */
const cloneJson = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const bad = (error) => [400, { success: false, error }];

/** Python's type name for a JSON value — the backend's 400s name it. */
function pyTypeName(value) {
  if (value === null) return 'NoneType';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'string') return 'str';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  return 'dict';
}

/** Copy only `fields` that `body` owns (never inherited keys, never `__proto__`). */
function pick(body, fields) {
  const out = {};
  for (const field of fields) {
    if (own(body, field)) out[field] = cloneJson(body[field]);
  }
  return out;
}

/** document_versions.split_versioned_title: `"Title (v3)"` → `['Title', 3]`. */
function splitVersionedTitle(title) {
  const text = typeof title === 'string' ? title.trim() : '';
  // Anchored suffix only (no lazy prefix group), so there is no backtracking.
  const suffix = /\(v(\d{1,9})\)$/.exec(text);
  const base = (suffix ? text.slice(0, suffix.index) : text).trim() || 'Untitled';
  return [base, suffix ? Number(suffix[1]) : null];
}

/** document_versions.DOCUMENT_TYPE_TITLE_LABELS, lower-cased. */
const TYPE_TITLE_LABELS = { prd: ['prd'], prfaq: ['pr/faq', 'pr-faq', 'prfaq'] };

/** document_versions.series_base_title: drop a trailing ` — <own type label>` (no regex). */
function withoutTypeLabel(base, type) {
  const cut = Math.max(base.lastIndexOf(' \u2014'), base.lastIndexOf(' \u2013'), base.lastIndexOf(' -'));
  if (cut <= 0) return base;
  const label = base.slice(cut + 2).trim().toLowerCase();
  return TYPE_TITLE_LABELS[type].includes(label) ? base.slice(0, cut).trim() : base;
}

/** document_generator.default_prototype_title: `'<source title> prototype'`, else `fallback`. */
function defaultPrototypeTitle(prd, prfaq, fallback) {
  for (const [doc, type] of [[prd, 'prd'], [prfaq, 'prfaq']]) {
    const raw = doc?.base_title || doc?.title;
    if (typeof raw === 'string' && raw.trim()) {
      const [base] = splitVersionedTitle(raw);
      return `${withoutTypeLabel(base, type).slice(0, 200).trim()} prototype`;
    }
  }
  return fallback;
}

/** `YYYYMMDDHHMMSS` in UTC — the stamp the backend puts in persona and note ids. */
const idStamp = (date = new Date()) => date.toISOString().replace(/[-:T]/g, '').slice(0, 14);

/** A backend-shaped `{prefix}_{stamp}` id, suffixed only when that second is taken. */
function stampedId(prefix, taken) {
  const base = `${prefix}_${idStamp()}`;
  let id = base;
  let n = 2;
  while (taken(id)) {
    id = `${base}_${n}`;
    n += 1;
  }
  return id;
}

// ── Project store helpers ───────────────────────────────────────────────────

const findDocument = (detail, documentId) => detail.documents.find((d) => d.document_id === documentId);
const findPersona = (detail, personaId) => detail.personas.find((p) => p.persona_id === personaId);

function addDocument(detail, document) {
  detail.documents.push(document);
  detail.project.document_count = (Number(detail.project.document_count) || 0) + 1;
  detail.project.updated_at = nowIso();
  return document;
}

/** Newest document of `type`, as the generator picks a default source. */
function newestOfType(detail, type) {
  return detail.documents
    .filter((d) => d.document_type === type)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] ?? null;
}

/** persist_versioned_document: the next `(vN)` of the title's series for `type`. */
function addVersionedDocument(shared, detail, type, requestedTitle, fields) {
  const [base] = splitVersionedTitle(requestedTitle);
  const series = base.toLowerCase();
  const versions = detail.documents
    .filter((d) => d.document_type === type && splitVersionedTitle(d.base_title ?? d.title)[0].toLowerCase() === series)
    .map((d) => (Number.isInteger(d.version) ? d.version : 1));
  const version = Math.max(0, ...versions) + 1;
  return addDocument(detail, {
    document_id: shared.nextMockId(type), document_type: type,
    title: `${base} (v${version})`, base_title: base, version,
    created_at: nowIso(), updated_at: nowIso(), ...fields,
  });
}

/** How many feedback items the mock "read" — the real count of the feedback fixture. */
const feedbackCount = (shared) => (Array.isArray(shared.mockFeedback) ? shared.mockFeedback.length : 0);

/** A route answer `[status, payload]` with the request's methodology block added (shared/methodology.py). */
const withMethodology = ([status, payload], block) => [status, { ...payload, methodology: block }];

/**
 * The fixture feedback a body's filters match: the F1 pre-check of POST .../personas/generate
 * and .../research, and the wizards' live count (mock-personas.js)
 * (projects.ensure_persona_feedback / ensure_research_feedback): does any fixture
 * item match the body's sources / categories / sentiments? An empty or absent list
 * matches everything, as in shared/feedback.py. `days` is not applied: the fixture's
 * dates are static, and windowing them would make every page empty over time.
 */
export function matchingFeedback(shared, body) {
  const [sources, categories, sentiments] = ['sources', 'categories', 'sentiments'].map((f) => stringList(body[f]));
  const keep = (values, value) => values.length === 0 || values.includes(value);
  const items = Array.isArray(shared.mockFeedback) ? shared.mockFeedback : [];
  return items.filter((item) => keep(sources, item.source_platform)
    && keep(categories, item.category)
    && keep(sentiments, item.sentiment_label));
}

const anyFeedbackMatches = (shared, body) => matchingFeedback(shared, body).length > 0;

const PERSONA_NO_FEEDBACK_MESSAGE = 'No feedback data found for the given filters';
const RESEARCH_NO_FEEDBACK_MESSAGE = 'No feedback data found matching the filters. Try adjusting your filter criteria.';

// ── Job registry (shared/jobs.py records) ───────────────────────────────────
// jobId -> { projectId, record, polls, runningStep, errorMessage, complete }.
// `complete(detail)` writes the job's output into the project and returns the
// job `result`; throwing fails the job the way job_handler does.

const jobs = new Map();

// Persona containers that are NOT projects (the company persona mock registers the company
// library, `company_personas`): their jobs land in the container, and every
// `/projects/{container id}/...` route is a 404, as the real per-project gate answers.
const containers = new Map(); // container id -> detail-shaped { project, personas, documents }

/** Register a non-project persona container (id -> its detail-shaped store). */
export function registerPersonaContainer(containerId, detail) {
  containers.set(containerId, detail);
}

const detailOf = (shared, id) => containers.get(id) ?? shared.mockProjectDetails[id];

function startJob(projectId, { jobType, status, message, runningStep, errorMessage, complete }) {
  const jobId = `job_${hex(16)}`;
  const at = nowIso();
  jobs.set(jobId, {
    projectId, polls: 0, runningStep, errorMessage, complete,
    record: {
      job_id: jobId, job_type: jobType, status, progress: 0,
      current_step: status === 'pending' ? 'queued' : 'starting',
      created_at: at, updated_at: at, completed_at: null, error: null, result: null,
      initiated_by: MOCK_CALLER_SUB,
    },
  });
  return [200, { success: true, job_id: jobId, status, message }];
}

function finishJob(entry, shared) {
  const { record } = entry;
  const detail = detailOf(shared, entry.projectId);
  const at = nowIso();
  try {
    if (!detail) throw new Error('Project not found');
    Object.assign(record, { status: 'completed', progress: 100, current_step: 'complete', result: entry.complete(detail) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    Object.assign(record, { status: 'failed', progress: 0, current_step: 'error', error: `${entry.errorMessage}: ${reason.slice(0, 200)}` });
  }
  record.completed_at = at;
  record.updated_at = at;
}

/** One step per read: running, then completed (result applied exactly once). */
function advanceJob(entry, shared) {
  const { record } = entry;
  if (record.status === 'completed' || record.status === 'failed') return;
  entry.polls += 1;
  if (entry.polls === 1 && !entry.assist) {
    Object.assign(record, { status: 'running', progress: 50, current_step: entry.runningStep, updated_at: nowIso() });
    return;
  }
  finishJob(entry, shared);
}

const isAssistJob = (record) => typeof record.job_type === 'string' && record.job_type.startsWith('assist_');

/**
 * shared/assist_jobs.start for a project assist: `answer` is the [status, body]
 * the route used to send synchronously. An error answer is still sent as is (the
 * real route checks its preconditions before it starts the job); a success
 * becomes 202 + a job that completes on its FIRST poll with that very body.
 * `config` is the job row's config (never answered by a poll), as the real start stores it.
 */
export function startProjectAssistJob(projectId, jobType, answer, config = {}) {
  const [status, body] = answer;
  if (status !== 200) return answer;
  const [, started] = startJob(projectId, {
    jobType, status: 'pending', runningStep: 'running', errorMessage: 'Request failed', complete: () => body,
  });
  Object.assign(jobs.get(started.job_id), { assist: true, config });
  return [202, { success: true, job_id: started.job_id, status: 'pending' }];
}

/** A route handler whose synchronous answer now arrives through an assist job. */
const assisted = (jobType, run) => (ctx, ...groups) => startProjectAssistJob(ctx.projectId, jobType, run(ctx, ...groups));

/** GET /projects/{id}/jobs row (api_list_jobs). */
function listRow(job) {
  return {
    job_id: job.job_id ?? null, job_type: job.job_type ?? null, status: job.status ?? null,
    progress: job.progress ?? 0, current_step: job.current_step ?? null,
    created_at: job.created_at ?? null, updated_at: job.updated_at ?? null,
    completed_at: job.completed_at ?? null, error: job.error ?? null, result: job.result ?? null,
    initiated_by: job.initiated_by ?? null,
  };
}

function listJobs(ctx) {
  // Assist jobs (start-and-poll model calls) are never listed: api_list_jobs leaves `assist_*` out.
  const mine = [...jobs.values()].filter((e) => e.projectId === ctx.projectId && !isAssistJob(e.record));
  for (const entry of mine) advanceJob(entry, ctx.shared);
  // Product-report jobs are mock-server.js's; they are listed but only its own
  // single-job poll advances them.
  const product = Object.values(ctx.shared.mockProductJobs)
    .filter((e) => e.projectId === ctx.projectId)
    .map((e) => e.job);
  const rows = [...mine.map((e) => e.record), ...product]
    .map(listRow)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 50);
  return [200, { success: true, jobs: rows }];
}

function getJob(ctx, jobId) {
  const entry = jobs.get(jobId);
  advanceJob(entry, ctx.shared);
  return [200, { success: true, ...listRow(entry.record) }];
}

/** api_delete_job: an unconditional delete, so an unknown id is still a success. */
function deleteJob(ctx, jobId) {
  if (jobs.get(jobId)?.projectId === ctx.projectId) jobs.delete(jobId);
  if (ctx.shared.mockProductJobs[jobId]?.projectId === ctx.projectId) delete ctx.shared.mockProductJobs[jobId];
  return [200, { success: true }];
}

const isOwnJob = (projectId, jobId) => jobs.get(jobId)?.projectId === projectId;

// ── Personas ────────────────────────────────────────────────────────────────

const PERSONA_SECTIONS = [
  'identity', 'goals_motivations', 'pain_points', 'behaviors',
  'context_environment', 'quotes', 'scenario', 'research_notes',
];
const PERSONA_UPDATABLE = ['name', 'tagline', 'confidence', ...PERSONA_SECTIONS, 'avatar_url', 'avatar_prompt'];

const PERSONA_TEMPLATES = [
  {
    name: 'Tracking-Obsessed Theo', tagline: 'Refreshes the order page hourly', confidence: 'high',
    identity: { age_range: '28-35', location: 'Urban apartment', occupation: 'Operations analyst', bio: 'Plans his week around deliveries and hates surprises.' },
    goals_motivations: { primary_goal: 'Know exactly when a package will arrive', secondary_goals: ['Avoid missed deliveries'], underlying_motivations: ['Control over his schedule'] },
    pain_points: { current_challenges: ['Estimates change without notice'], blockers: ['Carrier status lags reality'], workarounds: ['Checks the carrier site directly'], emotional_impact: 'Anxious and distrustful after one late order' },
    behaviors: { current_solutions: ['Carrier apps'], tools_used: ['Mobile app', 'Email'], activity_frequency: 'Weekly orders', tech_savviness: 'High', decision_style: 'Data-driven' },
    context_environment: { usage_context: 'Between meetings on his phone', devices: ['iPhone', 'Work laptop'], time_constraints: 'Short bursts', social_context: 'Orders for a shared household', influencers: ['Review sites'] },
    quotes: [{ text: 'Just tell me the truth about the date and I will plan around it.', context: 'App store review' }],
    scenario: { title: 'The moved delivery window', narrative: 'Theo planned to be home Tuesday; the estimate silently moved to Thursday.', trigger: 'Estimate change', outcome: 'Contacts support and leaves a 2-star review' },
  },
  {
    name: 'Bargain-Bundling Bea', tagline: 'Waits for the free-shipping threshold', confidence: 'medium',
    identity: { age_range: '35-44', location: 'Suburbs', occupation: 'School administrator', bio: 'Batches purchases to save on shipping.' },
    goals_motivations: { primary_goal: 'Pay the price she saw first', secondary_goals: ['Combine orders'], underlying_motivations: ['Feeling smart about money'] },
    pain_points: { current_challenges: ['Coupons fail at checkout'], blockers: ['Price changes between cart and checkout'], workarounds: ['Screenshots the cart'], emotional_impact: 'Feels tricked' },
    behaviors: { current_solutions: ['Price trackers'], tools_used: ['Desktop browser'], activity_frequency: 'Monthly', tech_savviness: 'Medium', decision_style: 'Deliberate' },
    context_environment: { usage_context: 'Evenings at home', devices: ['Laptop'], time_constraints: 'Unhurried', social_context: 'Shops for the family', influencers: ['Friends', 'Deal forums'] },
    quotes: [{ text: 'I do not mind paying, I mind being surprised.', context: 'Support chat' }],
    scenario: { title: 'The vanishing coupon', narrative: 'Bea applies a coupon that disappears on the payment step.', trigger: 'Checkout total changes', outcome: 'Abandons the cart' },
  },
  {
    name: 'Mobile-First Mina', tagline: 'Thumb-first, patience-last', confidence: 'medium',
    identity: { age_range: '22-27', location: 'City centre', occupation: 'Retail associate', bio: 'Shops entirely on her phone during commutes.' },
    goals_motivations: { primary_goal: 'Reorder favourites in seconds', secondary_goals: ['Stay signed in'], underlying_motivations: ['Convenience'] },
    pain_points: { current_challenges: ['Gets logged out weekly'], blockers: ['Checkout button below the fold'], workarounds: ['Uses the website instead'], emotional_impact: 'Irritated' },
    behaviors: { current_solutions: ['Saved carts'], tools_used: ['Android app'], activity_frequency: 'Several times a week', tech_savviness: 'High', decision_style: 'Impulsive' },
    context_environment: { usage_context: 'On the train', devices: ['Android phone'], time_constraints: 'A few minutes', social_context: 'Shops alone', influencers: ['Social media'] },
    quotes: [{ text: 'Every extra tap is a reason to use a competitor.', context: 'App review' }],
    scenario: { title: 'The commute reorder', narrative: 'Mina tries to reorder on the train and is asked to sign in again.', trigger: 'Session expiry', outcome: 'Gives up until she is home' },
  },
  {
    name: 'Gift-Giving Gus', tagline: 'Ships to someone else, every time', confidence: 'low',
    identity: { age_range: '45-60', location: 'Small town', occupation: 'Pharmacist', bio: 'Sends gifts to grandchildren across the country.' },
    goals_motivations: { primary_goal: 'Gifts arrive before the occasion', secondary_goals: ['Gift wrap that looks good'], underlying_motivations: ['Being thoughtful'] },
    pain_points: { current_challenges: ['No way to confirm arrival'], blockers: ['Recipient address validation'], workarounds: ['Calls the recipient'], emotional_impact: 'Embarrassed when late' },
    behaviors: { current_solutions: ['Orders early'], tools_used: ['Tablet'], activity_frequency: 'Around holidays', tech_savviness: 'Low', decision_style: 'Cautious' },
    context_environment: { usage_context: 'Weekend mornings', devices: ['Tablet'], time_constraints: 'Plenty of time', social_context: 'Buys for family', influencers: ['Family'] },
    quotes: [{ text: 'If it arrives late it is not a gift, it is an apology.', context: 'Survey' }],
    scenario: { title: 'The birthday deadline', narrative: 'Gus orders a gift a week ahead and the estimate slips past the birthday.', trigger: 'Carrier delay', outcome: 'Requests a refund' },
  },
];

/** A persona item as _build_persona_items / the persona importer store it; `taken` guards id reuse. */
function personaItem(taken, fields) {
  const at = nowIso();
  const personaId = stampedId('persona', taken);
  return {
    persona_id: personaId, name: 'New Persona', tagline: '',
    identity: {}, goals_motivations: {}, pain_points: {}, behaviors: {},
    context_environment: {}, quotes: [], scenario: {}, research_notes: [],
    created_at: at, updated_at: at, ...fields,
  };
}

/** shared/persona_overlap._name_key: whitespace collapsed, case folded. */
const personaNameKey = (name) => (typeof name === 'string' ? name.split(/\s+/).filter(Boolean).join(' ').toLowerCase() : '');

/** A fresh set of `count` personas; ids differ from each other and from the `kept` personas. */
function generatedPersonas(shared, count, kept = []) {
  const read = feedbackCount(shared);
  const personas = [];
  const taken = (id) => personas.some((p) => p.persona_id === id) || kept.some((p) => p.persona_id === id);
  // Like the real plan step told the kept names: skip a name a kept persona already has. The
  // instruction is advisory, so the FIRST candidate may still repeat one, which savePersonaSet then
  // drops (duplicate_names_dropped), so the job's notice can be seen against the mock.
  const keptNames = new Set(kept.map((p) => personaNameKey(p.name)));
  let i = 0;
  while (personas.length < count) {
    const template = PERSONA_TEMPLATES[i % PERSONA_TEMPLATES.length];
    const round = Math.floor(i / PERSONA_TEMPLATES.length);
    const name = round > 0 ? `${template.name} ${round + 1}` : template.name;
    const mayRepeat = i === 0;
    i += 1;
    if (!mayRepeat && keptNames.has(personaNameKey(name))) continue;
    personas.push(personaItem(taken, {
      ...cloneJson(template),
      name,
      feedback_count: Math.max(1, Math.round(read / count)),
      source_breakdown: { webscraper: read },
      supporting_evidence: ['Recurring delivery-estimate complaints', 'Checkout friction mentions'],
    }));
  }
  return personas;
}

/**
 * keep_existing_personas (#353): add next to the project's personas, dropping a new one whose
 * name repeats a kept one (drop_name_clashes); otherwise replace them (_clear_existing_personas).
 * Returns [the new personas saved, how many were dropped].
 */
function savePersonaSet(detail, generated, keep) {
  // Add keeps every persona; replace keeps the protected ones (#429). A new name repeating a kept one is dropped.
  const kept = keep ? detail.personas : detail.personas.filter((p) => p.protected === true);
  const seen = new Set(kept.map((p) => personaNameKey(p.name)).filter(Boolean));
  const added = generated.filter((p) => {
    const key = personaNameKey(p.name);
    if (key && seen.has(key)) return false;
    if (key) seen.add(key);
    return true;
  });
  detail.personas.splice(0, detail.personas.length, ...kept, ...added);
  return [added, generated.length - added.length];
}

const personaIdTaken = (detail) => (id) => Boolean(findPersona(detail, id));

function startPersonaGeneration(ctx) {
  const raw = ctx.body.persona_count;
  const asked = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : 3;
  const count = Math.min(Math.max(asked, 1), MAX_PERSONAS_PER_GENERATION);
  if (own(ctx.body, 'generate_avatars') && ctx.body.generate_avatars !== null && typeof ctx.body.generate_avatars !== 'boolean') {
    return bad(`generate_avatars must be true or false, got ${pyTypeName(ctx.body.generate_avatars)}`);
  }
  const keepRaw = ctx.body.keep_existing_personas;
  if (own(ctx.body, 'keep_existing_personas') && keepRaw !== null && typeof keepRaw !== 'boolean') {
    return bad(`keep_existing_personas must be true or false, got ${pyTypeName(keepRaw)}`);
  }
  const keep = keepRaw === true;
  if (!anyFeedbackMatches(ctx.shared, ctx.body)) return bad(PERSONA_NO_FEEDBACK_MESSAGE);
  return startJob(ctx.projectId, {
    jobType: 'generate_personas', status: 'running', message: 'Persona generation started.',
    runningStep: 'executing_llm_chain', errorMessage: 'Persona generation failed',
    complete: (detail) => {
      const [personas, duplicateNamesDropped] = savePersonaSet(
        detail, generatedPersonas(ctx.shared, count, detail.personas), keep,
      );
      detail.project.persona_count = detail.personas.length;
      const read = feedbackCount(ctx.shared);
      return {
        success: true, personas: cloneJson(personas),
        analysis: { research: 'Mock research pass: delivery predictability and checkout trust dominate the corpus.' },
        metadata: {
          feedback_count: read, feedback_items_used: read, context_truncated: false,
          fetch_limit_reached: false, fetch_limit: 500, source_breakdown: { webscraper: read },
          duplicate_names_dropped: duplicateNamesDropped, generation_time_ms: 1800,
        },
      };
    },
  });
}

/** update_persona: a missing persona fails its condition, which the backend reports as a 500. */
function updatePersona(ctx, personaId) {
  const persona = findPersona(ctx.detail, personaId);
  if (!persona) return [500, { success: false, error: 'Failed to update persona' }];
  const fields = pick(ctx.body, PERSONA_UPDATABLE);
  if (typeof fields.name === 'string' && fields.name) fields.name = fields.name.replace(/([a-z])([A-Z])/g, '$1 $2');
  Object.assign(persona, fields, { updated_at: nowIso() });
  return [200, { success: true }];
}

function deletePersona(ctx, personaId) {
  const index = ctx.detail.personas.findIndex((p) => p.persona_id === personaId);
  if (index === -1) return [500, { success: false, error: 'Failed to delete persona' }];
  ctx.detail.personas.splice(index, 1);
  ctx.detail.project.persona_count = Math.max(0, (Number(ctx.detail.project.persona_count) || 0) - 1);
  return [200, { success: true }];
}

/**
 * regenerate_persona_avatar: a NEW image per call (the real route writes a new,
 * content-addressed key), answered as the signed URL the browser loads. The mock's
 * image is an inline SVG whose colour changes per generation, so the swap is visible.
 */
const avatarGenerations = { count: 0 };
function regeneratePersonaAvatar(ctx, personaId) {
  const persona = findPersona(ctx.detail, personaId);
  if (!persona) return [404, { success: false, error: 'Persona not found' }];
  avatarGenerations.count += 1;
  const generation = avatarGenerations.count;
  const hue = (generation * 67) % 360;
  const initial = String(persona.name || '?').charAt(0).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="hsl(${hue} 55% 55%)"/>`
    + `<text x="32" y="41" font-family="sans-serif" font-size="28" text-anchor="middle" fill="white">${initial}</text></svg>`;
  const prompt = `Professional headshot of ${persona.name} (mock generation ${generation})`;
  Object.assign(persona, { avatar_url: `data:image/svg+xml,${encodeURIComponent(svg)}`, avatar_prompt: prompt, updated_at: nowIso() });
  return [200, { success: true, avatar_url: persona.avatar_url, avatar_prompt: prompt }];
}

function addPersonaNote(ctx, personaId) {
  const text = ctx.body.text;
  if (!text) return bad('Note text is required');
  const persona = findPersona(ctx.detail, personaId);
  if (!persona) return [500, { success: false, error: 'Failed to add note' }];
  const notes = Array.isArray(persona.research_notes) ? persona.research_notes : [];
  const note = {
    note_id: stampedId('note', (id) => notes.some((n) => n?.note_id === id)),
    text: cloneJson(text), author: stringOr(ctx.body.author, 'anonymous'),
    created_at: nowIso(), updated_at: null, tags: stringList(ctx.body.tags),
  };
  persona.research_notes = [...notes, note];
  persona.updated_at = note.created_at;
  return [200, { success: true, note }];
}

/** shared/persona_import.validate_import_config, then the persona_importer job. */
function importPersona(ctx) {
  const raw = ctx.body.input_type;
  let inputType = '';
  if (raw === undefined || raw === null) inputType = 'text';
  else if (typeof raw === 'string') inputType = raw.trim().toLowerCase() || 'text';
  const accepts = 'Persona import accepts pasted text or an image.';
  if (inputType === 'pdf') return bad(`PDF import is not supported yet. ${accepts}`);
  if (inputType !== 'text' && inputType !== 'image') return bad(`Unsupported import type. ${accepts}`);
  const content = stringOr(ctx.body.content, '');
  if (!content.trim()) return bad('There was nothing to read. Paste the persona description, or upload an image, and try again.');
  const mediaType = stringOr(ctx.body.media_type, '').trim().toLowerCase();
  if (inputType === 'image' && !CONVERSE_IMAGE_TYPES.includes(mediaType)) {
    return bad(`That image could not be read. Accepted: ${CONVERSE_IMAGE_TYPES.join(', ')}.`);
  }
  const name = inputType === 'text' ? (content.trim().split('\n')[0].slice(0, 40) || 'Imported Persona') : 'Screenshot Persona';
  return withMethodology(startJob(ctx.projectId, {
    jobType: 'import_persona', status: 'running', message: 'Persona import started.',
    runningStep: 'extracting_persona', errorMessage: 'Persona import failed',
    complete: (detail) => {
      const persona = personaItem(personaIdTaken(detail), {
        ...cloneJson(PERSONA_TEMPLATES[0]), name, tagline: 'Imported from a pasted description', confidence: 'low',
        imported_from: inputType, ...importedPersonaMarker(),
      });
      detail.personas.push(persona);
      detail.project.persona_count = (Number(detail.project.persona_count) || 0) + 1;
      return { persona_id: persona.persona_id, title: `Imported: ${persona.name}` };
    },
  }), importStartMethodology());
}

// ── Generated content ───────────────────────────────────────────────────────

const personaLine = (detail) => detail.personas.map((p) => p.name).filter(Boolean).join(', ') || 'no personas yet';

function researchContent(shared, detail, question) {
  return `# Research Report\n\n**Question:** ${question}\n\n## Executive Summary\nAcross ${feedbackCount(shared)} feedback items, customers tie dissatisfaction to unpredictability more than to raw speed.\n\n## Key Findings\n1. **Silent estimate changes** are the most cited trigger for negative reviews.\n2. **Checkout surprises** (fees, failed coupons) drive abandonment.\n\n## Personas Considered\n${personaLine(detail)}\n\n## Recommendations\n- Notify customers the moment an estimate moves\n- Show the final total before the payment step`;
}

function prdContent(title, featureIdea, detail) {
  return `# PRD: ${title}\n\n## Problem\n${featureIdea || 'Customers report unpredictable delivery estimates.'}\n\n## Target Personas\n${personaLine(detail)}\n\n## Requirements\n1. Notify the customer within 5 minutes of an estimate change.\n2. Show the new estimate and the reason in the order page.\n\n## Success Metrics\n- 30% fewer "where is my order" contacts`;
}

function prfaqContent(title, featureIdea) {
  return `# PR/FAQ: ${title}\n\n## Press Release\n${featureIdea || 'Today we launch a customer-first improvement.'}\n\n## Customer FAQ\n**Q: What changes for me?**\nA: You hear about changes before you have to ask.\n\n## Internal FAQ\n**Q: What is the riskiest dependency?**\nA: Carrier event latency.`;
}

function mergedContent(title, instructions, sources) {
  const list = sources.map((d) => `- ${d.title} (${d.document_type})`).join('\n') || '- (no source documents)';
  return `# ${title}\n\n## Merge Instructions\n${instructions || '(none)'}\n\n## Sources\n${list}\n\n## Combined Narrative\nThe sources agree that predictability is the core customer need; this document unifies their requirements.`;
}

function prototypeHtml(title, sources, feedback) {
  const from = sources.map((d) => d.title).join(' + ') || 'project documents';
  const revision = feedback ? `<p class="note">Revision: ${feedback.replace(/[<>&"]/g, '')}</p>` : '';
  return `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>${title}</title>\n<style>body{font-family:system-ui,sans-serif;margin:0;background:#f6f7f9;color:#1d2330}header{background:#232f3e;color:#fff;padding:16px 24px}main{padding:24px;max-width:720px;margin:auto}.card{background:#fff;border-radius:8px;padding:16px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.1)}button{background:#ff9900;border:0;border-radius:6px;padding:8px 14px;font-weight:600}.note{color:#555;font-size:13px}</style></head>\n<body><header><h1>${title}</h1></header><main>\n<div class="card" id="order-status"><h2>Order #1042</h2><p>Arriving <strong>Thursday</strong> (was Tuesday): carrier delay at the regional hub.</p><button>Notify me about delays</button></div>\n<div class="card" id="checkout-summary"><h2>Checkout</h2><p>Total, including shipping: <strong>$42.10</strong></p><button>Place order</button></div>\n<p class="note">Mock prototype built from ${from}.</p>${revision}\n</main></body></html>`;
}

// ── Document routes ─────────────────────────────────────────────────────────

function startResearch(ctx) {
  const question = stringOr(ctx.body.question, 'What are the main customer pain points?');
  // research_config always stores `title` (body.get('title', '')), so the
  // step handler's `config.get('title', 'Research: …')` default never applies.
  const title = stringOr(ctx.body.title, '');
  if (!anyFeedbackMatches(ctx.shared, ctx.body)) return bad(RESEARCH_NO_FEEDBACK_MESSAGE);
  // Research reads personas only when some are selected (api_run_research).
  const block = generationMethodology(ctx.detail, 'research', { personas: stringList(ctx.body.selected_persona_ids).length > 0 });
  return withMethodology(startJob(ctx.projectId, {
    jobType: 'research', status: 'pending', message: 'Research started.',
    runningStep: 'analyzing_feedback', errorMessage: 'Research failed',
    complete: (detail) => {
      const doc = addDocument(detail, {
        document_id: ctx.shared.nextMockId('research'), document_type: 'research',
        title, question, content: researchContent(ctx.shared, detail, question),
        feedback_count: feedbackCount(ctx.shared), created_at: nowIso(),
      });
      return { document_id: doc.document_id, title: doc.title };
    },
  }), block);
}

function startDocumentGeneration(ctx) {
  const docType = own(ctx.body, 'doc_type') && ctx.body.doc_type !== null ? ctx.body.doc_type : 'prd';
  if (!GENERATED_DOC_TYPES.includes(docType)) {
    return bad(`doc_type must be one of: ${GENERATED_DOC_TYPES.join(', ')} (got ${pyTypeName(docType)})`);
  }
  const [title] = splitVersionedTitle(stringOr(ctx.body.title, 'Untitled'));
  const featureIdea = stringOr(ctx.body.feature_idea, '');
  // Feedback ON unless the body says false (methodology.data_sources_with_defaults).
  const used = documentRequestUse(ctx.detail, ctx.body);
  const block = generationMethodology(ctx.detail, docType, used);
  return withMethodology(startJob(ctx.projectId, {
    jobType: `generate_${docType}`, status: 'pending', message: `${docType.toUpperCase()} generation started.`,
    runningStep: 'generating_document', errorMessage: 'Document generation failed',
    complete: (detail) => {
      const content = docType === 'prd' ? prdContent(title, featureIdea, detail) : prfaqContent(title, featureIdea);
      // The generator stores the final block: the forecast plus the evidence that reached the prompt.
      const evidence = used.feedback ? feedbackCount(ctx.shared) : 0;
      const doc = addVersionedDocument(ctx.shared, detail, docType, title, {
        feature_idea: featureIdea, content, methodology: generationMethodology(detail, docType, used, { evidence }),
      });
      return { document_id: doc.document_id, title: doc.title, methodology: doc.methodology };
    },
  }), block);
}

/** POST /projects/{id}/document for another mock module (mock-decisions.js "Pursue"). */
export const startMockDocumentGeneration = (projectId, body, shared) => startDocumentGeneration({ projectId, body, shared });

function startMerge(ctx) {
  const outputType = own(ctx.body, 'output_type') ? ctx.body.output_type : 'custom';
  if (typeof outputType !== 'string' || !MERGE_OUTPUT_TYPES.includes(outputType)) {
    return bad(`output_type must be one of: ${MERGE_OUTPUT_TYPES.join(', ')} (got ${pyTypeName(outputType)})`);
  }
  const rawTitle = stringOr(ctx.body.title, 'Merged Document');
  const title = outputType === 'custom' ? rawTitle : splitVersionedTitle(rawTitle)[0];
  const selected = stringList(ctx.body.selected_document_ids);
  const instructions = stringOr(ctx.body.instructions, '');
  return startJob(ctx.projectId, {
    jobType: 'merge_documents', status: 'pending', message: 'Document merge started.',
    runningStep: 'generating_merged_document', errorMessage: 'Document merge failed',
    complete: (detail) => {
      const sources = selected.map((id) => findDocument(detail, id)).filter(Boolean);
      const fields = { content: mergedContent(title, instructions, sources), source_documents: selected, merge_instructions: instructions };
      const doc = outputType === 'custom'
        ? addDocument(detail, { document_id: ctx.shared.nextMockId('custom'), document_type: 'custom', title, created_at: nowIso(), ...fields })
        : addVersionedDocument(ctx.shared, detail, outputType, title, fields);
      return { document_id: doc.document_id, title: doc.title };
    },
  });
}

// ── Document history (shared/document_history.py) ──────────────────────────
// Every edit is a new version. A PRD / PR-FAQ edit is the next `(vN)` of its
// series (a new document, like a regeneration); a research / custom edit keeps
// its id and saves what it replaced as a revision `r{n}`. Restore = a new
// version with the old content. Revisions live here, never on the GET payload.
const savedRevisions = new Map(); // `${projectId}:${documentId}` → [{revision, title, content, saved_at, ...}]
const revisionsOf = (ctx, documentId) => savedRevisions.get(`${ctx.projectId}:${documentId}`) ?? [];
const currentRevision = (doc) => (Number.isInteger(doc.revision) && doc.revision >= 1 ? doc.revision : 1);
const seriesOf = (detail, doc) => {
  const series = splitVersionedTitle(doc.base_title ?? doc.title)[0].toLowerCase();
  return detail.documents
    .filter((d) => d.document_type === doc.document_type && splitVersionedTitle(d.base_title ?? d.title)[0].toLowerCase() === series)
    .sort((a, b) => (b.version ?? 1) - (a.version ?? 1));
};
// document_history._ROW_IDENTITY_FIELDS (plus what is set afresh): `edited_by`, `revise_job_id` and `llm_metadata`
// describe the version a revise wrote, never a later one derived from it.
const ROW_IDENTITY = new Set(['document_id', 'title', 'base_title', 'version', 'created_at', 'updated_at', 'content', 'edited_from_id', 'edit_kind', 'restored_from_id', 'restored_from_version', 'edited_by', 'revise_job_id', 'llm_metadata']);

function newManagedVersion(ctx, source, content, provenance) {
  const carried = Object.fromEntries(Object.entries(source).filter(([key]) => !ROW_IDENTITY.has(key)));
  const [base] = splitVersionedTitle(source.base_title ?? source.title);
  return addVersionedDocument(ctx.shared, ctx.detail, source.document_type, base, { ...carried, content, ...provenance });
}

function replaceUnmanaged(ctx, doc, { content, title, provenance }) {
  const key = `${ctx.projectId}:${doc.document_id}`;
  const revision = currentRevision(doc);
  savedRevisions.set(key, [{
    revision, title: doc.title, content: doc.content ?? '', saved_at: doc.updated_at ?? doc.created_at,
    edit_kind: doc.edit_kind ?? null, restored_from_version: doc.restored_from_version ?? null,
  }, ...revisionsOf(ctx, doc.document_id)]);
  Object.assign(doc, { content, title, revision: revision + 1, updated_at: nowIso(), restored_from_version: null, ...provenance });
  return doc;
}

/** The title an edit saves, or the 400 it earns: a managed series keeps its own. */
function editedTitle(body, doc, managed) {
  if (!own(body, 'title')) return [doc.title, null];
  if (managed) {
    const stored = doc.base_title || doc.title || 'Untitled';
    return splitVersionedTitle(body.title)[0].toLowerCase() === splitVersionedTitle(stored)[0].toLowerCase()
      ? [doc.title, null]
      : [null, bad('Managed PRD, PR/FAQ, and prototype titles cannot change series. Use the dedicated workflow to create a new series.')];
  }
  return typeof body.title === 'string' && body.title.trim()
    ? [body.title, null]
    : [null, bad('title must be a non-empty string')];
}

/**
 * validated_expected_revision (shared/document_history.py): the revision the editor loaded
 * — a series' head `version` for a PRD / PR-FAQ, the edit counter (unset = 1) otherwise.
 * Absent / null: no check. Checked BEFORE the no-change return (a malformed one is a 400 even
 * then); whether it is stale is checked after it (an edit that saves nothing clobbers nothing).
 */
function expectedRevisionOf(body) {
  if (!own(body, 'expected_revision') || body.expected_revision === null) return [null, null];
  const expected = body.expected_revision;
  return Number.isInteger(expected) && expected >= 1
    ? [expected, null]
    : [null, bad('expected_revision must be the revision you loaded (a whole number ≥ 1)')];
}

const STALE_DOCUMENT = [409, { success: false, error: 'The document was changed by someone else; reload it and try again' }];
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** validated_revise_job_id: the pass a save of its proposal names (null when absent). */
function reviseJobIdOf(body) {
  if (!own(body, 'revise_job_id') || body.revise_job_id === null) return [null, null];
  return typeof body.revise_job_id === 'string' && OPAQUE_ID.test(body.revise_job_id)
    ? [body.revise_job_id, null]
    : [null, bad('revise_job_id must be the job id of a Revise from comments pass')];
}

// document_series.plain_text, its steps in its order: block markers, links, images, emphasis and table pipes go.
// Its line patterns run here line by line (the same result once whitespace is collapsed, and linear; only where
// its `\s` runs across lines, e.g. a divider then marker-only lines, does the API drop a little more).
const isFence = (line) => line.trimStart().startsWith('```') || line.trimStart().startsWith('~~~');
function isTableSeparator(line) {
  const row = line.trim();
  const inner = row.slice(row.startsWith('|') ? 1 : 0, row.endsWith('|') && row.length > 1 ? -1 : undefined);
  return inner.split('|').every((cell) => /^:?-{2,}:?$/.test(cell.trim()));
}
const isDivider = (line) => /^[-*_]{3,}$/.test(line.replace(/\s/g, ''));
const LINE_MARKERS = [
  /^\s{0,3}#{1,6}\s+/, // headings
  /^\s{0,3}>\s?/, // quotes
  /^\s*(?:[-*+]|\p{Nd}{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/u, // list items and to-dos
];

/** `[words](target)` (`![words](target)` when `bang`) as its words, left to right like the API's regex. */
function unlink(text, bang) {
  let out = '';
  let at = 0;
  let open = text.indexOf('[');
  while (open !== -1) {
    const start = bang ? open - 1 : open;
    const close = text.indexOf(']', open);
    const end = close !== -1 && text[close + 1] === '(' ? text.indexOf(')', close) : -1;
    const found = start >= at && (!bang || text[start] === '!') && end !== -1;
    if (found) {
      out += text.slice(at, start) + text.slice(open + 1, close);
      at = end + 1;
    }
    open = text.indexOf('[', found ? at : open + 1);
  }
  return out + text.slice(at);
}

function plainText(markdown) {
  const lines = String(markdown).split('\n').map((line) => (isFence(line) || isTableSeparator(line) ? ' ' : line));
  const unlinked = unlink(unlink(lines.join('\n'), true), false).split('\n').map((line) => {
    const marked = LINE_MARKERS.reduce((text, pattern) => text.replace(pattern, ' '), line);
    return isDivider(marked) ? ' ' : marked;
  });
  return unlinked.join('\n')
    .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(?<![\p{L}\p{N}_*])\*(?=\S)|(?<=\S)\*(?![\p{L}\p{N}_*])/gu, '')
    .replaceAll('|', ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** How often `passage` occurs in `text`, verbatim and as plain text (0 when it has none): `[verbatim, plain]`. */
function occurrences(text, passage) {
  const count = (haystack, needle) => (needle === '' ? 0 : haystack.split(needle).length - 1);
  return [count(text, passage), count(plainText(text), plainText(passage))];
}

/**
 * document_revision.holds_a_change: at least one change is NEW in the saved text relative to the edited version's:
 * a non-empty `after` occurs more often (verbatim, or as plain text); or its `before` occurs less often, verbatim and
 * as plain text (when it has any), while its non-empty `after` is in the saved text and does not occur less often
 * (a deletion, or a trim whose `after` is a piece of its `before`).
 */
export function holdsAChange(content, edited, changes) {
  return Array.isArray(changes) && changes.some((change) => {
    if (!isPlainObject(change) || typeof change.after !== 'string') return false;
    const { after, before } = change;
    const hasAfter = after.trim() !== '';
    const [afterNow, afterWas] = hasAfter ? [occurrences(content, after), occurrences(edited, after)] : [[0, 0], [0, 0]];
    if (afterNow[0] > afterWas[0] || afterNow[1] > afterWas[1]) return true;
    if (typeof before !== 'string' || before.trim() === '') return false;
    const [now, was] = [occurrences(content, before), occurrences(edited, before)];
    const beforeGone = now[0] < was[0] && (now[1] < was[1] || plainText(before) === '');
    // Only a deletion or a trim: the `after` is a piece of the `before` (verbatim, or as plain text).
    const flatAfter = plainText(after);
    const trimmed = !hasAfter || before.includes(after) || (flatAfter !== '' && plainText(before).includes(flatAfter));
    // "Less often" as for the before: verbatim and as plain text; a trim may change the kept words' markup.
    const afterKept = !hasAfter
      || ((afterNow[0] >= afterWas[0] || afterNow[1] >= afterWas[1]) && (afterNow[0] > 0 || afterNow[1] > 0));
    return beforeGone && trimmed && afterKept;
  });
}

/**
 * document_revision.verify_saved_proposal: the `revise` provenance of a save naming its pass, or the
 * 400. The job is this project's revise pass, completed with a proposal, started by the same caller,
 * of the edited document's series, and one of its changes is new in the saved text; never a quiet relabel.
 * Each of its refusals carries the code `revise_refused` (the document type's 400 is projects.py's, without it).
 */
function verifiedProposal(ctx, doc, content, jobId) {
  const refused = (error) => [null, [400, { success: false, error, code: 'revise_refused' }]];
  const entry = jobs.get(jobId);
  const record = entry?.projectId === ctx.projectId ? entry.record : null;
  if (record?.job_type !== 'assist_revise_from_comments') return refused('That revision was not found in this project');
  if (record.status !== 'completed' || record.result?.outcome !== 'proposal') {
    return refused('That revision has no proposal to save: it is still running, failed or only recommended');
  }
  const caller = ctx.shared.mockCaller?.sub ?? MOCK_CALLER_SUB;
  if (record.initiated_by !== caller) return refused('That revision was started by someone else: save it as your own edit');
  if (doc.document_type !== 'prfaq' && doc.document_type !== 'prd') {
    return [null, bad('Comments are available on PR/FAQ and PRD documents only')];
  }
  if (entry.config?.series_key !== documentSeriesKey(ctx.projectId, doc)) return refused('That revision is of another document');
  if (!holdsAChange(content, String(doc.content ?? ''), record.result.changes)) return refused('This save does not hold a change from that revision');
  return [{ edited_by: { sub: caller, kind: 'user' }, revise_job_id: jobId, ...passLlmMetadata(record.result) }, null];
}

/** document_revision.verify_saved_proposal's llm_metadata: the pass's own model and prompt version; none unrecorded. */
function passLlmMetadata(result) {
  const { model_id: modelId, prompt_version: promptVersion } = result;
  if (typeof modelId !== 'string' || !modelId || typeof promptVersion !== 'string' || !promptVersion) return {};
  return { llm_metadata: { model: modelId, prompt_version: promptVersion } };
}

/** The new version's provenance: a checked proposal save records the person and the pass (D4). */
function editProvenance(doc, revise) {
  const provenance = { edit_kind: revise ? 'revise' : 'edit', edited_from_id: doc.document_id };
  return revise ? { ...provenance, ...revise } : provenance;
}

/** validated_edit_id: the caller's idempotency key for one save, or a digest of the content. */
function editIdOf(body, content) {
  if (!own(body, 'edit_id') || body.edit_id === null) {
    return [createHash('sha256').update(content).digest('hex').slice(0, 32), null];
  }
  return typeof body.edit_id === 'string' && OPAQUE_ID.test(body.edit_id)
    ? [body.edit_id, null]
    : [null, bad('edit_id must be 1-64 letters, digits, "-" or "_"')];
}

// persist_versioned_document's allocation records: `${projectId}:${type}:${allocation id}` → the
// document it made, so a retried save (same `edit:{source}:{edit_id}`) replays that version
// instead of making another, and is never refused as stale by the version it made itself.
const allocations = new Map();

function allocatedManagedVersion(ctx, source, allocationId, expected, build) {
  const key = `${ctx.projectId}:${source.document_type}:${allocationId}`;
  const replayed = findDocument(ctx.detail, allocations.get(key) ?? '');
  if (replayed) return [200, { success: true, document: replayed }];
  if (expected !== null && expected !== (seriesOf(ctx.detail, source)[0]?.version ?? 1)) return STALE_DOCUMENT;
  const saved = build();
  allocations.set(key, saved.document_id);
  return [200, { success: true, document: saved }];
}

/** A save's body checks (revise_job_id, expected_revision, content) and the pass it names:
 *  `[{expected, content, revise}, null]`, or `[null, the 400]`. Any other key (`edit_kind` too) is ignored.
 *  An unchanged save is the no-op, whatever pass it names: the pass is not checked. */
function checkedSave(ctx, doc, title) {
  const [expected, expectedError] = expectedRevisionOf(ctx.body);
  const [reviseJobId, reviseJobIdError] = reviseJobIdOf(ctx.body);
  const refusal = reviseJobIdError ?? expectedError;
  if (refusal) return [null, refusal];
  if (own(ctx.body, 'content') && typeof ctx.body.content !== 'string') return [null, bad('content must be a string')];
  const content = own(ctx.body, 'content') ? ctx.body.content : (doc.content ?? '');
  const unchanged = content === (doc.content ?? '') && title === doc.title;
  const [revise, reviseError] = reviseJobId === null || unchanged ? [null, null] : verifiedProposal(ctx, doc, content, reviseJobId);
  return reviseError ? [null, reviseError] : [{ expected, content, revise, unchanged }, null];
}

/** update_document (projects.py + document_history.edit_document): every save is a new version, never an overwrite. */
function updateDocument(ctx, documentId) {
  const doc = findDocument(ctx.detail, documentId);
  if (!doc) return [404, { success: false, error: 'Document not found' }];
  if (doc.document_type === 'decision') return bad('Decision records are edited through PUT /projects/{id}/decisions/{document_id}.');
  const managed = VERSIONED_DOC_TYPES.has(doc.document_type);
  const [title, titleError] = editedTitle(ctx.body, doc, managed);
  if (titleError) return titleError;
  if (own(ctx.body, 'content') && doc.document_type === 'prototype') {
    return bad('Prototype content is stored in S3 and cannot be updated through generic document CRUD. Use the prototype revision workflow.');
  }
  const [save, refusal] = checkedSave(ctx, doc, title);
  if (refusal) return refusal;
  const { expected, content, revise, unchanged } = save;
  if (unchanged) return [200, { success: true, unchanged: true, document: doc }];
  const [editId, editIdError] = editIdOf(ctx.body, content);
  if (editIdError) return editIdError;
  if (managed) {
    return allocatedManagedVersion(ctx, doc, `edit:${doc.document_id}:${editId}`, expected,
      () => newManagedVersion(ctx, doc, content, editProvenance(doc, revise)));
  }
  if (expected !== null && expected !== currentRevision(doc)) return STALE_DOCUMENT;
  return [200, { success: true, document: replaceUnmanaged(ctx, doc, { content, title, provenance: { edit_kind: 'edit' } }) }];
}

/** GET …/documents/{id}/versions: newest first, with content. */
function listDocumentVersions(ctx, documentId) {
  const doc = findDocument(ctx.detail, documentId);
  if (!doc) return [404, { success: false, error: 'Document not found' }];
  if (VERSIONED_DOC_TYPES.has(doc.document_type)) {
    const versions = seriesOf(ctx.detail, doc).map((d, index) => ({
      version_id: d.document_id, document_id: d.document_id, version: d.version ?? 1, title: d.title,
      content: d.content ?? '', created_at: d.created_at, current: index === 0,
      edit_kind: d.edit_kind ?? null, restored_from_version: d.restored_from_version ?? null, llm_metadata: versionLlmView(d.llm_metadata),
    }));
    return [200, { success: true, managed: true, versions }];
  }
  const revision = currentRevision(doc);
  const current = { version_id: `r${revision}`, document_id: doc.document_id, version: revision, title: doc.title,
    content: doc.content ?? '', created_at: doc.updated_at ?? doc.created_at, current: true,
    edit_kind: doc.edit_kind ?? null, restored_from_version: doc.restored_from_version ?? null };
  const earlier = revisionsOf(ctx, documentId).map((r) => ({
    version_id: `r${r.revision}`, document_id: doc.document_id, version: r.revision, title: r.title, content: r.content,
    created_at: r.saved_at, current: false, edit_kind: r.edit_kind, restored_from_version: r.restored_from_version,
  }));
  return [200, { success: true, managed: false, versions: [current, ...earlier] }];
}

// shared/prototype_versions._PROTOTYPE_ROW_FIELDS beyond ROW_IDENTITY: what described the version a restore copies.
const PROTOTYPE_ROW_ONLY = ['job_id', 'revised_from_id', 'revision_feedback'];

/** prototype_versions.version_html's rule: inline content is HTML when marked so or shaped like a document. */
const isInlineHtml = (row) => (row.content ?? '') === '' || row.prototype_format === 'html' || /^\s*<(?:!doctype html|html)/i.test(row.content);
/** prototype_versions.version_html's 400 for an early JSON screen spec (Back to vN and a draft's base alike). */
const EARLY_SPEC = bad('This prototype is an early screen spec, not HTML, so it cannot be restored. Build a new prototype instead.');

/**
 * Back to vN (shared/prototype_versions.restore_prototype_version): a NEW version from vN's HTML
 * (inline here: the mock has no S3), recorded `edited_by` the caller. Never "unchanged": a stored
 * prototype row's `content` is empty on both sides, so the server skips that check.
 */
function restorePrototypeVersion(ctx, doc, versionId) {
  const series = seriesOf(ctx.detail, doc);
  const source = series.find((d) => d.document_id === versionId);
  if (!source) return [404, { success: false, error: 'Version not found' }];
  if (!isInlineHtml(source)) return EARLY_SPEC;
  const [latest] = series;
  const [editId, editIdError] = editIdOf(ctx.body, versionId);
  if (editIdError) return editIdError;
  const carried = Object.fromEntries(Object.entries(source).filter(([key]) => !PROTOTYPE_ROW_ONLY.includes(key)));
  return allocatedManagedVersion(ctx, latest, `restore:${versionId}:${editId}`, null, () => newManagedVersion(ctx, carried, source.content ?? '', {
    edit_kind: 'restore', edited_from_id: latest.document_id, edited_by: { sub: ctx.shared.mockCaller?.sub ?? MOCK_CALLER_SUB, kind: 'user' },
    restored_from_id: versionId, restored_from_version: source.version ?? 1,
  }));
}

/** POST …/versions/{version_id}/restore: a NEW version with that version's content. */
function restoreDocumentVersion(ctx, documentId, versionId) {
  const doc = findDocument(ctx.detail, documentId);
  if (!doc) return [404, { success: false, error: 'Document not found' }];
  if (doc.document_type === 'prototype') return restorePrototypeVersion(ctx, doc, versionId);
  if (VERSIONED_DOC_TYPES.has(doc.document_type)) {
    const series = seriesOf(ctx.detail, doc);
    const source = series.find((d) => d.document_id === versionId);
    if (!source) return [404, { success: false, error: 'Version not found' }];
    const [latest] = series;
    const content = source.content ?? '';
    if (content === (latest.content ?? '')) return [200, { success: true, unchanged: true, document: latest }];
    const [editId, editIdError] = editIdOf(ctx.body, content);
    if (editIdError) return editIdError;
    return allocatedManagedVersion(ctx, latest, `restore:${versionId}:${editId}`, null, () => newManagedVersion(ctx, latest, content, {
      edit_kind: 'restore', edited_from_id: latest.document_id, restored_from_id: versionId, restored_from_version: source.version ?? 1,
    }));
  }
  const revision = Number(/^r([1-9]\d*)$/.exec(versionId)?.[1] ?? NaN);
  if (revision === currentRevision(doc)) return [200, { success: true, unchanged: true, document: doc }];
  const row = revisionsOf(ctx, documentId).find((r) => r.revision === revision);
  if (!row) return [404, { success: false, error: 'Version not found' }];
  const saved = replaceUnmanaged(ctx, doc, { content: row.content, title: row.title, provenance: { edit_kind: 'restore', restored_from_version: revision } });
  return [200, { success: true, document: saved }];
}

function deleteDocument(ctx, documentId) {
  const index = ctx.detail.documents.findIndex((d) => d.document_id === documentId);
  if (index === -1) return [404, { success: false, error: 'Document not found' }];
  ctx.detail.documents.splice(index, 1);
  ctx.detail.project.document_count = ctx.detail.documents.length;
  ctx.detail.project.updated_at = nowIso();
  return [200, { success: true }];
}

// ── Build prototype (api_build_prototype + document_generator) ──────────────

/** _validated_source_id: null/blank = "newest", else it must name a `type` doc here. */
function validatedSourceId(detail, type, raw, field) {
  if (raw === undefined || raw === null) return [null, null];
  if (typeof raw !== 'string') return [null, bad(`${field} must be a document id string`)];
  const id = raw.trim();
  if (!id) return [null, null];
  if (id.length > MAX_KEY_SEGMENT_ID_LEN) return [null, bad(`${field} is not a valid document id`)];
  const doc = findDocument(detail, id);
  if (!doc || doc.document_type !== type) return [null, [404, { success: false, error: `${field}: no such document in this project` }]];
  return [id, null];
}

/**
 * A bounded id list (absent = none), each entry checked by `resolveEntry`, which
 * returns `[id, error]` like validatedSourceId. Duplicates collapse.
 */
function validatedIdList(raw, field, max, resolveEntry) {
  if (raw === undefined || raw === null) return [[], null];
  if (!Array.isArray(raw)) return [null, bad(`${field} must be a list of document ids`)];
  if (raw.length > max) return [null, bad(`${field} names more than ${max} documents`)];
  const ids = [];
  for (const entry of raw) {
    const [id, error] = resolveEntry(entry);
    if (error) return [null, error];
    if (id && !ids.includes(id)) ids.push(id);
  }
  return [ids, null];
}

/**
 * Product docs live in mock-server.js's own store, which is not shared, so a
 * visual id is shape-checked here but cannot be resolved to a real upload.
 */
function shapeCheckedId(entry, field) {
  if (typeof entry !== 'string') return [null, bad(`${field} must be a document id string`)];
  return [entry.trim() || null, null];
}

function prototypeConfig(ctx) {
  const { body, detail } = ctx;
  const config = {};
  for (const [key, type, field] of [['base', 'prototype', 'base_prototype_id'], ['prd', 'prd', 'source_prd_id'], ['prfaq', 'prfaq', 'source_prfaq_id']]) {
    const [id, error] = validatedSourceId(detail, type, body[field], field);
    if (error) return [null, error];
    config[key] = id;
  }
  const useResearch = Boolean(body.use_research);
  if (useResearch) {
    const field = 'selected_research_ids';
    const [, error] = validatedIdList(body[field], field, MAX_SELECTED_RESEARCH_IDS,
      (entry) => validatedSourceId(detail, 'research', entry, field));
    if (error) return [null, error];
  }
  // `use_design_system`: absent/null = on (the API default); anything but a boolean is a 400.
  const designSystem = body.use_design_system;
  if (designSystem !== undefined && designSystem !== null && typeof designSystem !== 'boolean') {
    return [null, bad(`use_design_system must be true or false, got ${typeof designSystem}`)];
  }
  const visualsField = 'selected_product_doc_ids';
  const [, visualsError] = validatedIdList(body[visualsField], visualsField, MAX_SELECTED_PRODUCT_DOC_IDS,
    (entry) => shapeCheckedId(entry, visualsField));
  if (visualsError) return [null, visualsError];
  const given = body.title === undefined || body.title === null || body.title === '' ? null : body.title;
  // No title: named after the source PRD/PR-FAQ when the job runs (defaultPrototypeTitle).
  config.title = given === null ? null : splitVersionedTitle(stringOr(given, 'Prototype'))[0];
  config.feedback = stringOr(body.feedback, '').trim();
  return [config, null];
}

function startPrototypeBuild(ctx) {
  const [config, error] = prototypeConfig(ctx);
  if (error) return error;
  // Refused before any job row (api_build_prototype, tenet 2), no longer a failed job.
  if (prototypeBlocked(ctx.detail)) return [409, { success: false, error: NO_SOURCE_MESSAGE }];
  const block = generationMethodology(ctx.detail, 'prototype');
  return withMethodology(startJob(ctx.projectId, {
    jobType: 'build_prototype', status: 'pending', message: 'Prototype build started.',
    runningStep: 'invoking_bedrock', errorMessage: 'Document generation failed',
    complete: (detail) => {
      const prd = config.prd ? findDocument(detail, config.prd) : newestOfType(detail, 'prd');
      const prfaq = config.prfaq ? findDocument(detail, config.prfaq) : newestOfType(detail, 'prfaq');
      if (!prd && !prfaq) throw new Error(NO_SOURCE_MESSAGE);
      // Inline HTML (the legacy srcDoc path): the mock has no signed CloudFront URL to mint.
      const title = config.title ?? defaultPrototypeTitle(prd, prfaq, `Prototype: ${detail.project?.name ?? 'Project'}`);
      const doc = addVersionedDocument(ctx.shared, detail, 'prototype', title, {
        content: prototypeHtml(title, [prd, prfaq].filter(Boolean), config.feedback),
        prototype_format: 'html',
        source_prd_id: prd?.document_id ?? null, source_prfaq_id: prfaq?.document_id ?? null,
        ...(config.feedback ? { revised_from_id: config.base, revision_feedback: config.feedback.slice(0, 2000) } : {}),
        methodology: block,
      });
      return { document_id: doc.document_id, title: doc.title };
    },
  }), block);
}

// ── Prototype drafts (docs/prototype-builder.md, part 2) ────────────────────
// A draft is a finished `draft_prototype` job: its detail (and, the mock having no S3, its HTML)
// lives on the job entry, never on the job record a job route answers, so the job DELETE (Discard)
// removes it. Its preview is served by this mock at /mock-prototype-drafts/{draft_id}.html.

const MAX_INSTRUCTION_CHARS = 2000;
const DRAFT_LLM = { model: 'mock', prompt_version: 'prototype-draft-mock-1' };
const DRAFT_PREVIEW_PATH = /^\/mock-prototype-drafts\/([^/]+)\.html$/;
const PROTOTYPE_NOT_FOUND = [404, { success: false, error: 'Prototype not found' }];
const DRAFT_NOT_FOUND = [404, { success: false, error: 'Draft not found' }];
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The prototype `documentId` names in this project, or null. */
function prototypeOf(ctx, documentId) {
  const doc = findDocument(ctx.detail, documentId);
  return doc?.document_type === 'prototype' ? doc : null;
}

/** The mock's draft "HTML": the base's, with a visible note of the instruction at the top of its body. */
function draftHtml(base, instruction) {
  const note = `<p data-draft-note style="margin:0;padding:8px 24px;background:#fff4d6;color:#1d2330;font:13px system-ui,sans-serif">Draft: ${escapeHtml(instruction)}</p>`;
  const html = base.content || prototypeHtml(base.title ?? 'Prototype', [], '');
  return /<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, (open) => `${open}${note}`) : `${note}${html}`;
}

/** POST /prototypes/{document_id}/drafts: `{instruction}` → a draft job on the series' newest version. */
function startPrototypeDraft(ctx, documentId) {
  const { body } = ctx;
  if (own(body, 'pin_ids')) return bad('Incorporating feedback into a draft is not available yet');
  if (typeof body.instruction !== 'string') return bad('instruction must be a string');
  const instruction = body.instruction.trim();
  if (instruction === '' || instruction.length > MAX_INSTRUCTION_CHARS) return bad(`instruction must be 1-${MAX_INSTRUCTION_CHARS} characters`);
  const doc = prototypeOf(ctx, documentId);
  if (!doc) return PROTOTYPE_NOT_FOUND;
  const [base] = seriesOf(ctx.detail, doc);
  if (!isInlineHtml(base)) return EARLY_SPEC;
  const started = startJob(ctx.projectId, {
    jobType: 'draft_prototype', status: 'pending', message: 'Prototype draft started.',
    runningStep: 'invoking_bedrock', errorMessage: 'Prototype draft failed', complete: () => ({}),
  });
  const entry = jobs.get(started[1].job_id);
  const baseId = base.document_id;
  const baseVersion = base.version ?? 1;
  entry.complete = (detail) => {
    const row = findDocument(detail, baseId);
    if (!row) throw new Error('The prototype this draft revises no longer exists');
    const quoted = instruction.slice(0, 120);
    entry.draft = {
      base_document_id: baseId, base_version: baseVersion, instruction, html: draftHtml(row, instruction),
      summary: `All screens: changed as asked ("${quoted}")\nHeader: a draft note names the instruction`,
    };
    return { draft_id: entry.record.job_id };
  };
  return started;
}

/** The job entry of a finished draft of `documentId`'s series in this project, or null (every refusal is a 404). */
function draftEntry(ctx, documentId, draftId) {
  const doc = prototypeOf(ctx, documentId);
  const entry = jobs.get(draftId);
  if (!doc || entry?.projectId !== ctx.projectId || !entry.draft) return null;
  if (entry.record.job_type !== 'draft_prototype' || entry.record.status !== 'completed') return null;
  const inSeries = seriesOf(ctx.detail, doc).some((d) => d.document_id === entry.draft.base_document_id);
  return inSeries ? { doc, entry } : null;
}

/** GET /prototypes/{document_id}/drafts/{draft_id} (EDIT). */
function getPrototypeDraft(ctx, documentId, draftId) {
  const found = draftEntry(ctx, documentId, draftId);
  if (!found) return DRAFT_NOT_FOUND;
  const { record, draft } = found.entry;
  return [200, {
    draft_id: record.job_id, base_document_id: draft.base_document_id, base_version: draft.base_version,
    instruction: draft.instruction, summary: draft.summary,
    preview_url: `${ctx.origin}/mock-prototype-drafts/${encodeURIComponent(record.job_id)}.html`,
    completed_at: record.completed_at,
  }];
}

/**
 * POST …/drafts/{draft_id}/apply: the draft as the next version (`apply:{draft_id}` allocation), 201 for the
 * call that wrote it and 200 with the same version on a replay; 409 once the series moved past the base.
 */
function applyPrototypeDraft(ctx, documentId, draftId) {
  const found = draftEntry(ctx, documentId, draftId);
  if (!found) return DRAFT_NOT_FOUND;
  const { draft } = found.entry;
  const base = findDocument(ctx.detail, draft.base_document_id);
  if (!base) return DRAFT_NOT_FOUND;
  const key = `${ctx.projectId}:prototype:apply:${draftId}`;
  const replayed = findDocument(ctx.detail, allocations.get(key) ?? '');
  if (replayed) return [200, { success: true, document: replayed }];
  if ((seriesOf(ctx.detail, base)[0]?.version ?? 1) !== draft.base_version) return STALE_DOCUMENT;
  const carried = Object.fromEntries(Object.entries(base).filter(([field]) => !PROTOTYPE_ROW_ONLY.includes(field)));
  const saved = newManagedVersion(ctx, carried, draft.html, {
    edit_kind: 'revise', revised_from_id: base.document_id, revision_feedback: draft.instruction.slice(0, MAX_INSTRUCTION_CHARS),
    edited_by: { sub: ctx.shared.mockCaller?.sub ?? MOCK_CALLER_SUB, kind: 'user' }, llm_metadata: { ...DRAFT_LLM },
  });
  allocations.set(key, saved.document_id);
  return [201, { success: true, document: saved }];
}

/** GET /mock-prototype-drafts/{draft_id}.html: the draft's page (the stand-in for its signed CloudFront URL). */
function serveDraftPreview(req, res, url) {
  const match = req.method === 'GET' ? url.pathname.match(DRAFT_PREVIEW_PATH) : null;
  if (!match) return false;
  const html = jobs.get(safeDecode(match[1]))?.draft?.html;
  res.writeHead(html ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html ?? '<!doctype html><title>Not found</title><p>This draft is gone.</p>');
  return true;
}

// ── AI helpers (assist jobs: their answer is the job `result`, see `assisted`) ──

function suggestResearchQuestions() {
  return [200, {
    suggestions: [
      { title: 'Delivery estimate trust', question: 'Which delivery-estimate changes cause the most negative reviews, and how early must customers hear about them?' },
      { title: 'Checkout total surprises', question: 'At which checkout step do price or coupon surprises lead customers to abandon their cart?' },
      { title: 'Mobile session friction', question: 'How often do mobile shoppers mention being logged out, and what do they do next?' },
    ],
  }];
}

// ── Prototype pins (shared/prototype_pins.py; projects_handler pin routes) ──
// Keyed `${projectId}\0${documentId}`. proj_1's pins are seeded lazily on first
// read; proj_1's fixtures have no prototype, so for it ANY id that names no
// document is accepted and seeded, so the review panel has data locally.

const PIN_STATUSES = ['open', 'addressed', 'resolved'];
const PIN_DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PIN_ID = /^pin_\d{20}[0-9a-f]{6}$/;
const MAX_REPLIES = 50;
const MAX_REPLY_CHARS = 2000;
const SEEDED_PIN_PROJECT = 'proj_1';
const pinStore = new Map();

/** prototype_pins.pin_form_id: deterministic per document. */
function pinFormId(documentId) {
  const digest = createHash('sha256').update(`prototype_pin|${documentId}`).digest('hex');
  return `pf_${digest.slice(0, 16)}`;
}

/** `pin_` + UTC `%Y%m%d%H%M%S%f` + 6 hex: unique and time-sortable. */
function newPinId(date) {
  const stamp = idStamp(date) + String(date.getUTCMilliseconds() * 1000).padStart(6, '0');
  return `pin_${stamp}${hex(6)}`;
}

function pinAnchor(selector, snippet, bbox, route) {
  return { selector, text_snippet: snippet, bbox, viewport: { w: 1280, h: 800 }, scroll: { x: 0, y: 0 }, route };
}

function seedPins(projectId, documentId) {
  const formId = pinFormId(documentId);
  const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000);
  const pin = (minutesAgo, fields) => {
    const created = at(minutesAgo);
    return {
      pin_id: newPinId(created), form_id: formId, project_id: projectId, document_id: documentId,
      status: 'open', flagged: false, created_at: created.toISOString(), updated_at: created.toISOString(),
      replies: [], user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Safari/605.1.15',
      console: [], screening: [], ...fields,
    };
  };
  return [
    pin(240, {
      comment: 'The "Notify me about delays" button does nothing when I click it.',
      anchor: pinAnchor('#order-status > button', 'Notify me about delays', { x: 8.5, y: 31.2, w: 22.4, h: 5.1 }, '/'),
      console: [{ level: 'error', message: "TypeError: Cannot read properties of undefined (reading 'enabled')" }],
      replies: [{ by: MOCK_CALLER_SUB, name: MOCK_CALLER_NAME, text: 'Reproduced: the handler is not wired in this build.', at: at(200).toISOString() }],
      updated_at: at(200).toISOString(),
    }),
    pin(180, {
      comment: 'I cannot tell whether Thursday is the new date or the old one.',
      anchor: pinAnchor('#order-status p strong', 'Thursday', { x: 14.1, y: 24.8, w: 9.3, h: 3.2 }, '/'),
    }),
    pin(120, {
      status: 'addressed', addressed_by: 'prototype_revision_mock', status_by: MOCK_CALLER_SUB,
      comment: 'Shipping should be shown before I reach this button.',
      anchor: pinAnchor('#checkout-summary > button', 'Place order', { x: 8.5, y: 62.0, w: 15.7, h: 5.1 }, '/'),
    }),
    pin(90, {
      status: 'resolved', status_by: MOCK_CALLER_SUB, comment: 'Header text is too small on my laptop.',
      anchor: pinAnchor('header h1', 'Proactive Delay Alerts', { x: 2.0, y: 2.5, w: 40.0, h: 6.0 }, '/'),
    }),
    // Sparse legacy-shaped pin: no anchor, replies or console, so prototypePinsApi's defaults stay exercised.
    { pin_id: newPinId(at(30)), status: 'open', comment: 'Love the clearer delay reason!', created_at: at(30).toISOString() },
  ];
}

/** _pin_form_for: valid id, then a prototype of this project (else 404) and its pins. */
function pinsFor(ctx, documentId) {
  if (!PIN_DOCUMENT_ID.test(documentId)) return [null, bad('Invalid document id')];
  const doc = findDocument(ctx.detail, documentId);
  const seeded = ctx.projectId === SEEDED_PIN_PROJECT;
  const isPrototype = doc?.document_type === 'prototype';
  if (!isPrototype && !(seeded && !doc)) return [null, [404, { success: false, error: 'Prototype not found' }]];
  const key = `${ctx.projectId}\u0000${documentId}`;
  if (!pinStore.has(key)) pinStore.set(key, seeded ? seedPins(ctx.projectId, documentId) : []);
  return [pinStore.get(key), null];
}

const publicPin = (pin) => cloneJson(pin);
const pinConflict = (what) => [409, { success: false, error: `The pin does not exist or ${what}` }];

function listPins(ctx, documentId) {
  const [pins, error] = pinsFor(ctx, documentId);
  if (error) return error;
  const status = ctx.params.get('status') || null;
  if (status !== null && !PIN_STATUSES.includes(status)) return bad('status must be open, addressed or resolved');
  const listed = pins
    .filter((p) => status === null || p.status === status)
    .sort((a, b) => a.pin_id.localeCompare(b.pin_id))
    .slice(0, 200)
    .map(publicPin);
  return [200, { form_id: pinFormId(documentId), document_id: documentId, count: listed.length, pins: listed }];
}

function replyToPin(ctx, documentId, pinId) {
  const [pins, error] = pinsFor(ctx, documentId);
  if (error) return error;
  const { text } = ctx.body;
  if (text !== undefined && text !== null && typeof text !== 'string') return bad('text must be a string');
  const clean = stringOr(text, '').replace(/\0/g, '').trim();
  if (!clean) return bad('text is required');
  if (!PIN_ID.test(pinId)) return bad('Invalid pin id');
  const pin = pins.find((p) => p.pin_id === pinId);
  const replies = Array.isArray(pin?.replies) ? pin.replies : [];
  if (!pin || replies.length >= MAX_REPLIES) return pinConflict('its thread is full');
  const reply = { by: MOCK_CALLER_SUB, name: MOCK_CALLER_NAME, text: clean.slice(0, MAX_REPLY_CHARS), at: nowIso() };
  pin.replies = [...replies, reply];
  pin.updated_at = reply.at;
  return [200, { success: true, pin: publicPin(pin) }];
}

/** set_status: moves only from `onlyFrom`; anything else is the 409 the backend maps it to. */
function movePin(pins, pinId, status, onlyFrom, extra) {
  const pin = pins.find((p) => p.pin_id === pinId);
  if (!pin || !onlyFrom.includes(pin.status)) return null;
  Object.assign(pin, { status, updated_at: nowIso(), status_by: MOCK_CALLER_SUB }, extra);
  return pin;
}

function changePinStatus(ctx, documentId, pinId, action) {
  const [pins, error] = pinsFor(ctx, documentId);
  if (error) return error;
  if (!PIN_ID.test(pinId)) return bad('Invalid pin id');
  const pin = action === 'resolve'
    ? movePin(pins, pinId, 'resolved', ['open', 'addressed'], {})
    : movePin(pins, pinId, 'open', ['addressed', 'resolved'], { addressed_by: null });
  if (!pin) return pinConflict('cannot move to that state');
  return [200, { success: true, pin: publicPin(pin) }];
}

// ── Route table ─────────────────────────────────────────────────────────────
// `pattern` matches the path after `/projects/{id}`. `body`: 'none' (GET/DELETE),
// 'lenient' (the backend's `json_body or {}`) or 'object' (json_object_body: a
// non-object body is a 400). `claim` lets a route decline a request it does not own.

const ROUTES = [
  { method: 'GET', pattern: /^\/jobs$/, run: listJobs },
  { method: 'GET', pattern: /^\/jobs\/([^/]+)$/, claim: isOwnJob, run: getJob },
  { method: 'DELETE', pattern: /^\/jobs\/([^/]+)$/, run: deleteJob },

  { method: 'POST', pattern: /^\/personas\/generate$/, body: 'lenient', run: startPersonaGeneration },
  { method: 'POST', pattern: /^\/personas\/import$/, body: 'lenient', run: importPersona },
  { method: 'PUT', pattern: /^\/personas\/([^/]+)$/, body: 'lenient', run: updatePersona },
  { method: 'DELETE', pattern: /^\/personas\/([^/]+)$/, run: deletePersona },
  { method: 'POST', pattern: /^\/personas\/([^/]+)\/notes$/, body: 'lenient', run: addPersonaNote },
  { method: 'POST', pattern: /^\/personas\/([^/]+)\/regenerate-avatar$/, run: assisted('assist_persona_avatar', regeneratePersonaAvatar) },

  { method: 'POST', pattern: /^\/research$/, body: 'lenient', run: startResearch },
  { method: 'POST', pattern: /^\/research\/suggest-questions$/, body: 'lenient', run: assisted('assist_research_questions', suggestResearchQuestions) },

  { method: 'POST', pattern: /^\/document$/, body: 'object', run: startDocumentGeneration },
  { method: 'POST', pattern: /^\/documents\/merge$/, body: 'object', run: startMerge },
  { method: 'POST', pattern: /^\/documents\/suggest-brief$/, body: 'lenient', run: assisted('assist_document_brief', suggestDocumentBrief) },
  { method: 'PUT', pattern: /^\/documents\/([^/]+)$/, body: 'lenient', run: updateDocument },
  { method: 'DELETE', pattern: /^\/documents\/([^/]+)$/, run: deleteDocument },
  { method: 'GET', pattern: /^\/documents\/([^/]+)\/versions$/, run: listDocumentVersions },
  { method: 'POST', pattern: /^\/documents\/([^/]+)\/versions\/([^/]+)\/restore$/, body: 'lenient', run: restoreDocumentVersion },

  { method: 'POST', pattern: /^\/prfaq-autofill$/, body: 'lenient', run: assisted('assist_prfaq_autofill', autofillPrfaq) },
  { method: 'POST', pattern: /^\/build-prototype$/, body: 'object', run: startPrototypeBuild },

  { method: 'POST', pattern: /^\/prototypes\/([^/]+)\/drafts$/, body: 'object', run: startPrototypeDraft },
  { method: 'GET', pattern: /^\/prototypes\/([^/]+)\/drafts\/([^/]+)$/, run: getPrototypeDraft },
  { method: 'POST', pattern: /^\/prototypes\/([^/]+)\/drafts\/([^/]+)\/apply$/, body: 'lenient', run: applyPrototypeDraft },

  { method: 'GET', pattern: /^\/prototypes\/([^/]+)\/pins$/, run: listPins },
  { method: 'POST', pattern: /^\/prototypes\/([^/]+)\/pins\/([^/]+)\/replies$/, body: 'object', run: replyToPin },
  { method: 'POST', pattern: /^\/prototypes\/([^/]+)\/pins\/([^/]+)\/resolve$/, body: 'object', run: (ctx, doc, pin) => changePinStatus(ctx, doc, pin, 'resolve') },
  { method: 'POST', pattern: /^\/prototypes\/([^/]+)\/pins\/([^/]+)\/reopen$/, body: 'object', run: (ctx, doc, pin) => changePinStatus(ctx, doc, pin, 'reopen') },
];

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The request body as the route reads it, or the 400 a non-object body earns. */
function routeBody(route, raw) {
  if (route.body === 'object' && raw !== null && !isPlainObject(raw)) return [null, bad('the request body must be a JSON object')];
  return [isPlainObject(raw) ? raw : {}, null];
}

function dispatch(route, { projectId, groups, raw, params, shared, origin }) {
  const detail = detailOf(shared, projectId);
  if (!detail) return NOT_FOUND;
  const [body, error] = routeBody(route, raw);
  if (error) return error;
  return route.run({ projectId, detail, body, params, shared, origin }, ...groups);
}

/** Handle the project action routes above; returns true when the request was taken. */
export function handleProjectActionRoutes(req, res, url, send, shared) {
  if (serveDraftPreview(req, res, url)) return true;
  const match = url.pathname.match(PROJECT_PATH);
  if (!match) return false;
  const projectId = safeDecode(match[1]);
  // `/projects/prioritization/...` belongs to mock-server.js, never a project id.
  if (projectId === 'prioritization') return false;
  // A persona container is never a project, for admins too.
  if (containers.has(projectId)) {
    send(...NOT_FOUND);
    return true;
  }
  return serveRoute(req, res, { projectId, rest: match[2], params: url.searchParams, send, shared, origin: url.origin });
}

/** Find and run the route for `rest` on `projectId`; false when no route takes it. */
function serveRoute(req, res, { projectId, rest, params, send, shared, routes = ROUTES, bodyPatch, origin = '' }) {
  const route = routes.find((r) => r.method === req.method && r.pattern.test(rest));
  if (!route) return false;
  const groups = rest.match(route.pattern).slice(1).map(safeDecode);
  if (route.claim && !route.claim(projectId, ...groups)) return false;
  const respond = (raw) => {
    // A patch always lands: on a non-object body it is the whole body (never a lost override).
    const patched = bodyPatch ? { ...(isPlainObject(raw) ? raw : {}), ...bodyPatch } : raw;
    const [status, payload] = dispatch(route, { projectId, groups, raw: patched, params, shared, origin });
    send(status, payload);
  };
  if (route.body) {
    shared.collectJson(req, res, respond);
  } else {
    respond(null);
  }
  return true;
}

// The routes a registered container offers: its jobs and its persona writes (no documents).
const CONTAINER_PREFIXES = [String.raw`^\/jobs`, String.raw`^\/personas`];
const CONTAINER_ROUTES = ROUTES.filter((r) => CONTAINER_PREFIXES.some((prefix) => r.pattern.source.startsWith(prefix)));

/**
 * Serve `rest` (a project-relative path such as `/personas/generate`) on a registered
 * container. `bodyPatch` overrides body fields (the library forces additive generation).
 * Returns false when no container route takes the request.
 */
export function serveContainerRoute(req, res, { containerId, rest, params, send, shared, bodyPatch }) {
  return serveRoute(req, res, { projectId: containerId, rest, params, send, shared, routes: CONTAINER_ROUTES, bodyPatch });
}
