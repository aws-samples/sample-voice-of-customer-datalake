/**
 * @fileoverview Step-by-step setup help for each token on Administration →
 * Integrations: what it is for, where to get it at the provider, which
 * permissions to grant, how to save and check it here, what a failure means and
 * how it is kept. One accessible disclosure per provider (button with
 * aria-expanded / aria-controls, a labelled region), collapsed by default.
 *
 * @module pages/Settings/IntegrationSetupGuide
 */
import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { ChevronDown, ExternalLink, LifeBuoy } from 'lucide-react'
import clsx from 'clsx'
import { INTEGRATION_GUIDES } from './integrationGuides'
import type { IntegrationGuide } from './integrationGuides'

/** The app's own labels, interpolated so the help names exactly what the UI shows in every locale. */
function useUiLabels(guide: IntegrationGuide): Record<string, string> {
  const { t } = useTranslation(['settings', 'common'])
  return {
    company: t('common:nav.company'),
    design: t('settings:company.tabs.design'),
    add: t('settings:designSystem.addReference'),
    kind: t(`settings:designSystem.kinds.${guide.provider}`),
    ready: t('settings:designSystem.statuses.ready'),
    failed: t('settings:designSystem.statuses.failed'),
    refresh: t('settings:designSystem.refresh'),
    field: t(`settings:designSystem.providers.${guide.provider}`),
    save: t('settings:designSystem.saveTokens'),
    configured: t('settings:designSystem.configured'),
  }
}

function GuideSection({ title, children }: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <section className="space-y-1.5">
      <h4 className="text-[13px] font-semibold text-text-strong">{title}</h4>
      {children}
    </section>
  )
}

function ExternalGuideLink({ href, label }: Readonly<{ href: string; label: string }>) {
  const { t } = useTranslation('settings')
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 link focus-ring rounded-sm">
      {label}
      <ExternalLink size={12} aria-hidden="true" />
      <span className="sr-only">({t('integrationGuide.newTab')})</span>
    </a>
  )
}

function GuideBody({ guide }: Readonly<{ guide: IntegrationGuide }>) {
  const { t } = useTranslation('settings')
  const labels = useUiLabels(guide)
  return (
    <div className="space-y-4 text-sm text-text leading-relaxed">
      <GuideSection title={t('integrationGuide.purposeHeading')}>
        <p>{t(guide.purposeKey, labels)}</p>
      </GuideSection>
      <GuideSection title={t('integrationGuide.stepsHeading')}>
        <ol className="list-decimal pl-5 space-y-1">
          {guide.stepKeys.map((step) => <li key={step.textKey}>{t(step.textKey, labels)}</li>)}
        </ol>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-[13px]">
          {guide.links.map((link) => <li key={link.href}><ExternalGuideLink href={link.href} label={t(link.labelKey)} /></li>)}
        </ul>
      </GuideSection>
      <GuideSection title={t('integrationGuide.permissionsHeading')}>
        <p>{t(guide.permissionsKey, labels)}</p>
      </GuideSection>
      <GuideSection title={t('integrationGuide.saveHeading')}>
        <p>{t('integrationGuide.save', labels)}</p>
      </GuideSection>
      <GuideSection title={t('integrationGuide.testHeading')}>
        <p>{t('integrationGuide.test', labels)}</p>
        <p className="text-muted">{t(guide.linkFormatKey, labels)}</p>
        <Link to="/company?tab=design" className="inline-block link focus-ring rounded-sm">
          {t('integrationGuide.openDesignSystem', labels)}
        </Link>
      </GuideSection>
      <GuideSection title={t('integrationGuide.failuresHeading')}>
        <ul className="space-y-1.5">
          {guide.failures.map((failure) => (
            <li key={failure.message}>
              <code className="font-mono text-[12px] bg-bg-hover text-text-strong rounded-sm px-1 py-0.5">{failure.message}</code>
              {' '}<span className="text-muted">{t(failure.meaningKey, labels)}</span>
            </li>
          ))}
        </ul>
      </GuideSection>
      <GuideSection title={t('integrationGuide.securityHeading')}>
        <p>{t(guide.securityKey, labels)}</p>
        <p>{t('integrationGuide.storage', labels)}</p>
      </GuideSection>
    </div>
  )
}

function GuideDisclosure({ guide }: Readonly<{ guide: IntegrationGuide }>) {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  const id = useId()
  const buttonId = `${id}-button`
  const regionId = `${id}-region`
  return (
    <li className="border border-border rounded-md">
      <h3>
        <button
          type="button"
          id={buttonId}
          aria-expanded={open}
          aria-controls={regionId}
          onClick={() => setOpen((current) => !current)}
          className="w-full flex items-center gap-3 px-3 py-2.5 text-left rounded-md hover:bg-bg-hover transition-colors focus-ring"
        >
          <span className="flex-1 min-w-0">
            <span className="block text-sm font-medium text-text-strong">{t(guide.titleKey)}</span>
            <span className="block text-xs text-muted">{t(guide.summaryKey)}</span>
          </span>
          <ChevronDown size={16} aria-hidden="true" className={clsx('text-muted transition-transform flex-shrink-0', open && 'rotate-180')} />
        </button>
      </h3>
      <div id={regionId} role="region" aria-labelledby={buttonId} hidden={!open} className="border-t border-border px-3 py-3">
        {open ? <GuideBody guide={guide} /> : null}
      </div>
    </li>
  )
}

export default function IntegrationSetupGuide() {
  const { t } = useTranslation(['settings', 'common'])
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-text-strong flex items-center gap-1.5">
          <LifeBuoy size={14} className="text-muted" aria-hidden="true" /> {t('settings:integrationGuide.heading')}
        </h3>
        <p className="text-xs text-muted mt-0.5">{t('settings:integrationGuide.intro')}</p>
      </div>
      <ul className="space-y-2">
        {INTEGRATION_GUIDES.map((guide) => <GuideDisclosure key={guide.provider} guide={guide} />)}
      </ul>
      <p className="text-xs text-muted">{t('settings:integrationGuide.otherCredentials', { plugins: t('settings:tabs.plugins') })}</p>
    </div>
  )
}
