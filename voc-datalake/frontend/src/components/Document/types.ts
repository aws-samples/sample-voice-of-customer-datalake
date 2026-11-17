/**
 * @fileoverview The shared document component's types (docs/kiro-design-system.md → Documents): what a feature hands
 * DocumentSurface. Each feature passes an adapter; the component never names a route.
 *
 * @module components/Document/types
 */
import type { Location } from 'react-router-dom'

/** A heading of a document's "Contents": h1–h3 (a contents list of every h4 is a second copy of the text). */
export interface OutlineItem { readonly id: string; readonly level: 1 | 2 | 3; readonly text: string }

/** What the code enforces on a plain text or prompt (the server stays the gate). */
export interface DocumentLimits {
  readonly maxChars?: number
  readonly maxLines?: number
}

/** How a document's text reads and is written: Markdown (the canvas), plain text or a prompt, or code (read only). */
export type ContentType = 'markdown' | 'plain' | 'code'

/**
 * Why a document is read only here, said as visible text (never a disabled input): a viewer, an older version, a
 * file that ships with a release, an accepted version (it never changes), a document changed only by proposals, or
 * one edited in another place.
 */
export type ReadOnlyReason = 'viewer' | 'olderVersion' | 'managedByTemplate' | 'decided' | 'proposalOnly' | 'editedElsewhere'

/**
 * Where a surface sits: a page (Projects documents, a full-page view), a 360 px panel (an inspector), a sheet (the
 * app's side sheet, SideSheet `size="wide"`: its header, scrolling body and footer) or inline (no chrome, in a card or
 * a details).
 */
export type SurfaceVariant = 'page' | 'panel' | 'sheet' | 'inline'

/** What a surface shows: the text read, the text edited, or two versions compared. */
export type SurfaceMode = 'read' | 'edit' | 'compare'

/** A stored version's identity: `token` names it (a new one resets the draft), `number` orders versions. */
export interface VersionRef { readonly token: string; readonly number?: number }

/** What a draft writes: its title and its text. */
export interface DocumentDraft {
  readonly title: string
  readonly content: string
}

/** A stored version of a document, as the feature has it (a project document, a skill version …). */
export type StoredDocument = DocumentDraft

/** How one save is sent: with the revision check (`checked`: false is "Save mine anyway"), and its mark (or null). */
export interface SaveOptions {
  readonly checked: boolean
  readonly mark: string | null
}

export interface DocumentPermissions {
  /** True, or why the document is read only here. */
  readonly edit: true | ReadOnlyReason
}

/**
 * A feature's document, for DocumentSurface and useDocumentDraft. `S` is the feature's own stored version (a project
 * document): the component reads its `title` and `content`, and hands it back on select and save.
 */
export interface DocumentAdapter<S extends StoredDocument = StoredDocument> {
  /** Names the document (view preferences, query keys). */
  readonly id: string
  readonly contentType: ContentType
  /** `split`: a YAML front-matter (SKILL.md) is kept apart byte for byte; the editor sees the body only. */
  readonly frontMatter?: 'split'
  readonly limits?: DocumentLimits
  /**
   * How the rendered text is read (read/markdownPolicy.ts): `stored` (the default: text people stored) or `model` (text
   * an agent or a model wrote that a person reviews: safe links and no images, so nothing it names is fetched).
   */
  readonly policy?: 'stored' | 'model'
  readonly permissions: DocumentPermissions
  /** Which stored version `stored` is. */
  readonly versionOf: (stored: S) => VersionRef
  /** The newest stored copy of `stored` (undefined: deleted meanwhile): Load the latest, Compare and merge. */
  readonly load: (stored: S) => Promise<S | undefined>
  /** Write one new version of `on` (null: saved, but the answer did not carry it: it is read back with `load`). */
  readonly save?: (draft: DocumentDraft, on: S, options: SaveOptions) => Promise<S | null>
  /** Rename in place: one new version carrying only the title. Absent: the title is not renamed here. */
  readonly rename?: (title: string, on: S) => Promise<S | null>
  /** A failed save that means "someone saved in between" (default: a 409). */
  readonly conflictOf?: (error: unknown) => boolean
  /** A failed marked save the server would not record with its mark: its reason (null message: none given). */
  readonly refusalOf?: (error: unknown) => { readonly message: string | null } | null
  /** An address change that keeps this document on screen (its full-screen view, an older version): never a leave. */
  readonly isSameDocument?: (current: Location, next: Location) => boolean
}

/** The canvas's handle, as the draft needs it: the editor's own text (flushed), and replacing it. */
export interface DraftEditor {
  readonly getMarkdown: () => string
  readonly setMarkdown: (markdown: string) => void
}

/** A stale save's way out, as the conflict banner offers them (each waits while a save or a load is on its way). */
export interface DocumentConflict {
  readonly onLoadLatest: () => Promise<unknown>
  readonly onSaveAnyway: () => Promise<unknown>
  /** Compare and merge: the latest version's changes, to take into this draft where they still apply. */
  readonly onCompare?: () => Promise<unknown>
  /** A save is on its way (this one, or the page's). */
  readonly saving: boolean
  /** "Load the latest" (or the compare's read) is on its way. */
  readonly loading: boolean
}
