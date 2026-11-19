/**
 * @fileoverview The preview window, `/form-preview.html` (7.55.01, audit §1.4 B): the real widget in preview mode
 * (it never fetches a form, never submits, never counts anything; its own strip says "Preview · Nothing is sent"),
 * given the draft the builder posts over the session's BroadcastChannel (preview/previewChannel.ts), in a real
 * viewport: the widget's width rules, the pointer and the sticky Next bar behave as on the device.
 *
 * Above the form, a 40 px toolbar of its own (outside the widget's shadow root, styled by previewWindow.css: no app
 * CSS, no React): the window's size (Phone 390 × 844, Phone rotated, Tablet, Desktop, "Embedded, 480 px tall"; the
 * window resizes itself, which a browser allows for a window a page opened), the preview language and Restart. In a
 * tab (a phone) the size is the device's and the size choice is left out.
 *
 * The window says `ready` until the builder answers with the draft (the builder may be loading, or busy in the
 * background), then follows `config`, `goTo`, `restart`, `language` and `scheme`, saying `alive` as often while it
 * shows the form and `closed` when it goes (so the builder's in-pane preview collapses only while it is open). A new
 * address (the builder opened it again, at another size or for another form) is read without a reload.
 *
 * @module pages/FeedbackForms/preview/window/previewWindow
 */
import { loadWidget, startPreview } from '../widgetScript'
import type { PreviewHandle, PreviewScheme } from '../widgetScript'
import {
  WINDOW_PRESETS, WINDOW_PRESET_IDS, WINDOW_TOOLBAR_PX, openChannel, postPreview, readPreviewMessage, readWindowAddress,
} from '../previewChannel'
import type { LanguageChoice, PreviewMessage, WindowAddress, WindowPreset } from '../previewChannel'
import { noCleanup } from '../../../../hooks/noCleanup'
import { loadWords, windowLanguage } from './windowWords'
import type { Words } from './windowWords'

/** How often the window asks again while no draft has come, and says it is still open once one has. */
const READY_RETRY_MS = 1500
/** How long a resize may take before the window checks whether the browser allowed it. */
const RESIZE_SETTLE_MS = 600
/** A viewport within this many px of a preset is that preset (zoom rounding). */
const SIZE_SLACK_PX = 2
const CUSTOM = 'custom'

