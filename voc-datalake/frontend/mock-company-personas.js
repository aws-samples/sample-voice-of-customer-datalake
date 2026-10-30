// Company persona library mocks (5.60, Knowledge → Company → Personas): `/company-personas`
// and the project-side copy routes `/projects/{id}/personas/{pid}/promote`,
// `/projects/{id}/personas/copy-sources` and `/projects/{id}/personas/copy`.
//
// The library is a reserved persona container (`company_personas`), as on the real API:
// generate / import / jobs / persona writes / avatar are the project persona routes of
// mock-project-actions.js run on that container (registerPersonaContainer), and every
// `/projects/company_personas/...` route is a 404. Generation is always additive.
// Copies are independent (new ids) and never carry research notes; `copied_from` says
// where each came from. The mock caller is the admin of mock-server.js (`can_edit: true`).
// Stateful for the life of the mock process. Wired into mock-server.js by
// handleDomainModules; project fixtures and sharing come through `shared`.

import { randomBytes } from 'node:crypto';
import { registerPersonaContainer, serveContainerRoute } from './mock-project-actions.js';

const CONTAINER_ID = 'company_personas';
const MAX_COPY = 20;
const MAX_SOURCE_PROJECTS = 100;

const nowIso = () => new Date().toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const cloneJson = (value) => JSON.parse(JSON.stringify(value));
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const newPersonaId = () => `persona_${randomBytes(6).toString('hex')}`;

const library = {
  project: {
    project_id: CONTAINER_ID, kind: 'company_personas', name: 'Company personas', visibility: 'private',
    owner_sub: 'system:company', persona_count: 2, created_at: daysAgo(30), updated_at: daysAgo(2),
  },
  personas: [
    {
      persona_id: 'cpersona_1', name: 'Frequent-Flyer Farah', tagline: 'Books Example Air every month for work',
      created_at: daysAgo(30), updated_at: daysAgo(30), confidence: 'high', feedback_count: 18,
      identity: { age_range: '35-44', occupation: 'Regional sales lead', bio: 'Lives out of a carry-on and plans trips on her phone.' },
      goals_motivations: { primary_goal: 'Change a flight in under a minute', secondary_goals: ['Keep her loyalty status'] },
      pain_points: { current_challenges: ['Rebooking after a delay takes several screens'], emotional_impact: 'Stressed when plans move' },
      quotes: [{ text: 'When my meeting moves, my flight should move with two taps.', context: 'App review' }],
      research_notes: [],
    },
    {
      persona_id: 'cpersona_2', name: 'First-Trip Felix', tagline: 'Flying Example Air for the first time',
      created_at: daysAgo(2), updated_at: daysAgo(2), confidence: 'medium', feedback_count: 7,
      identity: { age_range: '18-24', occupation: 'Student', bio: 'Booked a holiday with friends and wants no surprises.' },
      goals_motivations: { primary_goal: 'Know exactly what the fare includes' },
      pain_points: { current_challenges: ['Baggage rules are hard to find'], emotional_impact: 'Anxious before the trip' },
      quotes: [{ text: 'I just want to know if my bag is included before I pay.', context: 'Survey' }],
      research_notes: [],
      copied_from: { scope: 'project', project_id: 'proj_2', project_name: 'Mobile App Redesign', persona_id: 'persona_3', copied_at: daysAgo(2), copied_by: 'sub-admin-demo' },
    },
  ],
  documents: [],
};
registerPersonaContainer(CONTAINER_ID, library);

// The contract's error envelope is `{success: false, message}` (like projects_handler).
const notFound = (message) => [404, { success: false, message }];
const bad = (message) => [400, { success: false, message }];
const findIn = (detail, personaId) => detail.personas.find((p) => p.persona_id === personaId);
const newestFirst = (personas) => [...personas].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

function decode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** A copy of `persona` for `target`: new id, no research notes, `copied_from` replaced. */
function copyOf(persona, target, copiedFrom) {
  const taken = (id) => Boolean(findIn(target, id));
  let personaId = newPersonaId();
  while (taken(personaId)) personaId = newPersonaId();
  const at = nowIso();
  return { ...cloneJson(persona), persona_id: personaId, research_notes: [], created_at: at, updated_at: at, copied_from: copiedFrom };
}

function addPersonas(target, personas) {
  target.personas.push(...personas);
  target.project.persona_count = target.personas.length;
  target.project.updated_at = nowIso();
}

const summary = (p) => ({
  persona_id: p.persona_id, name: p.name ?? '', tagline: p.tagline ?? '', avatar_url: p.avatar_url ?? null,
  ...(p.copied_from ? { copied_from: p.copied_from } : {}),
});

/** Owner or member (any role) of a project: the only projects the caller may copy from. */
function callerBelongs(shared, projectId) {
  const meta = shared.mockProjectSharing[projectId];
  const sub = shared.mockCaller.sub;
  return Boolean(meta) && (meta.owner_sub === sub || Boolean(meta.members?.[sub]));
}

// ── /company-personas ───────────────────────────────────────────────────────

/** The container route a library path maps onto (`/generate` → `/personas/generate`, …). */
function containerPath(rest) {
  if (rest === '/generate' || rest === '/import') return `/personas${rest}`;
  if (rest.startsWith('/jobs')) return rest;
  return `/personas${rest}`;
}

