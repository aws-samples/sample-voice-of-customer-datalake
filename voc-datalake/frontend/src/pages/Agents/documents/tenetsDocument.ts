/**
 * @fileoverview A repository's tenets version as a document (§6.4 [52] step 2, the setup guide's Tenets step): the
 * adapter Tenets review hands DocumentSurface, the version's Markdown projection, its diff keyed by tenet id, and the
 * decision's body.
 *
 * A version is structured (`voc-tenets/1`: a summary and 1-30 tenets `{id, title, statement, rationale, citations}`),
 * written by the Tenets flow (an agent): it reads through a Markdown projection on the `model` policy (safe links, no
 * images), and compares by id (added, changed, removed), never as text. Nobody edits a draft (D6-3): an administrator
 * accepts or rejects it with a reason, then runs Tenets again. A decision names the accepted version the screen
 * showed (`expected_accepted`, 0 for none, gap P): the server answers 409 "read it again" when it moved.
 *
 * @module pages/Agents/documents/tenetsDocument
 */
import { engineeringKnowledgeApi } from '../../../api/engineeringKnowledgeApi'
import { apiErrorStatus } from '../../../api/apiErrorStatus'
import { unlessGone } from './readOnly'
import type { DocumentAdapter, ReadOnlyReason, StoredDocument } from '../../../components/Document/types'
import type { Tenet, TenetsDecisionBody, TenetsHead, TenetsRecord, TenetsVersion } from '../../../api/engineeringKnowledgeApi'

/** The most a decision's reason takes (knowledge_routes MAX_REASON). */
export const MAX_TENETS_REASON = 500

/** The words the projection uses around a tenet's own text (the reader's language). */
export interface TenetsLabels {
  readonly summary: string
  readonly why: string
  readonly cites: string
}

export interface TenetsDocument extends StoredDocument {
  readonly connection: string
  readonly version: TenetsVersion
}

/** A citation as code (a path, `path:line` or a commit): never a link the model chose. */
const citation = (cited: string) => `\`${cited.replaceAll('`', '')}\``

/** One line of model text as a heading's text: no line break, and no leading marks Markdown would read. */
const headingText = (value: string) => value.replace(/\s+/gu, ' ').trim().replace(/^[#>*+-]+\s*/u, '')

/** The record as Markdown: the summary, then each tenet as a section (its statement, why, what it cites). */
export function tenetsMarkdown(record: TenetsRecord, labels: TenetsLabels): string {
  const parts: string[] = []
  if (record.summary.trim() !== '') parts.push(`## ${labels.summary}`, record.summary.trim())
  for (const tenet of record.tenets) {
    parts.push(`### ${headingText(tenet.title)} (\`${tenet.id}\`)`, tenet.statement.trim())
    if (tenet.rationale.trim() !== '') parts.push(`**${labels.why}** ${tenet.rationale.trim()}`)
    if (tenet.citations.length > 0) parts.push(`${labels.cites} ${tenet.citations.map(citation).join(', ')}`)
  }
  return `${parts.join('\n\n')}\n`
}

export type TenetChange =
  | { readonly kind: 'added'; readonly tenet: Tenet }
  | { readonly kind: 'removed'; readonly tenet: Tenet }
  | { readonly kind: 'changed'; readonly tenet: Tenet; readonly fields: readonly TenetField[] }

export type TenetField = 'title' | 'statement' | 'rationale' | 'citations'
const FIELDS: readonly TenetField[] = ['title', 'statement', 'rationale', 'citations']

const fieldOf = (tenet: Tenet, field: TenetField) => (field === 'citations' ? tenet.citations.join('\n') : tenet[field].trim())

/**
 * What a version changes from another (null: none to compare with, every tenet added), keyed by id, in the version's
 * order with the removed ones after; an unchanged tenet is left out.
 */
export function tenetsChanges(before: TenetsRecord | null, after: TenetsRecord): TenetChange[] {
  const old = new Map((before?.tenets ?? []).map((tenet) => [tenet.id, tenet]))
  const kept = new Set(after.tenets.map((tenet) => tenet.id))
  const changes: TenetChange[] = []
  for (const tenet of after.tenets) {
    const was = old.get(tenet.id)
    if (was === undefined) {
      changes.push({ kind: 'added', tenet })
      continue
    }
    const fields = FIELDS.filter((field) => fieldOf(was, field) !== fieldOf(tenet, field))
    if (fields.length > 0) changes.push({ kind: 'changed', tenet, fields })
  }
  for (const tenet of before?.tenets ?? []) if (!kept.has(tenet.id)) changes.push({ kind: 'removed', tenet })
  return changes
}

/** The version to compare a draft with: the one it was drafted on, else the accepted one (null: neither). */
export function comparedWith(version: TenetsVersion, head: TenetsHead): number | null {
  if (version.base_version > 0 && version.base_version !== version.version) return version.base_version
  const accepted = head.accepted_version
  return accepted !== null && accepted !== version.version ? accepted : null
}

/** The version to open first: the newest draft, else the accepted one, else the newest (`versions` newest first). */
export function tenetsToReview(versions: readonly TenetsVersion[], head: TenetsHead): number | null {
  return versions.find((version) => version.status === 'draft')?.version ?? head.accepted_version ?? versions[0]?.version ?? null
}

/** Why a version is read only: decided once accepted or rejected; a draft is decided on, never edited (D6-3). */
export function tenetsReadOnlyReason(status: string): ReadOnlyReason {
  return status === 'draft' ? 'proposalOnly' : 'decided'
}

export function tenetsDocumentOf(connection: string, version: TenetsVersion, title: string, labels: TenetsLabels): TenetsDocument {
  return { title, content: tenetsMarkdown(version.record, labels), connection, version }
}

/** The surface's adapter for one tenets version of a connection (`load` reads it again; undefined: none). */
export function tenetsAdapter(connection: string, status: string, title: (version: number) => string, labels: TenetsLabels):
DocumentAdapter<TenetsDocument> {
  return {
    id: `tenets:${connection}`,
    contentType: 'markdown',
    policy: 'model',
    permissions: { edit: tenetsReadOnlyReason(status) },
    versionOf: (stored) => ({ token: `tenets/${stored.connection}/v${String(stored.version.version)}`, number: stored.version.version }),
    load: async (stored) => {
      const read = await unlessGone(() => engineeringKnowledgeApi.tenetsVersion(stored.connection, stored.version.version))
      return read && tenetsDocumentOf(stored.connection, read.version, title(read.version.version), labels)
    },
  }
}

/** A decision's body: the accepted version the screen showed (0 for none), and the reason when one was given. */
export function tenetsDecisionBody(head: TenetsHead, reason: string): TenetsDecisionBody {
  const trimmed = reason.trim()
  return trimmed === '' ? { expected_accepted: head.accepted_version ?? 0 } : { expected_accepted: head.accepted_version ?? 0, reason: trimmed }
}

/** A refusal that means the accepted version moved since the screen read it: read it again (409). */
export function isTenetsStale(error: unknown): boolean {
  return apiErrorStatus(error) === 409
}
