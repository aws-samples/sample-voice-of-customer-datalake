/**
 * @fileoverview The surface's edit body, for a feature without an editor page of its own: the shared draft
 * (useDocumentDraft) on the adapter, its save row (SaveBar), and the text edited by its content type: Markdown on
 * the canvas (MarkdownEdit, its chunk loaded now, the text readable meanwhile), plain text and prompts as written
 * (SourceEditor, the count against the limit; past it Save waits and says why). A split front-matter stays out of the
 * editor and is joined back byte for byte on save (bodyAdapter); it shows read only above the text.
 *
 * @module components/Document/surface/EditBody
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useDocumentDraft } from '../draft/useDocumentDraft'
import MarkdownEdit from '../edit/MarkdownEdit'
import { READING_TEXT_CLASS } from '../readingColumn'
import PropertiesPanel from '../text/PropertiesPanel'
import SourceEditor from '../text/SourceEditor'
import { joinFrontMatter, splitFrontMatter } from '../text/frontMatter'
import { overLimit } from '../text/limits'
import SaveBar from './SaveBar'
import type { CanvasEditorHandle } from '../edit/editor/CanvasEditor'
import type { DocumentAdapter, StoredDocument } from '../types'

/**
 * The adapter as the draft sees it: with `frontMatter: 'split'`, every stored version's text is its body, and every
 * save writes the front-matter it was read with back in front of the body.
 */
function bodyAdapter<S extends StoredDocument>(adapter: DocumentAdapter<S>): DocumentAdapter<S> {
  if (adapter.frontMatter !== 'split') return adapter
  const toBody = (stored: S): S => asBody(stored, true)
  const { load, save, rename } = adapter
  return {
    ...adapter,
    load: async (stored) => {
      const found = await load(stored)
      return found === undefined ? undefined : toBody(found)
    },
    ...(save === undefined ? {} : {
      save: async (draft, on, options) => {
        const saved = await save({ ...draft, content: joinFrontMatter(frontMatterOf(on), draft.content) }, on, options)
        return saved === null ? null : toBody(saved)
      },
    }),
    ...(rename === undefined ? {} : {
      rename: async (title, on) => {
        const renamed = await rename(title, on)
        return renamed === null ? null : toBody(renamed)
      },
    }),
  }
}

/** The front-matter a body was read with: kept on the stored version the draft holds (its `frontMatter` field). */
function frontMatterOf(on: StoredDocument): string | null {
  return 'frontMatter' in on && typeof on.frontMatter === 'string' ? on.frontMatter : null
}

/** A stored version as the draft holds it: its body, and the front-matter to join back. */
function asBody<S extends StoredDocument>(stored: S, split: boolean): S {
  if (!split) return stored
  const { frontMatter, body } = splitFrontMatter(stored.content)
  return { ...stored, content: body, frontMatter }
}

interface EditBodyProps<S extends StoredDocument> {
  readonly adapter: DocumentAdapter<S>
  readonly stored: S
  readonly title: string
  readonly onSaved: (stored: S) => void
}

export default function EditBody<S extends StoredDocument>({ adapter, stored, title, onSaved }: EditBodyProps<S>) {
  const { t } = useTranslation('documents')
  const split = adapter.frontMatter === 'split'
  const draftAdapter = useMemo(() => bodyAdapter(adapter), [adapter])
  const held = useMemo(() => asBody(stored, split), [split, stored])
  const state = useDocumentDraft<S, CanvasEditorHandle>(draftAdapter, { stored: held, onSelect: onSaved })
  const over = overLimit(state.draft, adapter.limits)
  const frontMatter = split ? splitFrontMatter(stored.content).frontMatter : null
  return (
    <div className="space-y-3">
      <SaveBar state={state} blocked={over === null ? null : t(`count.over.${over}`)} />
      {frontMatter === null ? null : <PropertiesPanel frontMatter={frontMatter} />}
      {adapter.contentType === 'markdown' ? (
        <MarkdownEdit markdown={state.content} editable ariaLabel={title} onChange={state.onChange} handleRef={state.handleRef}
          className={READING_TEXT_CLASS} />
      ) : (
        <SourceEditor value={state.draft} onChange={state.onChange} label={title} limits={adapter.limits}
          prompt={adapter.contentType === 'plain'} />
      )}
    </div>
  )
}
