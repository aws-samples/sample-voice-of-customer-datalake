/**
 * Pins the data ramp (`--chart-1…8` in index.css) to KiroCrew's categorical
 * data hues and to the properties a chart palette needs, in both themes:
 *  - SOURCE: the steps are KiroCrew's `--ctx-src-*` / `--ctx-cat-*` hues
 *    (kirodotdev/kirocrew website/src/index.css). Dark uses KiroCrew's own recipe
 *    exactly (`color-mix(in srgb, <hue> 74%, var(--card))`); light keeps each hue
 *    and darkens it, because the 74%-into-white mix is 1.5–2.3:1 on the white card.
 *    Reverting to the old purple→pink ramp fails these pins.
 *  - WCAG 1.4.11: every step ≥ 3:1 against `--card`. Steps are fills (bars,
 *    lines, swatches, row edges), never text — the last case checks no
 *    `text-chart-*` utility is used.
 *  - every pair of steps ≥ 10 ΔE2000 apart, so two categories never share a
 *    colour to the eye.
 * See docs/kiro-design-system.md › Sentiment and data visualisation.
 */
import { describe, expect, it } from 'vitest'
import { appTsxLines } from '@test/appSources'
import { THEMES, contrastRatio, hueDistance, hueOf, mixHex, themeHex } from '@test/themeTokens'

const MIN_NON_TEXT_CONTRAST = 3
const MIN_DELTA_E = 10
/** KiroCrew mixes each data hue this far into the card (`--ctx-src-*`). */
const KIROCREW_MIX = 0.74
/** Rounding to whole sRGB bytes moves a darkened hue by well under this. */
const MAX_HUE_DRIFT_DEG = 3

/**
 * The KiroCrew hue behind each step (`null` = the neutral step, `--muted`).
 * Step 1 rides the accent like KiroCrew's `--ctx-cat-message`; green and amber
 * come last so a short category list does not read as ok / warn statuses.
 */
const KIROCREW_SOURCE: ReadonlyArray<{ step: number; token: string; hue: string | null }> = [
  { step: 1, token: '--ctx-cat-message (accent)', hue: null },
  { step: 2, token: '--ctx-src-memory', hue: '#4aa8ff' },
  { step: 3, token: '--ctx-src-sys', hue: '#43c9bd' },
  { step: 4, token: '--ctx-src-lessons', hue: '#ff9d5c' },
  { step: 5, token: '--ctx-src-tool', hue: '#b98cff' },
  { step: 6, token: '--muted', hue: null },
  { step: 7, token: '--ctx-src-skill', hue: '#00c48f' },
  { step: 8, token: '--ctx-src-history', hue: '#f2c14e' },
]

type Rgb = readonly [number, number, number]
type Lab = readonly [number, number, number]

/** One sRGB channel (`#rrggbb` offset 1, 3 or 5) as linear light. */
function linearChannel(hex: string, offset: number): number {
  const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function rgbOf(hex: string): Rgb {
  return [linearChannel(hex, 1), linearChannel(hex, 3), linearChannel(hex, 5)]
}

function labOf(hex: string): Lab {
  const [r, g, b] = rgbOf(hex)
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116)
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
}

const DEG = Math.PI / 180

function hueDeg(b: number, a: number): number {
  const h = Math.atan2(b, a) / DEG
  return h < 0 ? h + 360 : h
}

