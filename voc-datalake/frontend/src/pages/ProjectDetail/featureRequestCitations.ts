/**
 * @fileoverview Feedback-board requests behind a generated artefact (C5), kept apart from its reviews:
 *
 * - `featureRequestIdsOf` reads the request ids an artefact was written from: a persona's or research
 *   report's `input_feature_request_ids`, a PRD / PR/FAQ's `derivation.input_feature_request_ids`
 *   (≤ 200). Read leniently at runtime (the project schemas keep unknown keys): absent or malformed
 *   reads as none.
 * - `linkFeatureRequestCitations` turns the model's `[FR:<request_id>]` citations in markdown into
 *   links to the request on its board (`/feature-requests?request=<id>`, which opens it there). The
 *   rendered text stays `[FR:<id>]`, so a comment anchored on it still finds it.
 *
 * @module pages/ProjectDetail/featureRequestCitations
 */
import { z } from 'zod'
import { nonBlankStringList } from '../../api/lenientFields'

/** The most request ids an artefact stores (the backend's cap). */
const MAX_FEATURE_REQUEST_IDS = 200

/** A request id as the boards mint it (`fr_<hex>`), loosely: word characters and dashes. */
const REQUEST_ID = String.raw`[A-Za-z0-9_-]{1,64}`
/** `[FR:<id>]` not already followed by a link target. */
const CITATION = new RegExp(String.raw`\[FR:(${REQUEST_ID})\](?!\()`, 'g')

const artefactSchema = z.object({
  input_feature_request_ids: z.unknown().optional(),
  derivation: z.object({ input_feature_request_ids: z.unknown().optional() }).nullable().optional().catch(null),
}).catch({})

/** The distinct request ids `artefact` was written from, in stored order. */
export function featureRequestIdsOf(artefact: unknown): string[] {
  const parsed = artefactSchema.parse(artefact)
  const own = nonBlankStringList.parse(parsed.input_feature_request_ids)
  const derived = nonBlankStringList.parse(parsed.derivation?.input_feature_request_ids)
  return [...new Set([...own, ...derived])].slice(0, MAX_FEATURE_REQUEST_IDS)
}

/** The in-app link that opens one request on its board. */
export function featureRequestHref(requestId: string): string {
  return `/feature-requests?${new URLSearchParams({ request: requestId }).toString()}`
}

/** `markdown` with every `[FR:<id>]` citation linked to its request (the visible text unchanged). */
export function linkFeatureRequestCitations(markdown: string): string {
  return markdown.replace(CITATION, (_match, id: string) => `[\\[FR:${id}\\]](${featureRequestHref(id)})`)
}
