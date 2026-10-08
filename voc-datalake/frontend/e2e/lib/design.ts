/**
 * In-page checks against docs/kiro-design-system.md: Kiro palette only
 * (off-palette solid colours are listed), Space Grotesk body font, no emojis
 * in rendered text, a visible focus indicator on the first Tab stops, and the
 * active theme attributes.
 */
import type { Page } from '@playwright/test'

export interface DesignAudit {
  themeAttr: string | null
  modeAttr: string | null
  bodyFont: string
  headingFonts: string[]
  emojis: string[]
  offPalette: Array<{ color: string; property: string; count: number; sample: string }>
  focus: Array<{ element: string; visible: boolean; detail: string }>
}

/** Every hex the design doc names, both themes (tokens, tones, chart ramp). */
const PALETTE = [
  '#8e48ff', '#9f63ff', '#7a35e0', '#ffffff', '#bd8fff', '#723acc', '#c19aff', '#7337d6', '#352f3d', '#4a464f',
  '#ebe5f3', '#c4bcd0', '#19161d', '#1c1922', '#f5f5f5', '#fafafa', '#211d25', '#28242e', '#f0f0f0', '#f2f1f4',
  '#dcdadf', '#938f9b', '#5e5966', '#8a8592', '#e4e4e7', '#d4d4d8', '#a1a1aa', '#1bb36b', '#007038', '#e0b94d',
  '#6b5900', '#ff5f73', '#bd1c3a', '#7aa3e6', '#285092', '#b07fff', '#3f84c6', '#4194e0', '#3a9c95', '#359f95',
  '#c57c4e', '#c97c49', '#916fc6', '#a37be0', '#099973', '#00a377', '#bc9643', '#ae8b38', '#000000',
]

/** Tokens are mixed with alpha/tints in places; a solid colour within this distance of a token is that token. */
const PALETTE_TOLERANCE = 12

export interface OffPaletteFill {
  selector: string
  color: string
  /** The colour comes from an inline `style` (a customer's own form theme, a data swatch), not from the app's CSS. */
  inline: boolean
}

/**
 * Every visible element whose computed `background-color` is solid (alpha ≥ 0.9)
 * and not a Kiro palette colour (lib/design.ts PALETTE, same tolerance as
 * `designAudit`). Any CSS colour syntax is read through a canvas, so the oklab /
 * `color(srgb …)` values Tailwind 4 emits are judged as well as `rgb()`.
 * Inline-styled fills are returned marked `inline`: they render user data (a
 * form's chosen brand colour), which the palette rule does not govern.
 * `rootSelector` limits the scan to one subtree (an open dialog).
 */
