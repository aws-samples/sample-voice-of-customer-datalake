/**
 * @fileoverview A template's source text as a document (gap S, `GET …/templates/<kind>/<id>/source`): what the
 * Registry card's Source shows, read only (`managedByTemplate`: it changes with a release, in
 * `templates/orchestration`). A role's SKILL.md reads as Markdown with its YAML front-matter split off byte for byte
 * (shown as Properties; the canvas never sees the `---` block); an agent.yaml or a flow's YAML is code, shown exactly
 * as stored in the code view (no YAML library, no highlighting: D6-5). The owner's text: the `stored` policy.
 *
 * @module pages/Agents/documents/templateSourceDocument
 */
import { engineeringRegistryApi } from '../../../api/engineeringRegistryApi'
import { unlessGone } from './readOnly'
import type { DocumentAdapter, StoredDocument } from '../../../components/Document/types'
import type { SourceKind, TemplateSource } from '../../../api/engineeringRegistryApi'

export interface SourceDocument extends StoredDocument {
  readonly path: string
  readonly digest: string
  readonly templateVersion: number | null
}

export function sourceDocumentOf(source: TemplateSource): SourceDocument {
  return {
    title: source.path, content: source.text, path: source.path, digest: source.digest,
    templateVersion: source.template_version,
  }
}

/** Markdown for a SKILL.md or a brief; code for the YAML (a card's agent.yaml, a flow). */
const isMarkdown = (kind: SourceKind) => kind === 'skill' || kind === 'brief'

/** The surface's adapter for one template's source (`load` reads it again; undefined: gone from the bundle). */
export function templateSourceAdapter(kind: SourceKind, id: string): DocumentAdapter<SourceDocument> {
  return {
    id: `template:${kind}:${id}`,
    contentType: isMarkdown(kind) ? 'markdown' : 'code',
    ...(kind === 'skill' ? { frontMatter: 'split' as const } : {}),
    permissions: { edit: 'managedByTemplate' },
    versionOf: (stored) => ({ token: stored.digest, ...(stored.templateVersion === null ? {} : { number: stored.templateVersion }) }),
    load: async () => {
      const source = await unlessGone(() => engineeringRegistryApi.source(kind, id))
      return source && sourceDocumentOf(source)
    },
  }
}
