/**
 * @fileoverview The Settings tab (UX §14.1): General, Category routing, Linked project, Theme and the Danger zone,
 * as cards on one page with an anchor list from `lg`. They are part of the one draft (one Save, principle 2).
 *
 * @module pages/FeedbackForms/tabs/SettingsTab
 */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfigStore } from '../../../store/configStore'
import { useDraft } from '../builder/formDraftContext'
import ValidationLinkPicker from '../ValidationLinkPicker'
import CategoryRoutingSection from './settings/CategoryRoutingSection'
import ThemeSection from './settings/ThemeSection'
import { DangerZone, GeneralSection } from './settings/GeneralSection'

const SECTIONS = ['general', 'routing', 'project', 'theme', 'danger'] as const
type Section = (typeof SECTIONS)[number]

function SettingsCard({ section, title, children }: Readonly<{ section: Section; title: string; children: ReactNode }>) {
  return (
    <section id={`form-settings-${section}`} aria-labelledby={`form-settings-${section}-title`} className="card scroll-mt-4 space-y-4">
      <h2 id={`form-settings-${section}-title`} className="text-base font-semibold tracking-tight text-text-strong">{title}</h2>
      {children}
    </section>
  )
}

function LinkedProject() {
  const { form, update } = useDraft()
  const apiEndpoint = useConfigStore((state) => state.config.apiEndpoint)
  return (
    <ValidationLinkPicker value={{ project_id: form.project_id, document_id: form.document_id }} enabled={apiEndpoint !== ''}
      onChange={(link) => update((current) => ({ ...current, project_id: link.project_id, document_id: link.document_id }))} />
  )
}

export default function SettingsTab() {
  const { t } = useTranslation('feedbackForms')
  const { meta } = useDraft()
  const shown = SECTIONS.filter((section) => section !== 'danger' || meta !== null)
  const titles: Readonly<Record<Section, string>> = {
    general: t('settings.sections.general'), routing: t('settings.sections.routing'), project: t('settings.sections.project'),
    theme: t('settings.sections.theme'), danger: t('settings.sections.danger'),
  }
  const title = (section: Section) => titles[section]
  return (
    <div className="lg:grid lg:grid-cols-[12rem_1fr] lg:gap-6">
      <nav aria-label={t('settings.sectionsLabel')} className="hidden lg:block">
        <ul className="sticky top-4 space-y-1">
          {shown.map((section) => (
            <li key={section}><a href={`#form-settings-${section}`} className="link text-sm">{title(section)}</a></li>
          ))}
        </ul>
      </nav>
      <div className="space-y-4 sm:space-y-6">
        <SettingsCard section="general" title={title('general')}><GeneralSection /></SettingsCard>
        <SettingsCard section="routing" title={title('routing')}><CategoryRoutingSection /></SettingsCard>
        <SettingsCard section="project" title={title('project')}><LinkedProject /></SettingsCard>
        <SettingsCard section="theme" title={title('theme')}><ThemeSection /></SettingsCard>
        {meta !== null && <SettingsCard section="danger" title={title('danger')}><DangerZone /></SettingsCard>}
      </div>
    </div>
  )
}
