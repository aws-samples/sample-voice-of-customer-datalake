/**
 * @fileoverview Account → "Assistant": how the AI assistant behaves for me in
 * this browser. Desktop notifications read and write the SAME persisted store
 * field as the bell in the assistant header (`useNotifySetting`), and "Reset
 * bubble position" clears my stored launcher spot (`voc-assistant-bubble`,
 * keyed by my user), so the launcher returns to its default corner.
 *
 * @module pages/Account/AssistantSection
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, RotateCcw } from 'lucide-react'
import Switch from '../../components/Switch/Switch'
import { useNotifySetting } from '../../assistant/notifications/useNotifySetting'
import { useBubbleStore, useBubbleUserKey } from '../../assistant/bubble/bubbleStore'
import { Section } from './ProfileSections'

function NotificationsSetting() {
  const { t } = useTranslation('common')
  const hintId = useId()
  const { on, unavailable, label, toggle } = useNotifySetting()
  return (
    <div className="space-y-1">
      <Switch label={t('account.assistant.notify')} checked={on} disabled={unavailable} describedBy={hintId}
        onChange={() => { void toggle() }} />
      <p id={hintId} className="text-xs text-muted">
        {t('account.assistant.notifyHint')} {unavailable ? label : null}
      </p>
    </div>
  )
}

function BubblePosition() {
  const { t } = useTranslation('common')
  const user = useBubbleUserKey()
  const moved = useBubbleStore((s) => s.positions[user] !== undefined)
  const resetPosition = useBubbleStore((s) => s.resetPosition)
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
      <div>
        <p className="text-sm text-text">{t('account.assistant.bubble')}</p>
        <p className="text-xs text-muted" aria-live="polite">
          {moved ? t('account.assistant.bubbleMoved') : t('account.assistant.bubbleDefault')}
        </p>
      </div>
      <button type="button" className="btn btn-secondary btn-sm" disabled={!moved} onClick={() => { resetPosition(user) }}>
        <RotateCcw size={14} aria-hidden="true" /> {t('account.assistant.resetBubble')}
      </button>
    </div>
  )
}

export default function AssistantSection() {
  const { t } = useTranslation('common')
  return (
    <Section icon={Bot} title={t('account.nav.assistant')} description={t('account.assistant.hint')}>
      <NotificationsSetting />
      <BubblePosition />
    </Section>
  )
}
