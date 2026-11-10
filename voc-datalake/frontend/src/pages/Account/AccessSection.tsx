/**
 * @fileoverview Account → "My access" (read-only): my role and the category and
 * source scope every list and count is filtered by server-side
 * (`GET /feedback/access`, the same route the filters use). An administrator
 * changes it in Administration → Privacy & access → Users.
 *
 * @module pages/Account/AccessSection
 */
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { KeyRound } from 'lucide-react'
import { callerAccessKey, categoryAccessApi } from '../../api/categoryAccessApi'
import type { CallerAccess } from '../../api/categoryAccessApi'
import { useConfigStore } from '../../store/configStore'
import { RoleValue, Section } from './ProfileSections'

function NameList({ names }: Readonly<{ names: readonly string[] }>) {
  return (
    <ul className="flex flex-wrap gap-2 mt-1">
      {names.map((name) => <li key={name} className="badge badge-muted">{name}</li>)}
    </ul>
  )
}

function Row({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm text-text-strong mt-0.5">{children}</dd>
    </div>
  )
}

function CategoriesValue({ access }: Readonly<{ access: CallerAccess }>) {
  const { t } = useTranslation('common')
  const { all, categories } = access.categories
  return all ? <>{t('account.access.everyCategory')}</> : <NameList names={categories} />
}

function SourcesValue({ access }: Readonly<{ access: CallerAccess }>) {
  const { t } = useTranslation('common')
  const { rule, sources, denied } = access.sources
  if (rule === 'all') return <>{t('account.access.everySource')}</>
  return (
    <>
      {rule === 'allow' ? t('account.access.allowedSources') : t('account.access.deniedSources')}
      <NameList names={rule === 'allow' ? sources : denied} />
    </>
  )
}

/** The line shown instead of the scope while it cannot be shown yet, or null once it can. */
function useStatusLine(enabled: boolean, pending: boolean, failed: boolean): ReactNode {
  const { t } = useTranslation('common')
  if (!enabled) return <p className="text-sm text-warn mt-3">{t('settings:shared.configureFirst')}</p>
  if (pending) return <p className="text-sm text-muted mt-3">{t('account.access.loading')}</p>
  if (failed) return <p role="alert" className="text-sm text-danger mt-3">{t('account.access.failed')}</p>
  return null
}

function AccessBody({ isAdmin }: Readonly<{ isAdmin: boolean }>) {
  const { t } = useTranslation('common')
  const enabled = useConfigStore((s) => s.config.apiEndpoint) !== ''
  const query = useQuery({ queryKey: callerAccessKey(), queryFn: categoryAccessApi.getCallerAccess, enabled })
  const status = useStatusLine(enabled, query.isPending, query.isError)
  return (
    <>
      <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Row label={t('account.role')}><RoleValue isAdmin={isAdmin} /></Row>
        {query.data === undefined ? null : (
          <>
            <Row label={t('account.access.categories')}><CategoriesValue access={query.data} /></Row>
            <Row label={t('account.access.sources')}><SourcesValue access={query.data} /></Row>
          </>
        )}
      </dl>
      {status}
    </>
  )
}

export default function AccessSection({ isAdmin }: Readonly<{ isAdmin: boolean }>) {
  const { t } = useTranslation('common')
  return (
    <Section icon={KeyRound} title={t('account.nav.access')} description={t('account.access.hint')}>
      <AccessBody isAdmin={isAdmin} />
    </Section>
  )
}
