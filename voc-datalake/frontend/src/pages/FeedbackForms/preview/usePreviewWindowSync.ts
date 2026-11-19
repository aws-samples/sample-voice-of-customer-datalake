/**
 * @fileoverview The opener's side of the preview window (previewChannel.ts): one BroadcastChannel per preview
 * session, opened when the person opens the window, or at once when this tab already has a session for the form
 * (the builder reloaded while its window stayed open). The window's `ready` is answered with the draft, the
 * language, the palette and the card; then every change of the draft is posted with the pane's 150 ms debounce
 * (a theme-only change on the next frame), and a change of view as it happens. The window's `ready` and `alive` say
 * it is open, `closed` or 5 s of silence (a window killed with its tab) that it is not (`openSince`).
 *
 * @module pages/FeedbackForms/preview/usePreviewWindowSync
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FormV2 } from '../model/formsV2'
import { toWireForm } from '../model/formsV2Schema'
import { noCleanup } from '../../../hooks/noCleanup'
import {
  keepPreviewSession, knownPreviewSession, openChannel, openPreviewWindow, postPreview, previewSession, randomSeed,
  readPreviewMessage,
} from './previewChannel'
import type { WindowPreset } from './previewChannel'
import { languageChoices, onlyThemeChanged } from './previewForm'
import type { PreviewView, PreviewWindowApi, WindowCommand } from './previewWindowContext'

const UPDATE_DELAY_MS = 150
/** The window says `alive` every 1.5 s: past this without a word, it is taken as closed. */
const SILENCE_MS = 5000

/** The window keeps the person's words: the app's language as the catalogs name it ("pl", not "pl-PL"). */
export function uiLanguage(language: string | undefined): string {
  return (language ?? 'en').slice(0, 2).toLowerCase()
}

/** The opener's side of the preview window of `formKey` (a form id, `new`, `picker`), showing `form`. */
export function usePreviewWindowSync(form: FormV2 | null, formKey: string): PreviewWindowApi {
  const { t, i18n } = useTranslation('feedbackForms')
  const [seed] = useState(randomSeed)
  const session = useRef<string | null>(null)
  const channel = useRef<BroadcastChannel | null>(null)
  const sent = useRef<FormV2 | null>(null)
  const [opening] = useState((): PreviewView => ({ language: form?.language ?? 'en', target: null, scheme: null }))
  const latest = useRef({ form, t, view: opening })
  const [openSince, setOpenSince] = useState<number | null>(null)
  const lastHeard = useRef(0)
  // (first among the effects: the ones below, and the window's answers, read the draft as it is now)
  useEffect(() => {
    latest.current.form = form
    latest.current.t = t
  }, [form, t])

  const postConfig = useCallback((draft: FormV2) => {
    sent.current = draft
    postPreview(channel.current, {
      action: 'config', config: toWireForm(draft), seed, name: draft.name, languages: languageChoices(latest.current.t, draft),
    })
  }, [seed])

  /** Everything the window needs to show what the builder shows (its answer to `ready`). */
  const sendState = useCallback(() => {
    const { form: draft, view } = latest.current
    if (draft === null || channel.current === null) return
    postConfig(draft)
    postPreview(channel.current, { action: 'language', language: view.language })
    postPreview(channel.current, { action: 'scheme', scheme: view.scheme })
    if (view.target !== null) postPreview(channel.current, { action: 'goTo', questionId: view.target })
  }, [postConfig])

  const connect = useCallback((id: string) => {
    if (channel.current !== null && session.current === id) return
    channel.current?.close()
    session.current = id
    const next = openChannel(id)
    channel.current = next
    if (next !== null) {
      next.onmessage = (event: MessageEvent<unknown>) => {
        const action = readPreviewMessage(event.data)?.action
        if (action === 'closed') { setOpenSince(null); return }
        if (action !== 'ready' && action !== 'alive') return
        lastHeard.current = Date.now()
        setOpenSince((since) => since ?? lastHeard.current)
        if (action === 'ready') sendState()
      }
    }
  }, [sendState])

  const disconnect = useCallback(() => {
    channel.current?.close()
    channel.current = null
    setOpenSince(null)
  }, [])

  // A window that went without saying so (its tab killed): open no more after SILENCE_MS without a word.
  useEffect(() => {
    if (openSince === null) return noCleanup
    const watch = window.setInterval(() => {
      if (Date.now() - lastHeard.current > SILENCE_MS) setOpenSince(null)
    }, SILENCE_MS / 2)
    return () => window.clearInterval(watch)
  }, [openSince])

  // A session this tab already has for the form: its window may still be open (the builder reloaded), so talk to it
  // again. A new form's first save moves its session to the form's id, and the window keeps following.
  useEffect(() => {
    const id = session.current ?? knownPreviewSession(formKey)
    if (id === null) return noCleanup
    keepPreviewSession(formKey, id)
    connect(id)
    sendState()
    return disconnect
  }, [formKey, connect, sendState, disconnect])
  useEffect(() => disconnect, [disconnect])

  useEffect(() => {
    if (form === null || channel.current === null || sent.current === form) return noCleanup
    const before = sent.current
    if (before !== null && onlyThemeChanged(before, form)) {
      const frame = window.requestAnimationFrame(() => postConfig(form))
      return () => window.cancelAnimationFrame(frame)
    }
    const timer = window.setTimeout(() => postConfig(form), UPDATE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [form, postConfig])

  const setView = useCallback((view: PreviewView) => {
    const before = latest.current.view
    latest.current.view = view
    const open = channel.current
    if (open === null) return
    if (view.language !== before.language) postPreview(open, { action: 'language', language: view.language })
    if (view.scheme !== before.scheme) postPreview(open, { action: 'scheme', scheme: view.scheme })
    if (view.target !== null && view.target !== before.target) postPreview(open, { action: 'goTo', questionId: view.target })
  }, [])

  const send = useCallback((command: WindowCommand) => {
    if (command.kind === 'restart') postPreview(channel.current, { action: 'restart' })
    else postPreview(channel.current, { action: 'goTo', questionId: command.target })
  }, [])

  const open = useCallback((preset: WindowPreset, options: { readonly tab?: boolean } = {}) => {
    const id = session.current ?? previewSession(formKey)
    // (the channel first: the window's `ready` must find someone listening)
    connect(id)
    return openPreviewWindow({ session: id, ui: uiLanguage(i18n.resolvedLanguage ?? i18n.language), preset, tab: options.tab === true })
  }, [formKey, connect, i18n])

  return useMemo(() => ({ seed, open, setView, send, openSince }), [seed, open, setView, send, openSince])
}
