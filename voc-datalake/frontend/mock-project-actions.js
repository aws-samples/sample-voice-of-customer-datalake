// Project action mocks: the async jobs (persona generation and import, research,
// PRD / PR-FAQ generation, document merge, prototype builds), persona and document
// writes, the synchronous AI helpers (research question / brief / PR-FAQ autofill
// suggestions) and prototype pins (todofeatures §6.2). Wire shapes follow
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

/**
 * The F1 pre-check of POST .../personas/generate and .../research
 * (projects.ensure_persona_feedback / ensure_research_feedback): does any fixture
 * item match the body's sources / categories / sentiments? An empty or absent list
 * matches everything, as in shared/feedback.py. `days` is not applied: the fixture's
 * dates are static, and windowing them would make every page empty over time.
 */
function anyFeedbackMatches(shared, body) {
  const [sources, categories, sentiments] = ['sources', 'categories', 'sentiments'].map((f) => stringList(body[f]));
  const keep = (values, value) => values.length === 0 || values.includes(value);
  const items = Array.isArray(shared.mockFeedback) ? shared.mockFeedback : [];
  return items.some((item) => keep(sources, item.source_platform)
    && keep(categories, item.category)
    && keep(sentiments, item.sentiment_label));
}

const PERSONA_NO_FEEDBACK_MESSAGE = 'No feedback data found for the given filters';
const RESEARCH_NO_FEEDBACK_MESSAGE = 'No feedback data found matching the filters. Try adjusting your filter criteria.';

// ── Job registry (shared/jobs.py records) ───────────────────────────────────
// jobId -> { projectId, record, polls, runningStep, errorMessage, complete }.
// `complete(detail)` writes the job's output into the project and returns the
// job `result`; throwing fails the job the way job_handler does.

const jobs = new Map();

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
  const detail = shared.mockProjectDetails[entry.projectId];
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
  if (entry.polls === 1) {
    Object.assign(record, { status: 'running', progress: 50, current_step: entry.runningStep, updated_at: nowIso() });
    return;
  }
  finishJob(entry, shared);
}

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
  const mine = [...jobs.values()].filter((e) => e.projectId === ctx.projectId);
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

/** A persona item as _build_persona_items / create_persona store it; `taken` guards id reuse. */
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

/** A fresh set of `count` personas; they replace the project's, so only ids within the set must differ. */
function generatedPersonas(shared, count) {
  const read = feedbackCount(shared);
  const personas = [];
  const taken = (id) => personas.some((p) => p.persona_id === id);
  for (let i = 0; i < count; i += 1) {
    const template = PERSONA_TEMPLATES[i % PERSONA_TEMPLATES.length];
    const round = Math.floor(i / PERSONA_TEMPLATES.length);
    personas.push(personaItem(taken, {
      ...cloneJson(template),
      name: round > 0 ? `${template.name} ${round + 1}` : template.name,
      feedback_count: Math.max(1, Math.round(read / count)),
      source_breakdown: { webscraper: read },
      supporting_evidence: ['Recurring delivery-estimate complaints', 'Checkout friction mentions'],
    }));
  }
  return personas;
}

const personaIdTaken = (detail) => (id) => Boolean(findPersona(detail, id));

