/**
 * Give jsdom a `Range.prototype.getBoundingClientRect`, and take it away again afterwards.
 *
 * jsdom has no layout, so a Range has no box at all. The document comment margin
 * (components/DocumentComments/useCommentLayout) places each bubble at its quote's box,
 * and without one its measuring effect throws and no thread is placed. The stub answers
 * an empty box at the origin. Teardown restores the absence of the method, like
 * stubScrollTo.ts.
 */
export function stubRangeLayout(): () => void {
  if ('getBoundingClientRect' in Range.prototype) return () => {}
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(0, 0, 0, 0),
  })
  return () => {
    Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
  }
}
