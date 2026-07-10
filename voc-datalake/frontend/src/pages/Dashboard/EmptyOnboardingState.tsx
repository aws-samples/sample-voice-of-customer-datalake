/**
 * @fileoverview Empty-state onboarding shown on the Dashboard when the workspace
 * has zero feedback. Without this, a new user lands on an empty dashboard with
 * no clue that ingesting data is the required first step. Walks them through
 * collect → share → analyze with direct links.
 *
 * Lives in its own file (with `useTranslation('dashboard')`) so the `dashboard`
 * i18n namespace is isolated to this file — Dashboard.tsx stays on `common`.
 *
 * @module pages/Dashboard/EmptyOnboardingState
 */

import { Globe, FileText, Bot, ArrowRight } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

interface OnboardingStep {
  to: string
  icon: LucideIcon
  titleKey: string
  descKey: string
  primary: boolean
}

const STEPS: OnboardingStep[] = [
  { to: '/scrapers', icon: Globe, titleKey: 'onboarding.step1Title', descKey: 'onboarding.step1Desc', primary: true },
  { to: '/feedback-forms', icon: FileText, titleKey: 'onboarding.step2Title', descKey: 'onboarding.step2Desc', primary: false },
  { to: '/chat', icon: Bot, titleKey: 'onboarding.step3Title', descKey: 'onboarding.step3Desc', primary: false },
]

export default function EmptyOnboardingState() {
  const { t } = useTranslation('dashboard')

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-4">
      <div className="text-center max-w-2xl mb-8">
        <h2 className="text-2xl font-bold mb-2">{t('onboarding.heading')}</h2>
        <p className="text-gray-500">{t('onboarding.subheading')}</p>
      </div>
      <div className="grid gap-4 w-full max-w-2xl sm:grid-cols-3">
        {STEPS.map((s, i) => {
          const Icon = s.icon
          return (
            <Link
              key={s.to}
              to={s.to}
              className={`flex flex-col gap-2 rounded-xl border p-5 transition-colors ${
                s.primary
                  ? 'border-blue-500 bg-blue-50 hover:bg-blue-100'
                  : 'border-gray-200 bg-white hover:bg-gray-50'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${
                  s.primary ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600'
                }`}>{i + 1}</span>
                <Icon size={18} className={s.primary ? 'text-blue-600' : 'text-gray-500'} />
              </div>
              <div className="font-semibold text-sm">{t(s.titleKey)}</div>
              <div className="text-xs text-gray-500 flex-1">{t(s.descKey)}</div>
              {s.primary ? (
                <span className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-blue-600">
                  {t('onboarding.cta')} <ArrowRight size={12} />
                </span>
              ) : null}
            </Link>
          )
        })}
      </div>
    </div>
  )
}
