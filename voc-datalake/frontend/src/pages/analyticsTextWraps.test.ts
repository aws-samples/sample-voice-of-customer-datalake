/**
 * Wave 4 (owner request, WCAG 1.4.4 / 1.4.10): card text on the analytics pages WRAPS, it is never
 * cut with an ellipsis. Clipped labels were found by screenshot and by scrollWidth > clientWidth
 * at 1440 / 1024 / 768 / 390 px and 200 % text; every one now wraps (`min-w-0` + `break-words`).
 * A dense list may still clamp to a few lines (`line-clamp-*`) when the full text is one click away.
 * This pins the class contract so a new `truncate` in these files has to be argued for.
 */
import { describe, expect, it } from 'vitest'

const SOURCES = import.meta.glob<string>([
  './Home/**/*.tsx', './Dashboard/**/*.tsx', './Categories/**/*.tsx', './FeedbackDetail/**/*.tsx',
  './ProblemAnalysis/**/*.tsx', './Prioritization/**/*.tsx', './Radar/**/*.tsx',
  '../components/ReviewModal/*.tsx', '../components/ReviewLink/*.tsx',
  '../components/FeedbackDimensions/*.tsx', '../components/FeedbackCard/*.tsx',
  '!./**/*.test.tsx', '!../components/**/*.test.tsx',
], { query: '?raw', import: 'default', eager: true })

/** A `truncate` CLASS (in a className string, plain or `clsx(...)`), not the word in a comment. */
const TRUNCATE_CLASS = /className=\{?(?:clsx\()?["'`][^"'`]*\btruncate\b/u

describe('analytics card text wraps instead of truncating', () => {
  it('found the files it guards', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(40)
  })

  it('uses no `truncate` class on any label, title or value', () => {
    const offenders = Object.entries(SOURCES).filter(([, text]) => TRUNCATE_CLASS.test(text)).map(([path]) => path)
    expect(offenders).toStrictEqual([])
  })
})
