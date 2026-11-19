/**
 * The widget's own words (UX spec §11.6): its STRINGS table has the app's nine locales, each with every key and
 * the same placeholders as English, nothing left in English where a translation is due, and no English UI text
 * anywhere in the file outside STRINGS.en. The table is read from the source itself (it lives inside the widget's
 * closure, which a page cannot reach).
 */
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { supportedLanguages } from '../../i18n/languages'
import { WIDGET_SOURCE } from '../../test/feedbackWidgetHarness'

type Words = Record<string, string | string[]>

/** The `var STRINGS = {…}` literal of the widget, parsed (never run). */
function findTable(node: ts.Node): ts.ObjectLiteralExpression | undefined {
  if (ts.isVariableDeclaration(node) && node.name.getText() === 'STRINGS' && node.initializer !== undefined
    && ts.isObjectLiteralExpression(node.initializer)) return node.initializer
  return ts.forEachChild(node, findTable)
}

function propertyName(property: ts.ObjectLiteralElementLike): string {
  if (!ts.isPropertyAssignment(property)) throw new Error(`STRINGS holds a ${ts.SyntaxKind[property.kind]}`)
  return ts.isStringLiteral(property.name) ? property.name.text : property.name.getText()
}

/** A literal of the table as its value: strings, lists of strings, objects of those. */
function literal(node: ts.Expression): unknown {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal)
  if (ts.isObjectLiteralExpression(node)) {
    return Object.fromEntries(node.properties.map((property) => [
      propertyName(property), ts.isPropertyAssignment(property) ? literal(property.initializer) : null,
    ]))
  }
  throw new Error(`STRINGS holds a ${ts.SyntaxKind[node.kind]}, not a literal`)
}

const TABLE = findTable(ts.createSourceFile('feedback-widget.js', WIDGET_SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS))
if (TABLE === undefined) throw new Error('feedback-widget.js has no STRINGS table')
const START = TABLE.getStart()
const END = TABLE.getEnd()

/** A locale's words: its strings and lists of strings, as the table holds them. */
function words(value: unknown): Words {
  if (typeof value !== 'object' || value === null) throw new Error('a locale of STRINGS is not an object')
  return Object.fromEntries(Object.entries(value).map(([key, word]: [string, unknown]): [string, string | string[]] => {
    if (typeof word === 'string') return [key, word]
    if (Array.isArray(word) && word.every((item) => typeof item === 'string')) return [key, word.map(String)]
    throw new Error(`STRINGS.${key} is neither a string nor a list of strings`)
  }))
}

const PARSED = literal(TABLE)
const STRINGS: Record<string, Words> = typeof PARSED === 'object' && PARSED !== null
  ? Object.fromEntries(Object.entries(PARSED).map(([locale, table]: [string, unknown]) => [locale, words(table)]))
  : {}

function sorted(list: string[]): string[] {
  const copy = [...list]
  copy.sort((a, b) => a.localeCompare(b))
  return copy
}
const ENGLISH = STRINGS.en ?? {}

/** `value`'s placeholders, sorted ('{n}', '{max}'…); for a list, its length. */
function shape(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return `list of ${value.length}`
  return (value ?? '').match(/\{\w+\}/g)?.sort((a, b) => a.localeCompare(b)).join(' ') ?? ''
}

// Keys whose words are the same in some locale by nature: the counter, Optional/Name/E-mail/Company in a few, TEST.
const MAY_MATCH_ENGLISH = new Set(['charCount', 'optional', 'name', 'email', 'company', 'other', 'outOf'])

describe("the widget's STRINGS", () => {
  it('has exactly the app\'s nine locales', () => {
    expect(sorted(Object.keys(STRINGS))).toStrictEqual(sorted([...supportedLanguages]))
  })

  it.each(supportedLanguages)('has every English key in %s, with the same placeholders, and none of its own', (locale) => {
    const words = STRINGS[locale] ?? {}
    const keys = Object.keys(ENGLISH)

    expect(sorted(Object.keys(words))).toStrictEqual(sorted(keys))
    expect(keys.map((key) => shape(words[key]))).toStrictEqual(keys.map((key) => shape(ENGLISH[key])))
  })

  it.each(supportedLanguages.filter((locale) => locale !== 'en'))('leaves nothing blank or in English in %s', (locale) => {
    const words = STRINGS[locale] ?? {}
    const untranslated = Object.keys(ENGLISH).filter((key) => !MAY_MATCH_ENGLISH.has(key))
      .filter((key) => JSON.stringify(words[key]) === JSON.stringify(ENGLISH[key]))
    const blank = Object.entries(words).filter(([, word]) => [word].flat().some((part) => part.trim() === ''))
      .map(([key]) => key)

    expect(untranslated).toStrictEqual([])
    expect(blank).toStrictEqual([])
  })

  it('keeps the words the UX spec gives in English and Polish (§11.6)', () => {
    const pick = (locale: string) => ['next', 'previous', 'submit', 'chooseUpTo', 'none', 'testKeep', 'preview'].map((key) => STRINGS[locale]?.[key])

    expect(pick('en')).toStrictEqual(['Next', 'Back', 'Submit', 'Choose up to {n}', 'None of these', "TEST · Responses aren't counted", 'Preview · Nothing is sent'])
    expect(pick('pl')).toStrictEqual(['Dalej', 'Wstecz', 'Wyślij', 'Wybierz maksymalnie {n}', 'Żadne z powyższych', 'TEST · Odpowiedzi nie są liczone', 'Podgląd · Nic nie jest wysyłane'])
  })

  it('has no English UI words anywhere in the file outside STRINGS.en (comments aside)', () => {
    const outside = (WIDGET_SOURCE.slice(0, START) + WIDGET_SOURCE.slice(END))
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    const english = Object.values(ENGLISH).flat().filter((word) => word.length > 3)
    const quoted = english.filter((word) => outside.includes(`'${word}'`) || outside.includes(`"${word}"`))

    expect(english.length).toBeGreaterThan(50)
    expect(quoted).toStrictEqual([])
  })
})