function startPersonaGeneration(ctx) {
  const raw = ctx.body.persona_count;
  const asked = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : 3;
  const count = Math.min(Math.max(asked, 1), MAX_PERSONAS_PER_GENERATION);
  if (own(ctx.body, 'generate_avatars') && ctx.body.generate_avatars !== null && typeof ctx.body.generate_avatars !== 'boolean') {
    return bad(`generate_avatars must be true or false, got ${pyTypeName(ctx.body.generate_avatars)}`);
  }
  if (!anyFeedbackMatches(ctx.shared, ctx.body)) return bad(PERSONA_NO_FEEDBACK_MESSAGE);
  return startJob(ctx.projectId, {
    jobType: 'generate_personas', status: 'running', message: 'Persona generation started.',
    runningStep: 'executing_llm_chain', errorMessage: 'Persona generation failed',
    complete: (detail) => {
      // Replace semantics (_clear_existing_personas): a re-run never accumulates.
      const personas = generatedPersonas(ctx.shared, count);
      detail.personas.splice(0, detail.personas.length, ...personas);
      detail.project.persona_count = personas.length;
      const read = feedbackCount(ctx.shared);
      return {
        success: true, personas: cloneJson(personas),
        analysis: { research: 'Mock research pass: delivery predictability and checkout trust dominate the corpus.' },
        metadata: {
          feedback_count: read, feedback_items_used: read, context_truncated: false,
          fetch_limit_reached: false, fetch_limit: 500, source_breakdown: { webscraper: read },
          generation_time_ms: 1800,
        },
      };
    },
  });
}

function createPersona(ctx) {
  const fields = pick(ctx.body, ['name', 'tagline', ...PERSONA_SECTIONS]);
  const persona = personaItem(personaIdTaken(ctx.detail), fields);
  ctx.detail.personas.push(persona);
  ctx.detail.project.persona_count = (Number(ctx.detail.project.persona_count) || 0) + 1;
  return [200, { success: true, persona }];
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
  return startJob(ctx.projectId, {
    jobType: 'import_persona', status: 'running', message: 'Persona import started.',
    runningStep: 'extracting_persona', errorMessage: 'Persona import failed',
    complete: (detail) => {
      const persona = personaItem(personaIdTaken(detail), {
        ...cloneJson(PERSONA_TEMPLATES[0]), name, tagline: 'Imported from a pasted description', confidence: 'low',
      });
      detail.personas.push(persona);
      detail.project.persona_count = (Number(detail.project.persona_count) || 0) + 1;
      return { persona_id: persona.persona_id, title: `Imported: ${persona.name}` };
    },
  });
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
  return startJob(ctx.projectId, {
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
  });
}

function startDocumentGeneration(ctx) {
  const docType = own(ctx.body, 'doc_type') && ctx.body.doc_type !== null ? ctx.body.doc_type : 'prd';
  if (!GENERATED_DOC_TYPES.includes(docType)) {
    return bad(`doc_type must be one of: ${GENERATED_DOC_TYPES.join(', ')} (got ${pyTypeName(docType)})`);
  }
  const [title] = splitVersionedTitle(stringOr(ctx.body.title, 'Untitled'));
  const featureIdea = stringOr(ctx.body.feature_idea, '');
  return startJob(ctx.projectId, {
    jobType: `generate_${docType}`, status: 'pending', message: `${docType.toUpperCase()} generation started.`,
    runningStep: 'generating_document', errorMessage: 'Document generation failed',
    complete: (detail) => {
      const content = docType === 'prd' ? prdContent(title, featureIdea, detail) : prfaqContent(title, featureIdea);
      const doc = addVersionedDocument(ctx.shared, detail, docType, title, { feature_idea: featureIdea, content });
      return { document_id: doc.document_id, title: doc.title };
    },
  });
}

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
const ROW_IDENTITY = new Set(['document_id', 'title', 'base_title', 'version', 'created_at', 'updated_at', 'content', 'edited_from_id', 'edit_kind', 'restored_from_id', 'restored_from_version']);

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

/** update_document: a new version; managed types keep their series title; prototype HTML is not CRUD content. */
/**
 * The real handler's no-clobber check (shared/document_history.py): `expected_revision`
 * is the revision the editor loaded — a series' head `version` for a PRD / PR-FAQ, the
 * edit counter (unset = 1) otherwise. Absent: no check. Else a 400, or a 409 when stale.
 */
