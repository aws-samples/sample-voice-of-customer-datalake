/**
 * @fileoverview The preview window's protocol (7.55.01, audit §1.4 B): how the builder (or the forms list, or the
 * template picker) opens `/form-preview.html` and keeps it showing the draft.
 *
 * The window is a top-level page on the app's own origin, so CloudFront's `frame-ancestors 'none'` does not apply
 * and its bundled module runs under `script-src 'self'`. The two sides talk over
 * `BroadcastChannel('voc-form-preview:<session>')`, same-origin by construction: the window says `ready` when it
 * starts (and again until it has a form), the opener answers with the current draft, language, palette and card,
 * then posts `config` on every change, `goTo`, `restart`, `language` and `scheme`. Once it shows a form the window
 * says `alive` every 1.5 s and `closed` when it goes, so the builder knows it is open (its in-pane preview then
 * collapses and gives the editor the width). The session id is kept per form
 * in sessionStorage, so a builder that reloads keeps talking to the window it opened. The window never submits: it
 * starts the widget in preview mode (`init({ container, preview: { config, seed, scheme } })`).
 *
 * @module pages/FeedbackForms/preview/previewChannel
 */

import { isRecord } from '../../../lib/typeGuards'
import type { PreviewScheme } from './widgetScript'

const PREVIEW_MESSAGE_TYPE = 'voc-form-preview'
const PREVIEW_WINDOW_NAME = 'voc-form-preview'
const PREVIEW_WINDOW_PATH = '/form-preview.html'
/** The window's own toolbar above the form, in CSS px: the window's viewport is the preset's height plus this. */
export const WINDOW_TOOLBAR_PX = 40

/** The sizes the window offers (the form's viewport, under the window's toolbar). */
export const WINDOW_PRESETS = {
  phone: { width: 390, height: 844 },
  rotate: { width: 844, height: 390 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 800 },
  /** What the iframe snippet gives a customer's page: 480 px tall. */
  embedded: { width: 1280, height: 480 },
} as const
export type WindowPreset = keyof typeof WINDOW_PRESETS
export const WINDOW_PRESET_IDS: readonly WindowPreset[] = ['phone', 'rotate', 'tablet', 'desktop', 'embedded']

const isPreset = (value: string | null): value is WindowPreset => WINDOW_PRESET_IDS.some((id) => id === value)

/** A language the window's select offers: its code and the builder's words for it ("English (4 missing, …)"). */
export interface LanguageChoice {
  readonly value: string
  readonly label: string
}

export type PreviewMessage =
  | { readonly type: typeof PREVIEW_MESSAGE_TYPE; readonly action: 'ready' }
  /** The window's heartbeat once it shows a form, and its goodbye (`pagehide`, or another session's address). */
  | { readonly type: typeof PREVIEW_MESSAGE_TYPE; readonly action: 'alive' }
  | { readonly type: typeof PREVIEW_MESSAGE_TYPE; readonly action: 'closed' }
  | {
    readonly type: typeof PREVIEW_MESSAGE_TYPE; readonly action: 'config'
    /** The draft as the widget reads it (`toWireForm`). */
    readonly config: Record<string, unknown>
    /** The preview session's shuffle seed (the builder's pane uses the same one). */
    readonly seed: number
    readonly name: string
    readonly languages: readonly LanguageChoice[]
  }
  /** `questionId`: a question id, `'welcome'` or `'end:<ending id>'` (the widget's `goTo`). */
  | { readonly type: typeof PREVIEW_MESSAGE_TYPE; readonly action: 'goTo'; readonly questionId: string }
  | { readonly type: typeof PREVIEW_MESSAGE_TYPE; readonly action: 'restart' }
  | { readonly type: typeof PREVIEW_MESSAGE_TYPE; readonly action: 'language'; readonly language: string }
  | { readonly type: typeof PREVIEW_MESSAGE_TYPE; readonly action: 'scheme'; readonly scheme: PreviewScheme | null }

type WithoutType<M> = M extends unknown ? Omit<M, 'type'> : never
/** A message without its `type` (the sender adds it). */
type PreviewPayload = WithoutType<PreviewMessage>


function isLanguageChoice(value: unknown): value is LanguageChoice {
  return isRecord(value) && typeof value['value'] === 'string' && typeof value['label'] === 'string'
}

function readConfig(data: Record<string, unknown>): PreviewMessage | null {
  const { config, seed, name, languages } = data
  if (!isRecord(config) || typeof seed !== 'number' || !Number.isFinite(seed)) return null
  const choices = Array.isArray(languages) ? languages.filter(isLanguageChoice) : []
  return { type: PREVIEW_MESSAGE_TYPE, action: 'config', config, seed, name: typeof name === 'string' ? name : '', languages: choices }
}

function readScheme(data: Record<string, unknown>): PreviewMessage | null {
  const scheme = data['scheme']
  return scheme === 'light' || scheme === 'dark' || scheme === null ? { type: PREVIEW_MESSAGE_TYPE, action: 'scheme', scheme } : null
}

