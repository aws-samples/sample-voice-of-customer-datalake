/**
 * Give jsdom a `Range.prototype.getBoundingClientRect` and `getClientRects`, and take them away again afterwards.
 *
 * jsdom has no layout, so a Range has no box at all. The document comment margin
 * (components/DocumentComments/useCommentLayout) places each bubble at its quote's box,
 * and without one its measuring effect throws and no thread is placed; ProseMirror measures
 * the caret (coordsAtPos) when a canvas takes the focus. The stubs answer an empty box at the
 * origin and an empty list of boxes. Each is defined only when jsdom lacks it, and teardown
 * removes only what was added, restoring the absence of the method, like stubScrollTo.ts.
 */
const RANGE_BOXES = {
  getBoundingClientRect: () => new DOMRect(0, 0, 0, 0),
  getClientRects: () => document.createElement('div').getClientRects(),
} satisfies Partial<Record<keyof Range, () => unknown>>

export function stubRangeLayout(): () => void {
  const added = Object.entries(RANGE_BOXES).filter(([name]) => !(name in Range.prototype))
  added.forEach(([name, value]) => {
    Object.defineProperty(Range.prototype, name, { configurable: true, value })
  })
  return () => {
    added.forEach(([name]) => Reflect.deleteProperty(Range.prototype, name))
  }
}
