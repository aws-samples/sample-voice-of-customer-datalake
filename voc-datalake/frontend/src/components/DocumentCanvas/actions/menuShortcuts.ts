/**
 * @fileoverview A menu entry's keyboard shortcut, as the menu shows it ("⌘B" on an Apple device, "Ctrl+B"
 * elsewhere) and as `aria-keyshortcuts` names it (both modifier spellings, as the page's Save does). Every one is a
 * Mod shortcut the editor already answers (the menus add none).
 *
 * @module components/DocumentCanvas/actions/menuShortcuts
 */

/** Mod (⌘ / Ctrl) + `key`, with Shift or Alt when set. */
export interface Shortcut {
  readonly key: string
  readonly shift?: boolean
  readonly alt?: boolean
}

/** Apple devices name Mod "⌘" (and Shift "⇧", Alt "⌥"). */
function isApple(): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(globalThis.navigator.userAgent)
}

/** The shortcut as the menu shows it. */
export function shortcutText(shortcut: Shortcut, apple: boolean = isApple()): string {
  const key = shortcut.key.toUpperCase()
  if (apple) return `${shortcut.alt === true ? '⌥' : ''}${shortcut.shift === true ? '⇧' : ''}⌘${key}`
  return ['Ctrl', shortcut.shift === true ? 'Shift' : null, shortcut.alt === true ? 'Alt' : null, key]
    .filter((part) => part !== null).join('+')
}

/** The shortcut for `aria-keyshortcuts`: "Control+B Meta+B". */
export function shortcutKeys(shortcut: Shortcut): string {
  const rest = [shortcut.shift === true ? 'Shift' : null, shortcut.alt === true ? 'Alt' : null, shortcut.key.toUpperCase()]
    .filter((part) => part !== null).join('+')
  return `Control+${rest} Meta+${rest}`
}
