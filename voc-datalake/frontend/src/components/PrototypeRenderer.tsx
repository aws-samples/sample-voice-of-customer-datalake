/**
 * Shared prototype renderer.
 *
 * Renders the Bedrock-generated JSON prototype spec natively as React. Used
 * from the Documents tab inside a project AND from the Prioritization page
 * (under the PR/FAQ preview, so reviewers see the demo without leaving).
 *
 * Spec parsing/types live in ./prototypeSpec (Zod-validated).
 */
import clsx from 'clsx'
import { useCallback, useMemo, useState } from 'react'
import type { Ref } from 'react'
import { signedUrlExpiresAt, unsignedUrlKey } from './prototypeLinkLifetime'
import { useDeadlinePassed } from './useDeadlinePassed'
import type { PrototypeBlock, PrototypeSpec } from './prototypeSpec'

/**
 * Keep the URL this frame actually loaded with, ignoring re-signings of the same
 * document.
 *
 * A prototype URL is a signed credential that the app replaces before it expires,
 * so `url` changes roughly hourly while pointing at the very same document. Passing
 * each new value straight to `src` would **reload the iframe** — silently resetting
 * a reviewer who is several screens into the prototype, on a timer they cannot see.
 *
 * It is also unnecessary. A signature governs the *request*; once the document is
 * loaded, the credential behind it has no further bearing on it. Only a NEW
 * request needs a live signature, which means the anchors beside this frame, not
 * the frame.
 *
 * So: follow the address, ignore the credential. `unsignedUrlKey` is what tells
 * those apart, and a genuine change of document (different path, or dropping to a
 * legacy inline prototype) still reloads, because that is a different address.
 */
/** `value`, or `fallback` when it is absent or empty. */
function orFallback(value: string | undefined, fallback: string): string {
  return value === undefined || value === '' ? fallback : value
}

/**
 * Whether a screen can be rendered and keyed. The spec is parsed by Zod, but it
 * is model output stored verbatim, so the renderer stays safe on its own.
 */
function hasStringId(screen: unknown): boolean {
  return typeof screen === 'object' && screen !== null && 'id' in screen && typeof screen.id === 'string'
}

function useLoadedUrl(url: string | undefined): string | undefined {
  // Whether the URL on offer has ALREADY lapsed. Read only at the moment it is taken —
  // see `deadOnArrival` below — so this asks "could this ever load?", not "is the
  // document still fresh?".
  const incomingIsDead = useDeadlinePassed(signedUrlExpiresAt(url))

  const [loaded, setLoaded] = useState<{
    readonly url: string | undefined
    /**
     * True when this URL was already expired when the frame took it, so it never had a
     * chance of rendering and any replacement is an improvement.
     *
     * This, and NOT the URL's deadline, is what licenses a swap. Releasing on the
     * deadline instead reintroduces exactly the reload the freeze exists to prevent: a
     * frame that loaded fine at t+0 would swap at t+60m to the URL delivered at t+55m,
     * reloading the prototype under the reviewer once an hour. Once a document is in
     * the browser, the credential that fetched it has no further bearing on it — only a
     * fetch that never succeeded does.
     */
    readonly deadOnArrival: boolean
  }>(() => ({ url, deadOnArrival: incomingIsDead }))

  const addressChanged = unsignedUrlKey(loaded.url) !== unsignedUrlKey(url)

  // Adopt for a genuinely different document, or to escape a URL that could never have
  // worked. `url !== loaded.url` matters: with no replacement on offer there is nothing
  // to adopt, and swapping a dead URL for itself would reload the frame every render.
  const adopt = addressChanged || (loaded.deadOnArrival && url !== loaded.url)

  if (adopt) {
    // Guarded render-phase update — the same derive-from-props pattern
    // useCategoryFilters uses to adopt external changes. React re-renders
    // immediately; the value returned below is already the new one, so the frame
    // never renders a stale src even for one frame.
    setLoaded({ url, deadOnArrival: incomingIsDead })
  }
  return adopt ? url : loaded.url
}

/**
 * Renders a self-contained HTML prototype inside an iframe.
 *
 * `url` (new, preferred): loads the prototype from its own CloudFront path
 * (`/prototypes/*`), which has a permissive CSP scoped ONLY to that path —
 * this is what makes the prototype's inline navigation JS actually run.
 * No `sandbox` attribute needed: cross-document `src=` loads are already
 * isolated from the parent page by the browser's normal frame model (the
 * `sandbox` on the old `srcDoc` approach was only compensating for the fact
 * that a same-document `srcDoc` shares the parent's CSP/origin unless
 * sandboxed).
 *
 * That `url` is SIGNED and short-lived, so the caller hands over a new one
 * periodically; `useLoadedUrl` above is why that does not reload the frame.
 *
 * `html` (legacy fallback): pre-migration prototypes have no `prototype_url`
 * and are rendered the old way, via `srcDoc` + `sandbox` — still broken
 * (their inline `<script>` is CSP-blocked by the main app's strict policy),
 * but non-breaking to display.
 */
