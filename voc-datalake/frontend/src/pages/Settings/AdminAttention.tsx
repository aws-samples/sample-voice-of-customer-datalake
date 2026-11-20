/**
 * @fileoverview "Needs attention" on General (7.59.00; the items: useAdminAttention.ts): one compact strip that says
 * what needs looking at and links to it, in a `role="status"` that is always there (so its content is read once) and
 * empty while nothing does.
 * @module pages/Settings/AdminAttention
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { AlertTriangle } from 'lucide-react'
import { adminPath } from './adminPaths'
import type { AdminAttention } from './useAdminAttention'

/** The strip on General: nothing while nothing needs attention; the region is always there, so its content is read once. */
export function AttentionStrip({ attention }: Readonly<{ attention: AdminAttention }>) {
  const { t } = useTranslation('settings')
  const titleId = useId()
  return (
    <div role="status" className={attention.items.length === 0 ? undefined : 'mb-4 sm:mb-6'}>
      {attention.items.length === 0 ? null : (
        <section aria-labelledby={titleId} className="rounded-xl border border-warn/40 bg-warn-subtle px-4 py-3">
          <h2 id={titleId} className="flex items-center gap-2 text-sm font-semibold tracking-tight text-text-strong">
            <AlertTriangle size={16} className="flex-shrink-0 text-warn" aria-hidden="true" />
            {t('attention.title')}
          </h2>
          <ul className="mt-1 divide-y divide-warn/20">
            {attention.items.map((item) => (
              <li key={item.key} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-sm text-text">{item.text}</span>
                <Link to={adminPath(item.target)} className="btn btn-secondary btn-sm self-start sm:self-auto">{item.action}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
