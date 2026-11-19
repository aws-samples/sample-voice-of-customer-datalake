/**
 * @fileoverview The form's style (audit §2.2, F5): the theme editor of the Questions tab's Style panel and of
 * Settings › Appearance, one component reading and writing the draft's theme (`useDraft`: one draft, one Save).
 *
 * Preset (VoC light, VoC dark, High contrast, "Your brand"; "Save as brand…" for the workspace's admins) · Mode
 * (Light | Dark | Auto, and in Auto which palette is being edited) · the palette's three colours, with the derived
 * option edge · Corners (four presets and a 0–24 px slider) · Font (system stacks only) · Size · the live contrast
 * table with its one-click suggestions (theme/contrast.ts: the server's and the widget's rules).
 *
 * The palette being edited is the one the previews should show meanwhile, whatever the device prefers:
 * `onEditingSchemeChange` says which ('light' | 'dark'), and null when the editor goes. Built from the design system's
 * recipes (`tabs-track`/`tab`, `.input`, `.select`, `range`), it fits a 28–44 rem column and a side sheet.
 *
 * @module pages/FeedbackForms/theme/ThemeEditor
 */
import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { RotateCcw } from 'lucide-react'
import { formatDecimal } from '../../../utils/numberFormat'
import { useDraft } from '../builder/formDraftContext'
import type { FormTheme, ThemeFont, ThemeMode, ThemePalette, ThemeTextSize } from '../model/formsV2'
import { THEME_FONTS } from '../model/formsV2'
import { shownRatio } from '../model/validateForm'
import Segmented from '../ui/Segmented'
import { keptLiveTheme, liveThemeOf, notesAbout, optionEdge, palettePairs, paletteOf, shownPalettes } from './contrast'
import type { PaletteColour, PaletteName } from './contrast'
import ColourField from './ColourField'
import ContrastTable from './ContrastTable'
import PresetPicker from './PresetPicker'
import { matchingPreset, presetName, presetTheme } from './presets'
import type { PresetId } from './presets'
import { useFormBrand } from './useFormBrand'

const CORNERS = [0, 4, 8, 16] as const
const CORNER_KEYS = ['square', 'small', 'medium', 'large'] as const
const MAX_SLIDER_PX = 24

export interface ThemeEditorProps {
  /** The palette being edited, for the preview to show it ('Showing: Dark'); null when the editor goes. */
  readonly onEditingSchemeChange?: (scheme: 'light' | 'dark' | null) => void
}

/** A form theme with one colour of one palette changed. */
function withColour(theme: FormTheme, palette: PaletteName, colour: PaletteColour, value: string): FormTheme {
  return palette === 'light' ? { ...theme, [colour]: value } : { ...theme, dark: { ...theme.dark, [colour]: value } }
}

const radiusPx = (radius: string): number => Number.parseInt(radius, 10) || 0

/** Tell the preview which palette is edited, and the device's again when the editor goes. */
function useEditingScheme(scheme: PaletteName, onChange: ThemeEditorProps['onEditingSchemeChange']): void {
  const latest = useRef(onChange)
  useEffect(() => { latest.current = onChange })
  useEffect(() => { latest.current?.(scheme) }, [scheme])
  useEffect(() => () => latest.current?.(null), [])
}

function Field({ label, children, hint }: Readonly<{ label: string; children: ReactNode; hint?: string }>) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium text-text">{label}</p>
      {children}
      {hint !== undefined && <p className="text-[12px] text-muted">{hint}</p>}
    </div>
  )
}

