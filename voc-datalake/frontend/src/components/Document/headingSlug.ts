/**
 * @fileoverview Heading ids, shared by both engines: the canvas (components/Document/edit/editor/headingIds.ts, a
 * ProseMirror decoration) and the light reader (a property of the rendered heading). One rule, so a deep link or a
 * Contents entry names the same heading whichever engine shows the text. No editor import: the reader loads it.
 *
 * @module components/Document/headingSlug
 */

/** `h-` keeps a heading such as "Root" or "Main" from colliding with the app's own element ids. */
function headingSlug(text: string): string {
  const words = text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replaceAll(' ', '-')
  return `h-${words === '' ? 'section' : words}`
}

/** The id of the next heading reading `text`, in document order: its slug, then `-1`, `-2` … (`seen` counts repeats). */
export function headingId(seen: Map<string, number>, text: string): string {
  const slug = headingSlug(text)
  const count = seen.get(slug) ?? 0
  seen.set(slug, count + 1)
  return count === 0 ? slug : `${slug}-${count}`
}