function readText(data: Record<string, unknown>, field: 'questionId' | 'language'): string | null {
  const value = data[field]
  return typeof value === 'string' ? value : null
}

const READERS: Readonly<Record<PreviewMessage['action'], (data: Record<string, unknown>) => PreviewMessage | null>> = {
  ready: () => ({ type: PREVIEW_MESSAGE_TYPE, action: 'ready' }),
  alive: () => ({ type: PREVIEW_MESSAGE_TYPE, action: 'alive' }),
  closed: () => ({ type: PREVIEW_MESSAGE_TYPE, action: 'closed' }),
  restart: () => ({ type: PREVIEW_MESSAGE_TYPE, action: 'restart' }),
  config: readConfig,
  goTo: (data) => {
    const questionId = readText(data, 'questionId')
    return questionId === null ? null : { type: PREVIEW_MESSAGE_TYPE, action: 'goTo', questionId }
  },
  language: (data) => {
    const language = readText(data, 'language')
    return language === null ? null : { type: PREVIEW_MESSAGE_TYPE, action: 'language', language }
  },
  scheme: readScheme,
}

const isAction = (value: unknown): value is PreviewMessage['action'] => typeof value === 'string' && Object.hasOwn(READERS, value)

/** A message of the protocol, checked field by field; null for anything else. */
export function readPreviewMessage(data: unknown): PreviewMessage | null {
  if (!isRecord(data) || data['type'] !== PREVIEW_MESSAGE_TYPE) return null
  const action = data['action']
  return isAction(action) ? READERS[action](data) : null
}

const channelName = (session: string): string => `voc-form-preview:${session}`

/** A channel to the window of `session`; null where BroadcastChannel is missing (the window then cannot follow). */
export function openChannel(session: string): BroadcastChannel | null {
  return typeof BroadcastChannel === 'function' ? new BroadcastChannel(channelName(session)) : null
}

export function postPreview(channel: BroadcastChannel | null, payload: PreviewPayload): void {
  channel?.postMessage({ type: PREVIEW_MESSAGE_TYPE, ...payload })
}

const SESSION_PATTERN = /^[\w-]{8,64}$/u
const sessionKey = (formKey: string): string => `voc-form-preview-session:${formKey}`

/** A 32-bit shuffle seed for a preview session. */
export function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] ?? 0
}

function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return [...crypto.getRandomValues(new Uint32Array(4))].map((part) => part.toString(36)).join('-')
}

/** The session already kept for `formKey` (a form id, `new`, `picker`) in this tab, or null. */
export function knownPreviewSession(formKey: string): string | null {
  try {
    const stored = window.sessionStorage.getItem(sessionKey(formKey))
    return stored !== null && SESSION_PATTERN.test(stored) ? stored : null
  } catch {
    return null
  }
}

/** The session of `formKey`, made and kept now when there is none. */
export function previewSession(formKey: string): string {
  return knownPreviewSession(formKey) ?? keepPreviewSession(formKey, randomId())
}

/** Keep `session` as the one of `formKey` (a new form's first save moves its session to the form's id). */
export function keepPreviewSession(formKey: string, session: string): string {
  try {
    window.sessionStorage.setItem(sessionKey(formKey), session)
  } catch {
    // (storage refused: this tab still talks to the window it opened, until it reloads)
  }
  return session
}

export interface WindowAddress {
  readonly session: string
  /** The app's language, for the window's own words. */
  readonly ui: string
  readonly preset: WindowPreset
  /** Opened as a tab (a narrow screen): the window's size choices are left out. */
  readonly tab: boolean
}

/** The window's address. A fresh `n` makes a reused window see a new hash (and so resize to the preset asked for). */
export function previewWindowUrl({ session, ui, preset, tab }: WindowAddress): string {
  const params = new URLSearchParams({ s: session, ui, p: preset, n: Date.now().toString(36) })
  if (tab) params.set('tab', '1')
  return `${PREVIEW_WINDOW_PATH}#${params.toString()}`
}

/** The window's address read back from its hash; null without a valid session. */
export function readWindowAddress(hash: string): WindowAddress | null {
  const params = new URLSearchParams(hash.replace(/^#/u, ''))
  const session = params.get('s')
  if (session === null || !SESSION_PATTERN.test(session)) return null
  const preset = params.get('p')
  return { session, ui: params.get('ui') ?? 'en', preset: isPreset(preset) ? preset : 'phone', tab: params.get('tab') === '1' }
}

/**
 * Open the preview window (or bring the open one forward, at `preset`). Call it synchronously in the click handler:
 * browsers let a page open a pop-up only in answer to the person's own click. False when the browser blocked it.
 */
export function openPreviewWindow(address: WindowAddress): boolean {
  const url = previewWindowUrl(address)
  if (address.tab) return window.open(url, PREVIEW_WINDOW_NAME) !== null
  const { width, height } = WINDOW_PRESETS[address.preset]
  const opened = window.open(url, PREVIEW_WINDOW_NAME, `popup=yes,width=${String(width)},height=${String(height + WINDOW_TOOLBAR_PX)}`)
  opened?.focus()
  return opened !== null
}
