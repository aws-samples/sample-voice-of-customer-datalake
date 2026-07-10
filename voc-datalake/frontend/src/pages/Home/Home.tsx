/**
 * @fileoverview Home / getting-started page — the app's landing route ("/").
 *
 * Promoted from the Dashboard empty-state onboarding into a permanent, always-
 * available guide. It explains what the platform does and walks the user
 * through the product-development flow the sidebar is organized around
 * (AI-PDLC phases: Sources → Signals → Ideation → Validation), with direct
 * links into each section, plus quick-start cards for the fastest path to
 * first data.
 *
 * Uses the `dashboard` i18n namespace: it reuses the existing `onboarding.*`
 * strings for the quick-start cards and adds `home.*` strings for the hero and
 * phase flow, so no new namespace has to be registered. Sidebar nav labels are
 * pulled from the `common` namespace via explicit `common:` key prefixes.
 *
 * @module pages/Home
 */

import {
  Globe,
  Database,
  MessageSquare,
  FolderOpen,
  SearchX,
  Bot,
  Briefcase,
  FileText,
  ListOrdered,
  ArrowRight,
  Sparkles,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

/** A link chip inside a phase card, pointing at the relevant sidebar section. */
interface PhaseLink {
  to: string
  /** i18n key (uses `common:` prefix to reuse the sidebar nav labels). */
  labelKey: string
  icon: LucideIcon
}

/** One step of the product-development flow, mapped to an AI-PDLC phase. */
interface Phase {
  num: number
  titleKey: string
  descKey: string
  links: PhaseLink[]
}

/**
 * The four workflow phases, in order. Link targets mirror the sidebar sections
 * so the guide and the nav stay in lockstep (Sources → Signals → Ideation →
 * Validation).
 */
const PHASES: Phase[] = [
  {
    num: 1,
    titleKey: 'home.phase1Title',
    descKey: 'home.phase1Desc',
    links: [
      { to: '/scrapers', labelKey: 'common:nav.scrapers', icon: Globe },
      { to: '/data-explorer', labelKey: 'common:nav.dataExplorer', icon: Database },
    ],
  },
  {
    num: 2,
    titleKey: 'home.phase2Title',
    descKey: 'home.phase2Desc',
    links: [
      { to: '/feedback', labelKey: 'common:nav.feedback', icon: MessageSquare },
      { to: '/categories', labelKey: 'common:nav.categories', icon: FolderOpen },
      { to: '/problems', labelKey: 'common:nav.problemAnalysis', icon: SearchX },
    ],
  },
  {
    num: 3,
    titleKey: 'home.phase3Title',
    descKey: 'home.phase3Desc',
    links: [
      { to: '/chat', labelKey: 'common:nav.aiChat', icon: Bot },
      { to: '/projects', labelKey: 'common:nav.projects', icon: Briefcase },
    ],
  },
  {
    num: 4,
    titleKey: 'home.phase4Title',
    descKey: 'home.phase4Desc',
    links: [
      { to: '/feedback-forms', labelKey: 'common:nav.feedbackForms', icon: FileText },
      { to: '/prioritization', labelKey: 'common:nav.prioritization', icon: ListOrdered },
    ],
  },
]

/** A quick-start CTA card (fastest path to first data). */
interface QuickStart {
  to: string
  icon: LucideIcon
  titleKey: string
  descKey: string
  primary: boolean
}

const QUICK_START: QuickStart[] = [
  { to: '/scrapers', icon: Globe, titleKey: 'onboarding.step1Title', descKey: 'onboarding.step1Desc', primary: true },
  { to: '/feedback-forms', icon: FileText, titleKey: 'onboarding.step2Title', descKey: 'onboarding.step2Desc', primary: false },
  { to: '/chat', icon: Bot, titleKey: 'onboarding.step3Title', descKey: 'onboarding.step3Desc', primary: false },
]

function PhaseCard({ phase }: Readonly<{ phase: Phase }>) {
  const { t } = useTranslation('dashboard')
  return (
    <div className="flex gap-4 rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">
        {phase.num}
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold text-gray-900">{t(phase.titleKey)}</h3>
        <p className="mt-1 text-sm text-gray-500">{t(phase.descKey)}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {phase.links.map((link) => {
            const Icon = link.icon
            return (
              <Link
                key={link.to}
                to={link.to}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700"
              >
                <Icon size={14} className="flex-shrink-0" />
                {t(link.labelKey)}
              </Link>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function QuickStartCard({ item, index }: Readonly<{ item: QuickStart; index: number }>) {
  const { t } = useTranslation('dashboard')
  const Icon = item.icon
  return (
    <Link
      to={item.to}
      className={`flex flex-col gap-2 rounded-xl border p-5 transition-colors ${
        item.primary
          ? 'border-blue-500 bg-blue-50 hover:bg-blue-100'
          : 'border-gray-200 bg-white hover:bg-gray-50'
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${
            item.primary ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600'
          }`}
        >
          {index + 1}
        </span>
        <Icon size={18} className={item.primary ? 'text-blue-600' : 'text-gray-500'} />
      </div>
      <div className="text-sm font-semibold">{t(item.titleKey)}</div>
      <div className="flex-1 text-xs text-gray-500">{t(item.descKey)}</div>
      {item.primary ? (
        <span className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-blue-600">
          {t('onboarding.cta')} <ArrowRight size={12} />
        </span>
      ) : null}
    </Link>
  )
}

export default function Home() {
  const { t } = useTranslation('dashboard')

  return (
    <div className="mx-auto max-w-3xl space-y-8 pb-8">
      {/* Hero */}
      <header className="pt-2">
        <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">
          <Sparkles size={14} />
          {t('home.badge')}
        </div>
        <h1 className="text-2xl font-bold text-gray-900 sm:text-3xl">{t('home.title')}</h1>
        <p className="mt-2 text-gray-600">{t('home.intro')}</p>
      </header>

      {/* Workflow flow */}
      <section>
        <div className="mb-1 flex items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold text-gray-900">{t('home.howItWorks')}</h2>
        </div>
        <p className="mb-4 text-sm text-gray-500">{t('home.flowHint')}</p>
        <div className="space-y-3">
          {PHASES.map((phase) => (
            <PhaseCard key={phase.num} phase={phase} />
          ))}
        </div>
      </section>

      {/* Quick start */}
      <section>
        <h2 className="mb-1 text-lg font-semibold text-gray-900">{t('home.quickStart')}</h2>
        <p className="mb-4 text-sm text-gray-500">{t('home.quickStartHint')}</p>
        <div className="grid gap-4 sm:grid-cols-3">
          {QUICK_START.map((item, i) => (
            <QuickStartCard key={item.to} item={item} index={i} />
          ))}
        </div>
      </section>
    </div>
  )
}
