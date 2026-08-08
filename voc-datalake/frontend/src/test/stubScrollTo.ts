/**
 * Give jsdom an `Element.prototype.scrollTo`, and take it away again afterwards.
 *
 * jsdom does not implement it, so any component that scrolls a container in an
 * effect throws on mount — and React renders the whole subtree as an empty div,
 * which quietly turns "the API was not called" style assertions into vacuous
 * passes. Several ProjectDetail tests need the stub for that reason.
 *
 * Teardown restores the *absence* of the property rather than assigning the
 * original back: `Element.prototype.scrollTo` is `undefined` in jsdom, so
 * assigning it leaves an own `scrollTo: undefined` on the prototype. Harmless in
 * practice, but a test that checks for the method's presence would then see a
 * property that was never there.
 */
import { vi } from 'vitest'

export function stubElementScrollTo(): () => void {
  const existed = 'scrollTo' in Element.prototype
  const original = Element.prototype.scrollTo

  Element.prototype.scrollTo = vi.fn()

  return () => {
    if (existed) {
      Element.prototype.scrollTo = original
    } else {
      // `Reflect.deleteProperty` rather than `delete (… as { scrollTo?: unknown })`:
      // TS types the method as required, so a plain delete needs an assertion, and
      // an assertion here would claim something about the type rather than do the
      // one thing intended.
      Reflect.deleteProperty(Element.prototype, 'scrollTo')
    }
  }
}
