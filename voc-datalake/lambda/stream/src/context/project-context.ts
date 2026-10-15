/**
 * Project Chat context builder.
 * Ported from Python shared/project_chat.py build_chat_context().
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { signCloudFrontUrl } from '../lib/cloudfront-signing.js';
import { NotFoundError } from '../lib/errors.js';
import { buildDocumentsContext, isPrototypeDocument } from './document-context.js';
import { fetchRecentFeedback } from './recent-feedback.js';
import { buildSinglePersonaPrompt } from './persona-prompt.js';
import {
  bulletList,
  personaFrustrations,
  personaGoals,
  personaNeeds,
  personaVoice,
} from './persona-fields.js';
import { getLanguageInstruction } from './language.js';
import type { SupportedLanguage } from './language.js';
import type { ProjectLoader } from './projects-client.js';

// ── Avatar URL helpers ──

const AVATARS_CDN_URL = process.env.AVATARS_CDN_URL ?? '';

/** Convert an S3 URI (s3://bucket/avatars/file.<ext>) to a CloudFront CDN URL. */
function stripTrailingSlashes(value: string): string {
  // Recursive instead of a trailing-slash regex: sonarjs flags /\/+$/ as
  // backtracking-prone, and the input is a short constant env URL.
  return value.endsWith('/') ? stripTrailingSlashes(value.slice(0, -1)) : value;
}

function trustedAvatarCdnUrl(url: string): string | undefined {
  if (!AVATARS_CDN_URL) return undefined;
  try {
    const configured = new URL(stripTrailingSlashes(AVATARS_CDN_URL));
    const candidate = new URL(url);
    const pathPrefix = `${stripTrailingSlashes(configured.pathname)}/`;
    if (
      candidate.origin !== configured.origin
      || !candidate.pathname.startsWith(pathPrefix)
    ) return undefined;
    return candidate.toString();
  } catch {
    return undefined;
  }
}

const CLOUDFRONT_AUTH_PARAMS = ['Expires', 'Signature', 'Key-Pair-Id'];

function hasCurrentCloudFrontSignature(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (CLOUDFRONT_AUTH_PARAMS.some(
      (name) => parsed.searchParams.getAll(name).length !== 1,
    )) return false;
    const expires = Number.parseInt(parsed.searchParams.get('Expires') ?? '', 10);
    return Number.isSafeInteger(expires)
      && expires > Math.floor(Date.now() / 1000)
      && Boolean(parsed.searchParams.get('Signature'))
      && Boolean(parsed.searchParams.get('Key-Pair-Id'));
  } catch {
    return false;
  }
}

