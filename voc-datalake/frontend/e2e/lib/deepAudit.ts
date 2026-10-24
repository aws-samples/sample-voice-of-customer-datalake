/**
 * Deep design/accessibility audit for the design track (extends lib/design.ts,
 * which keeps its quick checks). Everything here is measured from computed
 * styles in the live page, not sampled:
 *
 * - contrast of EVERY visible text node (HTML and SVG chart text), placeholders,
 *   disabled controls (reported apart: WCAG exempts them) and form-control
 *   borders (1.4.11), against the background actually painted under the text
 *   (`elementsFromPoint` stack, alpha-composited, with ancestor opacity);
 * - conformance to docs/kiro-design-system.md: every colour maps to a Kiro token
 *   (solid or alpha), font family, size on the type scale, weight, radius,
 *   spacing on the 2px grid, lucide icons only, no emojis;
 * - readability: text below 12px that is not a decorative label, line length,
 *   truncation without a tooltip, horizontal overflow / clipping;
 * - structure: landmarks, h1 count, heading-level skips.
 *
 * `keyboardAudit` tabs through the page and checks reachability, a visible and
 * contrasting focus indicator, focus not obscured, and traps.
 */
import type { Page } from '@playwright/test'

export interface ContrastIssue {
  selector: string
  text: string
  kind: 'text' | 'large-text' | 'svg-text' | 'placeholder' | 'disabled' | 'control-border'
  fg: string
  bg: string
  ratio: number
  required: number
  fontPx: number
  weight: number
}

export interface TokenIssue {
  selector: string
  property: string
  value: string
}

export interface DeepAudit {
  textNodes: number
  contrastChecked: number
  contrast: ContrastIssue[]
  /** Text whose background could not be resolved (gradient/image) — listed, not judged. */
  contrastUnresolved: Array<{ selector: string; reason: string }>
  offPalette: Array<TokenIssue & { count: number }>
  fonts: Array<TokenIssue & { count: number }>
  typeScale: Array<TokenIssue & { count: number; text: string }>
  weights: Array<TokenIssue & { count: number }>
  radius: Array<TokenIssue & { count: number }>
  spacing: Array<TokenIssue & { count: number }>
  smallText: Array<{ selector: string; text: string; fontPx: number }>
  nonLucideSvgs: Array<{ selector: string; viewBox: string | null }>
  emojis: string[]
  longLines: Array<{ selector: string; chars: number }>
  truncatedNoTooltip: Array<{ selector: string; text: string }>
  overflow: { documentScrollWidth: number; viewportWidth: number; offenders: Array<{ selector: string; right: number; width: number }> }
  landmarks: { main: number; nav: number; banner: number; contentinfo: number; complementary: number; h1: number; headingSkips: string[] }
}

/** Every Kiro token value (both themes) from src/index.css — solid and alpha. */
const SOLID_TOKENS = [
  '#19161d', '#1c1922', '#211d25', '#28242e', '#f2f1f4', '#dcdadf', '#938f9b', '#8a8592', '#ffffff', '#352f3d',
  '#4a464f', '#5e5966', '#8e48ff', '#9f63ff', '#bd8fff', '#c19aff', '#1bb36b', '#000000', '#e0b94d', '#ff5f73',
  '#7aa3e6', '#b07fff', '#3f84c6', '#3a9c95', '#c57c4e', '#916fc6', '#099973', '#bc9643', '#f5f5f5', '#fafafa',
  '#f0f0f0', '#e4e4e7', '#d4d4d8', '#a1a1aa', '#7a35e0', '#723acc', '#ebe5f3', '#c4bcd0', '#007038', '#6b5900',
  '#bd1c3a', '#285092', '#7337d6', '#4194e0', '#359f95', '#c97c49', '#a37be0', '#00a377', '#ae8b38',
]
/** rgba tokens: [r,g,b,a]. */
const ALPHA_TOKENS: Array<[number, number, number, number]> = [
  [255, 255, 255, 0.04], [0, 0, 0, 0.03], [25, 22, 29, 0.95], [255, 255, 255, 0.95], [178, 127, 255, 0.16],
  [142, 72, 255, 0.3], [142, 72, 255, 0.12], [142, 72, 255, 0.15], [0, 133, 67, 0.15], [224, 185, 77, 0.12],
  [249, 67, 89, 0.12], [193, 154, 255, 0.15], [10, 8, 12, 0.6], [25, 22, 29, 0.4], [0, 112, 56, 0.12],
  [107, 89, 0, 0.1], [189, 28, 58, 0.1], [115, 55, 214, 0.12],
]

