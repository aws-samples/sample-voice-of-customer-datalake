/**
 * @fileoverview THE CONTRACT (wave 13) rules for component style values, the
 * lenient reading of `components`, the wire shape Save sends, and what makes
 * the components draft unsaveable.
 */
import { describe, expect, it } from 'vitest'
import {
  componentList, componentsInvalid, duplicateNames, isValidOutline, isValidStyleValue, tokenRefName, toWireComponents,
} from './designComponents'
import type { DesignComponent } from './designComponents'

const variant = (styles = {}) => ({ name: 'primary', styles, hover: {}, focus: {} })
const button = (overrides: Partial<DesignComponent> = {}): DesignComponent => ({ name: 'Button', description: '', variants: [variant()], ...overrides })

describe('style value rules', () => {
  it.each([
    ['background', '#8e48ff'], ['background', 'oklch(0.62 0.25 295)'], ['color', 'var:primary'], ['border_color', 'transparent'],
    ['radius', '8px'], ['padding', '8px 16px'], ['padding', '4px 8px 4px 8px'], ['height', '2.25rem'],
    ['font_family', '"Space Grotesk", sans-serif'], ['font_weight', '600'], ['letter_spacing', '-0.01em'], ['letter_spacing', 'normal'],
    ['text_transform', 'uppercase'], ['shadow', '0 1px 2px rgba(0,0,0,0.2)'],
  ] as const)('accepts %s = %s', (key, value) => {
    expect(isValidStyleValue(key, value)).toBe(true)
  })

  it.each([
    ['background', 'url(https://evil.example/x.png)'], ['background', 'var(--x)'], ['color', 'red;}body{display:none'],
    ['color', 'var:'], ['radius', '8'], ['padding', '1px 2px 3px 4px 5px'], ['font_weight', '650'],
    ['text_transform', 'lowercase'], ['shadow', '0 0 0 url(x)'], ['shadow', 'expression(alert(1))'], ['font_family', 'a;b'],
  ] as const)('refuses %s = %s', (key, value) => {
    expect(isValidStyleValue(key, value)).toBe(false)
  })

  it('treats an empty value as not set, and checks the focus outline', () => {
    expect(isValidStyleValue('radius', '  ')).toBe(true)
    expect(isValidOutline('2px solid #8e48ff')).toBe(true)
    expect(isValidOutline(`2px solid ${'a'.repeat(80)}`)).toBe(false)
  })

  it('reads a token reference by name', () => {
    expect([tokenRefName('var:primary'), tokenRefName(' var:accent soft '), tokenRefName('#fff')]).toStrictEqual(['primary', 'accent soft', null])
  })
})

describe('reading components', () => {
  it('keeps known style keys, drops unknown keys and non-strings, and reads old {name, description} rows', () => {
    const parsed = componentList.parse([
      { name: 'Button', description: 'x', variants: [{ name: 'primary', styles: { background: '#000', onclick: 'x', radius: 8 }, hover: { color: '#fff', padding: '1px' } }] },
      { name: 'Card', description: 'Legacy' },
      { description: 'no name' },
    ])
    expect(parsed.map((c) => c.name)).toStrictEqual(['Button', 'Card'])
    expect(parsed[0]?.variants[0]).toStrictEqual({ name: 'primary', styles: { background: '#000' }, hover: { color: '#fff' }, focus: {} })
    expect(parsed[1]?.variants).toStrictEqual([])
  })
})

describe('the wire shape', () => {
  it('trims values and drops empty styles, hover, focus and example', () => {
    const wire = toWireComponents([button({ name: ' Button ', variants: [{ name: 'primary', styles: { background: ' #000 ', radius: '' }, hover: { color: ' ' }, focus: {} }], example_html: '  ' })])
    expect(wire).toStrictEqual([{ name: 'Button', description: '', variants: [{ name: 'primary', styles: { background: '#000' } }] }])
  })

  it('keeps hover, focus and the example when set', () => {
    const wire = toWireComponents([button({ variants: [{ ...variant(), hover: { background: 'var:hover' }, focus: { outline: '2px solid red' } }], example_html: '<button>Go</button>' })])
    expect(wire).toStrictEqual([{ name: 'Button', description: '', variants: [{ name: 'primary', styles: {}, hover: { background: 'var:hover' }, focus: { outline: '2px solid red' } }], example_html: '<button>Go</button>' }])
  })
})

describe('componentsInvalid', () => {
  it('passes a valid list and flags duplicate names case-insensitively', () => {
    expect(componentsInvalid([button(), button({ name: 'Card' })])).toBe(false)
    expect(componentsInvalid([button(), button({ name: 'button ' })])).toBe(true)
    expect([...duplicateNames(['Tabs', 'tabs', 'Card'])]).toStrictEqual(['tabs'])
  })

  it('flags an empty name, a bad style value and more than six variants', () => {
    expect(componentsInvalid([button({ name: ' ' })])).toBe(true)
    expect(componentsInvalid([button({ variants: [variant({ radius: 'big' })] })])).toBe(true)
    expect(componentsInvalid([button({ variants: Array.from({ length: 7 }, (_, i) => ({ ...variant(), name: `v${i}` })) })])).toBe(true)
  })

  it('flags more than 30 components', () => {
    expect(componentsInvalid(Array.from({ length: 31 }, (_, i) => button({ name: `C${i}` })))).toBe(true)
  })
})
