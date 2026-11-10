/**
 * The morning brief has ONE name per language: the Account tab, the Account nav,
 * the on/off switch and the Subscribe card all say it the same way (the email,
 * lambda/briefing/mailer.py, uses the same words). Regression: Polish said
 * "Poranny przegląd" on the tab and "poranne podsumowanie" on Home; Spanish mixed
 * "matutino" / "matinal"; Korean "브리프" / "브리핑".
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const NAMES: Record<string, string> = {
  en: 'morning brief',
  es: 'resumen matinal',
  fr: 'brief du matin',
  de: 'morgenbriefing',
  pt: 'resumo matinal',
  ja: '朝のブリーフ',
  zh: '晨间简报',
  ko: '아침 브리핑',
  pl: 'poranne podsumowanie',
}

function catalogue(locale: string, namespace: string): unknown {
  return JSON.parse(readFileSync(resolve(__dirname, `../../../../public/locales/${locale}/${namespace}.json`), 'utf8'))
}

/** The string at `path` in a parsed catalogue, '' when absent. */
function at(root: unknown, path: readonly string[]): string {
  const value = path.reduce<unknown>((node, key) =>
    (typeof node === 'object' && node !== null && key in node ? Reflect.get(node, key) : undefined), root)
  return typeof value === 'string' ? value : ''
}

function featureLabels(locale: string): string[] {
  const common = catalogue(locale, 'common')
  const briefing = catalogue(locale, 'briefing')
  return [
    at(common, ['account', 'nav', 'briefing']),
    at(common, ['account', 'tabs', 'briefing']),
    at(briefing, ['settings', 'enabled']),
    at(briefing, ['subscribe', 'title']),
  ]
}

describe.each(Object.keys(NAMES))('the morning brief name (%s)', (locale) => {
  it('is the same on the Account tab, the nav, the switch and the Subscribe card', () => {
    const labels = featureLabels(locale)
    expect(labels.filter((label) => !label.toLowerCase().includes(NAMES[locale] ?? '?'))).toStrictEqual([])
  })
})

describe('Polish', () => {
  it('never calls the brief a "przegląd"', () => {
    const texts = [JSON.stringify(catalogue('pl', 'briefing')), at(catalogue('pl', 'common'), ['account', 'briefHint']),
      ...featureLabels('pl')]
    expect(texts.filter((text) => /przegląd/i.test(text))).toStrictEqual([])
  })
})
