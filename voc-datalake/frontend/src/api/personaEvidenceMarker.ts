/**
 * @fileoverview Lenient boundary for a persona's `evidence` marker (lambda/shared/persona_evidence_marker.py).
 *
 * An imported persona, or a copy, says how many customer reviews stand behind it (`count`; 0 for an
 * import) and where its source's evidence came from (`origin`). A malformed value reads as "no
 * marker" rather than failing the persona it sits on.
 *
 * @module api/personaEvidenceMarker
 */
import { z } from 'zod'

export interface PersonaEvidenceMarker {
  readonly source: 'import' | 'copy'
  readonly count: number
  /** A copy that kept its source persona's reviews. */
  readonly inherited: boolean
  readonly origin: 'generated' | 'import' | 'unknown'
}

const markerObject = z.object({
  source: z.enum(['import', 'copy']),
  count: z.number().int().nonnegative().catch(0),
  inherited: z.boolean().catch(false),
  origin: z.enum(['generated', 'import', 'unknown']).catch('unknown'),
})

/** The persona field: absent or unreadable = undefined. */
export const personaEvidenceMarkerSchema: z.ZodType<PersonaEvidenceMarker | undefined> =
  markerObject.optional().catch(undefined)

/** Which "no customer evidence" note a persona shows, or null when it has evidence (or says nothing). */
export type NoEvidenceKind = 'imported' | 'copiedFromImport' | 'copied'

export function noEvidenceKind(
  marker: PersonaEvidenceMarker | undefined, importedFrom: string | undefined,
): NoEvidenceKind | null {
  if (marker === undefined) {
    // A persona imported before the marker existed: its `imported_from` is the only sign.
    return importedFrom === undefined || importedFrom === '' ? null : 'imported'
  }
  if (marker.count > 0) return null
  if (marker.source === 'import') return 'imported'
  return marker.origin === 'import' ? 'copiedFromImport' : 'copied'
}
