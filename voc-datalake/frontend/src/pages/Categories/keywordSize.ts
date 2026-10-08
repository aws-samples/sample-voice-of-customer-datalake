/**
 * @fileoverview Trending-keyword font size on the type scale.
 * @module pages/Categories/keywordSize
 */

/**
 * Keyword sizes, the type-scale steps 12 · 13 · 14 · 16 · 18 · 20 px. The cloud
 * used a continuous 0.65–1.25rem, so the rarest keywords rendered at 10.4px —
 * below the 12px content floor — and sizes fell between the scale's steps
 * (design audit D-TYPE).
 */
const KEYWORD_SIZES_PX = [12, 13, 14, 16, 18, 20] as const

/** Font size in px for a keyword with `count` mentions when the top keyword has `maxCount`. */
export function keywordFontPx(count: number, maxCount: number): number {
  const share = maxCount > 0 ? Math.min(Math.max(count / maxCount, 0), 1) : 0
  const step = Math.round(share * (KEYWORD_SIZES_PX.length - 1))
  return KEYWORD_SIZES_PX[step] ?? KEYWORD_SIZES_PX[0]
}
