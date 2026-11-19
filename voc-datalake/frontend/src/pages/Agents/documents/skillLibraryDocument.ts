/**
 * @fileoverview A library skill's file as a document (7.56.00, `GET …/skill-library/<name>[?reference=…]`): what the
 * Skills tab's Library shows, read only (`managedByTemplate`: it changes with a release, in
 * `templates/orchestration/skills`). Its SKILL.md reads as Markdown with its YAML front matter (name, description,
 * source, licence, what was adapted) split off byte for byte as Properties; a reference file is Markdown as written.
 * The repository's text: the `stored` policy, as a template's source.
 *
 * @module pages/Agents/documents/skillLibraryDocument
 */
import { engineeringSkillLibraryApi } from '../../../api/engineeringSkillLibraryApi'
import { unlessGone } from './readOnly'
import type { DocumentAdapter, StoredDocument } from '../../../components/Document/types'
import type { LibraryFile } from '../../../api/engineeringSkillLibraryApi'

export interface LibraryDocument extends StoredDocument {
  readonly path: string
  readonly digest: string
}

export function libraryDocumentOf(file: LibraryFile): LibraryDocument {
  return { title: file.path, content: file.text, path: file.path, digest: file.digest }
}

/** The surface's adapter for one file of a library skill (`reference` null: its SKILL.md; `load` reads it again,
 * undefined: gone from the bundle). */
export function libraryFileAdapter(name: string, reference: string | null): DocumentAdapter<LibraryDocument> {
  return {
    id: `library:${name}:${reference ?? 'SKILL.md'}`,
    contentType: 'markdown',
    ...(reference === null ? { frontMatter: 'split' as const } : {}),
    permissions: { edit: 'managedByTemplate' },
    versionOf: (stored) => ({ token: stored.digest }),
    load: async () => {
      const file = await unlessGone(() => engineeringSkillLibraryApi.file(name, reference))
      return file && libraryDocumentOf(file)
    },
  }
}