function Colours({ base, theme, palette, onColour }: Readonly<{
  base: string; theme: FormTheme; palette: PaletteName; onColour: (colour: PaletteColour, value: string) => void
}>) {
  const { t, i18n } = useTranslation('feedbackForms')
  const colours: ThemePalette = paletteOf(theme, palette)
  const pairs = palettePairs(colours)
  const edge = optionEdge(colours.text_color, colours.background_color)
  return (
    <fieldset className="min-w-0 space-y-3">
      <legend className="mb-2 flex items-center gap-2 text-sm font-medium text-text">
        {t('theme.colours.legend')}<span className="badge badge-muted">{t(`theme.palette.${palette}`)}</span>
      </legend>
      <ColourField label={t('theme.colours.primary')} hint={t('theme.colours.primaryHint')} value={colours.primary_color}
        describedBy={notesAbout(base, pairs, 'primary_color')} onChange={(value) => onColour('primary_color', value)} />
      <ColourField label={t('theme.colours.background')} value={colours.background_color}
        onChange={(value) => onColour('background_color', value)} />
      <ColourField label={t('theme.colours.text')} value={colours.text_color}
        describedBy={notesAbout(base, pairs, 'text_color')} onChange={(value) => onColour('text_color', value)} />
      {edge !== null && (
        <p className="text-[12px] text-muted">
          {t('theme.derived', { ratio: formatDecimal(shownRatio(edge.ratio, 3), i18n.language, 1), percent: Math.round(edge.alpha * 100) })}
        </p>
      )}
    </fieldset>
  )
}

function Corners({ radius, onChange }: Readonly<{ radius: string; onChange: (radius: string) => void }>) {
  const { t } = useTranslation('feedbackForms')
  const sliderId = useId()
  const px = radiusPx(radius)
  return (
    <Field label={t('theme.corners.label')}>
      <Segmented label={t('theme.corners.label')} value={radius} onChange={onChange}
        choices={CORNERS.map((value, index) => ({ value: `${String(value)}px`, label: t(`theme.corners.${CORNER_KEYS[index] ?? 'medium'}`, { px: value }) }))} />
      <div className="flex items-center gap-3">
        <label htmlFor={sliderId} className="sr-only">{t('theme.corners.slider')}</label>
        <input id={sliderId} type="range" className="range min-w-0 flex-1" min={0} max={MAX_SLIDER_PX} step={1}
          value={Math.min(px, MAX_SLIDER_PX)} aria-valuetext={t('theme.corners.value', { px })}
          onChange={(event) => onChange(`${event.target.value}px`)} />
        <output htmlFor={sliderId} className="w-14 shrink-0 text-end font-mono text-[13px] tabular-nums text-text">{t('theme.corners.value', { px })}</output>
      </div>
    </Field>
  )
}

function FontAndSize({ theme, set }: Readonly<{ theme: FormTheme; set: (patch: Partial<FormTheme>) => void }>) {
  const { t } = useTranslation('feedbackForms')
  const fontId = useId()
  return (
    <>
      <div className="space-y-1.5">
        <label htmlFor={fontId} className="block text-sm font-medium text-text">{t('theme.font.label')}</label>
        <select id={fontId} className="select w-full" value={theme.font}
          aria-describedby={theme.font === 'inherit' ? `${fontId}-hint` : undefined}
          onChange={(event) => set({ font: THEME_FONTS.find((font) => font === event.target.value) ?? 'system' })}>
          {THEME_FONTS.map((font: ThemeFont) => <option key={font} value={font}>{t(`theme.font.${font}`)}</option>)}
        </select>
        {theme.font === 'inherit' && <p id={`${fontId}-hint`} className="text-[12px] text-muted">{t('theme.font.inheritHint')}</p>}
      </div>
      <Field label={t('theme.size.label')} hint={t('theme.size.hint')}>
        <Segmented<ThemeTextSize> label={t('theme.size.label')} value={theme.text_size} onChange={(textSize) => set({ text_size: textSize })}
          choices={[{ value: 'default', label: t('theme.size.default') }, { value: 'large', label: t('theme.size.large') }]} />
      </Field>
    </>
  )
}

