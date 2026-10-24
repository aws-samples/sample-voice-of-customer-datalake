/**
 * Built-in templates start on the Kiro Light palette, and the widget's white
 * button label passes WCAG AA on every one of them (E2E F6).
 */
import { describe, expect, it } from 'vitest'
import { KIRO_LIGHT_HEX } from '../../theme/printPalette'
import { defaultFormConfig, formTemplates } from './formTemplates'
import { normalizeFeedbackForms } from './formSchema'

function luminance(hex: string): number {
  const linear = [1, 3, 5].map((i) => {
    const channel = Number.parseInt(hex.slice(i, i + 2), 16) / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0)
}

const contrastWithWhite = (hex: string) => 1.05 / (luminance(hex) + 0.05)
const PALETTE: readonly string[] = Object.values(KIRO_LIGHT_HEX)

describe.each(formTemplates.map((template) => [template.id, template.config.theme] as const))('template %s', (_id, theme) => {
  it('uses Kiro Light colours only', () => {
    expect([theme.primary_color, theme.background_color, theme.text_color].every((hex) => PALETTE.includes(hex))).toBe(true)
  })

  it('keeps a white button label at AA (>= 4.5:1)', () => {
    expect(contrastWithWhite(theme.primary_color)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('the default form theme (E2E F7: no off-palette swatch)', () => {
  it('is the Kiro accent, not the old Tailwind blue #3b82f6', () => {
    expect(defaultFormConfig.theme.primary_color).toBe(KIRO_LIGHT_HEX.accent)
    expect(defaultFormConfig.theme.primary_color.toLowerCase()).not.toBe('#3b82f6')
  })

  it('is what a stored form without a theme renders with', () => {
    const [form] = normalizeFeedbackForms([{ form_id: 'f1', name: 'legacy' }])
    expect(form?.theme.primary_color).toBe(KIRO_LIGHT_HEX.accent)
  })

  it('leaves a stored colour alone, even the old default', () => {
    const [form] = normalizeFeedbackForms([{ form_id: 'f1', name: 'old', theme: { primary_color: '#3B82F6' } }])
    expect(form?.theme.primary_color).toBe('#3B82F6')
  })
})
