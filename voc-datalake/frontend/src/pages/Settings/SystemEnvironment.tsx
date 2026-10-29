/**
 * @fileoverview The System errors tab's collapsible "Environment" block
 * (`GET /logs/system/environment`): what is deployed and how it is configured —
 * version, region, enabled sources, models, alerting — so whoever reads the
 * errors knows the deployment they came from. Nothing in it is secret.
 * @module pages/Settings/SystemEnvironment
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { ChevronDown, Server } from 'lucide-react'
import clsx from 'clsx'
import type { SystemEnvironmentEntry, SystemEnvironmentValue } from '../../api/systemDiagnostics'
import { SettingsLoading, SettingsNotice } from './SettingsNotice'
import { BUILD_INFO, paddedVersion } from './buildInfo'
import { useSystemEnvironment } from './useSystemLogs'

/** The route's known fields, in the order shown; any other field follows under its own name. */
const KNOWN_KEYS = [
  'version', 'region', 'account_suffix', 'deployment_prefix', 'enabled_sources', 'web_search',
  'inference_scope', 'image_model', 'models', 'alerting', 'open_circuits', 'log_coverage',
] as const
type KnownKey = (typeof KNOWN_KEYS)[number]

const isKnownKey = (key: string): key is KnownKey => KNOWN_KEYS.some((known) => known === key)

const rank = (key: string) => (isKnownKey(key) ? KNOWN_KEYS.indexOf(key) : KNOWN_KEYS.length)

/** Known fields first in their fixed order, then the rest as the route sent them. */
const ordered = (entries: readonly SystemEnvironmentEntry[]) =>
  entries.map((entry, position) => ({ entry, position }))
    .sort((a, b) => rank(a.entry.key) - rank(b.entry.key) || a.position - b.position)
    .map(({ entry }) => entry)

export default function SystemEnvironment() {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  return (
    <section className="card">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 text-left"
      >
        <span className="flex items-center gap-2 text-sm font-medium text-text-strong">
          <Server size={16} aria-hidden="true" />
          {t('logs.system.environment.title')}
        </span>
        <ChevronDown size={14} className={clsx('text-muted transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>
      {open && <div className="mt-3"><EnvironmentBody /></div>}
    </section>
  )
}

function EnvironmentBody() {
  const { t } = useTranslation('settings')
  const { data, isLoading, isError } = useSystemEnvironment()
  if (isLoading) return <SettingsLoading text={t('logs.system.environment.loading')} />
  if (isError || data === undefined) return <SettingsNotice text={t('logs.system.environment.loadFailed')} />
  // The route sends no version (a Lambda env var would change every template on every release):
  // the SPA's own build stamp is the version that is deployed.
  const entries = [buildEntry(), ...data.filter((entry) => entry.key !== 'version')]
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {ordered(entries).map((entry) => (
        <EnvironmentRow key={entry.key} entry={entry} />
      ))}
    </dl>
  )
}

/** `5.44.00 (abc1234)`, from the build stamps shown on Administration → System → Version. */
function buildEntry(): SystemEnvironmentEntry {
  const text = `${paddedVersion(BUILD_INFO.version)} (${BUILD_INFO.commit})`
  return { key: 'version', value: { kind: 'text', text }, raw: text }
}

/** Literal keys, so the i18n audit sees every label. */
function fieldLabel(key: KnownKey, t: TFunction<'settings'>): string {
  const labels: Record<KnownKey, string> = {
    version: t('logs.system.environment.fields.version'),
    region: t('logs.system.environment.fields.region'),
    account_suffix: t('logs.system.environment.fields.account_suffix'),
    deployment_prefix: t('logs.system.environment.fields.deployment_prefix'),
    enabled_sources: t('logs.system.environment.fields.enabled_sources'),
    web_search: t('logs.system.environment.fields.web_search'),
    inference_scope: t('logs.system.environment.fields.inference_scope'),
    image_model: t('logs.system.environment.fields.image_model'),
    // The route's `models` = {effective per surface, overrides}: the admin's model choices.
    models: t('logs.system.environment.fields.model_overrides'),
    alerting: t('logs.system.environment.fields.alerting'),
    open_circuits: t('logs.system.environment.fields.open_circuits'),
    log_coverage: t('logs.system.environment.fields.log_coverage'),
  }
  return labels[key]
}

function EnvironmentRow({ entry }: { readonly entry: SystemEnvironmentEntry }) {
  const { t } = useTranslation('settings')
  const label = isKnownKey(entry.key) ? fieldLabel(entry.key, t) : entry.key
  return (
    <>
      <dt className="font-medium text-text">{label}</dt>
      <dd className="font-mono text-muted break-all"><EnvironmentValue value={entry.value} /></dd>
    </>
  )
}

function EnvironmentValue({ value }: { readonly value: SystemEnvironmentValue }) {
  const { t } = useTranslation('settings')
  if (value.kind === 'flag') return <>{value.on ? t('logs.system.environment.on') : t('logs.system.environment.off')}</>
  if (value.kind === 'text') return <>{value.text}</>
  if (value.items.length === 0) return <>{t('logs.system.environment.none')}</>
  return (
    <ul className="space-y-0.5">
      {value.items.map((item) => <li key={item}>{item}</li>)}
    </ul>
  )
}