interface Shell {
  readonly size: HTMLSelectElement
  readonly language: HTMLSelectElement
  readonly restart: HTMLButtonElement
  readonly status: HTMLElement
  readonly stage: HTMLElement
  readonly message: HTMLElement
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function labelled(control: HTMLSelectElement, id: string, text: string): HTMLLabelElement {
  control.id = id
  const label = element('label', 'pw-sr-only', text)
  label.htmlFor = id
  return label
}

/** The preset the viewport is now (under the toolbar), or null for a size of the person's own. */
export function presetOfViewport(width: number, height: number): WindowPreset | null {
  return WINDOW_PRESET_IDS.find((id) => {
    const preset = WINDOW_PRESETS[id]
    return Math.abs(width - preset.width) <= SIZE_SLACK_PX && Math.abs(height - WINDOW_TOOLBAR_PX - preset.height) <= SIZE_SLACK_PX
  }) ?? null
}

/** The toolbar and the stage, in `root` (the page's body). */
function buildShell(root: HTMLElement, words: Words, address: WindowAddress): Shell {
  const bar = element('header', 'pw-bar')
  const size = element('select', 'pw-select')
  for (const id of WINDOW_PRESET_IDS) {
    const { width, height } = WINDOW_PRESETS[id]
    const option = element('option', '', words('sizeOption', { name: words(id), width, height }))
    option.value = id
    size.append(option)
  }
  const custom = element('option', '')
  custom.value = CUSTOM
  custom.disabled = true
  size.append(custom)
  const language = element('select', 'pw-select')
  const restart = element('button', 'pw-button', words('restart'))
  restart.type = 'button'
  const status = element('span', 'pw-status')
  status.setAttribute('role', 'status')
  const sizeGroup = element('span', 'pw-group')
  sizeGroup.append(labelled(size, 'pw-size', words('size')), size)
  sizeGroup.hidden = address.tab
  const languageGroup = element('span', 'pw-group')
  languageGroup.append(labelled(language, 'pw-language', words('language')), language)
  languageGroup.hidden = true
  bar.append(sizeGroup, languageGroup, restart, status)
  const stage = element('main', 'pw-stage')
  stage.setAttribute('role', 'region')
  stage.setAttribute('aria-label', words('title'))
  const message = element('p', 'pw-message', words('waiting'))
  root.replaceChildren(bar, message, stage)
  return { size, language, restart, status, stage, message }
}

/** Show the size the window is now in the size choice ("Custom · 1012 × 700" when it is none of them). */
function reflectSize(shell: Shell, words: Words): WindowPreset | null {
  const preset = presetOfViewport(window.innerWidth, window.innerHeight)
  const custom = shell.size.querySelector<HTMLOptionElement>(`option[value="${CUSTOM}"]`)
  if (custom !== null) {
    custom.hidden = preset !== null
    custom.textContent = words('custom', { width: window.innerWidth, height: Math.max(0, window.innerHeight - WINDOW_TOOLBAR_PX) })
  }
  shell.size.value = preset ?? CUSTOM
  return preset
}

/** Resize the window so the form gets the preset's viewport; says so when the browser keeps the size. */
function resizeWindow(shell: Shell, words: Words, preset: WindowPreset): void {
  const { width, height } = WINDOW_PRESETS[preset]
  const chromeX = Math.max(0, window.outerWidth - window.innerWidth)
  const chromeY = Math.max(0, window.outerHeight - window.innerHeight)
  shell.status.textContent = ''
  window.resizeTo(width + chromeX, height + WINDOW_TOOLBAR_PX + chromeY)
  window.setTimeout(() => {
    if (reflectSize(shell, words) !== preset) shell.status.textContent = words('resizeRefused')
  }, RESIZE_SETTLE_MS)
}

interface Showing {
  config: Record<string, unknown> | null
  seed: number
  language: string | null
  scheme: PreviewScheme | null
  target: string | null
  languages: readonly LanguageChoice[]
}

function fillLanguages(shell: Shell, choices: readonly LanguageChoice[], current: string | null): void {
  const group = shell.language.parentElement
  if (group !== null) group.hidden = choices.length < 2
  shell.language.replaceChildren(...choices.map((choice) => {
    const option = element('option', '', choice.label)
    option.value = choice.value
    return option
  }))
  if (current !== null) shell.language.value = current
}

/** One preview session: its channel, and the widget once the first draft has come. */
interface WindowSession {
  readonly close: () => void
}

function startSession(address: WindowAddress, shell: Shell, words: Words): WindowSession {
  const channel = openChannel(address.session)
  const showing: Showing = { config: null, seed: 0, language: null, scheme: null, target: null, languages: [] }
  const live: { handle: PreviewHandle | null; starting: boolean; closed: boolean } = { handle: null, starting: false, closed: false }

  const nameRegion = () => {
    const chosen = showing.languages.find((choice) => choice.value === showing.language)
    shell.stage.setAttribute('aria-label', chosen === undefined ? words('title') : words('region', { language: chosen.label }))
  }
  const failed = () => {
    shell.message.textContent = words('unavailable')
    shell.message.hidden = false
  }
  const start = (config: Record<string, unknown>) => {
    live.starting = true
    loadWidget().then((api) => {
      if (live.closed) return
      const fallback = typeof config['language'] === 'string' ? config['language'] : 'en'
      const handle = startPreview(api, shell.stage, config, showing.language ?? fallback, { seed: showing.seed, scheme: showing.scheme })
      live.handle = handle
      if (handle === null) {
        failed()
        return
      }
      shell.message.hidden = true
      // (what came while the script loaded)
      if (showing.config !== null && showing.config !== config) handle.update(showing.config)
      if (showing.target !== null) handle.goTo(showing.target)
    }, (error: unknown) => {
      console.warn('The form preview could not start:', error)
      failed()
    })
  }
  const onConfig = (message: Extract<PreviewMessage, { action: 'config' }>) => {
    showing.config = message.config
    showing.seed = message.seed
    showing.languages = message.languages
    fillLanguages(shell, message.languages, showing.language)
    nameRegion()
    document.title = message.name.trim() === '' ? words('title') : `${words('title')} · ${message.name}`
    if (live.handle !== null) live.handle.update(message.config)
    else if (!live.starting) start(message.config)
  }
  const onLanguage = (language: string) => {
    showing.language = language
    shell.language.value = language
    nameRegion()
    live.handle?.setLanguage(language)
  }
  const receive = (message: PreviewMessage) => {
    if (message.action === 'config') onConfig(message)
    else if (message.action === 'goTo') {
      showing.target = message.questionId
      live.handle?.goTo(message.questionId)
    } else if (message.action === 'restart') live.handle?.restart()
    else if (message.action === 'language') onLanguage(message.language)
    else if (message.action === 'scheme') {
      showing.scheme = message.scheme
      live.handle?.setScheme(message.scheme)
    }
    // (`ready`, `alive` and `closed` are the windows of this session talking to the builder: not for this one)
  }

  if (channel !== null) {
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const message = readPreviewMessage(event.data)
      if (message !== null && !live.closed) receive(message)
    }
  }
  const ask = () => postPreview(channel, { action: showing.config === null ? 'ready' : 'alive' })
  const retry = window.setInterval(ask, READY_RETRY_MS)
  ask()
  const goodbye = () => postPreview(channel, { action: 'closed' })
  window.addEventListener('pagehide', goodbye)

