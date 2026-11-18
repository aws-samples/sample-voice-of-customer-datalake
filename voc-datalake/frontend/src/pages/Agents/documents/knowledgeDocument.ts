/**
 * @fileoverview A knowledge pack's document as a document (§6.4 [52] step 3, the setup guide's Understand step): the
 * adapter Knowledge review hands DocumentSurface for one of a package version's seven documents, and the rule of
 * which version may be approved.
 *
 * The Understand flow (agents) writes each version; an administrator compares it with the approved one and approves
 * it. Nobody edits a pack here (there is no edit route, by design) and there is no reject: a version not approved just
 * stays. Agent text: read on the `model` policy (safe links, no images).
 *
 * @module pages/Agents/documents/knowledgeDocument
 */
import { engineeringKnowledgeApi } from '../../../api/engineeringKnowledgeApi'
import { apiErrorStatus } from '../../../api/apiErrorStatus'
import { unlessGone } from './readOnly'
import type { DocumentAdapter, ReadOnlyReason, StoredDocument } from '../../../components/Document/types'
import type { KnowledgeKind, KnowledgePackage, KnowledgeVersion, PackVersion } from '../../../api/engineeringKnowledgeApi'

export interface KnowledgeDocument extends StoredDocument {
  readonly connection: string
  /** The package as its path segment (the layout's encoding). */
  readonly segment: string
  readonly kind: KnowledgeKind
  readonly version: PackVersion
}

/** One document of a version, or null when the pack has none of that kind. */
export function knowledgeDocumentOf(connection: string, segment: string, loaded: KnowledgeVersion, kind: KnowledgeKind,
  title: string): KnowledgeDocument | null {
  const markdown = loaded.documents[kind]
  return markdown === undefined ? null : { title, content: markdown, connection, segment, kind, version: loaded.version }
}

/** Why a document is read only: an approved version is decided; a draft is approved or left, never edited. */
function knowledgeReadOnlyReason(status: string): ReadOnlyReason {
  return status === 'approved' ? 'decided' : 'proposalOnly'
}

/** The surface's adapter for one kind of a package's version (`load` reads it again; undefined: gone or no such kind). */
export function knowledgeAdapter(connection: string, segment: string, kind: KnowledgeKind, status: string, title: string):
DocumentAdapter<KnowledgeDocument> {
  return {
    id: `knowledge:${connection}:${segment}:${kind}`,
    contentType: 'markdown',
    policy: 'model',
    permissions: { edit: knowledgeReadOnlyReason(status) },
    versionOf: (stored) => ({ token: `${stored.segment}/v${String(stored.version.version)}/${stored.kind}`, number: stored.version.version }),
    load: async (stored) => {
      const loaded = await unlessGone(() => engineeringKnowledgeApi.packVersion(stored.connection, stored.segment, stored.version.version))
      // (a kind the version lacks is none too)
      return (loaded && knowledgeDocumentOf(stored.connection, stored.segment, loaded, stored.kind, title)) ?? undefined
    },
  }
}

/** A package's versions newest first (the server lists them oldest first). */
export function versionsNewestFirst(pkg: KnowledgePackage): PackVersion[] {
  return [...pkg.versions].sort((a, b) => b.version - a.version)
}

/** The version to open first: the newest draft above the approved one, else the approved one, else the newest. */
export function versionToReview(pkg: KnowledgePackage): number | null {
  const versions = versionsNewestFirst(pkg)
  const approved = pkg.approved_version ?? 0
  return versions.find((version) => version.status === 'draft' && version.version > approved)?.version
    ?? pkg.approved_version ?? versions[0]?.version ?? null
}

/** Whether a version may be approved: a draft above the approved one (the store refuses an older one). */
export function approvable(pkg: KnowledgePackage, version: PackVersion): boolean {
  return version.status === 'draft' && version.version > (pkg.approved_version ?? 0)
}

/** A refusal that means the version or the approved one moved since the screen read them: read it again (409). */
export function isKnowledgeStale(error: unknown): boolean {
  return apiErrorStatus(error) === 409
}