function staleSave(ctx, doc, managed) {
  if (!own(ctx.body, 'expected_revision')) return null;
  const expected = ctx.body.expected_revision;
  if (!Number.isInteger(expected) || expected < 1) {
    return bad('expected_revision must be the revision you loaded (a whole number ≥ 1)');
  }
  const current = managed ? (seriesOf(ctx.detail, doc)[0]?.version ?? 1) : currentRevision(doc);
  return expected === current
    ? null
    : [409, { success: false, error: 'The document was changed by someone else; reload it and try again' }];
}

function updateDocument(ctx, documentId) {
  const doc = findDocument(ctx.detail, documentId);
  if (!doc) return [404, { success: false, error: 'Document not found' }];
  const managed = VERSIONED_DOC_TYPES.has(doc.document_type);
  const [title, titleError] = editedTitle(ctx.body, doc, managed);
  if (titleError) return titleError;
  if (own(ctx.body, 'content') && doc.document_type === 'prototype') {
    return bad('Prototype content is stored in S3 and cannot be updated through generic document CRUD. Use the prototype revision workflow.');
  }
  const content = typeof ctx.body.content === 'string' ? ctx.body.content : (doc.content ?? '');
  if (content === (doc.content ?? '') && title === doc.title) return [200, { success: true, unchanged: true, document: doc }];
  const stale = staleSave(ctx, doc, managed);
  if (stale) return stale;
  const saved = managed
    ? newManagedVersion(ctx, doc, content, { edit_kind: 'edit', edited_from_id: doc.document_id })
    : replaceUnmanaged(ctx, doc, { content, title, provenance: { edit_kind: 'edit' } });
  return [200, { success: true, document: saved }];
}

