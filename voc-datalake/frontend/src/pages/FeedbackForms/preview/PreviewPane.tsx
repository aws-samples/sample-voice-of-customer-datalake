/**
 * @fileoverview The live preview's pane (UX §3.5, audit §1.4 A): the real widget as a phone (PreviewFrame: 390 px
 * logical, scaled to the pane, as tall as the room left) and its toolbar: the language ("English (4 missing, shown
 * in Polski)"), Restart, Start here, Style (the Questions tab's Style panel) and "Open in window ▾" (the preview
 * window at a phone, rotated phone, tablet, desktop or embedded size). Under the toolbar, the phone's size and zoom
 * ("Phone · 390 × 610 · 90 %") and "Showing: Dark" while a palette is forced; under the frame, "Shuffled for each
 * respondent" when a question shuffles (the preview keeps one order per session). The widget's own strip says
 * "Preview · Nothing is sent".
 *
 * It follows the editor's selection: selecting a question, the Welcome card or an ending moves the preview (and an
 * open preview window) to it; Start here goes back to it.
 *
 * @module pages/FeedbackForms/preview/PreviewPane
 */
import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { EyeOff, Locate, Palette, RotateCcw, Shuffle } from 'lucide-react'
import { languageNames } from '../../../i18n/languages'
import type { FormLanguage, FormV2 } from '../model/formsV2'
import PreviewFrame from './PreviewFrame'
import WindowMenu from './WindowMenu'
import type { PreviewCommand } from './PreviewFrame'
import { MIN_HEIGHT, PHONE_WIDTH } from './frameSize'
import type { FrameSize } from './frameSize'
import { randomSeed } from './previewChannel'
import type { WindowPreset } from './previewChannel'
import { hasShuffle, languageChoices } from './previewForm'
import { usePreviewWindow } from './previewWindowContext'
import type { PreviewWindowApi } from './previewWindowContext'
import type { PreviewScheme } from './widgetScript'

