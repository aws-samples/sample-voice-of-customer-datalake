/**
 * @fileoverview WCAG 2 contrast between two of a form's theme colours (UX §14.1: the Theme section warns when the
 * text on the background is under 4.5:1). Hex only (`#rgb`, `#rrggbb`): any other value is not judged.
 *
 * @module pages/FeedbackForms/tabs/settings/contrast
 */

export const MIN_TEXT_CONTRAST = 4.5

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

/** The 0–255 channels of a hex colour, or null when it is not one. */
function channels(color: string): readonly number[] | null {
  const match = HEX.exec(color.trim())
  const digits = match?.[1]
  if (digits === undefined) return null
  const full = digits.length === 3 ? digits.replace(/./g, '$&$&') : digits
  return [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16))
}

function luminance(rgb: readonly number[]): number {
  const [r = 0, g = 0, b = 0] = rgb.map((value) => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** The contrast ratio of two hex colours (1–21), or null when either is not a hex colour. */
export function contrastRatio(foreground: string, background: string): number | null {
  const fg = channels(foreground)
  const bg = channels(background)
  if (fg === null || bg === null) return null
  const [light, dark] = [luminance(fg), luminance(bg)].sort((a, b) => b - a)
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05)
}