/** GET …/documents/{id}/versions: newest first, with content. */
function listDocumentVersions(ctx, documentId) {
  const doc = findDocument(ctx.detail, documentId);
  if (!doc) return [404, { success: false, error: 'Document not found' }];
  if (VERSIONED_DOC_TYPES.has(doc.document_type)) {
    const versions = seriesOf(ctx.detail, doc).map((d, index) => ({
      version_id: d.document_id, document_id: d.document_id, version: d.version ?? 1, title: d.title,
      content: d.content ?? '', created_at: d.created_at, current: index === 0,
      edit_kind: d.edit_kind ?? null, restored_from_version: d.restored_from_version ?? null,
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

/** POST …/versions/{version_id}/restore: a NEW version with that version's content. */
function restoreDocumentVersion(ctx, documentId, versionId) {
  const doc = findDocument(ctx.detail, documentId);
  if (!doc) return [404, { success: false, error: 'Document not found' }];
  if (doc.document_type === 'prototype') return bad('Prototypes are restored through the prototype revision workflow');
  if (VERSIONED_DOC_TYPES.has(doc.document_type)) {
    const series = seriesOf(ctx.detail, doc);
    const source = series.find((d) => d.document_id === versionId);
    if (!source) return [404, { success: false, error: 'Version not found' }];
    const [latest] = series;
    if ((source.content ?? '') === (latest.content ?? '')) return [200, { success: true, unchanged: true, document: latest }];
    const saved = newManagedVersion(ctx, latest, source.content ?? '', {
      edit_kind: 'restore', edited_from_id: latest.document_id, restored_from_id: versionId, restored_from_version: source.version ?? 1,
    });
    return [200, { success: true, document: saved }];
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
  const visualsField = 'selected_product_doc_ids';
  const [, visualsError] = validatedIdList(body[visualsField], visualsField, MAX_SELECTED_PRODUCT_DOC_IDS,
    (entry) => shapeCheckedId(entry, visualsField));
  if (visualsError) return [null, visualsError];
  const rawTitle = body.title === undefined || body.title === null || body.title === '' ? 'Prototype' : body.title;
  config.title = splitVersionedTitle(stringOr(rawTitle, 'Prototype'))[0];
  config.feedback = stringOr(body.feedback, '').trim();
  return [config, null];
}

function startPrototypeBuild(ctx) {
  const [config, error] = prototypeConfig(ctx);
  if (error) return error;
  return startJob(ctx.projectId, {
    jobType: 'build_prototype', status: 'pending', message: 'Prototype build started.',
    runningStep: 'invoking_bedrock', errorMessage: 'Document generation failed',
    complete: (detail) => {
      const prd = config.prd ? findDocument(detail, config.prd) : newestOfType(detail, 'prd');
      const prfaq = config.prfaq ? findDocument(detail, config.prfaq) : newestOfType(detail, 'prfaq');
      if (!prd && !prfaq) throw new Error('No PRD or PR/FAQ found for this project. Generate at least one first.');
      // Inline HTML (the legacy srcDoc path): the mock has no signed CloudFront URL to mint.
      const doc = addVersionedDocument(ctx.shared, detail, 'prototype', config.title, {
        content: prototypeHtml(config.title, [prd, prfaq].filter(Boolean), config.feedback),
        prototype_format: 'html',
        source_prd_id: prd?.document_id ?? null, source_prfaq_id: prfaq?.document_id ?? null,
        ...(config.feedback ? { revised_from_id: config.base, revision_feedback: config.feedback.slice(0, 2000) } : {}),
      });
      return { document_id: doc.document_id, title: doc.title };
    },
  });
}

// ── Synchronous AI helpers ────────────────────────────────────────────────

function suggestResearchQuestions() {
  return [200, {
    suggestions: [
      { title: 'Delivery estimate trust', question: 'Which delivery-estimate changes cause the most negative reviews, and how early must customers hear about them?' },
      { title: 'Checkout total surprises', question: 'At which checkout step do price or coupon surprises lead customers to abandon their cart?' },
      { title: 'Mobile session friction', question: 'How often do mobile shoppers mention being logged out, and what do they do next?' },
    ],
  }];
}

function suggestDocumentBrief(ctx) {
  const label = ctx.body.doc_type === 'prfaq' ? 'PR-FAQ' : 'PRD';
  return [200, {
    title: 'Proactive Delay Alerts',
    feature_idea: `Notify customers the moment a delivery estimate changes, with the reason and the new date. Feedback shows silent estimate changes drive most negative delivery reviews. Drafted for a ${label}.`,
  }];
}

function autofillPrfaq(ctx) {
  const idea = stringOr(ctx.body.feature_idea, '').trim() || 'this feature';
  return [200, {
    answers: [
      'Frequent online shoppers who plan their day around deliveries.',
      'They learn about delays only after the promised date passes, so they cannot re-plan.',
      `With ${idea}, they hear about a change the moment it happens, with an honest new date.`,
      'Delivery-related reviews and support contacts repeatedly cite silent estimate changes.',
      '',
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
const MAX_BATCH_PINS = 50;
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

function batchPinIds(body) {
  const raw = body.pin_ids;
  if (!Array.isArray(raw) || raw.length === 0) return [null, 'pin_ids must be a non-empty list'];
  if (raw.length > MAX_BATCH_PINS) return [null, `at most ${MAX_BATCH_PINS} pin_ids are allowed`];
  if (!raw.every((p) => typeof p === 'string' && PIN_ID.test(p))) return [null, 'pin_ids holds an invalid pin id'];
  return [[...new Set(raw)], null];
}

function batchPins(ctx, documentId, action) {
  const revision = ctx.body.revision_document_id;
  if (action === 'addressed' && (typeof revision !== 'string' || !PIN_DOCUMENT_ID.test(revision))) {
    return bad('revision_document_id is required');
  }
  const [pins, error] = pinsFor(ctx, documentId);
  if (error) return error;
  const [pinIds, idsError] = batchPinIds(ctx.body);
  if (idsError) return bad(idsError);
  const changed = [];
  const skipped = [];
  for (const pinId of pinIds) {
    const moved = action === 'addressed'
      ? movePin(pins, pinId, 'addressed', ['open'], { addressed_by: revision })
      : movePin(pins, pinId, 'resolved', ['addressed'], {});
    (moved ? changed : skipped).push(pinId);
  }
  return [200, { success: true, changed, skipped }];
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
  { method: 'POST', pattern: /^\/personas$/, body: 'lenient', run: createPersona },
  { method: 'PUT', pattern: /^\/personas\/([^/]+)$/, body: 'lenient', run: updatePersona },
  { method: 'DELETE', pattern: /^\/personas\/([^/]+)$/, run: deletePersona },
  { method: 'POST', pattern: /^\/personas\/([^/]+)\/notes$/, body: 'lenient', run: addPersonaNote },
  { method: 'POST', pattern: /^\/personas\/([^/]+)\/regenerate-avatar$/, run: regeneratePersonaAvatar },

  { method: 'POST', pattern: /^\/research$/, body: 'lenient', run: startResearch },
  { method: 'POST', pattern: /^\/research\/suggest-questions$/, body: 'lenient', run: suggestResearchQuestions },

  { method: 'POST', pattern: /^\/document$/, body: 'object', run: startDocumentGeneration },
  { method: 'POST', pattern: /^\/documents\/merge$/, body: 'object', run: startMerge },
  { method: 'POST', pattern: /^\/documents\/suggest-brief$/, body: 'lenient', run: suggestDocumentBrief },
  { method: 'PUT', pattern: /^\/documents\/([^/]+)$/, body: 'lenient', run: updateDocument },
  { method: 'DELETE', pattern: /^\/documents\/([^/]+)$/, run: deleteDocument },
  { method: 'GET', pattern: /^\/documents\/([^/]+)\/versions$/, run: listDocumentVersions },
  { method: 'POST', pattern: /^\/documents\/([^/]+)\/versions\/([^/]+)\/restore$/, body: 'lenient', run: restoreDocumentVersion },

  { method: 'POST', pattern: /^\/prfaq-autofill$/, body: 'lenient', run: autofillPrfaq },
  { method: 'POST', pattern: /^\/build-prototype$/, body: 'object', run: startPrototypeBuild },

  { method: 'GET', pattern: /^\/prototypes\/([^/]+)\/pins$/, run: listPins },
  { method: 'POST', pattern: /^\/prototypes\/([^/]+)\/pins\/addressed$/, body: 'object', run: (ctx, doc) => batchPins(ctx, doc, 'addressed') },
  { method: 'POST', pattern: /^\/prototypes\/([^/]+)\/pins\/resolve$/, body: 'object', run: (ctx, doc) => batchPins(ctx, doc, 'resolve') },
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

function dispatch(route, { projectId, groups, raw, params, shared }) {
  const detail = shared.mockProjectDetails[projectId];
  if (!detail) return NOT_FOUND;
  const [body, error] = routeBody(route, raw);
  if (error) return error;
  return route.run({ projectId, detail, body, params, shared }, ...groups);
}

/** Handle the project action routes above; returns true when the request was taken. */
export function handleProjectActionRoutes(req, res, url, send, shared) {
  const match = url.pathname.match(PROJECT_PATH);
  if (!match) return false;
  const projectId = safeDecode(match[1]);
  // `/projects/prioritization/...` belongs to mock-server.js, never a project id.
  if (projectId === 'prioritization') return false;
  const rest = match[2];
  const route = ROUTES.find((r) => r.method === req.method && r.pattern.test(rest));
  if (!route) return false;
  const groups = rest.match(route.pattern).slice(1).map(safeDecode);
  if (route.claim && !route.claim(projectId, ...groups)) return false;
  const respond = (raw) => {
    const [status, payload] = dispatch(route, { projectId, groups, raw, params: url.searchParams, shared });
    send(status, payload);
  };
  if (route.body) {
    shared.collectJson(req, res, respond);
  } else {
    respond(null);
  }
  return true;
}
