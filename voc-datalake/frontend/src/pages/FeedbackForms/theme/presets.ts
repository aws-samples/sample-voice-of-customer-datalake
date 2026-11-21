/**
 * @fileoverview The theme editor's presets (audit §2.2): whole themes from the app's own palettes, already AA-checked
 * in styles/theme-palettes.css: VoC light (shown light), VoC dark (shown dark), High contrast (both palettes, shown by
 * the respondent's device), and "Your brand", the saved form brand (useFormBrand.ts). Picking one sets
 * the whole theme; "Reset to …" sets it again after edits.
 *
 * The colours are the customer's form data, rendered on their page (the design system's out-of-scope colours).
 *
 * @module pages/FeedbackForms/theme/presets
 */
import type { TFunction } from 'i18next'
import type { FormTheme, ThemePalette } from '../model/formsV2'
import { DEFAULT_THEME, VOC_DARK_PALETTE, VOC_LIGHT_PALETTE } from '../model/formsV2'
import { sameJson } from '../../../lib/sameJson'

const PRESET_IDS = ['voc-light', 'voc-dark', 'high-contrast', 'brand'] as const
export type PresetId = (typeof PRESET_IDS)[number]

/** High contrast (kirocrew's): text at least 7:1, everything else at least 4.5:1. */
const HIGH_CONTRAST_LIGHT: ThemePalette = { primary_color: '#0552c2', background_color: '#ffffff', text_color: '#000000' }
const HIGH_CONTRAST_DARK: ThemePalette = { primary_color: '#00d4ff', background_color: '#000000', text_color: '#ffffff' }
const LOOK = { border_radius: DEFAULT_THEME.border_radius, font: DEFAULT_THEME.font, text_size: DEFAULT_THEME.text_size }

const BUILT_IN: Readonly<Record<Exclude<PresetId, 'brand'>, FormTheme>> = {
  'voc-light': DEFAULT_THEME,
  'voc-dark': { ...VOC_LIGHT_PALETTE, ...LOOK, mode: 'dark', dark: VOC_DARK_PALETTE },
  'high-contrast': { ...HIGH_CONTRAST_LIGHT, ...LOOK, mode: 'auto', dark: HIGH_CONTRAST_DARK },
}

const NAME_KEYS: Readonly<Record<PresetId, string>> = {
  'voc-light': 'theme.presets.vocLight', 'voc-dark': 'theme.presets.vocDark',
  'high-contrast': 'theme.presets.highContrast', brand: 'theme.presets.brand',
}

/** A preset's name, as its button and "Reset to …" say it. */
export const presetName = (t: TFunction<'feedbackForms'>, id: PresetId): string => t(NAME_KEYS[id])

/** A preset's theme; null for "Your brand" while none is saved. */
export function presetTheme(id: PresetId, brand: FormTheme | null): FormTheme | null {
  return id === 'brand' ? brand : BUILT_IN[id]
}

/** The presets on offer: the three built in, and "Your brand" once one is saved. */
export const offeredPresets = (brand: FormTheme | null): readonly PresetId[] =>
  PRESET_IDS.filter((id) => id !== 'brand' || brand !== null)

/** The preset `theme` is exactly (the brand first, so a brand equal to a built-in reads as the brand), or null. */
export function matchingPreset(theme: FormTheme, brand: FormTheme | null): PresetId | null {
  const order: readonly PresetId[] = ['brand', 'voc-light', 'voc-dark', 'high-contrast']
  return order.find((id) => {
    const preset = presetTheme(id, brand)
    return preset !== null && sameJson(preset, theme)
  }) ?? null
}
