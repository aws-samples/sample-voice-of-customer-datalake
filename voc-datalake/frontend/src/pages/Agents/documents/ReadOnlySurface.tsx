/**
 * @fileoverview The Agents documents' read-only surface: DocumentSurface with nothing to save through it, no
 * comments, and no footer, close or page frame of its own (a skill version, a template update, a brief, a report, a
 * pack, a tenets version, a publish preview, a card's source). The caller names the rest.
 *
 * @module pages/Agents/documents/ReadOnlySurface
 */
import DocumentSurface from '../../../components/Document/DocumentSurface'
import { neverSaved } from './readOnly'
import type { DocumentSurfaceProps } from '../../../components/Document/DocumentSurface'
import type { StoredDocument } from '../../../components/Document/types'

type ReadOnlySurfaceProps<S extends StoredDocument> =
  Omit<DocumentSurfaceProps<S>, 'comments' | 'onSaved' | 'footer' | 'onClose' | 'page' | 'children'>

export default function ReadOnlySurface<S extends StoredDocument>(props: Readonly<ReadOnlySurfaceProps<S>>) {
  return (
    <DocumentSurface {...props} comments={null} onSaved={neverSaved} footer={null} onClose={null} page={null}>
      {null}
    </DocumentSurface>
  )
}
