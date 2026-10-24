/**
 * The context chip names every page in every locale: each `PageKind` and each
 * route label in `PAGE_PATTERNS` has a non-empty `assistant:pages.*` string,
 * so the chip never shows a raw key like "pages.agents".
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { z } from 'zod'
import { sortedStrings } from '@test/stringLists'
import { PAGE_KINDS } from '../contract'
import { PAGE_PATTERNS, pageContextFromLocation, pageLabelKey } from './pageContext'

const LOCALES_DIR = path.join(__dirname, '../../../public/locales')
const LOCALES = fs.readdirSync(LOCALES_DIR).filter((name) => fs.statSync(path.join(LOCALES_DIR, name)).isDirectory())
const pagesSchema = z.object({ pages: z.record(z.string(), z.string().min(1)) })

const REQUIRED_KEYS = [...new Set([...PAGE_KINDS, ...PAGE_PATTERNS.map((p) => p.label ?? p.kind)])]

function pageKeys(locale: string): Set<string> {
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'assistant.json'), 'utf8'))
  return new Set(Object.keys(pagesSchema.parse(raw).pages))
}

describe('assistant page labels', () => {
  it('covers the nine shipped locales', () => {
    expect(sortedStrings(LOCALES)).toStrictEqual(['de', 'en', 'es', 'fr', 'ja', 'ko', 'pl', 'pt', 'zh'])
  })

  it.each(LOCALES)('%s names every page kind and route label', (locale) => {
    const keys = pageKeys(locale)
    expect(REQUIRED_KEYS.filter((key) => !keys.has(key))).toStrictEqual([])
  })

  it.each([
    ['/admin', 'admin'],
    ['/settings', 'admin'],
    ['/agents', 'agents'],
    ['/agents/workflows/wf_1', 'workflow'],
    ['/agents/ag_1', 'agent'],
    ['/memory', 'memory'],
    ['/company', 'company'],
    ['/connect', 'connect'],
    ['/radar', 'radar'],
    ['/account', 'account'],
    ['/nowhere', 'other'],
  ])('labels %s as %s', (pathname, label) => {
    expect(pageLabelKey(pageContextFromLocation({ pathname, search: '' }))).toBe(label)
  })
})
