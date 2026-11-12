/**
 * @fileoverview Makes `[start, end)` of an element's first text node the page's selection, the way a reader's drag
 * does, for the comment tests that open a draft on a selected passage.
 */
export function selectText(element: Element, start: number, end: number): void {
  const node = element.firstChild
  if (node === null) throw new Error('no text to select')
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, end)
  globalThis.getSelection()?.removeAllRanges()
  globalThis.getSelection()?.addRange(range)
}
