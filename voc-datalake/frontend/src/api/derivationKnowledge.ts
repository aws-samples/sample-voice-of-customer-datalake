/**
 * @fileoverview The company knowledge a document's `derivation` records: which
 * COMPANY memories reached the prompt, how many public web searches ran, and
 * whether the company context (vision and company objectives) was included —
 * and, for a prototype, whether the company design system was read
 * (`design_system_included`: true read, false the build was told not to, absent
 * none configured or a build from before the option, read here as null).
 *
 * Written by every shared generator through `shared.job_knowledge` (research,
 * PR/FAQ, PRD, prototypes, personas); each key is written only when non-empty,
 * so a document built before these keys existed — or without any company
 * knowledge — reads as "none" here. Lenient at the boundary like
 * `api/derivation.ts`: a malformed value degrades to the empty answer and never
 * rejects the document.
 *
 * Kept apart from `normalizeDerivation` on purpose: those keys say what the
 * document was built FROM (documents, feedback, personas), these say what
 * background it was given, and `resolveDerivation`'s exact shape is pinned by
 * its own tests.
 *
 * @module api/derivationKnowledge
 */
import { z } from 'zod'
import { toCount } from './derivation'
import { isNonEmptyString, lenientList } from './lenientFields'
import { asRecord } from './wireRecord'

export interface DerivationKnowledge {
  /** COMPANY memory ids only — personal memories never reach a shared document. */
  memory_ids: string[]
  web_search_count: number
  company_context_included: boolean
  /** Prototypes: true read, false opted out, null not recorded. */
  design_system_included: boolean | null
}

const NO_KNOWLEDGE: DerivationKnowledge = {
  memory_ids: [], web_search_count: 0, company_context_included: false, design_system_included: null,
}

const KnowledgeSchema = z
  .object({
    memory_ids: lenientList(isNonEmptyString),
    // `.optional()` is load-bearing: the key is written only when > 0, and under Zod 4 a
    // bare `z.unknown()` rejects an ABSENT key, which tripped the object-level catch and
    // dropped every other key (company context, memories) of most documents.
    web_search_count: z.unknown().optional().transform(toCount),
    company_context_included: z.boolean().catch(false),
    design_system_included: z.boolean().nullable().optional().transform((value) => value ?? null).catch(null),
  })
  .catch(() => ({ ...NO_KNOWLEDGE }))

/** What company knowledge `document.derivation` records (total: any input yields an answer). */
export function derivationKnowledge(document: unknown): DerivationKnowledge {
  const derivation = asRecord(asRecord(document)?.derivation)
  return derivation ? KnowledgeSchema.parse(derivation) : { ...NO_KNOWLEDGE }
}