  const onChosen = () => onLanguage(shell.language.value)
  const onRestart = () => live.handle?.restart()
  shell.language.addEventListener('change', onChosen)
  shell.restart.addEventListener('click', onRestart)
  return {
    close: () => {
      live.closed = true
      window.clearInterval(retry)
      window.removeEventListener('pagehide', goodbye)
      goodbye()
      channel?.close()
      shell.language.removeEventListener('change', onChosen)
      shell.restart.removeEventListener('click', onRestart)
      live.handle?.destroy()
      live.handle = null
    },
  }
}

/**
 * The window's page: its words, its toolbar, then the session its address names (and the next, on a new hash).
 * Resolves to its own teardown (the page never needs it; a spec does).
 */
export async function bootPreviewWindow(root: HTMLElement): Promise<() => void> {
  const address = readWindowAddress(window.location.hash)
  const ui = windowLanguage(address?.ui ?? 'en')
  document.documentElement.lang = ui
  const words = await loadWords(ui)
  document.title = words('title')
  if (address === null) {
    root.replaceChildren(element('p', 'pw-message', words('noSession')))
    return noCleanup
  }
  const shell = buildShell(root, words, address)
  reflectSize(shell, words)
  shell.size.addEventListener('change', () => {
    const chosen = WINDOW_PRESET_IDS.find((id) => id === shell.size.value)
    if (chosen !== undefined) resizeWindow(shell, words, chosen)
  })
  const current = { address, session: startSession(address, shell, words) }
  const onResize = () => reflectSize(shell, words)
  const onAddress = () => {
    const next = readWindowAddress(window.location.hash)
    if (next === null) return
    if (next.session !== current.address.session) {
      current.session.close()
      shell.message.textContent = words('waiting')
      shell.message.hidden = false
      current.session = startSession(next, shell, words)
    }
    current.address = next
    if (!next.tab) resizeWindow(shell, words, next.preset)
  }
  window.addEventListener('resize', onResize)
  window.addEventListener('hashchange', onAddress)
  return () => {
    window.removeEventListener('resize', onResize)
    window.removeEventListener('hashchange', onAddress)
    current.session.close()
  }
}