/** viewBoxes of components/KiroGhost and its GhostPoses — the sanctioned non-lucide brand art. */
const GHOST_VIEWBOXES = ['210 80 805 1030', '-13.755 -13.755 235.006 265.619']

export async function deepAudit(page: Page): Promise<DeepAudit> {
  return page.evaluate(({ solid, alpha, ghostViewBoxes }) => {
    type RGBA = [number, number, number, number]
    const hexRgb = (h: string): RGBA => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 1]
    const solidRgb = solid.map(hexRgb)

    // --- colour parsing (rgb/rgba, color(srgb), oklab, oklch — Tailwind 4 emits all of them)
    const lin = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
    const oklabToRgb = (L: number, a: number, b: number): [number, number, number] => {
      const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
      const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
      const s_ = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
      const r = 4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_
      const g = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_
      const bl = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_
      const to = (x: number): number => Math.round(Math.min(1, Math.max(0, lin(x))) * 255)
      return [to(r), to(g), to(bl)]
    }
    const num = (s: string | undefined, pctScale = 1): number => {
      if (s === undefined || s === 'none') return 0
      return s.endsWith('%') ? (parseFloat(s) / 100) * pctScale : parseFloat(s)
    }
    const parse = (v: string): RGBA | null => {
      if (!v || v === 'transparent') return [0, 0, 0, 0]
      let m = v.match(/^rgba?\(([^)]+)\)/)
      if (m?.[1]) {
        const p = m[1].split(/[\s,/]+/).filter(Boolean)
        return [num(p[0]), num(p[1]), num(p[2]), p[3] === undefined ? 1 : num(p[3])]
      }
      m = v.match(/^color\(srgb ([^)]+)\)/)
      if (m?.[1]) {
        const p = m[1].split(/[\s/]+/).filter(Boolean)
        return [Math.round(num(p[0]) * 255), Math.round(num(p[1]) * 255), Math.round(num(p[2]) * 255), p[3] === undefined ? 1 : num(p[3])]
      }
      m = v.match(/^oklab\(([^)]+)\)/)
      if (m?.[1]) {
        const p = m[1].split(/[\s/]+/).filter(Boolean)
        const [r, g, b] = oklabToRgb(num(p[0]), num(p[1], 0.4), num(p[2], 0.4))
        return [r, g, b, p[3] === undefined ? 1 : num(p[3])]
      }
      m = v.match(/^oklch\(([^)]+)\)/)
      if (m?.[1]) {
        const p = m[1].split(/[\s/]+/).filter(Boolean)
        const L = num(p[0]); const C = num(p[1], 0.4); const H = (num(p[2]) * Math.PI) / 180
        const [r, g, b] = oklabToRgb(L, C * Math.cos(H), C * Math.sin(H))
        return [r, g, b, p[3] === undefined ? 1 : num(p[3])]
      }
      return null
    }
    const over = (top: RGBA, bottom: RGBA): RGBA => {
      const a = top[3] + bottom[3] * (1 - top[3])
      if (a === 0) return [0, 0, 0, 0]
      const ch = (i: 0 | 1 | 2): number => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a
      return [ch(0), ch(1), ch(2), a]
    }
    const lum = (c: RGBA): number => {
      const f = (x: number): number => { const s = x / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
    }
    const ratio = (a: RGBA, b: RGBA): number => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number]
      return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100
    }
    const fmt = (c: RGBA): string => `rgb(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}${c[3] < 1 ? ` / ${Math.round(c[3] * 100) / 100}` : ''})`

    const describe = (el: Element): string => {
      const parts: string[] = []
      let cur: Element | null = el
      for (let depth = 0; cur && depth < 3; depth += 1) {
        const id = cur.id && !/^:r|^radix|^\d/.test(cur.id) ? `#${cur.id}` : ''
        const cls = typeof cur.className === 'string' && cur.className.trim() !== ''
          ? `.${cur.className.trim().split(/\s+/).slice(0, 4).join('.')}` : ''
        const testid = cur.getAttribute('data-testid')
        parts.unshift(`${cur.tagName.toLowerCase()}${id}${testid ? `[data-testid=${testid}]` : ''}${cls}`)
        if (id || testid) break
        cur = cur.parentElement
      }
      return parts.join(' > ').slice(0, 220)
    }
    const visible = (el: Element): boolean => {
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return false
      const s = getComputedStyle(el)
      if (s.visibility === 'hidden' || s.display === 'none') return false
      if (el.closest('[aria-hidden="true"], [inert]') !== null && !(el instanceof SVGElement)) return false
      return true
    }
    const isDisabled = (el: Element): boolean =>
      el.closest('button:disabled, input:disabled, select:disabled, textarea:disabled, fieldset:disabled, [aria-disabled="true"]') !== null

    // Root canvas colour (html, then body).
    const rootBg = ((): RGBA => {
      const html = parse(getComputedStyle(document.documentElement).backgroundColor) ?? [0, 0, 0, 0]
      const body = parse(getComputedStyle(document.body).backgroundColor) ?? [0, 0, 0, 0]
      return over(body, over(html, [255, 255, 255, 1]))
    })()

    const opacityOf = (el: Element): number => {
      let o = 1
      for (let cur: Element | null = el; cur; cur = cur.parentElement) o *= parseFloat(getComputedStyle(cur).opacity || '1')
      return o
    }

    /** Background painted under `el`: the stack at its centre from `el` down, composited. */
    const backgroundUnder = (el: Element): { bg: RGBA; unresolved: string | null } => {
      const r = el.getBoundingClientRect()
      const cx = Math.min(Math.max(r.left + Math.min(r.width / 2, 8), 0), innerWidth - 1)
      const cy = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1)
      const onScreen = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth
      let stack: Element[] = []
      if (onScreen) {
        const all = document.elementsFromPoint(cx, cy)
        const at = all.findIndex((x) => x === el || el.contains(x))
        // From the element down; its own descendants painted above it don't sit under its text.
        stack = at >= 0 ? all.slice(at).filter((x) => x === el || !el.contains(x)) : []
      }
      if (stack.length === 0) {
        for (let cur: Element | null = el; cur; cur = cur.parentElement) stack.push(cur)
      }
      const layers: RGBA[] = []
      for (const layer of stack) {
        const s = getComputedStyle(layer)
        if (s.backgroundImage !== 'none' && /gradient|url\(/.test(s.backgroundImage) && !layer.classList.contains('app-ambient')) {
          return { bg: rootBg, unresolved: `background-image on ${describe(layer)}` }
        }
        const c = parse(s.backgroundColor)
        if (c && c[3] > 0) {
          const op = parseFloat(s.opacity || '1')
          layers.push([c[0], c[1], c[2], c[3] * op])
          if (c[3] * op >= 0.999) break
        }
      }
      let bg: RGBA = rootBg
      for (let i = layers.length - 1; i >= 0; i -= 1) bg = over(layers[i] as RGBA, bg)
      return { bg, unresolved: null }
    }

    // --- token conformance
    const nearSolid = (c: RGBA): boolean => solidRgb.some((t) => Math.abs(t[0] - c[0]) + Math.abs(t[1] - c[1]) + Math.abs(t[2] - c[2]) <= 6)
    const nearAlpha = (c: RGBA): boolean => alpha.some((t) =>
      Math.abs(t[0] - c[0]) + Math.abs(t[1] - c[1]) + Math.abs(t[2] - c[2]) <= 6 && Math.abs(t[3] - c[3]) <= 0.03)
    /** Token at a Tailwind opacity modifier (`border-ok/30`, `bg-accent/10`): same rgb as a solid token, any alpha. */
    const tokenWithOpacity = (c: RGBA): boolean => c[3] < 1 && nearSolid([c[0], c[1], c[2], 1])
    const onPalette = (c: RGBA): boolean => c[3] === 0 || nearSolid(c) || nearAlpha(c) || tokenWithOpacity(c)

    const TYPE_SCALE = new Set([10, 11, 12, 13, 14, 15, 16, 18, 20, 24, 30, 36, 48])
    const WEIGHTS = new Set([400, 500, 600, 700])
    const RADII = new Set([0, 6, 8, 12, 16])
    const bump = <T extends { count: number }>(map: Map<string, T>, key: string, make: () => T): void => {
      const e = map.get(key)
      if (e) e.count += 1
      else map.set(key, make())
    }
    const offPalette = new Map<string, TokenIssue & { count: number }>()
    const fonts = new Map<string, TokenIssue & { count: number }>()
    const typeScale = new Map<string, TokenIssue & { count: number; text: string }>()
    const weights = new Map<string, TokenIssue & { count: number }>()
    const radius = new Map<string, TokenIssue & { count: number }>()
    const spacing = new Map<string, TokenIssue & { count: number }>()

    const contrast: ContrastIssue[] = []
    const unresolved: Array<{ selector: string; reason: string }> = []
    const smallText: DeepAudit['smallText'] = []
    const longLines: DeepAudit['longLines'] = []
    const truncated: DeepAudit['truncatedNoTooltip'] = []
    let textNodes = 0
    let checked = 0

    const all = Array.from(document.querySelectorAll('body *')).filter((el) => !(el.closest('script,style,noscript,template')))
    const seenContrast = new Set<string>()

    for (const el of all) {
      if (!visible(el)) continue
      const s = getComputedStyle(el)
      const sel = (): string => describe(el)
      const isSvg = el instanceof SVGElement

      // Colours used by the element (background, border, outline, svg paint)
      if (!isSvg || el.tagName.toLowerCase() === 'svg') {
        const props: Array<[string, string]> = [['background-color', s.backgroundColor]]
        if (parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none') props.push(['border-color', s.borderTopColor])
        for (const [p, v] of props) {
          const c = parse(v)
          if (c && !onPalette(c)) bump(offPalette, `${p}|${fmt(c)}|${sel()}`, () => ({ selector: sel(), property: p, value: fmt(c), count: 1 }))
        }
      } else if (/^(rect|path|circle|line|text|tspan|polygon|polyline|ellipse)$/.test(el.tagName.toLowerCase()) && el.closest('.recharts-wrapper, .recharts-surface, svg') !== null) {
        for (const p of ['fill', 'stroke'] as const) {
          const v = s.getPropertyValue(p)
          if (!v || v === 'none' || v.startsWith('url(')) continue
          const c = parse(v)
          if (c && !onPalette(c)) bump(offPalette, `${p}|${fmt(c)}|${sel()}`, () => ({ selector: sel(), property: p, value: fmt(c), count: 1 }))
        }
      }

      // Radius (HTML only)
      if (!isSvg) {
        const rad = parseFloat(s.borderTopLeftRadius)
        const r = el.getBoundingClientRect()
        const isPill = rad >= Math.min(r.width, r.height) / 2 - 1 || s.borderTopLeftRadius.includes('%') || rad >= 999
        if (rad > 0 && !isPill && !RADII.has(Math.round(rad))) bump(radius, `${rad}|${sel()}`, () => ({ selector: sel(), property: 'border-radius', value: s.borderTopLeftRadius, count: 1 }))
        for (const p of ['paddingTop', 'paddingLeft', 'rowGap', 'columnGap'] as const) {
          const v = parseFloat(s[p])
          if (Number.isFinite(v) && v > 0 && Math.abs(v / 2 - Math.round(v / 2)) > 0.01 && v !== 1) {
            bump(spacing, `${p}|${v}|${sel()}`, () => ({ selector: sel(), property: p, value: `${v}px`, count: 1 }))
          }
        }
      }

      // Icons: every inline svg should be lucide (KiroGhost and chart surfaces excepted).
      // (collected below)

      // Text
      const ownText = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? '').join('').trim()
      const isSvgText = isSvg && /^(text|tspan)$/.test(el.tagName.toLowerCase())
      if (ownText === '' && !(isSvgText && (el.textContent ?? '').trim() !== '')) {
        // Placeholders and control borders handled below
      } else {
        textNodes += 1
        const text = (ownText || el.textContent || '').trim().slice(0, 60)
        const fontPx = parseFloat(s.fontSize)
        const weight = parseInt(s.fontWeight, 10) || 400
        const family = (s.fontFamily.split(',')[0] ?? '').replace(/["']/g, '').trim()
        if (!/^(Space Grotesk|JetBrains Mono)$/.test(family)) bump(fonts, `${family}|${sel()}`, () => ({ selector: sel(), property: 'font-family', value: s.fontFamily.slice(0, 80), count: 1 }))
        if (!TYPE_SCALE.has(Math.round(fontPx * 10) / 10)) bump(typeScale, `${fontPx}|${sel()}`, () => ({ selector: sel(), property: 'font-size', value: `${fontPx}px`, count: 1, text }))
        if (!WEIGHTS.has(weight)) bump(weights, `${weight}|${sel()}`, () => ({ selector: sel(), property: 'font-weight', value: String(weight), count: 1 }))
        const decorative = s.textTransform === 'uppercase' || /^\(?[\d.,%+\-–kKmM ]+\)?$/.test(text) || /mono/i.test(s.fontFamily)
        if (fontPx < 12 && !decorative) smallText.push({ selector: sel(), text, fontPx })
        // Readability: characters per line for paragraphs
        if (!isSvg && /^(P|LI|DD|BLOCKQUOTE)$/.test(el.tagName) && text.length > 40) {
          const chars = Math.round(el.getBoundingClientRect().width / (fontPx * 0.5))
          const lines = Math.round(el.getBoundingClientRect().height / (parseFloat(s.lineHeight) || fontPx * 1.5))
          if (chars > 100 && lines > 1) longLines.push({ selector: sel(), chars })
        }
        // Truncation without a tooltip (sr-only text is clipped on purpose)
        if (!isSvg && el instanceof HTMLElement && el.getBoundingClientRect().width > 2) {
          const clipsX = (s.textOverflow === 'ellipsis' || s.overflow === 'hidden') && el.scrollWidth > el.clientWidth + 1
          const clamped = s.webkitLineClamp !== 'none' && s.webkitLineClamp !== '' && el.scrollHeight > el.clientHeight + 1
          if (clipsX || clamped) {
            const tip = el.closest('[title]') ?? el.querySelector('[title]')
            const named = el.closest('[aria-label]')
            if (tip === null && named === null) truncated.push({ selector: sel(), text })
          }
        }
        // Contrast
        const fg = parse(isSvgText ? s.fill : s.color)
        if (fg !== null) {
          const { bg, unresolved: why } = backgroundUnder(el)
          if (why !== null) unresolved.push({ selector: sel(), reason: why })
          else {
            checked += 1
            const op = opacityOf(el)
            const fgEff = over([fg[0], fg[1], fg[2], fg[3] * op], bg)
            const r = ratio(fgEff, bg)
            const large = fontPx >= 24 || (fontPx >= 18.66 && weight >= 700)
            const required = large ? 3 : 4.5
            const disabled = isDisabled(el)
            if (r < required) {
              const key = `${sel()}|${fmt(fgEff)}|${fmt(bg)}`
              if (!seenContrast.has(key)) {
                seenContrast.add(key)
                contrast.push({
                  selector: sel(), text, kind: disabled ? 'disabled' : isSvgText ? 'svg-text' : large ? 'large-text' : 'text',
                  fg: fmt(fgEff), bg: fmt(bg), ratio: r, required, fontPx, weight,
                })
              }
            }
          }
        }
      }

      // Placeholders + control borders
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        const { bg } = backgroundUnder(el)
        if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.placeholder && el.value === '') {
          const ph = parse(getComputedStyle(el, '::placeholder').color)
          if (ph) {
            checked += 1
            const fgEff = over(ph, bg)
            const r = ratio(fgEff, bg)
            if (r < 4.5) contrast.push({ selector: sel(), text: el.placeholder.slice(0, 60), kind: isDisabled(el) ? 'disabled' : 'placeholder', fg: fmt(fgEff), bg: fmt(bg), ratio: r, required: 4.5, fontPx: parseFloat(s.fontSize), weight: parseInt(s.fontWeight, 10) })
          }
        }
        const type = el instanceof HTMLInputElement ? el.type : el.tagName.toLowerCase()
        if (!['checkbox', 'radio', 'range', 'hidden', 'file', 'color'].includes(type) && parseFloat(s.borderTopWidth) > 0) {
          const border = parse(s.borderTopColor)
          // The control's outer surroundings: what is painted under the control's parent.
          const parentBg = el.parentElement ? backgroundUnder(el.parentElement).bg : rootBg
          const own = parse(s.backgroundColor) ?? [0, 0, 0, 0]
          const fill = over(own, parentBg)
          if (border) {
            const bEff = over(border, parentBg)
            const rb = ratio(bEff, parentBg)
            const rf = ratio(fill, parentBg)
            if (Math.max(rb, rf) < 3) contrast.push({ selector: sel(), text: `(${type} boundary)`, kind: isDisabled(el) ? 'disabled' : 'control-border', fg: fmt(bEff), bg: fmt(parentBg), ratio: Math.max(rb, rf), required: 3, fontPx: 0, weight: 0 })
          }
        }
      }
    }

    // Icons
    const nonLucide: DeepAudit['nonLucideSvgs'] = []
    for (const svg of Array.from(document.querySelectorAll('svg'))) {
      if (!visible(svg)) continue
      const cls = svg.getAttribute('class') ?? ''
      if (/lucide/.test(cls) || svg.closest('.recharts-wrapper') || svg.parentElement?.closest('svg')) continue
      if (/ghost|kiro/i.test(cls) || svg.closest('[data-brand], [data-testid*="ghost"]')) continue
      // KiroGhost (components/KiroGhost) — the one sanctioned non-lucide svg.
      if (ghostViewBoxes.includes(svg.getAttribute('viewBox') ?? '')) continue
      if (svg.closest('[data-testid="qr-code"], .qr, canvas, .react-flow')) continue
      nonLucide.push({ selector: describe(svg), viewBox: svg.getAttribute('viewBox') })
    }

    // Emojis
    const emojiMatches = document.body.innerText.match(/(?:\p{Extended_Pictographic}|\p{Regional_Indicator})/gu) ?? []
    const emojis = Array.from(new Set(emojiMatches.filter((c) => !['©', '®', '™', '↔', '↕', '‼', '⁉', '→', '←', '↑', '↓', '✓', '✕', '×', '⌘'].includes(c))))

    // Overflow
    const vw = document.documentElement.clientWidth
    const offenders: DeepAudit['overflow']['offenders'] = []
    for (const el of all) {
      if (!(el instanceof HTMLElement) || !visible(el)) continue
      const r = el.getBoundingClientRect()
      if (r.right <= vw + 1 || r.left >= vw) continue
      // Inside a horizontally scrollable or clipping ancestor: intended.
      let clipped = false
      for (let cur = el.parentElement; cur && cur !== document.body; cur = cur.parentElement) {
        const cs = getComputedStyle(cur)
        if (/(auto|scroll|hidden|clip)/.test(cs.overflowX)) { clipped = true; break }
        if (cs.position === 'fixed') break
      }
      if (clipped) continue
      if (getComputedStyle(el).position === 'fixed' && r.left >= vw - 1) continue
      // Offscreen drawers (translated out) are fine
      if (r.left >= vw - 1) continue
      offenders.push({ selector: describe(el), right: Math.round(r.right), width: Math.round(r.width) })
    }
    // Keep the outermost offenders only
    const top = offenders.filter((o, i) => !offenders.slice(0, i).some((p) => o.selector.startsWith(p.selector))).slice(0, 15)

    // Landmarks and headings
    const count = (q: string): number => Array.from(document.querySelectorAll(q)).filter(visible).length
    const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter(visible)
    const skips: string[] = []
    let prev = 0
    for (const h of headings) {
      const lvl = Number(h.tagName[1])
      if (prev > 0 && lvl > prev + 1) skips.push(`h${prev}→h${lvl} "${(h.textContent ?? '').trim().slice(0, 40)}"`)
      prev = lvl
    }

    const sortMap = <T extends { count: number }>(m: Map<string, T>, n = 40): T[] => Array.from(m.values()).sort((a, b) => b.count - a.count).slice(0, n)
    return {
      textNodes,
      contrastChecked: checked,
      contrast: contrast.sort((a, b) => a.ratio - b.ratio).slice(0, 80),
      contrastUnresolved: unresolved.slice(0, 20),
      offPalette: sortMap(offPalette),
      fonts: sortMap(fonts),
      typeScale: sortMap(typeScale),
      weights: sortMap(weights),
      radius: sortMap(radius),
      spacing: sortMap(spacing),
      smallText: smallText.slice(0, 30),
      nonLucideSvgs: nonLucide.slice(0, 20),
      emojis,
      longLines: longLines.slice(0, 10),
      truncatedNoTooltip: truncated.slice(0, 30),
      overflow: { documentScrollWidth: document.documentElement.scrollWidth, viewportWidth: vw, offenders: top },
      landmarks: {
        main: count('main, [role="main"]'),
        nav: count('nav, [role="navigation"]'),
        banner: count('header:not(main header):not(article header):not(section header):not(aside header):not([role="dialog"] header), [role="banner"]'),
        contentinfo: count('footer:not(main footer):not(article footer):not(section footer):not([role="dialog"] footer), [role="contentinfo"]'),
        complementary: count('aside, [role="complementary"]'),
        h1: count('h1'),
        headingSkips: skips.slice(0, 10),
      },
    }
  }, { solid: SOLID_TOKENS, alpha: ALPHA_TOKENS, ghostViewBoxes: GHOST_VIEWBOXES })
}