function withoutCloudFrontAuth(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    for (const name of CLOUDFRONT_AUTH_PARAMS) parsed.searchParams.delete(name);
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/**
 * Turn an avatar reference into one valid signed CloudFront URL.
 *
 * The canonical Projects API already signs stored S3 avatar references. Keep a
 * current, complete signature unchanged; signing it again would duplicate the
 * reserved auth parameters and invalidate the resource. Legacy unsigned,
 * partial, or expired CDN URLs are stripped of stale auth before re-signing.
 */
async function resolveAvatarUrl(url: string | undefined): Promise<string | undefined> {
  if (!url) return undefined;
  if (!url.startsWith('s3://')) {
    const trustedUrl = trustedAvatarCdnUrl(url);
    if (!trustedUrl) return undefined;
    if (hasCurrentCloudFrontSignature(trustedUrl)) return trustedUrl;
    const unsignedUrl = withoutCloudFrontAuth(trustedUrl);
    return unsignedUrl ? signCloudFrontUrl(unsignedUrl) : undefined;
  }
  const parts = url.split('/');
  const filename = parts[parts.length - 1];
  if (!filename) return undefined;
  const trustedUrl = trustedAvatarCdnUrl(
    `${stripTrailingSlashes(AVATARS_CDN_URL)}/${filename}`,
  );
  return trustedUrl ? signCloudFrontUrl(trustedUrl) : undefined;
}

interface ProjectChatContext {
  systemPrompt: string;
  userMessage: string;
  metadata: Record<string, unknown>;
}

/**
 * DynamoDB stores empty optional attributes as `null`, but the schema below
 * declares fields as `.optional()` (i.e. `string | undefined`), which Zod does
 * NOT treat as nullable. A persona/document persisted with, for example,
 * `avatar_url: null` would therefore fail validation and take down the entire
 * project chat with an opaque "Unknown error". Normalize top-level `null`
 * values to `undefined` before parsing so missing/empty attributes validate
 * cleanly. All downstream reads already default with `?? ...`.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullsToUndefined(raw: unknown): unknown {
  if (!isPlainRecord(raw)) return raw;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = value === null ? undefined : value;
  }
  return out;
}

const projectItemSchema = z.preprocess(nullsToUndefined, z.object({
  sk: z.string().default(''),
  project_id: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  status: z.string().optional(),
  persona_count: z.number().optional(),
  document_count: z.number().optional(),
  filters: z.record(z.unknown()).optional(),
  persona_id: z.string().optional(),
  tagline: z.string().optional(),
  // 🔴 `quote`, `goals`, `frustrations` and `needs` are keys NO writer produces.
  // Stored personas follow `schemas/persona.schema.json`, and this schema omitted
  // `goals_motivations`, `pain_points` and `quotes` entirely — so it STRIPPED the
  // real fields before `buildPersonasContext` and `personaIdentitySection` could
  // read them, and both rendered empty Goals / Frustrations / Needs into the chat
  // and roundtable system prompts. Declaring them here is what makes a reader fix
  // possible at all; the boundary is the fix, per the workspace wire-shape rule.
  // 🪤 Declared as OPAQUE containers, and that is load-bearing rather than lazy.
  //
  // `projectItemSchema.parse()` THROWS, so any leaf declared here becomes a way
  // for one malformed persona to take down the whole chat-context build — which is
  // the exact incident the null-tolerance regression test below was written for.
  // These three sections were previously undeclared, so Zod stripped them and
  // never validated them; naming their inner types would have validated them for
  // the FIRST time, and `nullsToUndefined` is SHALLOW (top-level only), so a
  // `pain_points: {current_challenges: null}` row — DynamoDB stores empty
  // attributes as null — would fail `z.array(z.string()).optional()` and throw.
  //
  // The contents are LLM-authored, so odd shapes are expected, not exceptional.
  // `persona-fields.ts` validates every value it touches (`typeof === 'string'`,
  // `Array.isArray`), which is where the checking belongs per the repo's
  // wire-shape rule: normalize at the reader, never reject the row.
  quotes: z.array(z.unknown()).optional(),
  goals_motivations: z.record(z.unknown()).optional(),
  pain_points: z.record(z.unknown()).optional(),
  behaviors: z.union([
    z.object({
      current_solutions: z.array(z.string()).optional(),
      tools_used: z.array(z.string()).optional(),
      activity_frequency: z.string().optional(),
      tech_savviness: z.string().optional(),
      decision_style: z.string().optional(),
    }).passthrough(),
    z.array(z.string()),
  ]).optional(),
  scenario: z.union([
    z.object({
      title: z.string().optional(),
      narrative: z.string().optional(),
      trigger: z.string().optional(),
      outcome: z.string().optional(),
    }).passthrough(),
    z.string(),
  ]).optional(),
  demographics: z.record(z.unknown()).optional(),
  avatar_url: z.string().optional(),
  document_id: z.string().optional(),
  document_type: z.string().optional(),
  title: z.string().optional(),
  base_title: z.string().optional(),
  version: z.number().int().positive().optional(),
  content: z.string().optional(),
  feature_idea: z.string().optional(),
  question: z.string().optional(),
  created_at: z.string().optional(),
}).passthrough());

export type ProjectItem = z.infer<typeof projectItemSchema>;

// ── Item classification ──

const DOCUMENT_SK_PREFIXES = [
  'DOC#',
  'RESEARCH#',
  'PRD#',
  'PRFAQ#',
  'PRODUCT_REPORT#',
  'PROTOTYPE#',
];

interface ClassifiedItems {
  project: ProjectItem | null;
  personas: ProjectItem[];
  documents: ProjectItem[];
}

function classifyItems(items: ProjectItem[]): ClassifiedItems {
  const result: ClassifiedItems = { project: null, personas: [], documents: [] };
  for (const item of items) {
    const sk = item.sk;
    if (sk === 'META') result.project = item;
    else if (sk.startsWith('PERSONA#')) result.personas.push(item);
    else if (DOCUMENT_SK_PREFIXES.some((prefix) => sk.startsWith(prefix))) {
      result.documents.push(item);
    }
  }
  return result;
}

// ── Persona resolution ──

function resolveActivePersonas(
  personas: ProjectItem[],
  selectedPersonaIds: string[],
  message: string,
): ProjectItem[] {
  const personaMap = new Map(personas.map((p) => [(p.name ?? '').toLowerCase(), p]));
  const selected = personas.filter((p) => selectedPersonaIds.includes(p.persona_id ?? ''));

  const mentionPattern = /@(\w+)/g;
  const mentions: string[] = [];
  for (const m of message.matchAll(mentionPattern)) {
    mentions.push(m[1].toLowerCase());
  }

  const mentioned: ProjectItem[] = [];
  for (const mention of mentions) {
    for (const [name, persona] of personaMap) {
      if (name.includes(mention) && !mentioned.includes(persona)) {
        mentioned.push(persona);
      }
    }
  }

  // Deduplicate
  const activeMap = new Map<string, ProjectItem>();
  for (const p of [...selected, ...mentioned]) {
    activeMap.set(p.persona_id ?? '', p);
  }
  return [...activeMap.values()];
}

// ── Prompt building helpers ──

function buildPersonasContext(personas: ProjectItem[]): string {
  // Read through persona-fields, which knows where these values actually live.
  // This used to read `p.goals` / `p.frustrations` / `p.needs` / `p.quote` —
  // none of which any writer produces — so every section header was rendered
  // with nothing beneath it.
  const sections = personas.map((p) => {
    const taglineSuffix = p.tagline ? ` - ${p.tagline}` : '';
    const parts = [`### ${p.name}${taglineSuffix}`];

    // A header is emitted only when it has content: an empty "**Goals:**" reads
    // to the model as an assertion that the persona has none.
    const voice = personaVoice(p);
    if (voice) parts.push(`**Their voice:** "${voice}"`);

    const goals = personaGoals(p);
    if (goals.length) parts.push(`**Goals:**\n${bulletList(goals)}`);

    const frustrations = personaFrustrations(p);
    if (frustrations.length) parts.push(`**Frustrations:**\n${bulletList(frustrations)}`);

    const needs = personaNeeds(p);
    if (needs.length) parts.push(`**What they need:**\n${bulletList(needs)}`);

    return `\n${parts.join('\n\n')}\n\n---`;
  });
  return `\n## 👤 ACTIVE PERSONAS (Respond from their perspective)\n${sections.join('\n')}`;
}

// ── Feedback fetching ──
// Extracted to recent-feedback.ts (issue #220): the per-day partition walk,
// batching, and failure-visibility logic live there. Covered end-to-end via
// buildProjectChatContext in project-context.test.ts.

// ── System prompt assembly ──

function assembleSystemPrompt(
  projectName: string,
  selectedContent: string,
  activePersonas: ProjectItem[],
  allPersonas: ProjectItem[],
  otherDocsList: string[],
  feedbackSection: string,
  selectedTextDocuments: ProjectItem[],
  documents: ProjectItem[],
  responseLanguage?: SupportedLanguage,
): string {
  const parts: string[] = [
    `You are an AI product research assistant working on the project "${projectName}".\n\n`,
  ];

  if (selectedContent) {
    parts.push(`## REFERENCED DOCUMENTS (Use this content to answer the question)\n${selectedContent}\n`);
  }

  if (activePersonas.length > 0) {
    parts.push(buildPersonasContext(activePersonas));
    const names = activePersonas.map((p) => p.name);
    parts.push(`\n🎯 PERSONA MODE ACTIVE: ${names.join(', ')}\n`);
    parts.push('Respond AS IF you are this persona - use first person ("I think...", "As someone who..."), channel their specific frustrations, goals, and needs.\n\n');
  }

  if (feedbackSection) parts.push(feedbackSection);

  if (otherDocsList.length > 0) {
    parts.push(`## Other Available Documents (not currently referenced)\n${otherDocsList.slice(0, 5).join('\n')}\n\n`);
  }

  if (allPersonas.length > 0 && activePersonas.length === 0) {
    const pNames = allPersonas.slice(0, 5).map((p) => `@${p.name}`);
    parts.push(`## Available Personas (mention with @ to activate)\n${pNames.join(', ')}\n\n`);
  }

  if (selectedTextDocuments.length > 0) {
    const docTitles = selectedTextDocuments.map((document) => document.title);
    parts.push(`📄 IMPORTANT: The user has tagged the document(s): ${docTitles.join(', ')}\n`);
    parts.push('You MUST use the document content provided above to answer their question.\n\n');
  }

  const editableDocuments = documents.filter((document) => !isPrototypeDocument(document));
  const prototypes = documents.filter(isPrototypeDocument);
  if (editableDocuments.length > 0) {
    const editableEntries = editableDocuments.map(
      (document) => `- ${(document.document_type ?? 'doc').toUpperCase()}: ${document.title ?? 'Untitled'} [ID: ${document.document_id ?? ''}]`,
    );
    parts.push('## 🛠️ Document Tools\n');
    parts.push('You can use **update_document** for textual project documents and **create_document** for new custom documents.\n');
    parts.push('Prototype HTML is not editable through update_document; use the prototype revision workflow instead.\n');
    parts.push('Editable textual documents:\n');
    parts.push(`${editableEntries.join('\n')}\n\n`);
  } else {
    parts.push('You can use create_document to create new custom documents when the user asks.\n\n');
  }
  if (prototypes.length > 0) {
    const prototypeEntries = prototypes.map(
      (document) => `- PROTOTYPE: ${document.title ?? 'Untitled'} [ID: ${document.document_id ?? ''}]`,
    );
    parts.push('## Available Prototype Artifacts (metadata only; revise through the prototype workflow)\n');
    parts.push(`${prototypeEntries.join('\n')}\n\n`);
  }

  parts.push('You also have access to the search_feedback tool to look up customer feedback when relevant.\n\n');

  parts.push('Be specific, accurate, and base your response on the provided context.');

  const langInstruction = getLanguageInstruction(responseLanguage);
  if (langInstruction) parts.push(`\n\n${langInstruction}`);

  return parts.join('');
}

// ── Main export ──

export interface RoundtablePersona {
  persona_id: string;
  name: string;
  avatar_url?: string;
  systemPrompt: string;
}

export interface RoundtableContext {
  personas: RoundtablePersona[];
  userMessage: string;
  metadata: Record<string, unknown>;
  selectedDocumentIds: string[];
  documents: ProjectItem[];
}

export async function buildProjectChatContext(
  docClient: DynamoDBDocumentClient,
  loadProject: ProjectLoader,
  feedbackTable: string,
  projectId: string,
  message: string,
  selectedPersonaIds: string[] = [],
  selectedDocumentIds: string[] = [],
  responseLanguage?: SupportedLanguage,
  callerSubject?: string,
): Promise<ProjectChatContext> {
  const rawItems = callerSubject === undefined
    ? await loadProject(projectId, selectedDocumentIds)
    : await loadProject(projectId, selectedDocumentIds, callerSubject);
  if (rawItems.length === 0) {
    throw new NotFoundError('Project not found');
  }

  const items = rawItems.map((raw) => projectItemSchema.parse(raw));
  const { project, personas, documents } = classifyItems(items);

  if (!project) {
    throw new NotFoundError('Project metadata not found');
  }

  const activePersonas = resolveActivePersonas(personas, selectedPersonaIds, message);
  const {
    selectedContent,
    selectedTextDocuments,
    otherDocsList,
  } = buildDocumentsContext(documents, selectedDocumentIds);

  // A selected prototype is metadata, not textual grounding. Fall back to
  // recent feedback whenever no selected textual document supplied content.
  const feedback = selectedTextDocuments.length === 0 && feedbackTable
    ? await fetchRecentFeedback(docClient, feedbackTable)
    : { count: 0, promptSection: '' };

  const systemPrompt = assembleSystemPrompt(
    project.name ?? 'Project',
    selectedContent,
    activePersonas,
    personas,
    otherDocsList,
    feedback.promptSection,
    selectedTextDocuments,
    documents,
    responseLanguage,
  );

  const selectedPersonas = personas.filter((p) => selectedPersonaIds.includes(p.persona_id ?? ''));
  const mentionedPersonas = activePersonas.filter((p) => !selectedPersonaIds.includes(p.persona_id ?? ''));

  const metadata = {
    mentioned_personas: mentionedPersonas.map((p) => p.name),
    selected_personas: selectedPersonas.map((p) => p.name),
    referenced_documents: selectedTextDocuments.map((document) => document.title),
    context: { feedback_count: feedback.count, persona_count: personas.length, document_count: documents.length },
  };

  return { systemPrompt, userMessage: message, metadata };
}


// ── Roundtable ──

export async function buildRoundtableContext(
  docClient: DynamoDBDocumentClient,
  loadProject: ProjectLoader,
  feedbackTable: string,
  projectId: string,
  message: string,
  selectedPersonaIds: string[] = [],
  selectedDocumentIds: string[] = [],
  responseLanguage?: SupportedLanguage,
  callerSubject?: string,
): Promise<RoundtableContext> {
  const rawItems = callerSubject === undefined
    ? await loadProject(projectId, selectedDocumentIds)
    : await loadProject(projectId, selectedDocumentIds, callerSubject);
  if (rawItems.length === 0) throw new NotFoundError('Project not found');

  const items = rawItems.map((raw) => projectItemSchema.parse(raw));
  const { project, personas, documents } = classifyItems(items);
  if (!project) throw new NotFoundError('Project metadata not found');

  // Resolve which personas participate — all selected ones
  const activePersonas = selectedPersonaIds.length > 0
    ? personas.filter((p) => selectedPersonaIds.includes(p.persona_id ?? ''))
    : personas;

  const {
    selectedContent,
    selectedTextDocuments,
    otherDocsList,
  } = buildDocumentsContext(documents, selectedDocumentIds);

  const feedback = selectedTextDocuments.length === 0 && feedbackTable
    ? await fetchRecentFeedback(docClient, feedbackTable)
    : { count: 0, promptSection: '' };

  const selectedTextDocumentIds = selectedTextDocuments
    .map((document) => document.document_id)
    .filter((documentId): documentId is string => typeof documentId === 'string');
  const projectName = project.name ?? 'Project';

  // Build per-persona prompts (initial — no previous responses yet).
  // Avatar signing is a per-persona async call, so map concurrently rather than
  // serially awaiting inside a loop: the signing key is cached after the first
  // one, but the first call still fetches the secret.
  const roundtablePersonas: RoundtablePersona[] = await Promise.all(
    activePersonas.map(async (p) => ({
      persona_id: p.persona_id ?? '',
      name: p.name ?? 'Unknown',
      avatar_url: await resolveAvatarUrl(p.avatar_url),
      systemPrompt: buildSinglePersonaPrompt(
        projectName, p, selectedContent, otherDocsList,
        feedback.promptSection, selectedTextDocumentIds, selectedTextDocuments,
        [], responseLanguage,
      ),
    })),
  );

  const metadata = {
    roundtable: true,
    persona_count: activePersonas.length,
    referenced_documents: selectedTextDocuments.map((document) => document.title),
    context: { feedback_count: feedback.count, persona_count: personas.length, document_count: documents.length },
  };

  return {
    personas: roundtablePersonas,
    userMessage: message,
    metadata,
    selectedDocumentIds: selectedTextDocumentIds,
    documents,
  };
}
