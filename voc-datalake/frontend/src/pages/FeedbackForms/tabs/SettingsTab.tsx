/**
 * @fileoverview The Settings tab (UX §14.1, audit F5): General, Appearance, Category routing, Linked project and the
 * Danger zone, as cards on one page with an anchor list from `lg` that says which card is in view (`aria-current`).
 * They are part of the one draft (one Save, principle 2).
 *
 * Appearance is the form's style (theme/ThemeEditor.tsx, the same editor as the Questions tab's Style panel) with its
 * own live preview at the card's end (beside it from xl), showing the palette being edited. `…/settings/appearance`
 * (a theme problem's Go to) scrolls to it.
 *
 * @module pages/FeedbackForms/tabs/SettingsTab
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { useConfigStore } from '../../../store/configStore'
import { languageNames } from '../../../i18n/languages'
import { noCleanup } from '../../../hooks/noCleanup'
import { useDraft } from '../builder/formDraftContext'
import { useBuilderUi } from '../builder/builderUi'
import ValidationLinkPicker from '../ValidationLinkPicker'
import PreviewFrame from '../preview/PreviewFrame'
import ThemeEditor from '../theme/ThemeEditor'
import CategoryRoutingSection from './settings/CategoryRoutingSection'
import { DangerZone, GeneralSection } from './settings/GeneralSection'

const SECTIONS = ['general', 'appearance', 'routing', 'project', 'danger'] as const
type Section = (typeof SECTIONS)[number]
/** The Appearance card's phone, in logical px: tall enough for a question and its Next. */
const PREVIEW_HEIGHT = 640

const cardId = (section: Section): string => `form-settings-${section}`

/** Bring a card to the top of the page. */
function scrollToCard(section: Section): void {
  document.getElementById(cardId(section))?.scrollIntoView({ block: 'start' })
}

function SettingsCard({ section, title, children }: Readonly<{ section: Section; title: string; children: ReactNode }>) {
  return (
    <section id={cardId(section)} aria-labelledby={`${cardId(section)}-title`} className="card scroll-mt-4 space-y-4">
      <h2 id={`${cardId(section)}-title`} className="text-base font-semibold tracking-tight text-text-strong">{title}</h2>
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

/** Appearance: the theme editor and, at the card's end, the form as respondents see it in the palette being edited. */
function Appearance() {
  const { t } = useTranslation('feedbackForms')
  const { form } = useDraft()
  const [scheme, setScheme] = useState<'light' | 'dark' | null>(null)
  const title = t('preview.frameTitle', { size: t('preview.device.phone'), language: languageNames[form.language] })
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <ThemeEditor onEditingSchemeChange={setScheme} />
      <div className="min-w-0 space-y-2 xl:sticky xl:top-4 xl:self-start">
        {scheme !== null && <p className="text-[13px] text-muted">{t('preview.showing', { scheme: t(`preview.scheme.${scheme}`) })}</p>}
        <PreviewFrame form={form} language={form.language} title={title} scheme={scheme} fit={PREVIEW_HEIGHT} />
      </div>
    </div>
  )
}

/** The card most in view (the first one crossing the top of the page), for the anchor list; the first one without an
 * IntersectionObserver. */
function useCardInView(shown: readonly Section[]): [Section | null, (section: Section) => void] {
  const [current, setCurrent] = useState<Section | null>(shown[0] ?? null)
  const key = shown.join(' ')
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return noCleanup
    const sections = key.split(' ').filter((id): id is Section => SECTIONS.some((section) => section === id))
    const inView = new Map<string, boolean>()
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) inView.set(entry.target.id, entry.isIntersecting)
      const first = sections.find((section) => inView.get(cardId(section)) === true)
      if (first !== undefined) setCurrent(first)
    }, { rootMargin: '0px 0px -60% 0px' })
    for (const section of sections) {
      const element = document.getElementById(cardId(section))
      if (element !== null) observer.observe(element)
    }
    return () => observer.disconnect()
  }, [key])
  return [current, setCurrent]
}

export default function SettingsTab() {
  const { t } = useTranslation('feedbackForms')
  const { meta } = useDraft()
  const { rest } = useBuilderUi()
  const shown = SECTIONS.filter((section) => section !== 'danger' || meta !== null)
  const [current, setCurrent] = useCardInView(shown)
  const titles: Readonly<Record<Section, string>> = {
    general: t('settings.sections.general'), appearance: t('settings.sections.appearance'), routing: t('settings.sections.routing'),
    project: t('settings.sections.project'), danger: t('settings.sections.danger'),
  }
  const title = (section: Section) => titles[section]
  const target = rest[0]
  useEffect(() => {
    const section = SECTIONS.find((candidate) => candidate === target)
    if (section === undefined) return
    scrollToCard(section)
    setCurrent(section)
  }, [target, setCurrent])
  return (
    <div className="lg:grid lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-6">
      <nav aria-label={t('settings.sectionsLabel')} className="hidden lg:block">
        <ul className="sticky top-4 space-y-1">
          {shown.map((section) => (
            <li key={section}>
              <a href={`#${cardId(section)}`} aria-current={current === section ? 'true' : undefined}
                className={clsx('link text-sm', current === section && 'font-semibold')} onClick={() => setCurrent(section)}>
                {title(section)}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 space-y-4 sm:space-y-6">
        <SettingsCard section="general" title={title('general')}><GeneralSection /></SettingsCard>
        <SettingsCard section="appearance" title={title('appearance')}><Appearance /></SettingsCard>
        <SettingsCard section="routing" title={title('routing')}><CategoryRoutingSection /></SettingsCard>
        <SettingsCard section="project" title={title('project')}><LinkedProject /></SettingsCard>
        {meta !== null && <SettingsCard section="danger" title={title('danger')}><DangerZone /></SettingsCard>}
      </div>
    </div>
  )
}
