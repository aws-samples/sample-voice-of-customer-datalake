/**
 * Reader for the projects API's `POST /projects/{project_id}/personas/evidence-pack` (lambda/shared/persona_grounding.py):
 * each persona's cited reviews and the fresh ones that match the topic, as the caller may see them (their category and source access),
 * the stored text already under the source's PII policy. Parsed leniently: an unreadable review is dropped, never
 * fatal; an unreadable answer is an `unavailable` error the focus group fails open on.
 */
import { z } from 'zod';
import type { CallerClaims } from '../../types.js';
import { AssistantToolError } from '../errors.js';
import type { ApiInvoker } from '../internal-api.js';
import { EVIDENCE_PACK_RESOURCE } from '../internal-api.js';
import { parseEach, seg } from './common.js';

const evidenceSchema = z.object({
  feedback_id: z.string().min(1).max(128),
  text: z.string().catch(''),
  verbatim: z.boolean().catch(true),
  source_platform: z.string().catch('unknown'),
  category: z.string().catch('other'),
  sentiment_label: z.string().catch('unknown'),
  date: z.string().catch(''),
});

const personaSchema = z.object({
  persona_id: z.string().min(1),
  evidence: z.array(z.unknown()).catch([]),
});

const bodySchema = z.object({
  personas: z.array(z.unknown()).catch([]),
  missing_persona_ids: z.array(z.string()).catch([]),
});

export type EvidenceItem = z.infer<typeof evidenceSchema>;

interface PersonaEvidence {
  persona_id: string;
  evidence: EvidenceItem[];
}

export interface EvidencePack {
  /** By persona id; a persona the project no longer has is absent (and in `missing`). */
  byPersona: ReadonlyMap<string, PersonaEvidence>;
  missing: string[];
}

interface EvidencePackRequest {
  personaIds: readonly string[];
  question: string;
  limit: number;
}

export async function loadEvidencePack(
  invoke: ApiInvoker, projectId: string, request: EvidencePackRequest, claims: CallerClaims,
): Promise<EvidencePack> {
  const body = await invoke({
    fn: 'projects',
    method: 'POST',
    path: `/projects/${seg(projectId)}/personas/evidence-pack`,
    resource: EVIDENCE_PACK_RESOURCE,
    pathParameters: { project_id: projectId },
    body: { persona_ids: [...request.personaIds], question: request.question.slice(0, 2000), limit: request.limit },
  }, claims);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) throw new AssistantToolError('unavailable', 'The Projects API returned an unreadable evidence pack.');
  const personas = parseEach(personaSchema, parsed.data.personas).map((persona): PersonaEvidence => ({
    persona_id: persona.persona_id,
    evidence: parseEach(evidenceSchema, persona.evidence),
  }));
  return { byPersona: new Map(personas.map((persona) => [persona.persona_id, persona])), missing: parsed.data.missing_persona_ids };
}
