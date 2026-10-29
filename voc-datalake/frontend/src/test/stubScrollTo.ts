/**
 * Give jsdom an `Element.prototype.scrollIntoView`, and take it away again afterwards.
 *
 * jsdom does not implement it, so a component that scrolls a message list into view
 * in an effect throws on mount — and React renders the whole subtree as an empty div,
 * which quietly turns "the API was not called" style assertions into vacuous passes.
 *
 * Teardown restores the *absence* of the property rather than assigning the
 * original back: the method is `undefined` in jsdom, so assigning it would leave an
 * own `scrollIntoView: undefined` on the prototype. `Reflect.deleteProperty` rather
 * than a `delete` with a type assertion: TS types the method as required.
 *
 * Prefer this over patching the prototype at module scope: the stub would then
 * outlive the file that installed it, which only goes unnoticed because Vitest
 * isolates per file by default.
 */
import { vi } from 'vitest'

export function stubElementScrollIntoView(): () => void {
  const existed = 'scrollIntoView' in Element.prototype
  const original = Element.prototype.scrollIntoView

  Element.prototype.scrollIntoView = vi.fn()

  return () => {
    if (existed) {
      Element.prototype.scrollIntoView = original
    } else {
      Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
    }
  }
}
