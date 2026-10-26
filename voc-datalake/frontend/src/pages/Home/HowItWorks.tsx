/**
 * @fileoverview "How it works": the product-development flow the sidebar is organized
 * around (AI-PDLC phases: Sources -> Signals -> Ideation -> Validation), last on Home.
 * Uses the `dashboard` namespace (`home.*`); nav labels come from `common:`.
 * @module pages/Home/HowItWorks
 */
import {
  Globe,
  Database,
  FolderOpen,
  SearchX,
  Bot,
  Briefcase,
  FileText,
  ListOrdered,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import CollapsibleSection from '../../components/CollapsibleSection/CollapsibleSection'
import { useIsAdmin } from '../../store/authStore'
import { useSkippableOpen } from './useSkippableOpen'
import type { GuideState } from '../../api/onboardingApi'

/** A link chip inside a phase card, pointing at the relevant sidebar section. */
interface PhaseLink {
  to: string
  /** i18n key (uses `common:` prefix to reuse the sidebar nav labels). */
  labelKey: string
  icon: LucideIcon
  /** Hidden for non-admins, mirroring the sidebar's `adminOnly` items. */
  adminOnly?: boolean
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
      // Admin-only route (raw S3 cannot be filtered by category access).
      { to: '/data-explorer', labelKey: 'common:nav.dataExplorer', icon: Database, adminOnly: true },
    ],
  },
  {
    num: 2,
    titleKey: 'home.phase2Title',
    descKey: 'home.phase2Desc',
    links: [
      // No `/feedback` link here: that route and its `nav.feedback` label were
      // both removed when the standalone Feedback list was consolidated into
      // Categories (issue #198), so the chip rendered the raw key text.
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

function PhaseCard({ phase }: Readonly<{ phase: Phase }>) {
  const { t } = useTranslation('dashboard')
  const isAdmin = useIsAdmin()
  const links = phase.links.filter((link) => link.adminOnly !== true || isAdmin)
  return (
    // Number beside the text when the list is at least 18rem wide (every width at
    // 100 % text); stacked above it when not (390 px at 200 %), so a one-word link
    // like "Prioritization" never pushes the page sideways (WCAG 1.4.10).
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 @[18rem]:flex-row @[18rem]:gap-4 sm:p-5" data-testid="phase-card">
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-accent font-mono text-sm font-bold text-accent-fg">
        {phase.num}
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold tracking-tight text-text-strong">{t(phase.titleKey)}</h3>
        <p className="mt-1 text-sm text-muted">{t(phase.descKey)}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {links.map((link) => {
            const Icon = link.icon
            return (
              <Link
                key={link.to}
                to={link.to}
                className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-bg-accent px-2.5 py-1.5 text-xs font-medium text-text break-words hyphens-auto transition-colors hover:border-accent/30 hover:bg-accent-subtle hover:text-accent-text focus-ring"
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

export default function HowItWorks({ guide, onGuideChange, isSaving }: Readonly<{
  guide: GuideState
  onGuideChange: (guide: GuideState) => void
  isSaving: boolean
}>) {
  const { t } = useTranslation('dashboard')
  const section = useSkippableOpen(guide === 'skipped', () => { onGuideChange('open') })
  return (
    <CollapsibleSection title={t('home.howItWorks')} open={section.open} onOpenChange={section.onOpenChange}>
      <p className="mb-4 text-sm text-muted">{t('home.flowHint')}</p>
      <div className="@container space-y-3">
        {PHASES.map((phase) => (
          <PhaseCard key={phase.num} phase={phase} />
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <button type="button" className="btn btn-ghost btn-sm" disabled={isSaving}
          onClick={() => { section.followServer(); onGuideChange('skipped') }}>
          {t('home.buddy.skip')}
        </button>
      </div>
    </CollapsibleSection>
  )
}