export async function offPaletteFills(page: Page, rootSelector = 'body'): Promise<OffPaletteFill[]> {
  return page.evaluate(({ palette, tolerance, root }: { palette: string[]; tolerance: number; root: string }) => {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (ctx === null) return []
    const rgba = (css: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = '#000'
      ctx.fillStyle = css
      ctx.fillRect(0, 0, 1, 1)
      const [r = 0, g = 0, b = 0, a = 0] = Array.from(ctx.getImageData(0, 0, 1, 1).data)
      return [r, g, b, a / 255]
    }
    const tokens = palette.map((hex) => rgba(hex))
    const near = ([r, g, b]: [number, number, number, number]): boolean =>
      tokens.some(([tr, tg, tb]) => Math.abs(tr - r) + Math.abs(tg - g) + Math.abs(tb - b) <= tolerance)
    const found = new Map<string, { selector: string; color: string; inline: boolean }>()
    for (const el of Array.from(document.querySelectorAll(`${root} *`)).slice(0, 5000)) {
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      if (rect.width === 0 || rect.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue
      const value = style.backgroundColor
      if (value === '' || value === 'transparent' || value === 'rgba(0, 0, 0, 0)') continue
      const c = rgba(value)
      if (c[3] < 0.9 || near(c)) continue
      const inline = el instanceof HTMLElement && el.style.backgroundColor !== ''
      const classes = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : []
      const cls = classes.length > 0 ? `.${classes.join('.')}` : ''
      const selector = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}`.slice(0, 120)
      const color = `rgb(${c[0]}, ${c[1]}, ${c[2]})`
      found.set(`${selector}|${color}`, { selector, color, inline })
    }
    return Array.from(found.values())
  }, { palette: PALETTE, tolerance: PALETTE_TOLERANCE, root: rootSelector })
}

export async function designAudit(page: Page): Promise<DesignAudit> {
  const snapshot = await page.evaluate(({ palette, tolerance }: { palette: string[]; tolerance: number }) => {
    const toRgb = (hex: string): [number, number, number] => [
      Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16),
    ]
    const rgbPalette = palette.map(toRgb)
    // Tokens are mixed with alpha/tints in places; a solid colour within this
    // distance of a token is treated as that token.
    const TOLERANCE = tolerance
    const parse = (value: string): [number, number, number, number] | null => {
      const m = value.match(/rgba?\(([^)]+)\)/)
      if (m === null || m[1] === undefined) return null
      const parts = m[1].split(/[ ,/]+/).filter(Boolean).map(Number)
      const [r = 0, g = 0, b = 0] = parts
      const a = parts.length > 3 ? (parts[3] ?? 1) : 1
      return [r, g, b, a]
    }
    const near = (r: number, g: number, b: number): boolean =>
      rgbPalette.some(([pr, pg, pb]) => Math.abs(pr - r) + Math.abs(pg - g) + Math.abs(pb - b) <= TOLERANCE)
    const describe = (el: Element): string => {
      const id = el.id ? `#${el.id}` : ''
      const cls = typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}` : ''
      return `${el.tagName.toLowerCase()}${id}${cls}`.slice(0, 120)
    }

    const off = new Map<string, { color: string; property: string; count: number; sample: string }>()
    const elements = Array.from(document.querySelectorAll('body *')).slice(0, 4000)
    for (const el of elements) {
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none') continue
      const checks: Array<[string, string]> = [['background-color', style.backgroundColor]]
      if ((el.textContent ?? '').trim() !== '' && el.children.length === 0) checks.push(['color', style.color])
      if (style.borderTopWidth !== '0px' && style.borderTopStyle !== 'none') checks.push(['border-color', style.borderTopColor])
      for (const [property, value] of checks) {
        const rgba = parse(value)
        if (rgba === null) continue
        const [r, g, b, a] = rgba
        if (a < 0.9 || near(r, g, b)) continue
        const key = `${property}:${r},${g},${b}`
        const entry = off.get(key)
        if (entry) entry.count += 1
        else off.set(key, { color: `rgb(${r}, ${g}, ${b})`, property, count: 1, sample: describe(el) })
      }
    }

    const text = document.body.innerText
    const emojiMatches = text.match(/(?:\p{Extended_Pictographic}|\p{Regional_Indicator})/gu) ?? []
    const emojis = Array.from(new Set(emojiMatches.filter((c) => !['©', '®', '™', '↔', '↕', '‼', '⁉', '→', '←'].includes(c)))).slice(0, 20)
    const headings = Array.from(document.querySelectorAll('h1, h2')).slice(0, 5).map((h) => getComputedStyle(h).fontFamily)

    return {
      themeAttr: document.documentElement.getAttribute('data-theme'),
      modeAttr: document.documentElement.getAttribute('data-mode'),
      bodyFont: getComputedStyle(document.body).fontFamily,
      headingFonts: Array.from(new Set(headings)),
      emojis,
      offPalette: Array.from(off.values()).sort((x, y) => y.count - x.count).slice(0, 15),
    }
  }, { palette: PALETTE, tolerance: PALETTE_TOLERANCE })

  const focus = await focusAudit(page)
  return { ...snapshot, focus }
}

/** Drop focus without a key press (a key would act on the page under audit). */
async function blurActive(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
}

/** Tabs through the first stops and checks each has a visible indicator. */
async function focusAudit(page: Page): Promise<DesignAudit['focus']> {
  const results: DesignAudit['focus'] = []
  try {
    await blurActive(page)
    for (const _stop of [1, 2, 3]) {
      await page.keyboard.press('Tab')
      const info = await page.evaluate(() => {
        const el = document.activeElement
        if (!(el instanceof HTMLElement) || el === document.body) return null
        const s = getComputedStyle(el)
        const outline = s.outlineStyle !== 'none' && Number.parseFloat(s.outlineWidth) > 0
        const shadow = s.boxShadow !== 'none' && s.boxShadow !== ''
        const label = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 40) ?? ''
        return {
          element: `${el.tagName.toLowerCase()} "${label}"`,
          visible: outline || shadow,
          detail: `outline=${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}; shadow=${s.boxShadow.slice(0, 80)}`,
        }
      })
      if (info !== null) results.push(info)
    }
    // Leave the page as found by BLURRING, never Escape: Escape is the close key of
    // the overlay being audited (the assistant's sessions drawer closed under the
    // audit whenever all three Tabs landed inside it, and the spec's own Close then
    // timed out). A blur closes nothing that a focus-out does not already close.
    await blurActive(page)
  } catch {
    // focus audit is best-effort evidence; absence is reported as an empty list
  }
  return results
}
