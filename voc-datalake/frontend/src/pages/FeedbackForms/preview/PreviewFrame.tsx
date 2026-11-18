/**
 * @fileoverview The live preview (UX §3.5): the real widget, rendered in the page in preview mode (widgetScript.ts),
 * given the DRAFT. It never submits and shows "Preview · Nothing is sent". Typing updates it within 150 ms; the
 * language follows the select; `goTo` and `restart` move it. Phone is a 375 × 667 frame; Desktop the pane's width.
 *
 * Not an iframe: the app's own pages refuse to be framed (CloudFront `frame-ancestors 'none'`), so the widget runs
 * in a contained, scrolling region of the page; its keys are handled on its own container only.
 *
 * @module pages/FeedbackForms/preview/PreviewFrame
 */
import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import type { FormLanguage, FormV2 } from '../model/formsV2'
import { toWireForm } from '../model/formsV2Schema'
import { loadWidget, startPreview } from './widgetScript'
import type { PreviewHandle } from './widgetScript'
import { noCleanup } from '../../../hooks/noCleanup'

const UPDATE_DELAY_MS = 150

/** A command for the preview; a new `nonce` repeats the same one (Restart twice). */
export type PreviewCommand =
  | { readonly kind: 'goTo'; readonly questionId: string; readonly nonce: number }
  | { readonly kind: 'restart'; readonly nonce: number }

export interface PreviewFrameProps {
  readonly form: FormV2
  readonly language: FormLanguage
  readonly device: 'phone' | 'desktop'
  /** The region's accessible name ("Form preview, phone size, Polski"). */
  readonly title: string
  readonly command?: PreviewCommand | null
}

type Loading = 'loading' | 'ready' | 'failed'

/** Start the widget in `container` once, and stop it when the preview goes. */
function useWidget(container: RefObject<HTMLDivElement | null>, opening: { form: FormV2; language: FormLanguage }) {
  const handle = useRef<PreviewHandle | null>(null)
  const [loading, setLoading] = useState<Loading>('loading')
  const first = useRef(opening)
  useEffect(() => {
    const state = { stopped: false }
    loadWidget().then((api) => {
      const element = container.current
      if (state.stopped || element === null) return
      handle.current = startPreview(api, element, toWireForm(first.current.form), first.current.language)
      setLoading(handle.current === null ? 'failed' : 'ready')
    }, (error: unknown) => {
      console.warn('The form preview could not start:', error)
      if (!state.stopped) setLoading('failed')
    })
    return () => {
      state.stopped = true
      handle.current?.destroy()
      handle.current = null
    }
  }, [container])
  return { handle, loading }
}

export default function PreviewFrame({ form, language, device, title, command = null }: PreviewFrameProps) {
  const { t } = useTranslation('feedbackForms')
  const container = useRef<HTMLDivElement>(null)
  const { handle, loading } = useWidget(container, { form, language })

  useEffect(() => {
    if (loading !== 'ready') return noCleanup
    const timer = window.setTimeout(() => handle.current?.update(toWireForm(form)), UPDATE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [form, loading, handle])

  useEffect(() => {
    if (loading === 'ready') handle.current?.setLanguage(language)
  }, [language, loading, handle])

  useEffect(() => {
    if (command === null || loading !== 'ready') return
    if (command.kind === 'goTo') handle.current?.goTo(command.questionId)
    else handle.current?.restart()
  }, [command, loading, handle])

  return (
    <div className={clsx('mx-auto overflow-hidden rounded-lg border border-border bg-bg-accent', device === 'phone' ? 'w-[375px] max-w-full' : 'w-full')}>
      <div ref={container} role="region" aria-label={title} lang={language}
        className={clsx('isolate overflow-auto', device === 'phone' ? 'h-[667px]' : 'h-[560px]')} />
      {loading === 'loading' && <p role="status" className="p-3 text-[12px] text-muted">{t('previewFrame.loading')}</p>}
      {loading === 'failed' && <p role="status" className="p-3 text-[12px] text-muted">{t('previewFrame.unavailable')}</p>}
    </div>
  )
}