/** CIEDE2000 (Sharma, Wu & Dalal 2005). */
function deltaE2000([l1, a1, b1]: Lab, [l2, a2, b2]: Lab): number {
  const cBar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)))
  const a1p = a1 * (1 + g)
  const a2p = a2 * (1 + g)
  const c1p = Math.hypot(a1p, b1)
  const c2p = Math.hypot(a2p, b2)
  const h1 = hueDeg(b1, a1p)
  const h2 = hueDeg(b2, a2p)
  const rawDh = h2 - h1
  const dh = Math.abs(rawDh) > 180 ? rawDh - Math.sign(rawDh) * 360 : rawDh
  const dL = l2 - l1
  const dC = c2p - c1p
  const dH = 2 * Math.sqrt(c1p * c2p) * Math.sin((dh * DEG) / 2)
  const lBar = (l1 + l2) / 2
  const cBarP = (c1p + c2p) / 2
  const hBar = Math.abs(h1 - h2) > 180 ? (h1 + h2) / 2 + 180 : (h1 + h2) / 2
  const t = 1 - 0.17 * Math.cos((hBar - 30) * DEG) + 0.24 * Math.cos(2 * hBar * DEG)
    + 0.32 * Math.cos((3 * hBar + 6) * DEG) - 0.2 * Math.cos((4 * hBar - 63) * DEG)
  const sL = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2)
  const sC = 1 + 0.045 * cBarP
  const sH = 1 + 0.015 * cBarP * t
  const rT = -2 * Math.sqrt(cBarP ** 7 / (cBarP ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hBar - 275) / 25) ** 2)) * DEG)
  return Math.sqrt((dL / sL) ** 2 + (dC / sC) ** 2 + (dH / sH) ** 2 + rT * (dC / sC) * (dH / sH))
}

const STEPS = [1, 2, 3, 4, 5, 6, 7, 8] as const

describe.each(THEMES)('chart ramp in %s', (theme) => {
  const card = themeHex(theme, 'card')
  const ramp = STEPS.map((step) => ({ step, hex: themeHex(theme, `chart-${step}`) }))

  // `themeHex` throws for a missing step, so building `ramp` already proves all eight exist.
  it.each(ramp)(`gives --chart-$step ($hex) at least ${MIN_NON_TEXT_CONTRAST}:1 on --card`, ({ hex }) => {
    expect(contrastRatio(hex, card)).toBeGreaterThanOrEqual(MIN_NON_TEXT_CONTRAST)
  })

  it(`keeps every pair of steps at least ${MIN_DELTA_E} ΔE2000 apart`, () => {
    const tooClose = ramp.flatMap((a, i) => ramp.slice(i + 1)
      .map((b) => ({ pair: `${a.step}-${b.step}`, delta: deltaE2000(labOf(a.hex), labOf(b.hex)) }))
      .filter(({ delta }) => delta < MIN_DELTA_E)
      .map(({ pair, delta }) => `${pair}: ${delta.toFixed(1)}`))
    expect(tooClose).toStrictEqual([])
  })

  it('puts the neutral step (--chart-6) on --muted', () => {
    expect(themeHex(theme, 'chart-6')).toBe(themeHex(theme, 'muted'))
  })
})

describe('the ramp follows KiroCrew', () => {
  const sourced = KIROCREW_SOURCE.filter((s): s is { step: number; token: string; hue: string } => s.hue !== null)

  it.each(sourced)('dark --chart-$step is KiroCrew $token ($hue) mixed 74% into --card', ({ step, hue }) => {
    expect(themeHex('kiro-dark', `chart-${step}`)).toBe(mixHex(hue, themeHex('kiro-dark', 'card'), KIROCREW_MIX))
  })

  it.each(sourced)('light --chart-$step keeps the hue of KiroCrew $token ($hue)', ({ step, hue }) => {
    expect(hueDistance(hueOf(themeHex('kiro-light', `chart-${step}`)), hueOf(hue))).toBeLessThanOrEqual(MAX_HUE_DRIFT_DEG)
  })

  it('starts on the accent: KiroCrew kiro-dark accent tint, and --accent in light', () => {
    expect(themeHex('kiro-dark', 'chart-1')).toBe('#b07fff')
    expect(themeHex('kiro-light', 'chart-1')).toBe(themeHex('kiro-light', 'accent'))
  })
})

describe('chart steps are fills, not text', () => {
  it('uses no text-chart-* utility in app UI (steps are only 3:1, below the 4.5:1 text floor)', () => {
    const offenders = appTsxLines().filter(({ line }) => /\btext-chart-\d/.test(line)).map(({ at }) => at)
    expect(offenders).toStrictEqual([])
  })
})

describe('deltaE2000', () => {
  // Sharma et al. 2005, Table 1, pair 1.
  it('matches the published reference value', () => {
    expect(deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 3)
  })
})
