/**
 * @fileoverview What a document was made without, as the server recorded it on the document
 * (`methodology`, lambda/shared/methodology.py, docs/project-workspace.md → Methodology).
 *
 * Tenet 2: no step is skipped silently and every artefact says what evidence it cites. The lines come
 * from the stored block (components/MethodologyGaps); a hand-written document's `evidence: 0` says so in
 * its own words. Renders nothing for a document without gaps (or made before the block existed).
 * @module pages/ProjectDetail/MethodologyNotice
 */
import MethodologyGaps from '../../components/MethodologyGaps/MethodologyGaps'
import type { ProjectDocument } from '../../api/types'

export function MethodologyNotice({ doc }: { readonly doc: ProjectDocument }) {
  return (
    <MethodologyGaps block={doc.methodology} handWritten={doc.origin === 'human'} testId="document-methodology"
      className="mt-4 pt-3 border-t" />
  )
}
