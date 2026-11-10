// Dev-mock mirror of lambda/shared/methodology.py and lambda/shared/workflow_methodology.py
// (docs/project-workspace.md → Methodology). Pure helpers, like mock-legal-basis.js: the routes
// that carry the block call them (GET /projects/{id} and POST /projects/{id}/documents in
// mock-server.js, the research / document / build-prototype jobs in mock-project-actions.js,
// POST /workflows/validate in mock-server.js). Same shapes, codes and English messages as the
// real modules; the SPA renders by code.

const STEPS = ['personas', 'research', 'prfaq', 'prd', 'prototype'];
const UPSTREAM = {
  personas: [], research: ['personas'], prfaq: ['feedback', 'personas'],
  prd: ['feedback', 'personas', 'prfaq'], prototype: ['prd', 'prfaq'],
};
const LABEL = {
  feedback: 'customer feedback', personas: 'personas', research: 'research',
  prfaq: 'a PR/FAQ', prd: 'a PRD', prototype: 'a prototype',
};
export const NO_SOURCE_MESSAGE = 'No PRD or PR/FAQ found for this project. Generate at least one first.';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Per artifact step, the ids the project holds (methodology.present_steps). */
function present(detail) {
  const docs = detail?.documents ?? [];
  const idsOf = (type) => docs.filter((d) => d.document_type === type).map((d) => d.document_id);
  return {
    personas: (detail?.personas ?? []).map((p) => p.persona_id),
    research: idsOf('research'), prfaq: idsOf('prfaq'), prd: idsOf('prd'), prototype: idsOf('prototype'),
  };
}

/** GET /projects/{id} → `methodology` (methodology.overview). */
export function projectMethodology(detail) {
  const have = present(detail);
  const steps = Object.fromEntries(STEPS.map((step) => [step, {
    missing: UPSTREAM[step].filter((u) => u !== 'feedback' && have[u].length === 0), count: have[step].length,
  }]));
  steps.prototype.blocked = have.prd.length === 0 && have.prfaq.length === 0;
  return { order: STEPS, steps };
}

function skipWarning(step, upstream, reason) {
  const lead = `This ${LABEL[step].replace(/^a /, '')} is made without ${LABEL[upstream]}`;
  return reason === 'missing'
    ? { code: 'missing_upstream', step: upstream, message: `${lead}: the project has none yet.` }
    : { code: 'upstream_not_selected', step: upstream, message: `${lead}: it was not selected.` };
}

/** methodology.assess: `used[upstream] === false` = present but not read by the request. */
export function generationMethodology(detail, step, used = {}, { evidence = null, extraWarnings = [] } = {}) {
  const have = present(detail);
  const skipped = [];
  for (const upstream of UPSTREAM[step] ?? []) {
    if (upstream !== 'feedback' && have[upstream].length === 0) skipped.push({ step: upstream, reason: 'missing' });
    else if (used[upstream] === false) skipped.push({ step: upstream, reason: 'not_selected' });
  }
  const warnings = [...skipped.map((s) => skipWarning(step, s.step, s.reason)), ...extraWarnings];
  if (evidence === 0 && !warnings.some((w) => w.code === 'no_evidence')) {
    warnings.push({ code: 'no_evidence', message: 'No customer feedback reached this document: it cites no evidence.' });
  }
  return { step, skipped, warnings, evidence };
}

/** What a PR/FAQ / PRD request reads (methodology.data_source_use; feedback defaults ON). */
export function documentRequestUse(detail, body) {
  const sources = isObject(body?.data_sources) ? body.data_sources : {};
  const selected = Array.isArray(body?.selected_document_ids) ? body.selected_document_ids : [];
  const prfaqIds = new Set(present(detail).prfaq);
  const readsDocuments = Boolean(sources.documents || sources.research);
  return {
    feedback: sources.feedback !== false,
    personas: Boolean(sources.personas),
    prfaq: readsDocuments && (selected.length === 0 || selected.some((id) => prfaqIds.has(id))),
  };
}

/** True when a prototype build has no source (POST /build-prototype answers 409 before any job). */
export const prototypeBlocked = (detail) => projectMethodology(detail).steps.prototype.blocked;

