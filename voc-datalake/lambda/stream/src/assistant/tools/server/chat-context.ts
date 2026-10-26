/**
 * Reader for the internal `POST /projects/{project_id}/chat-context` route:
 * project name, persona identity sections, and the FULL content of up to 20
 * selected documents, bounded server-side (413 when too large).
 */
import { z } from 'zod';
import type { CallerClaims } from '../../types.js';
import type { ApiInvoker } from '../internal-api.js';
import { CHAT_CONTEXT_RESOURCE } from '../internal-api.js';
import { AssistantToolError } from '../errors.js';
import { parseProjectAccess, type ProjectAccessSummary } from '../project-access.js';
import { seg } from './common.js';

/** Lenient field: null or a malformed value degrades to absent instead of failing the row. */
function lenient<T>(schema: z.ZodType<T, unknown>) {
  return schema.nullish().catch(null).transform((value): T | undefined => value ?? undefined);
}

const optionalString = lenient(z.string());

const personaSchema = z.object({
  persona_id: z.string().min(1),
  name: optionalString,
  tagline: optionalString,
  avatar_url: optionalString,
  quotes: lenient(z.array(z.unknown())),
  goals_motivations: lenient(z.record(z.string(), z.unknown())),
  pain_points: lenient(z.record(z.string(), z.unknown())),
}).loose();

const documentSchema = z.object({
  sk: z.string().catch(''),
  document_id: z.string().min(1),
  document_type: optionalString,
  title: optionalString,
  version: lenient(z.number()),
  content: optionalString,
}).loose();

export type ChatContextPersona = z.infer<typeof personaSchema>;
export type ChatContextDocument = z.infer<typeof documentSchema>;

export interface ChatContext {
  projectName: string;
  personas: ChatContextPersona[];
  documents: ChatContextDocument[];
  /** The caller's access the route reported (top-level `access`), when readable. */
  access?: ProjectAccessSummary;
}

const bodySchema = z.object({
  project: z.object({ name: optionalString }).loose(),
  personas: z.array(z.unknown()).catch([]),
  documents: z.array(z.unknown()).catch([]),
  access: z.unknown().optional(),
});

function parseEach<T>(schema: z.ZodType<T, unknown>, rows: unknown[]): T[] {
  return rows.flatMap((row) => {
    const parsed = schema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

export async function loadChatContext(
  invoke: ApiInvoker,
  projectId: string,
  selectedDocumentIds: readonly string[],
  claims: CallerClaims,
): Promise<ChatContext> {
  const body = await invoke({
    fn: 'projects',
    method: 'POST',
    path: `/projects/${seg(projectId)}/chat-context`,
    resource: CHAT_CONTEXT_RESOURCE,
    pathParameters: { project_id: projectId },
    body: { selected_document_ids: [...selectedDocumentIds] },
  }, claims);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) throw new AssistantToolError('unavailable', 'The Projects API returned an unreadable project.');
  const access = parseProjectAccess(parsed.data.access);
  return {
    projectName: parsed.data.project.name ?? 'Project',
    personas: parseEach(personaSchema, parsed.data.personas),
    documents: parseEach(documentSchema, parsed.data.documents),
    ...(access ? { access } : {}),
  };
}
