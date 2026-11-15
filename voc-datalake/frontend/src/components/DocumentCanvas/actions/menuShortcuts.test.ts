/** A menu entry's shortcut as shown (an Apple device's ⌘ / ⇧ / ⌥, Ctrl+ elsewhere) and as `aria-keyshortcuts`. */
import { describe, expect, it } from 'vitest'
import { shortcutKeys, shortcutText } from './menuShortcuts'

describe('menuShortcuts', () => {
  it('shows Mod as ⌘ on an Apple device and Ctrl elsewhere, with Shift and Alt', () => {
    expect([
      shortcutText({ key: 'b' }, true), shortcutText({ key: 'z', shift: true }, true), shortcutText({ key: '2', alt: true }, true),
      shortcutText({ key: 'b' }, false), shortcutText({ key: 'z', shift: true }, false), shortcutText({ key: 'c', alt: true }, false),
    ]).toStrictEqual(['⌘B', '⇧⌘Z', '⌥⌘2', 'Ctrl+B', 'Ctrl+Shift+Z', 'Ctrl+Alt+C'])
  })

  it('names both modifier spellings for assistive technology', () => {
    expect([shortcutKeys({ key: 'k' }), shortcutKeys({ key: '8', shift: true })])
      .toStrictEqual(['Control+K Meta+K', 'Control+Shift+8 Meta+Shift+8'])
  })
})
