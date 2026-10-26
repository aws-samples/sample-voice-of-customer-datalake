/**
 * @fileoverview Pins the customizable `<select>` list (index.css,
 * `@supports (appearance: base-select)`): it opts in on both the field and its
 * `::picker(select)`, and the open list is never hidden.
 *
 * Regression (3.22.01–3.24.03): the picker faded in from `opacity: 0` keyed on
 * `::picker(select):popover-open`, which Chrome never matched for a select's
 * picker, so every dropdown opened with its options invisible.
 */
import { describe, expect, it } from 'vitest'
import { indexCss as css } from '@test/themeTokens'

/** The body of the first `{ … }` rule whose selector list is exactly `selector`, at the start of its line. */
function block(source: string, selector: string): string {
  const match = new RegExp(`\\n\\s*${selector.replace(/[\\^$.*+?()[\]{}|:]/g, '\\$&')} \\{`).exec(source)
  if (match === null) throw new Error(`${selector} not found in index.css`)
  return source.slice(match.index, source.indexOf('}', match.index))
}

const PICKER = css.slice(css.indexOf('@supports (appearance: base-select)'))

describe('customizable select list', () => {
  it('opts the field and its picker in', () => {
    expect(PICKER).toContain('select:not([multiple]), ::picker(select) { appearance: base-select; }')
    expect(css).toMatch(/\.select:not\(\[multiple\]\) \{ appearance: base-select; \}/)
  })

  it('never hides the open list', () => {
    expect(block(PICKER, '::picker(select)')).not.toMatch(/opacity|visibility:\s*hidden|display:\s*none/)
    expect(PICKER).not.toMatch(/::picker\(select\)[^{]*\{[^}]*opacity:\s*0/)
  })

  it('draws the list in the theme: elevated background, border, app font', () => {
    const picker = block(PICKER, '::picker(select)')
    expect(picker).toContain('background: var(--bg-elevated)')
    expect(picker).toContain('border: 1px solid var(--border)')
    expect(picker).toContain('var(--font-body)')
  })
})
