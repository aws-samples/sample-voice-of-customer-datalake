/**
 * @fileoverview The approved docs' preview as documents (§6.4 [52] steps 2 and 3, the publish sheet): each rendered
 * file (`docs/agents/**`, `TENETS.md`) is read as a document on its own, from its text in the preview (gap O), and a
 * publish's answer read as what to tell the administrator.
 *
 * Opening the pull request writes `voc-agent/docs/<kind>-v<n>` and opens it ready for review (or as a draft, as the
 * flow says); only a person merges it, on the host. A Human-driven administrator's publish is refused (`human_driven`):
 * the preview's patch is theirs to apply. The server's rendering, of what an administrator approved: read only.
 *
 * @module pages/Agents/documents/docsPreviewDocument
 */
import { engineeringKnowledgeApi, isPublishRefusal } from '../../../api/engineeringKnowledgeApi'
import { apiErrorCode, serverReason } from '../../../lib/errors'
import { apiErrorStatus } from '../../../api/apiErrorStatus'
import { unlessGone } from './readOnly'
import type { DocumentAdapter, StoredDocument } from '../../../components/Document/types'
import type { DocsKind, DocsPreview, DocsPublished, PreviewFile, PublishRefusal } from '../../../api/engineeringKnowledgeApi'

/** A rendered file: its path is its title, its sha256 names it. */
export interface PreviewFileDocument extends StoredDocument {
  readonly sha256: string
}

/** A rendered file as a document (null: its text did not fit the preview, `texts_truncated`: it is in the patch). */
export function previewFileDocumentOf(file: PreviewFile): PreviewFileDocument | null {
  return file.text === null ? null : { title: file.path, content: file.text, sha256: file.sha256 }
}

/** The surface's adapter for one rendered file (`load` reads the preview again and finds it; undefined: gone). */
export function previewFileAdapter(connection: string, kind: DocsKind, path: string): DocumentAdapter<PreviewFileDocument> {
  return {
    id: `docs:${connection}:${kind}:${path}`,
    contentType: path.toLowerCase().endsWith('.md') ? 'markdown' : 'code',
    policy: 'model',
    // What an administrator approved, as the server renders it: never edited here.
    permissions: { edit: 'decided' },
    versionOf: (stored) => ({ token: stored.sha256 }),
    load: async () => {
      const preview = await unlessGone(() => engineeringKnowledgeApi.preview(connection, kind))
      const file = preview?.files.find((entry) => entry.path === path)
      // (a file past the preview's bound has no document: none)
      return (file && previewFileDocumentOf(file)) ?? undefined
    },
  }
}

/** What a publish told: the pull request opened, or why not (a known code, else the server's words). */
export type PublishOutcome =
  | { readonly kind: 'opened'; readonly published: DocsPublished }
  | { readonly kind: 'refused'; readonly code: PublishRefusal }
  | { readonly kind: 'failed'; readonly message: string | null }

export function publishOutcomeOf(error: unknown): PublishOutcome {
  const code = apiErrorCode(error)
  if (apiErrorStatus(error) === 409 && isPublishRefusal(code)) return { kind: 'refused', code }
  return { kind: 'failed', message: serverReason(error) }
}

/** The patch as a file to download (`voc-docs-<kind>-v<n>.patch`). */
export function patchFileName(preview: DocsPreview): string {
  return `voc-docs-${preview.kind}-v${String(preview.version)}.patch`
}