/** In Auto, the palette not being edited when it has pairs below their minimum: one line, and the way to it. */
function OtherPalette({ theme, editing, onEdit }: Readonly<{ theme: FormTheme; editing: PaletteName; onEdit: (palette: PaletteName) => void }>) {
  const { t } = useTranslation('feedbackForms')
  const other: PaletteName = editing === 'light' ? 'dark' : 'light'
  if (!shownPalettes(theme).includes(other)) return null
  const count = palettePairs(paletteOf(theme, other)).filter((pair) => pair.level !== 'ok' && pair.id !== 'edge').length
  if (count === 0) return null
  return (
    <p role="note" className="flex flex-wrap items-center gap-2 text-[13px] text-text">
      {t(`theme.contrast.other.${other}`, { count })}
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onEdit(other)}>{t(`theme.contrast.editOther.${other}`)}</button>
    </p>
  )
}

export default function ThemeEditor({ onEditingSchemeChange }: Readonly<ThemeEditorProps>) {
  const { t } = useTranslation('feedbackForms')
  const base = useId()
  const { form, update, baseline, meta } = useDraft()
  // (a live form kept on its stored theme: its unreadable text is a warning, as the server only warns)
  const kept = keptLiveTheme(form.theme, liveThemeOf(baseline, meta !== null))
  const brand = useFormBrand()
  const theme = form.theme
  const [autoEditing, setAutoEditing] = useState<PaletteName>('light')
  const [picked, setPicked] = useState<PresetId | null>(null)
  const editing: PaletteName = theme.mode === 'auto' ? autoEditing : theme.mode
  useEditingScheme(editing, onEditingSchemeChange)

  const set = (patch: Partial<FormTheme>) => update((current) => ({ ...current, theme: { ...current.theme, ...patch } }))
  const setColour = (colour: PaletteColour, value: string) => update((current) => ({ ...current, theme: withColour(current.theme, editing, colour, value) }))
  const pick = (id: PresetId) => {
    const preset = presetTheme(id, brand.brand)
    if (preset === null) return
    setPicked(id)
    update((current) => ({ ...current, theme: preset }))
  }
  const pressed = matchingPreset(theme, brand.brand)
  // "Reset to …" undoes the edits made since a preset was picked here (a stored custom style has none to go back to).
  const resetTo = picked
  const resettable = resetTo !== null && pressed !== resetTo && presetTheme(resetTo, brand.brand) !== null
  const modes: readonly ThemeMode[] = ['light', 'dark', 'auto']
  const colours = paletteOf(theme, editing)
  return (
    <div className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="mb-1.5 text-sm font-medium text-text">{t('theme.presets.label')}</p>
          <PresetPicker theme={theme} pressed={pressed} brand={brand} onPick={pick} />
        </div>
        {resettable && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => pick(resetTo)}>
            <RotateCcw size={14} aria-hidden="true" />{t('theme.reset', { preset: presetName(t, resetTo) })}
          </button>
        )}
      </div>
      <Field label={t('theme.mode.label')} hint={t('theme.mode.hint')}>
        <Segmented<ThemeMode> label={t('theme.mode.label')} value={theme.mode} onChange={(mode) => set({ mode })}
          choices={modes.map((mode) => ({ value: mode, label: t(`theme.mode.${mode}`) }))} />
        {theme.mode === 'auto' && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] text-text">{t('theme.editing.label')}</span>
            <Segmented<PaletteName> label={t('theme.editing.label')} value={autoEditing} onChange={setAutoEditing}
              choices={[{ value: 'light', label: t('theme.mode.light') }, { value: 'dark', label: t('theme.mode.dark') }]} />
          </div>
        )}
      </Field>
      <Colours base={base} theme={theme} palette={editing} onColour={setColour} />
      <Corners radius={theme.border_radius} onChange={(radius) => set({ border_radius: radius })} />
      <FontAndSize theme={theme} set={set} />
      <section aria-labelledby={`${base}-contrast`} className="space-y-2">
        <h3 id={`${base}-contrast`} className="text-sm font-semibold text-text-strong">
          {t('theme.contrast.title', { palette: t(`theme.palette.${editing}`) })}
        </h3>
        <ContrastTable base={base} pairs={palettePairs(colours)} palette={colours} kept={kept} onUse={setColour} />
        <OtherPalette theme={theme} editing={editing} onEdit={setAutoEditing} />
      </section>
    </div>
  )
}
