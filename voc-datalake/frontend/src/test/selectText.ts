/**
 * @fileoverview Selections in a spec: makes `[start, end)` of an element's first text node the page's selection, the
 * way a reader's drag does (the comment tests that open a draft on a selected passage), and reads a text field's.
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

/** The selection inside a text field: [start, end]. */
export function selectedRange(field: HTMLElement): [number | null, number | null] {
  if (!(field instanceof HTMLInputElement)) throw new Error('not a text field')
  return [field.selectionStart, field.selectionEnd]
}