function handleLibrary(req, res, url, send, shared) {
  const rest = url.pathname.slice('/company-personas'.length);
  if (rest === '' && req.method === 'GET') {
    send(200, { success: true, personas: newestFirst(library.personas), can_edit: shared.mockCaller.isAdmin === true });
    return true;
  }
  const personaMatch = rest.match(/^\/([^/]+)(\/notes|\/regenerate-avatar)?$/);
  const isPersonaRoute = personaMatch && !['generate', 'import', 'jobs'].includes(personaMatch[1]);
  if (isPersonaRoute && !findIn(library, decode(personaMatch[1]))) {
    send(...notFound('Persona not found'));
    return true;
  }
  const bodyPatch = rest === '/generate' ? { keep_existing_personas: true } : undefined;
  const served = serveContainerRoute(req, res, {
    containerId: CONTAINER_ID, rest: containerPath(rest), params: url.searchParams, send, shared, bodyPatch,
  });
  if (!served && /^\/jobs\/[^/]+$/.test(rest)) {
    send(...notFound('Job not found'));
    return true;
  }
  return served;
}

// ── /projects/{id}/personas/(promote|copy-sources|copy) ─────────────────────

function promote(shared, projectId, personaId) {
  const detail = shared.mockProjectDetails[projectId];
  if (!detail) return notFound('Project not found');
  if (shared.mockCaller.isAdmin !== true) return [403, { success: false, message: 'Only administrators can promote personas' }];
  const persona = findIn(detail, personaId);
  if (!persona) return notFound('Persona not found');
  const copy = copyOf(persona, library, {
    scope: 'project', project_id: projectId, project_name: detail.project.name ?? '',
    persona_id: personaId, copied_at: nowIso(), copied_by: shared.mockCaller.sub,
  });
  addPersonas(library, [copy]);
  return [201, { success: true, persona: copy }];
}

function copySources(shared, projectId) {
  if (!shared.mockProjectDetails[projectId]) return notFound('Project not found');
  const projects = Object.values(shared.mockProjectDetails)
    .filter((d) => d.project.project_id !== projectId && d.personas.length > 0 && callerBelongs(shared, d.project.project_id))
    .map((d) => ({ project_id: d.project.project_id, name: d.project.name ?? '', persona_count: d.personas.length }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_SOURCE_PROJECTS);
  return [200, { success: true, company: newestFirst(library.personas).map(summary), projects }];
}

/** The copy source as `[error]` (a 400 / 404 answer) or `[null, sourceDetail, copiedFromBase]`. */
function copySource(shared, projectId, source) {
  if (!isPlainObject(source)) return [bad('source must be an object')];
  if (source.scope === 'company') return [null, library, { scope: 'company' }];
  if (source.scope !== 'project' || typeof source.project_id !== 'string' || source.project_id === '') {
    return [bad("source.scope must be 'company' or 'project' with a project_id")];
  }
  if (source.project_id === projectId) return [bad('Choose another project to copy from')];
  const detail = shared.mockProjectDetails[source.project_id];
  if (!detail || !callerBelongs(shared, source.project_id)) return [notFound('Source project not found')];
  return [null, detail, { scope: 'project', project_id: source.project_id, project_name: detail.project.name ?? '' }];
}

function validIds(ids) {
  return Array.isArray(ids) && ids.length >= 1 && ids.length <= MAX_COPY
    && ids.every((id) => typeof id === 'string' && id !== '') && new Set(ids).size === ids.length;
}

function copyPersonas(shared, projectId, body) {
  const target = shared.mockProjectDetails[projectId];
  if (!target) return notFound('Project not found');
  if (!isPlainObject(body) || !validIds(body.persona_ids)) return bad(`persona_ids must be 1-${MAX_COPY} unique non-empty strings`);
  const [error, source, base] = copySource(shared, projectId, body.source);
  if (error) return error;
  const originals = body.persona_ids.map((id) => findIn(source, id));
  if (originals.some((p) => !p)) return notFound('Persona not found in the source');
  const copies = originals.map((p) => copyOf(p, target, { ...base, persona_id: p.persona_id, copied_at: nowIso(), copied_by: shared.mockCaller.sub }));
  addPersonas(target, copies);
  return [201, { success: true, personas: copies }];
}

function handleProjectSide(req, res, url, send, shared) {
  const match = url.pathname.match(/^\/projects\/([^/]+)\/personas\/(copy-sources|copy|[^/]+\/promote)$/);
  if (!match) return false;
  const projectId = decode(match[1]);
  const action = match[2];
  if (action === 'copy-sources' && req.method === 'GET') {
    send(...copySources(shared, projectId));
    return true;
  }
  if (req.method !== 'POST') return false;
  if (action === 'copy') {
    shared.collectJson(req, res, (body) => send(...copyPersonas(shared, projectId, body)));
    return true;
  }
  if (action.endsWith('/promote')) {
    send(...promote(shared, projectId, decode(action.slice(0, -'/promote'.length))));
    return true;
  }
  return false;
}

/** Handle the company persona routes; returns true when the request was taken. */
export function handleCompanyPersonaRoutes(req, res, url, send, shared) {
  if (url.pathname === '/company-personas' || url.pathname.startsWith('/company-personas/')) {
    return handleLibrary(req, res, url, send, shared);
  }
  return handleProjectSide(req, res, url, send, shared);
}
