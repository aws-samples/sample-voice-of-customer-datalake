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
  url, html, title, className,
}: {
  readonly url?: string
  readonly html?: string
  readonly title?: string
  readonly className?: string
}) {
  const loadedUrl = useLoadedUrl(url)

  if (loadedUrl) {
    return (
      <iframe
        title={title || 'Prototype'}
        src={loadedUrl}
        className={className ?? 'w-full h-full border-0'}
      />
    )
  }
  return (
    <iframe
      title={title || 'Prototype'}
      srcDoc={html}
      sandbox="allow-scripts allow-popups allow-forms"
      className={className ?? 'w-full h-full border-0'}
    />
  )
}

export default function PrototypeRenderer({ spec }: { readonly spec: PrototypeSpec }) {
  const screens = useMemo(
    () => spec.screens.filter((s) => s && typeof s.id === 'string'),
    [spec.screens],
  )
  const [activeId, setActiveId] = useState<string>(screens[0]?.id ?? '')

  const goto = useCallback((id?: string) => {
    if (id && screens.some((s) => s.id === id)) setActiveId(id)
  }, [screens])

  if (screens.length === 0) {
    return <div className="text-sm text-gray-500">No screens in prototype.</div>
  }

  const active = screens.find((s) => s.id === activeId) ?? screens[0]

  return (
    <div className="max-w-2xl mx-auto">
      {spec.banner ? (
        <div className="bg-amber-100 text-amber-900 text-xs text-center py-1.5 rounded-md mb-3 font-medium">
          {spec.banner}
        </div>
      ) : null}
      <nav className="flex gap-1 mb-4 border-b overflow-x-auto pb-1">
        {screens.map((s) => (
          <button
            key={s.id}
            onClick={() => setActiveId(s.id)}
            className={clsx(
              'px-3 py-1.5 text-sm rounded-t-md whitespace-nowrap transition-colors',
              s.id === active.id
                ? 'bg-blue-600 text-white'
                : 'text-gray-600 hover:bg-gray-100',
            )}
          >
            {s.label || s.id}
          </button>
        ))}
      </nav>
      <div className="space-y-4">
        {active.heading ? (
          <div>
            <h3 className="text-lg font-semibold">{active.heading}</h3>
            {active.subheading ? <p className="text-sm text-gray-500 mt-0.5">{active.subheading}</p> : null}
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
      return <p className="text-sm text-gray-700 whitespace-pre-wrap">{block.text}</p>
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
        <div className="text-xs text-gray-400 italic">
          (Unsupported block type: {block.type})
        </div>
      )
  }
}

function PrototypeCalloutBlock({ block }: { readonly block: PrototypeBlock }) {
  const toneClass = {
    info: 'bg-blue-50 border-blue-200 text-blue-800',
    success: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    warn: 'bg-amber-50 border-amber-200 text-amber-800',
    error: 'bg-red-50 border-red-200 text-red-800',
  }[block.tone || 'info'] ?? 'bg-gray-50 border-gray-200 text-gray-800'
  return <div className={clsx('text-sm p-3 rounded-md border', toneClass)}>{block.text}</div>
}

function PrototypeStatsBlock({ block }: { readonly block: PrototypeBlock }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {(block.items ?? []).map((s, i) => (
        <div key={i} className="border rounded-lg p-3 bg-gray-50">
          <div className="text-xs text-gray-500">{s.label}</div>
          <div className="text-lg font-semibold mt-0.5">{s.value}</div>
        </div>
      ))}
    </div>
  )
}

function PrototypeListBlock({ block }: { readonly block: PrototypeBlock }) {
  return (
    <div className="space-y-2">
      {block.title ? <h4 className="text-sm font-medium text-gray-700">{block.title}</h4> : null}
      <ul className="divide-y border rounded-lg">
        {(block.items ?? []).map((item, i) => (
          <li key={i} className="px-3 py-2 flex items-center justify-between">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate">{item.title}</div>
              {item.subtitle ? <div className="text-xs text-gray-500 truncate">{item.subtitle}</div> : null}
            </div>
            {item.badge ? (
              <span className="ml-2 text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded-full whitespace-nowrap">
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
              ? 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              : 'bg-blue-600 text-white hover:bg-blue-700',
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
      className="space-y-3 border rounded-lg p-3 bg-gray-50"
    >
      {block.title ? <h4 className="text-sm font-medium text-gray-700">{block.title}</h4> : null}
      {fields.map((f, i) => (
        <div key={i}>
          <label className="block text-xs text-gray-600 mb-1">{f.label}</label>
          {(f.type ?? 'text') === 'textarea' ? (
            <textarea
              placeholder={f.placeholder}
              rows={3}
              className="w-full px-3 py-2 border rounded-md text-sm"
            />
          ) : (
            <input
              type={f.type ?? 'text'}
              placeholder={f.placeholder}
              className="w-full px-3 py-2 border rounded-md text-sm"
            />
          )}
        </div>
      ))}
      {block.submit ? (
        <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700">
          {block.submit.label}
        </button>
      ) : null}
      {submitted && !block.submit?.goto ? (
        <div className="text-xs text-emerald-700 mt-1">✓ Submitted (mock)</div>
      ) : null}
    </form>
  )
}
