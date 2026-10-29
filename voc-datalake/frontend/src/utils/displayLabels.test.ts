import { describe, expect, it } from 'vitest'
import { categoryBucket, categoryLabel, channelLabel, humanizeId, keywordLabel, sourceLabel, subcategoryLabel, themeLabel } from './displayLabels'

const CATEGORIES = [
  {
    name: 'software_firmware',
    description: 'Software & Firmware',
    subcategories: [{ name: 'firmware_updates', description: 'Firmware Updates' }],
  },
  {
    name: 'ease_of_use',
    description: '',
    subcategories: [{ name: 'installation_setup', description: 'Installation & Setup' }],
  },
  { name: 'pricing', description: 'Everything about price. '.repeat(5), subcategories: [] },
]

describe('humanizeId', () => {
  it.each([
    ['existing_customer', 'Existing customer'],
    ['ease of_use', 'Ease of use'],
    ['api_automation', 'API automation'],
    ['ios_operating_system', 'iOS operating system'],
    ['pii__redaction_', 'PII redaction'],
    ['AcmeAir', 'AcmeAir'],
    ['com.examplemusic.player', 'com.examplemusic.player'],
    ['', ''],
  ])('%s → %s', (id, label) => {
    expect(humanizeId(id)).toBe(label)
  })
})

describe('categoryLabel / subcategoryLabel', () => {
  it('prefers the configured name', () => {
    expect(categoryLabel('software_firmware', CATEGORIES)).toBe('Software & Firmware')
  })

  it('falls back to the humanised id when the name is empty, too long or unknown', () => {
    expect([
      categoryLabel('ease_of_use', CATEGORIES),
      categoryLabel('pricing', CATEGORIES),
      categoryLabel('ux_issues'),
    ]).toStrictEqual(['Ease of use', 'Pricing', 'UX issues'])
  })

  it('finds a subcategory under its parent, then anywhere, else humanises', () => {
    expect([
      subcategoryLabel('firmware_updates', 'software_firmware', CATEGORIES),
      subcategoryLabel('installation_setup', undefined, CATEGORIES),
      subcategoryLabel('tac_services', 'software_firmware', CATEGORIES),
    ]).toStrictEqual(['Firmware Updates', 'Installation & Setup', 'Tac services'])
  })

  it('joins a theme as Category / Subcategory', () => {
    expect([
      themeLabel('ease_of_use', 'installation_setup', CATEGORIES),
      themeLabel('ease_of_use', null, CATEGORIES),
      themeLabel('ease_of_use', '', CATEGORIES),
    ]).toStrictEqual(['Ease of use / Installation & Setup', 'Ease of use', 'Ease of use'])
  })
})

describe('keywordLabel', () => {
  it.each([
    ['software_firmware', 'Software & Firmware'],
    ['ease_of_use', 'Ease of use'],
    ['battery', 'battery'],
  ])('%s → %s', (keyword, label) => {
    expect(keywordLabel(keyword, CATEGORIES)).toBe(label)
  })
})

describe('channelLabel', () => {
  it.each([
    ['app_review_android', undefined],
    ['web_scrape_jsonld', undefined],
    ['unknown', undefined],
    ['manual_import', undefined],
    ['', undefined],
    ['ACME Airlines', 'ACME Airlines'],
    ['airlinequality.com', 'airlinequality.com'],
    ['customer_email', 'Customer email'],
  ])('%s → %s', (channel, label) => {
    expect(channelLabel(channel, 'manual_import')).toBe(label)
  })
})

describe('sourceLabel', () => {
  it.each([
    ['Acme Android_android', 'Acme (Android)'],
    ['Example Air - iOS_ios', 'Example Air (iOS)'],
    ['Example Air_android', 'Example Air (Android)'],
    ['Example Air (iOS)_ios', 'Example Air (iOS)'],
    ['Acme iOS_ios', 'Acme (iOS)'],
    ['Android Auto helper_android', 'Android Auto helper'],
    ['Foo iOS_android', 'Foo iOS (Android)'],
    ['AcmeAir_android', 'AcmeAir (Android)'],
    ['TinyBean_iOS', 'TinyBean (iOS)'],
    ['acmeshop_ios', 'Acmeshop (iOS)'],
    ['com.examplemusic.player_Android', 'com.examplemusic.player (Android)'],
    ['Biosphere_android', 'Biosphere (Android)'],
    ['web_trustpilot_acme', 'Acme (Trustpilot)'],
    ['web_trustpilot_acme_airlines_main', 'Acme airlines main (Trustpilot)'],
    ['web_www_trustpilot_com', 'Trustpilot'],
    ['web_www_trustpilot_com_acme', 'Acme (Trustpilot)'],
    ['web_trustpilot_com_acme_airlines', 'Acme airlines (Trustpilot)'],
    ['web_www_example_co_uk', 'Example'],
    ['web_trustpilot_co_op', 'Co op (Trustpilot)'],
    ['manual_import', 'Manual import'],
    ['Melia - Trustpilot', 'Melia - Trustpilot'],
  ])('%s → %s', (id, label) => {
    expect(sourceLabel(id)).toBe(label)
  })

  it('prefers a source profile label, ignoring one that only repeats the id', () => {
    const profiles = [
      { id: 'web_trustpilot_acme', label: 'ACME Airlines' },
      { id: 'radar_example_air', label: 'radar_example_air' },
    ]
    expect([sourceLabel('web_trustpilot_acme', profiles), sourceLabel('radar_example_air', profiles)])
      .toStrictEqual(['ACME Airlines', 'Radar · Example air'])
  })

  // Wave 4: "Radar example air" in the CSV import source picker, Source policies and Erase.
  it('names a Radar source by its brand: "Radar · <Brand>"', () => {
    const profiles = [{ id: 'competitor_reviews', label: 'competitor_reviews', radar_brand: 'Globex' }]
    expect([sourceLabel('radar_example_air'), sourceLabel('competitor_reviews', profiles), sourceLabel('radar_acme_air')])
      .toStrictEqual(['Radar · Example air', 'Radar · Globex', 'Radar · Acme air'])
  })
})

describe('the "Other" category', () => {
  it('reads as the translated label when one is given, and a configured name still wins', () => {
    expect(categoryLabel('other', [], 'Sonstiges')).toBe('Sonstiges')
    expect(categoryLabel('other')).toBe('Other')
    expect(categoryLabel('other', [{ name: 'other', description: 'Misc' }], 'Sonstiges')).toBe('Misc')
  })

  it('buckets missing, unconfigured and removed categories as "other"', () => {
    const configured = ['delivery']
    expect(['delivery', 'billing', '', undefined].map((name) => categoryBucket(name, configured)))
      .toStrictEqual(['delivery', 'other', 'other', 'other'])
  })

  it('keeps every name while the configuration is unknown', () => {
    expect(categoryBucket('billing', [])).toBe('billing')
  })
})