export interface FocusStop {
  index: number
  selector: string
  name: string
  visible: boolean
  indicator: string
  indicatorContrast: number | null
  obscured: boolean
}

export interface KeyboardAudit {
  interactive: number
  stops: FocusStop[]
  unreached: string[]
  noIndicator: FocusStop[]
  lowContrastIndicator: FocusStop[]
  obscured: FocusStop[]
  positiveTabindex: string[]
  cycled: boolean
  /** Tabbing ran out of budget before wrapping to the first stop. */
  truncated: boolean
}

/**
 * Tabs through the page (from the top) up to `maxStops`, recording for each
 * stop whether a focus indicator appears (outline, or box-shadow/border/bg that
 * differs from the unfocused state), its contrast against what is painted
 * around it, and whether something covers it. Interactive elements never
 * reached are listed. `scope` limits the walk to one container (a dialog).
 */
export async function keyboardAudit(page: Page, options: { maxStops?: number; scope?: string } = {}): Promise<KeyboardAudit> {
  const maxStops = options.maxStops ?? 120
  const scope = options.scope ?? 'body'
  const total = await page.evaluate((sc) => {
    const root = document.querySelector(sc) ?? document.body
    const q = 'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"], iframe'
    let i = 0
    const rest: Record<string, { outline: string; shadow: string; border: string; bg: string }> = {}
    for (const el of Array.from(root.querySelectorAll(q))) {
      if (!(el instanceof HTMLElement)) continue
      const r = el.getBoundingClientRect()
      const s = getComputedStyle(el)
      const disabled = (el as HTMLButtonElement).disabled === true || el.getAttribute('tabindex') === '-1'
      if (r.width < 1 || r.height < 1 || s.visibility === 'hidden' || disabled || el.closest('[inert], [aria-hidden="true"]')) continue
      if (el instanceof HTMLInputElement && el.type === 'hidden') continue
      el.setAttribute('data-qa-kbd', String(i))
      // A visually hidden control (sr-only switch/checkbox) shows focus on what is drawn for it.
      const shown = r.width <= 2 ? (el.nextElementSibling ?? el.closest('label') ?? el.parentElement ?? el) : el
      const vs = getComputedStyle(shown)
      rest[String(i)] = { outline: `${vs.outlineStyle} ${vs.outlineWidth} ${vs.outlineColor}`, shadow: vs.boxShadow, border: vs.borderTopColor, bg: vs.backgroundColor }
      i += 1
    }
    ;(window as unknown as { __qaRest: typeof rest }).__qaRest = rest
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    return i
  }, scope)

  const stops: FocusStop[] = []
  const reached = new Set<string>()
  let cycled = false
  let first: string | null = null
  // Focus styles animate (transition-colors); measure the settled state, not mid-transition.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  for (let n = 0; n < maxStops; n += 1) {
    await page.keyboard.press('Tab')
    const info = await page.evaluate(async () => {
      // Two frames: with reduced motion the 0.01ms focus transitions have finished by then.
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
      const focused = document.activeElement
      if (!(focused instanceof HTMLElement) || focused === document.body) return null
      const id = focused.getAttribute('data-qa-kbd')
      const fr = focused.getBoundingClientRect()
      // sr-only control (peer-styled switch/checkbox): its focus shows on the drawn sibling.
      const shown = fr.width <= 2 ? (focused.nextElementSibling ?? focused.closest('label') ?? focused.parentElement ?? focused) : focused
      const el = shown instanceof HTMLElement ? shown : focused
      const rest = (window as unknown as { __qaRest: Record<string, { outline: string; shadow: string; border: string; bg: string }> }).__qaRest[id ?? ''] ?? null
      const s = getComputedStyle(el)
      const outlineOn = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0
      const outline = `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`
      const shadowChanged = rest !== null ? s.boxShadow !== rest.shadow && s.boxShadow !== 'none' : s.boxShadow !== 'none'
      const borderChanged = rest !== null && s.borderTopColor !== rest.border
      const bgChanged = rest !== null && s.backgroundColor !== rest.bg
      // Indicator colours: every component that changed on focus (outline, box-shadow colours,
      // border, background). The indicator is judged by its strongest component.
      const candidates: string[] = []
      if (outlineOn) candidates.push(s.outlineColor)
      if (shadowChanged) candidates.push(...(s.boxShadow.match(/rgba?\([^)]+\)/g) ?? []))
      if (borderChanged) candidates.push(s.borderTopColor)
      if (bgChanged) candidates.push(s.backgroundColor)
      const parse = (v: string): [number, number, number, number] | null => {
        const m = v.match(/rgba?\(([^)]+)\)/)
        if (!m?.[1]) return null
        const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
        return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1]
      }
      const lum = (c: number[]): number => {
        const f = (x: number): number => { const v = x / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
        return 0.2126 * f(c[0] ?? 0) + 0.7152 * f(c[1] ?? 0) + 0.0722 * f(c[2] ?? 0)
      }
      let indicatorContrast: number | null = null
      if (candidates.length > 0) {
        // What surrounds the element: the first opaque-ish background up the tree.
        let bg: [number, number, number, number] = [25, 22, 29, 1]
        for (let cur = el.parentElement; cur; cur = cur.parentElement) {
          const c = parse(getComputedStyle(cur).backgroundColor)
          if (c && c[3] > 0.5) { bg = c; break }
          if (cur === document.documentElement) {
            const b = parse(getComputedStyle(document.body).backgroundColor)
            if (b) bg = b
          }
        }
        for (const colour of candidates) {
          const ic = parse(colour)
          if (!ic) continue
          const comp = [0, 1, 2].map((i) => (ic[i] ?? 0) * ic[3] + (bg[i] ?? 0) * (1 - ic[3]))
          const [a, b] = [lum(comp), lum(bg)].sort((x, y) => y - x) as [number, number]
          const r = Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100
          indicatorContrast = Math.max(indicatorContrast ?? 0, r)
        }
      }
      const r = el.getBoundingClientRect()
      const cx = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1)
      const cy = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1)
      const hit = document.elementFromPoint(cx, cy)
      const obscured = hit !== null && hit !== el && !el.contains(hit) && !hit.contains(el) && el.tagName !== 'IFRAME'
      const cls = typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).slice(0, 4).join('.')}` : ''
      const name = (focused.getAttribute('aria-label') ?? focused.textContent ?? focused.getAttribute('placeholder') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 50)
      return {
        id, selector: `${el.tagName.toLowerCase()}${cls}`.slice(0, 140), name,
        visible: outlineOn || shadowChanged || borderChanged || bgChanged,
        indicator: outlineOn ? `outline ${outline}` : shadowChanged ? `shadow ${s.boxShadow.slice(0, 90)}` : borderChanged ? `border ${s.borderTopColor}` : bgChanged ? `background ${s.backgroundColor}` : 'none',
        indicatorContrast, obscured,
      }
    })
    if (info === null) continue
    const key = info.id ?? `${info.selector}|${info.name}`
    if (first === null) first = key
    else if (key === first) { cycled = true; break }
    reached.add(key)
    stops.push({ index: n, selector: info.selector, name: info.name, visible: info.visible, indicator: info.indicator, indicatorContrast: info.indicatorContrast, obscured: info.obscured })
  }
  await page.emulateMedia({ reducedMotion: null })
  const extra = await page.evaluate((reachedIds: string[]) => {
    const set = new Set(reachedIds)
    const unreached: string[] = []
    for (const el of Array.from(document.querySelectorAll('[data-qa-kbd]'))) {
      const id = el.getAttribute('data-qa-kbd') ?? ''
      if (!set.has(id)) {
        const cls = typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}` : ''
        unreached.push(`${el.tagName.toLowerCase()}${cls} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}"`)
      }
      el.removeAttribute('data-qa-kbd')
    }
    const positive = Array.from(document.querySelectorAll('[tabindex]')).filter((el) => Number(el.getAttribute('tabindex')) > 0)
      .map((el) => `${el.tagName.toLowerCase()} tabindex=${el.getAttribute('tabindex')}`)
    return { unreached: unreached.slice(0, 40), positive }
  }, Array.from(reached))
  return {
    interactive: total,
    stops,
    unreached: cycled ? extra.unreached : [],
    noIndicator: stops.filter((s) => !s.visible),
    lowContrastIndicator: stops.filter((s) => s.visible && s.indicatorContrast !== null && s.indicatorContrast < 3),
    obscured: stops.filter((s) => s.obscured),
    positiveTabindex: extra.positive,
    cycled,
    truncated: !cycled,
  }
}

/** Under `prefers-reduced-motion: reduce`, the longest animation/transition on screen (ms). */
export async function motionAudit(page: Page): Promise<{ longestMs: number; offenders: string[] }> {
  return page.evaluate(() => {
    const ms = (v: string): number => Math.max(...v.split(',').map((x) => (x.trim().endsWith('ms') ? parseFloat(x) : parseFloat(x) * 1000)))
    let longest = 0
    const offenders: string[] = []
    for (const el of Array.from(document.querySelectorAll('body *')).slice(0, 5000)) {
      const s = getComputedStyle(el)
      const a = s.animationName !== 'none' ? ms(s.animationDuration) * (s.animationIterationCount === 'infinite' ? 1000 : 1) : 0
      const t = ms(s.transitionDuration)
      const worst = Math.max(a, t)
      if (worst > longest) longest = worst
      if (worst > 1 && offenders.length < 10) offenders.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 3).join('.')} anim=${s.animationName} ${s.animationDuration} x${s.animationIterationCount} trans=${s.transitionDuration}`)
    }
    return { longestMs: longest, offenders }
  })
}
