/**
 * `GET /projects/{id}` (whole raw items) → compact, content-free overviews.
 */
import { z } from 'zod';
import { AssistantToolError } from '../errors.js';
import { pick, withinBudget } from '../format.js';
import { parseProjectAccess, type ProjectAccessSummary } from '../project-access.js';
import { recordsAt } from './feedback-shape.js';

const projectBodySchema = z.object({ project: z.record(z.string(), z.unknown()) }).loose();

export interface ProjectPayload {
  project: Record<string, unknown>;
  personas: Record<string, unknown>[];
  documents: Record<string, unknown>[];
}

export function parseProjectPayload(body: unknown): ProjectPayload {
  const parsed = projectBodySchema.safeParse(body);
  if (!parsed.success) throw new AssistantToolError('unavailable', 'The Projects API returned an unreadable project.');
  return {
    project: parsed.data.project,
    personas: recordsAt(body, 'personas'),
    documents: recordsAt(body, 'documents'),
  };
}

const PROJECT_FIELDS = [
  'project_id', 'name', 'description', 'status', 'visibility', 'created_at', 'updated_at', 'persona_count',
  'document_count',
] as const;

const PERSONA_OVERVIEW_FIELDS = ['persona_id', 'name', 'tagline', 'confidence'] as const;

/** Persona fields get_persona returns (storage keys, avatar prompts and URLs excluded). */
export const PERSONA_DETAIL_FIELDS = [
  'persona_id', 'name', 'tagline', 'confidence', 'identity', 'goals_motivations', 'pain_points', 'behaviors',
  'context_environment', 'quotes', 'scenario', 'research_notes', 'created_at', 'updated_at',
] as const;

const DOCUMENT_FIELDS = ['document_id', 'document_type', 'title', 'version', 'created_at', 'updated_at'] as const;

export function isPrototype(document: Record<string, unknown>): boolean {
  return document.document_type === 'prototype'
    || (typeof document.sk === 'string' && document.sk.startsWith('PROTOTYPE#'));
}

/** What renderDocument reads of a chat-context document. */
interface RenderableDocument extends Record<string, unknown> {
  document_id: string;
  document_type?: string;
  title?: string;
  content?: string;
}

/** One document's text for the model (get_documents, the persona round), cut to `share` characters. */
export function renderDocument(document: RenderableDocument, share: number): string {
  const header = `## ${document.title ?? 'Untitled'} (${(document.document_type ?? 'doc').toUpperCase()}) [ID: ${document.document_id}]`;
  if (isPrototype(document)) {
    return `${header}\nPrototype HTML is not available as text.`;
  }
  if (document.content === undefined) return `${header}\n(No text content.)`;
  return `${header}\n\n${withinBudget(document.content, share)}`;
}

function documentOverview(document: Record<string, unknown>): Record<string, unknown> {
  const overview = pick(document, DOCUMENT_FIELDS, 200);
  if (isPrototype(document)) return { ...overview, prototype: true };
  const content = document.content;
  return { ...overview, content_chars: typeof content === 'string' ? content.length : 0 };
}

export interface ProjectSummary {
  /** The caller's access (first, so a size cut never drops it); absent when the API did not report it. */
  access?: ProjectAccessSummary;
  project: Record<string, unknown>;
  personas: Record<string, unknown>[];
  documents: Record<string, unknown>[];
}

export function summarizeProject(body: unknown): ProjectSummary {
  const payload = parseProjectPayload(body);
  const access = parseProjectAccess(payload.project.access);
  return {
    ...(access ? { access } : {}),
    project: pick(payload.project, PROJECT_FIELDS, 1000),
    personas: payload.personas.map((persona) => pick(persona, PERSONA_OVERVIEW_FIELDS, 300)),
    documents: payload.documents.map(documentOverview),
  };
}
