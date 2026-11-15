/**
 * @fileoverview What a document was made from, under its content: the revision and derivation footers, the
 * deleted-sources and methodology notices. Below the text, never above it: provenance is what the document was made
 * from, not what it says. The prose page and the prototype pane both show it.
 *
 * @module components/DocumentCanvas/page/DocumentProvenance
 */
import { DerivationFooter, RevisionFooter } from '../../../pages/ProjectDetail/DocumentLineageFooters'
import { DeletedSourcesNotice } from '../../../pages/ProjectDetail/DeletedSourcesNotice'
import { MethodologyNotice } from '../../../pages/ProjectDetail/MethodologyNotice'
import type { ProjectDocument } from '../../../api/types'

interface DocumentProvenanceProps {
  readonly document: ProjectDocument
  readonly documents: ProjectDocument[]
  readonly onSelectDoc: (doc: ProjectDocument) => void
}

export default function DocumentProvenance({ document, documents, onSelectDoc }: DocumentProvenanceProps) {
  return (
    <>
      <RevisionFooter doc={document} documents={documents} onSelectDoc={onSelectDoc} />
      <DerivationFooter doc={document} documents={documents} onSelectDoc={onSelectDoc} />
      <DeletedSourcesNotice doc={document} />
      <MethodologyNotice doc={document} />
    </>
  )
}
