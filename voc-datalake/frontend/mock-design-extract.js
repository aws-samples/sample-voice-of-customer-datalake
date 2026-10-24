// Design-system references that carry an `extracted_design` (wave 12, docs/company-context.md):
// a live-website and a GitHub reference read from a KiroCrew-like brand, the merge the apply route
// performs, and the reference-logo route. Wire shapes follow lambda/api/settings_handler.py:
//   POST /settings/design-system/references/{id}/apply → 200 {draft: {tokens, guidelines, components, logo_candidate}, changes}
//     (NOT saved; 404 unknown reference, 409 not read yet)
//   POST /settings/design-system/references/{id}/logo  → 200 {logo_url} (stored as the logo; 404, 409 no candidate)
// mock-server.js owns the design-system state and passes it in; this module never imports from it.

import { deflateSync } from 'node:zlib';
import { KIROCREW_REPO_COMPONENTS, KIROCREW_SITE_COMPONENTS, mergeComponents } from './mock-design-components.js';

const MAX_TOKENS = 40;
const MAX_GUIDELINES = 20000;
const LOGO_PATH = '/mock-design-logo/kirocrew.png';
// The copy the server downloads at read time (wave 13 `logo.preview_url`), served same-origin.
const LOGO_PREVIEW_PATH = '/mock-design-logo/preview/kirocrew.png';
const LOGO = { source_url: LOGO_PATH, content_type: 'image/png', preview_url: LOGO_PREVIEW_PATH };

const KIROCREW_COLORS = [
  { name: 'primary', value: '#8e48ff' }, { name: 'primary-hover', value: '#a46cff' },
  { name: 'surface', value: '#19161d' }, { name: 'surface-raised', value: '#211d27' },
  { name: 'text', value: '#f4f1f8' }, { name: 'muted', value: '#a59fae' },
  { name: 'border', value: '#352f3d' }, { name: 'success', value: '#3fb68b' },
  { name: 'warning', value: '#e0a43a' }, { name: 'danger', value: '#e5484d' },
  { name: 'info', value: '#7aa3e6' }, { name: 'accent-soft', value: 'rgba(142, 72, 255, 0.15)' },
];

const KIROCREW_TYPE = [
  { role: 'display', family: 'Space Grotesk', size: '48px', weight: '700' },
  { role: 'heading', family: 'Space Grotesk', size: '28px', weight: '600' },
  { role: 'body', family: 'Space Grotesk', size: '15px', weight: '400' },
  { role: 'mono', family: 'JetBrains Mono', size: '13px', weight: '400' },
];

/** A live website read in the secure browser (computed styles + one screenshot). */
export const WEBSITE_REFERENCE = {
  id: 'ref_site', kind: 'website', title: 'kirocrew.dev', url: 'https://kirocrew.dev', status: 'ready',
  extracted_summary: 'Dark, high-contrast site: purple accent on near-black surfaces, Space Grotesk headings, JetBrains Mono for code.',
  extracted_design: {
    colors: KIROCREW_COLORS.slice(0, 8),
    typography: KIROCREW_TYPE.filter((row) => row.role !== 'display'),
    spacing: [{ name: 'sm', value: '8px' }, { name: 'md', value: '16px' }, { name: 'lg', value: '24px' }],
    radius: [{ name: 'card', value: '12px' }, { name: 'button', value: '8px' }],
    guidelines_md: '- Purple is the one accent: primary buttons and links only.\n- Near-black surfaces, raised cards one step lighter.\n- Headings in Space Grotesk; code and ids in JetBrains Mono.',
    components: KIROCREW_SITE_COMPONENTS,
    logo: LOGO,
    source: 'computed_styles',
  },
};

/** A GitHub repository read from its theme files (design-tokens.css, tailwind-theme.css …). */
export const GITHUB_REFERENCE = {
  id: 'ref_kirocrew', kind: 'github', title: 'KiroCrew repository', url: 'https://github.com/kirodotdev/KiroCrew', status: 'ready',
  extracted_summary: 'Tokens read from website/src/styles/design-tokens.css and tailwind-theme.css; five ui components (button, card, input, badge, tabs) with their variants.',
  extracted_design: {
    colors: KIROCREW_COLORS,
    typography: KIROCREW_TYPE,
    spacing: [{ name: 'xs', value: '4px' }, { name: 'sm', value: '8px' }, { name: 'md', value: '16px' }, { name: 'lg', value: '24px' }],
    radius: [{ name: 'sm', value: '4px' }, { name: 'md', value: '8px' }, { name: 'card', value: '12px' }, { name: 'pill', value: '9999px' }],
    guidelines_md: '## Voice\nShort, direct, no exclamation marks.\n\n## Layout\n- One primary action per card.\n- Tabs as a top rail, never nested.\n\n## Do and don’t\n- Do use the purple accent sparingly.\n- Don’t use red for anything but errors.',
    components: KIROCREW_REPO_COMPONENTS,
    logo: LOGO,
    source: 'repo_files',
  },
};

/** A pending website reference becomes ready (with the website design) after this many reads. */
const READS_UNTIL_READY = 2;
const pendingReads = new Map();

const absolute = (host, path) => (path.startsWith('/') ? `http://${host}${path}` : path);

/** Logo URLs as the API sends them: absolute (the SPA reads source_url with z.url()). */
function publicLogo(logo, host) {
  if (!logo) return null;
  const preview = logo.preview_url ? { preview_url: absolute(host, logo.preview_url) } : {};
  return { ...logo, source_url: absolute(host, logo.source_url), ...preview };
}