function LanguageSelect({ form, value, onChange }: Readonly<{ form: FormV2; value: FormLanguage; onChange: (language: FormLanguage) => void }>) {
  const { t } = useTranslation('feedbackForms')
  const id = useId()
  if (form.languages.length < 2) return null
  return (
    <span className="flex min-w-0 items-center">
      <label htmlFor={id} className="sr-only">{t('preview.language')}</label>
      <select id={id} className="select select-sm w-auto max-w-full" value={value}
        onChange={(event) => {
          const next = form.languages.find((lng) => lng === event.target.value)
          if (next !== undefined) onChange(next)
        }}>
        {languageChoices(t, form).map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
      </select>
    </span>
  )
}

/** Hide preview: the builder's column gives the editor the width (none without `onHide`). */
function HideButton({ onHide }: Readonly<{ onHide: (() => void) | undefined }>) {
  const { t } = useTranslation('feedbackForms')
  if (onHide === undefined) return null
  return (
    <button type="button" className="btn btn-ghost btn-sm" onClick={onHide}>
      <EyeOff size={14} aria-hidden="true" />{t('preview.hide')}
    </button>
  )
}

/** Style: the Questions tab's Style panel, pressed while it is open (none without `onStyle`). */
function StyleButton({ styleOpen, onStyle }: Readonly<{ styleOpen: boolean; onStyle: (() => void) | undefined }>) {
  const { t } = useTranslation('feedbackForms')
  if (onStyle === undefined) return null
  return (
    <button type="button" className={clsx('btn btn-sm', styleOpen ? 'btn-secondary' : 'btn-ghost')} aria-pressed={styleOpen} onClick={onStyle}>
      <Palette size={14} aria-hidden="true" />{t('preview.style')}
    </button>
  )
}

/** "Phone · 390 × 610 · 90 %", and "Showing: Dark" while a palette is forced. */
function SizeLine({ size, scheme }: Readonly<{ size: FrameSize; scheme: PreviewScheme | null }>) {
  const { t } = useTranslation('feedbackForms')
  return (
    <p className="flex flex-wrap justify-between gap-x-3 text-[12px] tabular-nums text-muted">
      <span>{t('preview.size', { width: size.width, height: size.height, zoom: Math.round(size.scale * 100) })}</span>
      {scheme !== null && <span className="text-text">{t('preview.showing', { scheme: t(`preview.scheme.${scheme}`) })}</span>}
    </p>
  )
}

/** The preview's command: the selected card, or a Restart or Start here pressed since (mirrored into the window). */
function useCommands(selection: string | null, previewWindow: PreviewWindowApi | null) {
  // A Restart or Start here, pressed while `selection` was selected (a new selection supersedes it).
  const [manual, setManual] = useState<{ readonly command: PreviewCommand; readonly selection: string | null } | null>(null)
  // (a selection made in the editor moves the preview to that card: a new command per selection)
  const followed = useMemo<PreviewCommand | null>(
    () => (selection === null ? null : { kind: 'goTo', target: selection, nonce: 0 }), [selection])
  const command = manual !== null && manual.selection === selection ? manual.command : followed
  const send = (next: (n: number) => PreviewCommand) => {
    const made = next((manual?.command.nonce ?? 0) + 1)
    setManual({ command: made, selection })
    previewWindow?.send(made.kind === 'goTo' ? { kind: 'goTo', target: made.target } : { kind: 'restart' })
  }
  return { command, send }
}

export interface PreviewPaneProps {
  readonly form: FormV2
  /** The card the editor has selected, as the widget's `goTo` names it: a question id, `'welcome'`, `'end:<id>'`. */
  readonly selection: string | null
  /** A palette to show whatever the device prefers (the Style panel's, while it edits one). */
  readonly scheme?: PreviewScheme | null
  /** The Style panel is open (the Style button shows pressed). */
  readonly styleOpen?: boolean
  /** Style: open or close the Style panel; without it there is no Style button. */
  readonly onStyle?: () => void
  /** How tall the phone is (PreviewFrame `fit`): the pane's own height in the builder's columns. */
  readonly fit?: 'window' | 'fill' | number
  /** Hide preview: the builder's column gives the editor the width (none without it). */
  readonly onHide?: () => void
}

export default function PreviewPane({ form, selection, scheme = null, styleOpen = false, onStyle, fit = 'window', onHide }: PreviewPaneProps) {
  const { t } = useTranslation('feedbackForms')
  const previewWindow = usePreviewWindow()
  const [ownSeed] = useState(randomSeed)
  const seed = previewWindow?.seed ?? ownSeed
  const [chosen, setChosen] = useState<FormLanguage>(form.language)
  const [size, setSize] = useState<FrameSize>({ width: PHONE_WIDTH, height: MIN_HEIGHT, scale: 1 })
  const [blocked, setBlocked] = useState(false)
  const { command, send } = useCommands(selection, previewWindow)
  const language = form.languages.includes(chosen) ? chosen : form.language
  useEffect(() => {
    previewWindow?.setView({ language, target: selection, scheme })
  }, [previewWindow, language, selection, scheme])
  const open = useCallback((preset: WindowPreset) => {
    if (previewWindow !== null) setBlocked(!previewWindow.open(preset))
  }, [previewWindow])

  const title = t('preview.frameTitle', { size: t('preview.device.phone'), language: languageNames[language] })
  return (
    <div className={fit === 'fill' ? 'flex h-full min-h-0 flex-col gap-2' : 'space-y-2'}>
      <div className="flex flex-wrap items-center gap-1.5">
        <LanguageSelect form={form} value={language} onChange={setChosen} />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => send((n) => ({ kind: 'restart', nonce: n }))}>
          <RotateCcw size={14} aria-hidden="true" />{t('preview.restart')}
        </button>
        {selection !== null && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => send((n) => ({ kind: 'goTo', target: selection, nonce: n }))}>
            <Locate size={14} aria-hidden="true" />{t('preview.startHere')}
          </button>
        )}
        <StyleButton styleOpen={styleOpen} onStyle={onStyle} />
        {previewWindow !== null && <WindowMenu onOpen={open} />}
        <HideButton onHide={onHide} />
      </div>
      <SizeLine size={size} scheme={scheme} />
      {blocked && <p role="alert" className="text-[12px] text-warn">{t('preview.blocked')}</p>}
      <PreviewFrame form={form} language={language} title={title} command={command} scheme={scheme} seed={seed} fit={fit} onSize={setSize} />
      {hasShuffle(form) && (
        <p className="flex items-center gap-1.5 text-[12px] text-muted">
          <Shuffle size={12} aria-hidden="true" />{t('preview.shuffled')}
        </p>
      )}
    </div>
  )
}
