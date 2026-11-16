/**
 * @fileoverview What a typed document name means for a rename: the one rule of the page's title (InlineTitle) and of
 * a card's Rename in the documents list (DocumentCard). The name is trimmed; an empty one is refused (a document
 * needs a name); the same name saves nothing.
 *
 * @module components/DocumentCanvas/page/titleEdit
 */

export type TitleEdit =
  | { readonly kind: 'empty' }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'renamed'; readonly title: string }

/** `typed` read against the name the document has (`saved`). */
export function titleEditOf(typed: string, saved: string): TitleEdit {
  const title = typed.trim()
  if (title === '') return { kind: 'empty' }
  return title === saved ? { kind: 'unchanged' } : { kind: 'renamed', title }
}