function publicReference(reference, host) {
  const logo = reference.extracted_design?.logo;
  if (!logo) return reference;
  return { ...reference, extracted_design: { ...reference.extracted_design, logo: publicLogo(logo, host) } };
}

/** Moves a just-added link reference along: pending → ready after a few GETs, like the worker. */
function advancePending(reference) {
  if (reference.status !== 'pending' || !reference.url) return;
  const reads = (pendingReads.get(reference.id) ?? 0) + 1;
  pendingReads.set(reference.id, reads);
  if (reads < READS_UNTIL_READY) return;
  const template = reference.kind === 'github' ? GITHUB_REFERENCE : WEBSITE_REFERENCE;
  Object.assign(reference, { status: 'ready', extracted_summary: template.extracted_summary, extracted_design: template.extracted_design });
}

/** GET /settings/design-system: logo candidates as absolute URLs (the SPA reads them with z.url()). */
export function publicDesignSystem(designSystem, host) {
  designSystem.references.forEach(advancePending);
  return { ...designSystem, references: designSystem.references.map((reference) => publicReference(reference, host)) };
}

function mergeByKey(current, incoming, key) {
  const merged = [...current];
  for (const row of incoming) {
    const at = merged.findIndex((existing) => existing[key] === row[key]);
    if (at >= 0) merged[at] = row;
    else if (merged.length < MAX_TOKENS) merged.push(row);
  }
  return merged;
}

// Components are first-class since wave 13: only the reference's guidelines_md is appended.
function mergedGuidelines(current, reference) {
  const body = reference.extracted_design.guidelines_md.trim();
  if (!body) return current;
  const next = current.trim() ? `${current.trimEnd()}\n\n## From ${reference.title}\n\n${body}` : body;
  return next.slice(0, MAX_GUIDELINES);
}

/** THE CONTRACT merge: same name / role replaced, new appended (≤ 40 per group, ≤ 30 components), guidelines appended. */
export function mergeDesignDraft(designSystem, reference) {
  const { tokens } = designSystem;
  const design = reference.extracted_design;
  return {
    tokens: {
      colors: mergeByKey(tokens.colors, design.colors, 'name'),
      typography: mergeByKey(tokens.typography, design.typography, 'role'),
      spacing: mergeByKey(tokens.spacing, design.spacing, 'name'),
      radius: mergeByKey(tokens.radius, design.radius, 'name'),
    },
    guidelines: mergedGuidelines(designSystem.guidelines, reference),
    components: mergeComponents(designSystem.components ?? [], design.components ?? []),
    logo_candidate: design.logo ?? null,
  };
}

const notReadYet = [409, { success: false, error: 'This reference has not been read yet — wait until it shows Ready.' }];

function applyReference(designSystem, reference, host) {
  if (reference.status !== 'ready' || !reference.extracted_design) return notReadYet;
  const draft = mergeDesignDraft(designSystem, reference);
  return [200, { draft: { ...draft, logo_candidate: publicLogo(draft.logo_candidate, host) }, changes: { components: componentChanges(designSystem.components ?? [], reference.extracted_design.components ?? []) } }];
}

/** `changes.components = {added, replaced}` as the API reports it. */
function componentChanges(current, incoming) {
  const saved = new Set(current.map((c) => c.name.trim().toLowerCase()));
  const replaced = incoming.filter((c) => saved.has(c.name.trim().toLowerCase())).length;
  return { added: incoming.length - replaced, replaced };
}

function adoptLogo(designSystem, reference, host) {
  const logo = reference.extracted_design?.logo;
  if (!logo) return [409, { success: false, error: 'This reference has no logo to use.' }];
  designSystem.logo_url = absolute(host, logo.source_url);
  designSystem.updated_at = new Date().toISOString();
  return [200, { logo_url: designSystem.logo_url }];
}

const ACTION_ROUTE = /^\/settings\/design-system\/references\/([^/]+)\/(apply|logo)$/;

/** The two admin routes, or null when the path is not one of them. */
export function routeDesignExtract(req, url, designSystem) {
  const match = url.pathname.match(ACTION_ROUTE);
  if (!match) return null;
  if (req.method !== 'POST') return [405, { success: false, error: 'Method not allowed' }];
  const reference = designSystem.references.find((r) => r.id === decodeURIComponent(match[1]) && r.status !== 'archived');
  if (!reference) return [404, { success: false, error: 'Reference not found' }];
  const host = req.headers.host;
  return match[2] === 'apply' ? applyReference(designSystem, reference, host) : adoptLogo(designSystem, reference, host);
}

// ── A generated 64×64 PNG for the logo candidate (a purple tile with a light square). ──

const crcStep = (c) => (c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1);
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => Array.from({ length: 8 }).reduce(crcStep, n) >>> 0);

function crc32(buffer) {
  const crc = buffer.reduce((acc, byte) => CRC_TABLE[(acc ^ byte) & 0xff] ^ (acc >>> 8), 0xffffffff);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function logoPng() {
  const size = 64;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const rows = Array.from({ length: size }, (_, y) => Buffer.from([0, ...Array.from({ length: size }, (_, x) => {
    const inner = x > 20 && x < 44 && y > 20 && y < 44;
    return inner ? [244, 241, 248] : [142, 72, 255];
  }).flat()]));
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const logoCache = {};

/** Serves the candidate image (built once); true when it handled the request. */
export function serveMockLogo(req, res, url) {
  if (req.method !== 'GET' || (url.pathname !== LOGO_PATH && url.pathname !== LOGO_PREVIEW_PATH)) return false;
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
  logoCache.png ??= logoPng();
  res.end(logoCache.png);
  return true;
}
