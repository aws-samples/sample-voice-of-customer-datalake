/**
 * The print/widget hexes are the Kiro Light tokens, read back out of index.css.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readdirSync } from 'node:fs'
import { KIRO_LIGHT_HEX } from './printPalette'

const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8')
const lightStart = css.indexOf('[data-theme="kiro-light"] {')
const lightBlock = css.slice(lightStart, css.indexOf('}', lightStart))

/** The value of `--name` in the Kiro Light block. */
function lightToken(name: string): string | undefined {
  return new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(lightBlock)?.[1]
}

const TOKEN_OF: Record<keyof typeof KIRO_LIGHT_HEX, string> = {
  accent: 'accent',
  aim: 'aim',
  textStrong: 'text-strong',
  bg: 'bg',
  ok: 'ok',
  warn: 'warn',
  info: 'info',
}

/**
 * The Kiro Light tokens a print file may inline as hex (read from index.css, so
 * the allowlist cannot drift from the palette it stands for).
 */
const PRINT_TOKENS = [
  'accent', 'accent-text', 'aim', 'text-strong', 'text', 'muted', 'bg', 'bg-accent', 'border',
  'ok', 'warn', 'danger', 'info',
] as const

describe('KIRO_LIGHT_HEX', () => {
  it('finds the Kiro Light block', () => {
    expect(lightStart).toBeGreaterThan(-1)
  })

  it.each(Object.entries(TOKEN_OF))('%s equals --%s in Kiro Light', (key, token) => {
    const entry = Object.entries(KIRO_LIGHT_HEX).find(([k]) => k === key)
    expect(entry?.[1]).toBe(lightToken(token))
  })
})

/**
 * The tinted fills print needs as SOLID colours: each Kiro Light `*-subtle`
 * token (an rgba) flattened over white, because a PDF renderer composites
 * translucent fills inconsistently. `accentBorder` is the accent at 35% for
 * light rules and outlines. Pinned to the rgba tokens below; the print files may use these too.
 */
const KIRO_LIGHT_TINT_HEX = {
  accentSubtle: '#f1e9ff',
  accentBorder: '#d7bfff',
  okSubtle: '#e0eee7',
  warnSubtle: '#f0eee6',
  dangerSubtle: '#f8e8eb',
} as const

/** `rgba(r, g, b, a)` of `--name` in the Kiro Light block, flattened over white. */
function flattenedLightToken(name: string): string | undefined {
  const m = new RegExp(`--${name}:\\s*rgba\\((\\d+),\\s*(\\d+),\\s*(\\d+),\\s*([.\\d]+)\\)`).exec(lightBlock)
  if (m === null) return undefined
  const alpha = Number(m[4])
  return `#${[m[1], m[2], m[3]].map((c) => Math.round(Number(c) * alpha + 255 * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`
}

describe('KIRO_LIGHT_TINT_HEX', () => {
  it.each([
    ['accentSubtle', 'accent-subtle'],
    ['okSubtle', 'ok-subtle'],
    ['warnSubtle', 'warn-subtle'],
    ['dangerSubtle', 'danger-subtle'],
  ] as const)('%s is --%s flattened over white', (key, token) => {
    expect(KIRO_LIGHT_TINT_HEX[key]).toBe(flattenedLightToken(token))
  })
})

/** Every PDF / print renderer: the files that style with inline hex because CSS variables do not reach print. */
const PRINT_FILES = readdirSync(resolve(__dirname, '..'), { recursive: true, encoding: 'utf8' })
  .filter((rel) => /PDF[A-Za-z]*\.tsx$|pdfParts\.tsx$|BreakdownTable\.tsx$|printUtils\.ts$|lib\/sentiment\.ts$/.test(rel))
  .filter((rel) => !rel.includes('.test.'))

describe('PDF / print colours (E2E F12)', () => {
  const tokenHexes = PRINT_TOKENS.map((token) => lightToken(token))
  const allowed = new Set<string>([
    ...tokenHexes.filter((hex) => hex !== undefined).map((hex) => hex.toLowerCase()),
    ...Object.values(KIRO_LIGHT_TINT_HEX),
  ])

  it('reads every print token from the Kiro Light block', () => {
    expect(tokenHexes.filter((hex) => hex === undefined)).toStrictEqual([])
  })

  it('finds the print renderers', () => {
    expect(PRINT_FILES.length).toBeGreaterThanOrEqual(10)
  })

  it.each(PRINT_FILES)('%s uses Kiro Light hexes only', (rel) => {
    const source = readFileSync(resolve(__dirname, '..', rel), 'utf8')
    const offPalette = [...source.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toLowerCase()).filter((hex) => !allowed.has(hex))
    expect(offPalette).toStrictEqual([])
  })
})
