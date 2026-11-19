/**
 * @fileoverview The real widget (`lambda/api/static/feedback-widget.js`, the same file the API serves) loaded into
 * the app as a same-origin script, for the editor's preview (UX §3.5, checklist C10) and the preview window
 * (`form-preview.html`, preview/window/).
 *
 * The preview is not an iframe of an app page: CloudFront sends `frame-ancestors 'none'` and `X-Frame-Options:
 * DENY` on the app's own pages (7.55.00 B). Vite emits the widget file as an asset of the build (`?url`: one source,
 * never a copy kept by hand), the page loads it once with a `<script>` (`script-src 'self'`), and the preview calls
 * `VoCFeedbackForm.init({ container, preview: { config, seed, scheme } })`, which renders the draft, never fetches,
 * never submits and never sends a beacon, then drives it through the handle it returns.
 *
 * @module pages/FeedbackForms/preview/widgetScript
 */
import widgetUrl from '../../../../../lambda/api/static/feedback-widget.js?url'

/** The palette a preview can force, whatever the device prefers. */
export type PreviewScheme = 'light' | 'dark'

/** The handle `init` returns for a preview (feedback-widget.js). */
export interface PreviewHandle {
  readonly update: (config: Record<string, unknown>) => void
  /** A question id, `'welcome'` or `'end:<ending id>'`. */
  readonly goTo: (target: string) => void
  readonly restart: () => void
  readonly setLanguage: (language: string) => void
  /** Show the light or the dark palette (null: the one the device prefers). */
  readonly setScheme: (scheme: PreviewScheme | null) => void
  readonly destroy: () => void
}

interface WidgetApi {
  readonly init: (options: Record<string, unknown>) => unknown
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

function isWidgetApi(value: unknown): value is WidgetApi {
  return isObject(value) && typeof value['init'] === 'function'
}

const HANDLE_METHODS = ['update', 'goTo', 'restart', 'setLanguage', 'destroy'] as const
type HandleMethod = (typeof HANDLE_METHODS)[number] | 'setScheme'

/**
 * A preview handle, or null when the widget answered without one (a widget older than 7.55.00 has no preview). A
 * widget without `setScheme` (older than 7.55.01) still previews: forcing a palette then does nothing.
 */
export function asPreviewHandle(value: unknown): PreviewHandle | null {
  if (!isObject(value) || !HANDLE_METHODS.every((name) => typeof value[name] === 'function')) return null
  const call = (name: HandleMethod) => (...args: unknown[]) => {
    const method = value[name]
    if (typeof method === 'function') Reflect.apply(method, value, args)
  }
  return {
    update: call('update'), goTo: call('goTo'), restart: call('restart'), setLanguage: call('setLanguage'),
    setScheme: call('setScheme'), destroy: call('destroy'),
  }
}

function currentApi(): WidgetApi | null {
  const api: unknown = Reflect.get(window, 'VoCFeedbackForm')
  return isWidgetApi(api) ? api : null
}

const state: { loading: Promise<WidgetApi> | null } = { loading: null }

/** The widget's API, loading its script the first time (once per page). */
export function loadWidget(): Promise<WidgetApi> {
  const ready = currentApi()
  if (ready !== null) return Promise.resolve(ready)
  state.loading ??= new Promise<WidgetApi>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = widgetUrl
    script.async = true
    script.onload = () => {
      const api = currentApi()
      if (api === null) reject(new Error('The feedback widget loaded without its API.'))
      else resolve(api)
    }
    script.onerror = () => {
      state.loading = null
      reject(new Error('The feedback widget could not be loaded.'))
    }
    document.head.appendChild(script)
  })
  return state.loading
}

/** How a preview starts: the session's shuffle seed (one stable order, Restart included) and a forced palette. */
interface PreviewStart {
  readonly seed?: number
  readonly scheme?: PreviewScheme | null
}

/** Start a preview of `config` in `container`, in `language`. */
export function startPreview(api: WidgetApi, container: HTMLElement, config: Record<string, unknown>, language: string,
  start: PreviewStart = {}): PreviewHandle | null {
  const preview: Record<string, unknown> = { config }
  if (start.seed !== undefined) preview['seed'] = start.seed
  if (start.scheme !== undefined && start.scheme !== null) preview['scheme'] = start.scheme
  return asPreviewHandle(api.init({ container, language, preview }))
}
