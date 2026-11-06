/**
 * @fileoverview Triggers tab — what wakes the agent: new reviews in scope
 * (with a cooldown), a schedule (12 h / 24 h / cron in a time zone) or a
 * threshold of reviews per category / subcategory over a window. The
 * heartbeat checks them every 15 minutes; "Run now" is separate and unlimited.
 *
 * @module pages/Agents/AgentTriggers
 */
import { Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { AGENT_SCHEDULE_EVERY, AGENT_THRESHOLD_PER, API_AGENT_LIMITS, TRIGGER_KINDS } from '../../api/agentsApi'
import { LabeledField } from '../../components/LabeledField/LabeledField'
import { EnumSelectField } from '../../components/LabeledField/EnumSelectField'
import { ClampedNumberField } from './ClampedNumberField'
import type { AgentTrigger } from '../../api/agentsApi'
import type { SectionProps } from './AgentSections'

const L = API_AGENT_LIMITS
/** Weekdays at 09:00 — a sensible first cron for a PM's working week. */
const DEFAULT_CRON = '0 9 * * 1-5'

function defaultTrigger(kind: AgentTrigger['kind']): AgentTrigger {
  if (kind === 'new_reviews') return { kind, min_new: 5, cooldown_hours: 12 }
  if (kind === 'schedule') return { kind, every: '24h', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }
  return { kind, count: 10, per: 'category', window_days: 7 }
}

function TriggerFields({ trigger, readOnly, onChange }: Readonly<{
  trigger: AgentTrigger; readOnly: boolean; onChange: (trigger: AgentTrigger) => void
}>) {
  const { t } = useTranslation('agents')
  if (trigger.kind === 'new_reviews') {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <ClampedNumberField label={t('triggers.minNew')} readOnly={readOnly} min={1} max={L.maxMinNew} value={trigger.min_new}
          onChange={(n) => onChange({ ...trigger, min_new: n })} />
        <ClampedNumberField label={t('triggers.cooldown')} readOnly={readOnly} min={0} max={L.maxCooldownHours} value={trigger.cooldown_hours}
          onChange={(n) => onChange({ ...trigger, cooldown_hours: n })} />
      </div>
    )
  }
  if (trigger.kind === 'schedule') {
    return (
      <div className="grid gap-3 sm:grid-cols-3">
        <LabeledField label={t('triggers.every')}>
          {(id) => (
            <select id={id} className="select w-full" disabled={readOnly} value={trigger.every}
              onChange={(e) => {
                const every = AGENT_SCHEDULE_EVERY.find((v) => v === e.target.value)
                if (every === undefined) return
                const base = { kind: trigger.kind, timezone: trigger.timezone }
                onChange(every === 'cron' ? { ...base, every, cron: trigger.cron ?? DEFAULT_CRON } : { ...base, every })
              }}>
              {AGENT_SCHEDULE_EVERY.map((v) => <option key={v} value={v}>{t(`triggers.everyOptions.${v}`)}</option>)}
            </select>
          )}
        </LabeledField>
        {trigger.every === 'cron' && (
          <LabeledField label={t('triggers.cron')} hint={t('triggers.cronHint')}>
            {(id) => <input id={id} className="input w-full font-mono" disabled={readOnly} maxLength={L.maxCronChars} value={trigger.cron ?? ''}
              onChange={(e) => onChange({ ...trigger, cron: e.target.value })} />}
          </LabeledField>
        )}
        <LabeledField label={t('triggers.timezone')}>
          {(id) => <input id={id} className="input w-full" disabled={readOnly} maxLength={L.maxTimezoneChars} value={trigger.timezone}
            onChange={(e) => onChange({ ...trigger, timezone: e.target.value })} />}
        </LabeledField>
      </div>
    )
  }
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <ClampedNumberField label={t('triggers.count')} readOnly={readOnly} min={1} max={L.maxThresholdCount} value={trigger.count}
        onChange={(n) => onChange({ ...trigger, count: n })} />
      <EnumSelectField label={t('triggers.per')} choices={AGENT_THRESHOLD_PER} value={trigger.per}
        display={(v) => t(`triggers.perOptions.${v}`)} disabled={readOnly} onChange={(per) => onChange({ ...trigger, per })} />
      <ClampedNumberField label={t('triggers.windowDays')} readOnly={readOnly} min={1} max={L.maxWindowDays} value={trigger.window_days}
        onChange={(n) => onChange({ ...trigger, window_days: n })} />
    </div>
  )
}

export function TriggersSection({ draft, readOnly, onChange }: Readonly<SectionProps>) {
  const { t } = useTranslation('agents')
  const set = (triggers: AgentTrigger[]) => onChange({ ...draft, triggers })
  return (
    <div className="space-y-3">
      <p className="text-[12px] text-muted">{t('triggers.hint')}</p>
      {draft.triggers.length === 0 && <p className="text-sm text-muted italic">{t('triggers.none')}</p>}
      <ul className="space-y-3">
        {draft.triggers.map((trigger, index) => (
          <li key={`${trigger.kind}-${index}`} className="rounded-lg border border-border p-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="badge badge-accent">{t(`triggers.kinds.${trigger.kind}`)}</span>
              <span className="text-[12px] text-muted mr-auto">{t(`triggers.kindHints.${trigger.kind}`)}</span>
              {!readOnly && (
                <button type="button" className="icon-btn" aria-label={t('triggers.remove')} title={t('triggers.remove')}
                  onClick={() => set(draft.triggers.filter((_x, i) => i !== index))}>
                  <Trash2 size={16} />
                </button>
              )}
            </div>
            <TriggerFields trigger={trigger} readOnly={readOnly}
              onChange={(next) => set(draft.triggers.map((x, i) => (i === index ? next : x)))} />
          </li>
        ))}
      </ul>
      {!readOnly && draft.triggers.length < L.maxTriggers && (
        <div className="flex flex-wrap gap-2">
          {TRIGGER_KINDS.map((kind) => (
            <button key={kind} type="button" className="btn btn-secondary btn-sm" onClick={() => set([...draft.triggers, defaultTrigger(kind)])}>
              <Plus size={14} aria-hidden="true" /> {t(`triggers.kinds.${kind}`)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
