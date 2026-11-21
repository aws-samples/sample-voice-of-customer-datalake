/**
 * @fileoverview "How feedback forms work" (UX §14.2): above the list, a banner each person can dismiss (remembered in
 * this browser for the signed-in user, so it is read once, not 105 px forever); in the empty state the same two lines
 * as part of the start, never dismissed there (a first-time person needs them).
 *
 * @module pages/FeedbackForms/FormsIntro
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { Info } from 'lucide-react'
import DialogClose from '../../components/DialogClose/DialogClose'
import { useAuthStore } from '../../store/authStore'
import { readStoredStrings } from '../../lib/storedStrings'

/** localStorage: the users (Cognito `sub`, else the username) who dismissed the banner in this browser. */
const DISMISSED_KEY = 'voc-feedback-forms-intro-dismissed'

/** (an unreadable record shows the banner again: it is only a UI preference) */
const readDismissed = (): readonly string[] => readStoredStrings(DISMISSED_KEY)

/** Whether the signed-in user dismissed the banner here, and the way to dismiss it. */
function useIntroDismissed(): readonly [boolean, () => void] {
  const user = useAuthStore((state) => state.user?.sub ?? state.user?.username ?? 'anonymous')
  const [dismissed, setDismissed] = useState(() => readDismissed().includes(user))
  const dismiss = () => {
    setDismissed(true)
    try {
      window.localStorage.setItem(DISMISSED_KEY, JSON.stringify([...new Set([...readDismissed(), user])]))
    } catch {
      // (storage full or off: hidden for this visit only)
    }
  }
  return [dismissed, dismiss]
}

function IntroBody({ className }: Readonly<{ className?: string }>) {
  const { t } = useTranslation('feedbackForms')
  return (
    <div className={clsx('min-w-0', className)}>
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold tracking-tight text-info">
        <Info size={16} aria-hidden="true" /> {t('infoBanner.title')}
      </h2>
      <ul className="list-inside list-disc space-y-1 text-sm text-text">
        <li>{t('infoBanner.item1')}</li>
        <li>{t('infoBanner.item2')}</li>
      </ul>
    </div>
  )
}

/** The banner above the forms, until this person dismisses it. */
export function FormsIntroBanner() {
  const { t } = useTranslation('feedbackForms')
  const [dismissed, dismiss] = useIntroDismissed()
  if (dismissed) return null
  return (
    <section aria-label={t('infoBanner.title')} className="flex items-start gap-3 rounded-lg border border-info/30 bg-info-subtle p-4">
      <IntroBody className="flex-1" />
      <DialogClose label={t('infoBanner.dismiss')} onClick={dismiss} />
    </section>
  )
}

/** The same two lines inside the empty state. */
export function FormsIntroNote() {
  return <IntroBody className="rounded-lg border border-info/30 bg-info-subtle p-4" />
}