/** A hand-written PR/FAQ / PRD (methodology.human_document). */
export const humanMethodology = (step) => ({
  step, skipped: [],
  warnings: [{ code: 'no_evidence', message: 'Written by hand: this document cites no customer feedback yet.' }],
  evidence: 0,
});

// shared/persona_evidence_marker.py: an imported or copied persona's evidence marker.
const PERSONA_NO_EVIDENCE = {
  import: 'Imported persona: it is not based on customer feedback.',
  copy: 'Copied from a persona that is not based on customer feedback.',
};
const idList = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v !== '') : []);
const personaReviewCount = (p) => idList(p?.input_feedback_ids).length || idList(p?.evidence_feedback_ids).length;
const personaBlock = (source, count) => ({
  step: 'personas', skipped: [], evidence: count,
  warnings: count ? [] : [{ code: 'no_evidence', message: PERSONA_NO_EVIDENCE[source] }],
});

function personaOrigin(source) {
  if (personaReviewCount(source) > 0) return 'generated';
  const marker = source?.evidence;
  const origin = marker?.source === 'copy' ? marker?.origin : marker?.source;
  if (origin === 'generated' || origin === 'import') return origin;
  return source?.imported_from ? 'import' : 'unknown';
}

/** persona_evidence_marker.imported(): the fields an imported persona stores. */
export const importedPersonaMarker = () => ({
  evidence: { source: 'import', count: 0, inherited: false, origin: 'import' },
  methodology: personaBlock('import', 0),
});

/** persona_evidence_marker.import_start(): the block an import START answers. */
export const importStartMethodology = () => personaBlock('import', 0);

/** persona_evidence_marker.copied(source): the fields a copy stores (never invented). */
export function copiedPersonaMarker(source) {
  const count = personaReviewCount(source);
  return {
    evidence: { source: 'copy', count, inherited: count > 0, origin: personaOrigin(source) },
    methodology: personaBlock('copy', count),
  };
}

const EVIDENCE_KINDS = ['aggregate_reviews', 'deep_research'];
const PERSONA_KINDS = ['select_personas', 'generate_personas'];
const WORKFLOW_RULES = {
  write_prfaq: [
    ['no_upstream_evidence', EVIDENCE_KINDS, 'This PR/FAQ step has no customer evidence before it (aggregate reviews or deep research).'],
    ['no_upstream_personas', PERSONA_KINDS, 'This PR/FAQ step has no personas step before it.'],
  ],
  write_prd: [
    ['no_upstream_evidence', EVIDENCE_KINDS, 'This PRD step has no customer evidence before it (aggregate reviews or deep research).'],
    ['no_upstream_personas', PERSONA_KINDS, 'This PRD step has no personas step before it.'],
    ['no_upstream_prfaq', ['write_prfaq'], 'This PRD step has no PR/FAQ step before it: the methodology writes the PR/FAQ first.'],
  ],
  build_prototype: [
    ['no_upstream_document', ['write_prfaq', 'write_prd'], 'This prototype step has no PR/FAQ or PRD step before it.'],
  ],
};

function ancestors(nodeId, backward) {
  const seen = new Set();
  const queue = [...(backward.get(nodeId) ?? [])];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!seen.has(current)) {
      seen.add(current);
      queue.push(...(backward.get(current) ?? []));
    }
  }
  return seen;
}

/** POST /workflows/validate → `warnings` for a valid definition (workflow_methodology.methodology_warnings). */
export function workflowMethodologyWarnings(definition) {
  const nodes = Array.isArray(definition?.nodes) ? definition.nodes : [];
  const types = new Map(nodes.filter(isObject).map((n) => [n.id, n.type]));
  const backward = new Map([...types.keys()].map((id) => [id, []]));
  for (const edge of Array.isArray(definition?.edges) ? definition.edges : []) {
    if (isObject(edge) && types.has(edge.source) && types.has(edge.target)) backward.get(edge.target).push(edge.source);
  }
  const warnings = [];
  for (const [nodeId, type] of types) {
    const upstream = new Set([...ancestors(nodeId, backward)].map((id) => types.get(id)));
    for (const [code, kinds, message] of WORKFLOW_RULES[type] ?? []) {
      if (!kinds.some((kind) => upstream.has(kind))) warnings.push({ code, message, node_id: nodeId });
    }
  }
  return warnings;
}
