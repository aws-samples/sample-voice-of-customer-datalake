/**
 * @fileoverview The live preview's style object: token references resolve
 * against the current colours, invalid values never reach the style, hover and
 * focus layer on top, and the element is picked from the component's name.
 */
import { describe, expect, it } from 'vitest'
import { exampleDocument, previewElement, resolveColor, variantStyle } from './componentPreviewStyle'

const COLORS = [{ name: 'Primary', value: '#8e48ff' }, { name: 'broken', value: 'url(x)' }]
const variant = (overrides = {}) => ({ name: 'primary', styles: {}, hover: {}, focus: {}, ...overrides })

describe('resolveColor', () => {
  it('resolves var:<name> case-insensitively and passes plain colours through', () => {
    expect([resolveColor('var:primary', COLORS), resolveColor('#000', COLORS)]).toStrictEqual(['#8e48ff', '#000'])
  })

  it('drops an unknown token, a token with a bad value and an invalid colour', () => {
    expect([resolveColor('var:missing', COLORS), resolveColor('var:broken', COLORS), resolveColor('red;x', COLORS), resolveColor('', COLORS)])
      .toStrictEqual([undefined, undefined, undefined, undefined])
  })
})

describe('variantStyle', () => {
  it('maps the contract keys to CSS and resolves tokens', () => {
    const style = variantStyle(variant({ styles: { background: 'var:primary', color: '#fff', radius: '8px', padding: '8px 16px', font_weight: '600', text_transform: 'uppercase' } }), COLORS)
    expect(style).toStrictEqual({ borderStyle: 'none', backgroundColor: '#8e48ff', color: '#fff', borderRadius: '8px', padding: '8px 16px', fontWeight: '600', textTransform: 'uppercase' })
  })

  it('leaves out every value that fails its rule', () => {
    const style = variantStyle(variant({ styles: { background: 'url(javascript:alert(1))', radius: '8', shadow: 'expression(x)', font_family: 'a;}b' } }), COLORS)
    expect(style).toStrictEqual({ borderStyle: 'none' })
  })

  it('gives a bordered variant a solid border and layers hover and focus', () => {
    const outlined = variant({ styles: { border_color: 'var:primary', background: 'transparent' }, hover: { background: '#eee' }, focus: { outline: '2px solid #8e48ff' } })
    expect(variantStyle(outlined, COLORS)).toMatchObject({ borderStyle: 'solid', borderWidth: '1px', borderColor: '#8e48ff', backgroundColor: 'transparent' })
    expect(variantStyle(outlined, COLORS, 'hover')).toMatchObject({ backgroundColor: '#eee' })
    expect(variantStyle(outlined, COLORS, 'focus')).toMatchObject({ outline: '2px solid #8e48ff' })
    expect(variantStyle(outlined, COLORS)).not.toHaveProperty('outline')
  })

  it('paints the whole focus ring (border colour and glow) and the width', () => {
    const input = variant({
      styles: { border_color: '#333', width: '36px' },
      focus: { outline: '1px solid #8e48ff', border_color: 'var:primary', shadow: '0 0 0 3px rgba(178, 127, 255, .16)' },
    })
    expect(variantStyle(input, COLORS)).toMatchObject({ borderColor: '#333', width: '36px' })
    expect(variantStyle(input, COLORS, 'focus')).toMatchObject({
      outline: '1px solid #8e48ff', borderColor: '#8e48ff', boxShadow: '0 0 0 3px rgba(178, 127, 255, .16)' })
    expect(variantStyle(variant({ focus: { border_color: 'url(x)', shadow: 'expression(x)' } }), COLORS, 'focus'))
      .toStrictEqual({ borderStyle: 'none' })
  })
})

describe('previewElement', () => {
  it.each([
    ['Button', 'button'], ['Primary CTA', 'button'], ['Input', 'input'], ['Text area', 'input'], ['Select', 'input'],
    ['Badge', 'badge'], ['Chip', 'badge'], ['Tabs', 'tab'], ['Card', 'box'], ['Nav bar', 'box'],
  ])('%s → %s', (name, element) => {
    expect(previewElement(name)).toBe(element)
  })
})

describe('exampleDocument', () => {
  it('wraps the example in a page whose own CSP blocks scripts and remote loads', () => {
    const doc = exampleDocument('<b>Hi</b>')
    expect(doc).toContain("default-src 'none'")
    expect(doc).not.toContain('script-src')
    expect(doc).toContain('<body><b>Hi</b></body>')
  })
})
