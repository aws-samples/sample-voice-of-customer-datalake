/**
 * @fileoverview The page's "Contents": the document's h1-h3 headings as links, the one being read highlighted while
 * the page scrolls. Sticky beside the text on wide screens; on narrow screens a "Contents" disclosure above it.
 * Following a link scrolls the canvas to the heading and moves focus there (CanvasEditorHandle.scrollToHeading).
 *
 * @module components/DocumentCanvas/page/Outline
 */
import clsx from 'clsx'
import { ChevronDown } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { noCleanup } from '../../../hooks/noCleanup'
import type { KeyboardEvent, MouseEvent } from 'react'
import type { OutlineItem } from '../editor/CanvasEditor'

const INDENT: Readonly<Record<OutlineItem['level'], string>> = { 1: 'pl-2', 2: 'pl-5', 3: 'pl-8' }

interface OutlineProps {
  readonly items: readonly OutlineItem[]
  /** Scrolls the canvas to the heading with this id and moves focus to it. */
  readonly onNavigate: (id: string) => void
  readonly className?: string
}

/**
 * The id of the heading being read: the first one in the top part of the viewport, else the last one scrolled past.
 * Absent IntersectionObserver (old engines), the first heading.
 */
function useActiveHeading(idList: string): [string | undefined, (id: string) => void] {
  // One string, not an array: a new list with the same headings (every outline update) must not re-observe.
  const ids = useMemo(() => (idList === '' ? [] : idList.split('\n')), [idList])
  const [active, setActive] = useState<string | undefined>(ids[0])
  useEffect(() => {
    if (ids.length === 0 || typeof IntersectionObserver === 'undefined') return noCleanup
    const visible = new Set<string>()
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target.id)
        else visible.delete(entry.target.id)
      }
      const first = ids.find((id) => visible.has(id))
      if (first !== undefined) setActive(first)
    }, { rootMargin: '0px 0px -70% 0px' })
    for (const id of ids) {
      const heading = document.getElementById(id)
      if (heading !== null) observer.observe(heading)
    }
    return () => observer.disconnect()
  }, [ids])
  const current = active !== undefined && ids.includes(active) ? active : ids[0]
  return [current, setActive]
}

export default function Outline({ items, onNavigate, className }: OutlineProps) {
  const { t } = useTranslation('projectDetail')
  const [active, setActive] = useActiveHeading(items.map((item) => item.id).join('\n'))
  const [open, setOpen] = useState(false)
  const listId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  if (items.length === 0) return null

  const follow = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    event.preventDefault()
    setActive(id)
    setOpen(false)
    onNavigate(id)
  }
  const closeOnEscape = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || !open) return
    event.stopPropagation()
    setOpen(false)
    toggleRef.current?.focus()
  }
  return (
    <nav aria-label={t('canvas.page.contents')} onKeyDown={closeOnEscape}
      className={clsx('min-w-0 lg:sticky lg:top-4 lg:self-start', className)}>
      <button ref={toggleRef} type="button" aria-expanded={open} aria-controls={listId}
        className="lg:hidden btn btn-secondary btn-sm w-full justify-between" onClick={() => setOpen((value) => !value)}>
        {t('canvas.page.contents')}
        <ChevronDown size={14} aria-hidden className={clsx('transition-transform motion-reduce:transition-none', open && 'rotate-180')} />
      </button>
      <p aria-hidden className="hidden lg:block mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
        {t('canvas.page.contents')}
      </p>
      <ol id={listId} data-open={open} className={clsx('mt-2 lg:mt-0 space-y-0.5 text-sm', open ? 'block' : 'hidden lg:block')}>
        {items.map((item) => {
          const current = item.id === active
          return (
            <li key={item.id}>
              <a href={`#${item.id}`} aria-current={current ? 'location' : undefined}
                onClick={(event) => follow(event, item.id)}
                className={clsx(
                  'block rounded-md py-1 pr-2 border-l-2 break-words focus-ring transition-colors',
                  INDENT[item.level],
                  current ? 'border-accent text-accent-text font-medium bg-accent-subtle' : 'border-transparent text-muted hover:text-text hover:bg-bg-hover',
                )}>
                {item.text}
              </a>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