export function HtmlPrototypeFrame({
  url, html, title, className, frameRef,
}: {
  readonly url?: string
  readonly html?: string
  readonly title?: string
  readonly className?: string
  /** The CDN frame, for the prototype pin bridge (components/PrototypePins). */
  readonly frameRef?: Ref<HTMLIFrameElement>
}) {
  const loadedUrl = useLoadedUrl(url)

  if (loadedUrl) {
    return (
      <iframe
        ref={frameRef}
        title={orFallback(title, 'Prototype')}
        src={loadedUrl}
        className={className ?? 'w-full h-full border-0'}
      />
    )
  }
  return (
    <iframe
      title={orFallback(title, 'Prototype')}
      srcDoc={html}
      sandbox="allow-scripts allow-popups allow-forms"
      className={className ?? 'w-full h-full border-0'}
    />
  )
}

/**
 * The measure a spec prototype is laid out on when the caller does not say.
 *
 * A generated spec is prose, forms and lists — a document, not a canvas — so it is
 * capped at a readable column and centred rather than stretched across whatever
 * width it is given. Callers embedding it in a narrow pane never notice, because the
 * pane is the tighter constraint; a caller that really does have the screen (the
 * prioritization enlarge overlay) passes its own.
 */
const DEFAULT_SPEC_MEASURE = 'max-w-2xl mx-auto'

/**
 * @param measureClassName REPLACES the default measure (`max-w-2xl mx-auto`) rather
 *   than being added to it, so a caller can widen the column instead of fighting a
 *   cap it cannot reach — with both classes on the element, Tailwind's output order
 *   and not the argument order would decide, and the cap would be unwidenable.
 *
 *   Named for the measure rather than called `className` because that name reads as
 *   the conventional additive one, and a caller passing only spacing would silently
 *   drop `mx-auto` and un-centre the artifact. Omit it everywhere the artifact is
 *   embedded; the default is what the Documents tab and the prioritization row's pane
 *   get, byte for byte.
 */
export default function PrototypeRenderer({
  spec, measureClassName,
}: {
  readonly spec: PrototypeSpec
  readonly measureClassName?: string
}) {
  const screens = useMemo(
    () => spec.screens.filter(hasStringId),
    [spec.screens],
  )
  const [activeId, setActiveId] = useState<string>(screens[0]?.id ?? '')

  const goto = useCallback((id?: string) => {
    if (id && screens.some((s) => s.id === id)) setActiveId(id)
  }, [screens])

  const firstScreen = screens.at(0)
  if (firstScreen === undefined) {
    return <div className="text-sm text-muted">No screens in prototype.</div>
  }

  const active = screens.find((s) => s.id === activeId) ?? firstScreen

  return (
    <div className={measureClassName ?? DEFAULT_SPEC_MEASURE}>
      {spec.banner ? (
        <div className="bg-warn-subtle text-warn border border-warn/30 text-xs text-center py-1.5 rounded-md mb-3 font-medium">
          {spec.banner}
        </div>
      ) : null}
      <nav className="flex gap-1 mb-4 border-b border-border overflow-x-auto pb-1">
        {screens.map((s) => (
          <button
            key={s.id}
            onClick={() => setActiveId(s.id)}
            className={clsx(
              'px-3 py-1.5 text-sm rounded-t-md whitespace-nowrap transition-colors',
              s.id === active.id
                ? 'bg-accent text-accent-fg'
                : 'text-muted hover:text-text hover:bg-bg-hover',
            )}
          >
            {orFallback(s.label, s.id)}
          </button>
        ))}
      </nav>
      <div className="space-y-4">
        {active.heading ? (
          <div>
            <h3 className="text-lg font-semibold tracking-tight text-text-strong">{active.heading}</h3>
            {active.subheading ? <p className="text-sm text-muted mt-0.5">{active.subheading}</p> : null}
          </div>
        ) : null}
        {(active.blocks ?? []).map((block, i) => (
          <PrototypeBlockView key={i} block={block} onNavigate={goto} />
        ))}
      </div>
    </div>
  )
}

