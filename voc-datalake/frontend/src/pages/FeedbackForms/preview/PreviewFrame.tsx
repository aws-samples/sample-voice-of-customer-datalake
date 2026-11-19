/**
 * @fileoverview The live preview (UX §3.5, audit §1.4 A): the real widget, rendered in the page in preview mode
 * (widgetScript.ts), given the DRAFT. It never submits; the widget's own strip says "Preview · Nothing is sent".
 * Typing updates it within 150 ms, a theme-only change (a dragged slider, a colour) on the next frame; the language
 * follows the select; `goTo` and `restart` move it; `scheme` forces the light or the dark palette.
 *
 * Always a phone, honestly: the widget lays out in a 390 px wide box (its `narrow()` reads that width), scaled down
 * to the room there is (`transform` changes the drawing, not the layout), in a box the size of the scaled result. Its
 * height is the parent's (`fill`: the builder's panes, so the widget's sticky Next and the toolbar stay in view),
 * what is left in the window (`window`), or a fixed number of logical px (frameSize.ts). Bigger sizes are the
 * preview window's (previewChannel.ts), a real viewport.
 *
 * Not an iframe: the app's own pages refuse to be framed (CloudFront `frame-ancestors 'none'`), so the widget runs
 * in a contained, scrolling region of the page (in its own shadow root, out of the app's CSS); its keys are handled
 * on its own container only.
 *
 * @module pages/FeedbackForms/preview/PreviewFrame
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import type { FormLanguage, FormV2 } from '../model/formsV2'
import { toWireForm } from '../model/formsV2Schema'
import { noCleanup } from '../../../hooks/noCleanup'
import { loadWidget, startPreview } from './widgetScript'
import type { PreviewHandle, PreviewScheme } from './widgetScript'
import { onlyThemeChanged } from './previewForm'
import { PHONE_WIDTH, SHORT_HEIGHT, frameSize } from './frameSize'
import type { FrameSize, Room } from './frameSize'

const UPDATE_DELAY_MS = 150

/** A command for the preview; a new `nonce` repeats the same one (Restart twice). */
export type PreviewCommand =
  | { readonly kind: 'goTo'; /** A question id, `'welcome'` or `'end:<ending id>'`. */ readonly target: string; readonly nonce: number }
  | { readonly kind: 'restart'; readonly nonce: number }

export interface PreviewFrameProps {
  readonly form: FormV2
  readonly language: FormLanguage
  /** The region's accessible name ("Form preview, phone size, Polski"). */
  readonly title: string
  readonly command?: PreviewCommand | null
  /** Show the light or the dark palette whatever the device prefers (null: the device's). */
  readonly scheme?: PreviewScheme | null
  /** The preview session's shuffle seed: one stable order, Restart included. */
  readonly seed?: number
  /** `window` (the default): to the window's bottom; `fill`: the parent's height (a flex column); a number: that. */
  readonly fit?: 'window' | 'fill' | number
  readonly onSize?: (size: FrameSize) => void
}

type Loading = 'loading' | 'ready' | 'failed'

interface Opening {
  readonly form: FormV2
  readonly language: FormLanguage
  readonly scheme: PreviewScheme | null
  readonly seed: number | undefined
}

/** Start the widget in `container` once, and stop it when the preview goes. */
function useWidget(container: RefObject<HTMLDivElement | null>, opening: Opening) {
  const handle = useRef<PreviewHandle | null>(null)
  const [loading, setLoading] = useState<Loading>('loading')
  const [first] = useState(opening)
  useEffect(() => {
    const state = { stopped: false }
    loadWidget().then((api) => {
      const element = container.current
      if (state.stopped || element === null) return
      handle.current = startPreview(api, element, toWireForm(first.form), first.language, { seed: first.seed, scheme: first.scheme })
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
  }, [container, first])
  return { handle, loading }
}

/** The draft into the widget: 150 ms after typing stops, or on the next frame when only the theme changed. */
function useDraftUpdates(handle: RefObject<PreviewHandle | null>, form: FormV2, ready: boolean, opening: FormV2): void {
  const shown = useRef(opening)
  useEffect(() => {
    if (!ready || shown.current === form) return noCleanup
    const push = () => {
      shown.current = form
      handle.current?.update(toWireForm(form))
    }
    if (onlyThemeChanged(shown.current, form)) {
      const frame = window.requestAnimationFrame(push)
      return () => window.cancelAnimationFrame(frame)
    }
    const timer = window.setTimeout(push, UPDATE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [form, ready, handle])
}

/** The room the frame has: its box's width and height, and where it starts in the window; kept as they change. */
function useRoom(box: RefObject<HTMLDivElement | null>): Room {
  const [room, setRoom] = useState<Room>({ width: PHONE_WIDTH, height: 0, top: 0, windowHeight: 0 })
  useLayoutEffect(() => {
    const element = box.current
    if (element === null) return noCleanup
    const measure = () => {
      const next: Room = {
        width: element.clientWidth, height: element.clientHeight, top: Math.round(element.getBoundingClientRect().top), windowHeight: window.innerHeight,
      }
      setRoom((current) => (current.width === next.width && current.height === next.height && current.top === next.top
        && current.windowHeight === next.windowHeight ? current : next))
    }
    measure()
    window.addEventListener('resize', measure)
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    observer?.observe(element)
    return () => {
      window.removeEventListener('resize', measure)
      observer?.disconnect()
    }
  }, [box])
  return room
}

export default function PreviewFrame({ form, language, title, command = null, scheme = null, seed, fit = 'window', onSize }: PreviewFrameProps) {
  const { t } = useTranslation('feedbackForms')
  const container = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [opening] = useState<Opening>({ form, language, scheme, seed })
  const { handle, loading } = useWidget(container, opening)
  const ready = loading === 'ready'
  useDraftUpdates(handle, form, ready, opening.form)
  const room = useRoom(box)
  const size = useMemo(() => frameSize(room, fit), [room, fit])

  useEffect(() => {
    if (ready) handle.current?.setLanguage(language)
  }, [language, ready, handle])

  useEffect(() => {
    if (ready) handle.current?.setScheme(scheme)
  }, [scheme, ready, handle])

  useEffect(() => {
    if (command === null || !ready) return
    if (command.kind === 'goTo') handle.current?.goTo(command.target)
    else handle.current?.restart()
  }, [command, ready, handle])

  useEffect(() => {
    onSize?.(size)
  }, [onSize, size])

  const scaledWidth = Math.round(PHONE_WIDTH * size.scale)
  const scaledHeight = Math.round(size.height * size.scale)
  return (
    <div ref={box} className={clsx('w-full', fit === 'fill' && 'min-h-0 flex-1')}
      style={fit === 'fill' ? { minHeight: Math.round(SHORT_HEIGHT * size.scale) } : undefined}>
      <div className="mx-auto box-content overflow-hidden rounded-lg border border-border bg-bg-accent" style={{ width: scaledWidth, height: scaledHeight }}>
        <div style={{ width: PHONE_WIDTH, height: size.height, transform: size.scale === 1 ? undefined : `scale(${String(size.scale)})`, transformOrigin: 'top left' }}>
          <div ref={container} role="region" aria-label={title} lang={language} className="isolate h-full overflow-auto" />
        </div>
      </div>
      {loading === 'loading' && <p role="status" className="p-3 text-[12px] text-muted">{t('previewFrame.loading')}</p>}
      {loading === 'failed' && <p role="status" className="p-3 text-[12px] text-muted">{t('previewFrame.unavailable')}</p>}
    </div>
  )
}