function PrototypeBlockView({
  block, onNavigate,
}: {
  readonly block: PrototypeBlock
  readonly onNavigate: (id?: string) => void
}) {
  switch (block.type) {
    case 'text':
      return <p className="text-sm text-text whitespace-pre-wrap">{block.text}</p>
    case 'callout':
      return <PrototypeCalloutBlock block={block} />
    case 'stats':
      return <PrototypeStatsBlock block={block} />
    case 'list':
      return <PrototypeListBlock block={block} />
    case 'form':
      return <PrototypeFormBlock block={block} onNavigate={onNavigate} />
    case 'buttons':
      return <PrototypeButtonsBlock block={block} onNavigate={onNavigate} />
    default:
      return (
        <div className="text-xs text-muted italic">
          (Unsupported block type: {block.type})
        </div>
      )
  }
}

function PrototypeCalloutBlock({ block }: { readonly block: PrototypeBlock }) {
  const toneClass = {
    info: 'bg-info-subtle border-info/30 text-info',
    success: 'bg-ok-subtle border-ok/30 text-ok',
    warn: 'bg-warn-subtle border-warn/30 text-warn',
    error: 'bg-danger-subtle border-danger/30 text-danger',
  }[orFallback(block.tone, 'info')] ?? 'bg-bg-accent border-border text-text'
  return <div className={clsx('text-sm p-3 rounded-md border', toneClass)}>{block.text}</div>
}

function PrototypeStatsBlock({ block }: { readonly block: PrototypeBlock }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {(block.items ?? []).map((s, i) => (
        <div key={i} className="border border-border rounded-lg p-3 bg-bg-accent">
          <div className="text-xs text-muted">{s.label}</div>
          <div className="text-lg font-semibold font-mono text-text-strong mt-0.5">{s.value}</div>
        </div>
      ))}
    </div>
  )
}

function PrototypeListBlock({ block }: { readonly block: PrototypeBlock }) {
  return (
    <div className="space-y-2">
      {block.title ? <h4 className="text-sm font-semibold tracking-tight text-text-strong">{block.title}</h4> : null}
      <ul className="divide-y divide-border border border-border rounded-lg">
        {(block.items ?? []).map((item, i) => (
          <li key={i} className="px-3 py-2 flex items-center justify-between">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-text-strong truncate">{item.title}</div>
              {item.subtitle ? <div className="text-xs text-muted truncate">{item.subtitle}</div> : null}
            </div>
            {item.badge ? (
              <span className="ml-2 text-xs bg-bg-hover text-text px-2 py-0.5 rounded-full whitespace-nowrap">
                {item.badge}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

function PrototypeButtonsBlock({
  block, onNavigate,
}: {
  readonly block: PrototypeBlock
  readonly onNavigate: (id?: string) => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {(block.items ?? []).map((b, i) => (
        <button
          key={i}
          onClick={() => onNavigate(b.goto)}
          className={clsx(
            'px-4 py-2 rounded-md text-sm transition-colors',
            (b.tone ?? 'primary') === 'secondary'
              ? 'bg-bg-hover text-text hover:bg-border'
              : 'bg-accent text-accent-fg hover:bg-accent-hover',
          )}
        >
          {b.label}
        </button>
      ))}
    </div>
  )
}

function PrototypeFormBlock({
  block, onNavigate,
}: {
  readonly block: PrototypeBlock
  readonly onNavigate: (id?: string) => void
}) {
  const [submitted, setSubmitted] = useState(false)
  const fields = block.fields ?? []
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        setSubmitted(true)
        if (block.submit?.goto) onNavigate(block.submit.goto)
      }}
      className="space-y-3 border border-border rounded-lg p-3 bg-bg-accent"
    >
      {block.title ? <h4 className="text-sm font-semibold tracking-tight text-text-strong">{block.title}</h4> : null}
      {fields.map((f, i) => (
        <div key={i}>
          <label className="block text-xs text-text mb-1">{f.label}</label>
          {(f.type ?? 'text') === 'textarea' ? (
            <textarea
              placeholder={f.placeholder}
              rows={3}
              className="input"
            />
          ) : (
            <input
              type={f.type ?? 'text'}
              placeholder={f.placeholder}
              className="input"
            />
          )}
        </div>
      ))}
      {block.submit ? (
        <button type="submit" className="btn btn-primary">
          {block.submit.label}
        </button>
      ) : null}
      {submitted && !block.submit?.goto ? (
        <div className="text-xs text-ok mt-1">✓ Submitted (mock)</div>
      ) : null}
    </form>
  )
}
