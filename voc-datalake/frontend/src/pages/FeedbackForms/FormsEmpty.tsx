/**
 * @fileoverview The forms list with no form of the person's own (UX §14.2): the start itself instead of a second New
 * form button. "Describe your form" (the picker, which opens on it) and three templates, each a tile that opens the
 * picker with that template's preview (`/feedback-forms/new?template=…`), then how feedback forms work.
 *
 * @module pages/FeedbackForms/FormsEmpty
 */
import { createElement } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Sparkles } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { templateById } from './formTemplates'
import { pickerPath } from './builder/builderPaths'
import { FormsIntroNote } from './FormsIntro'

/** The three starts the empty state offers besides Describe: loyalty, a cancellation, a redesign's switch back. */
const STARTER_TEMPLATES = ['nps', 'churn', 'old_ui'] as const

function StartTile({ to, icon, title, text, aim }: Readonly<{ to: string; icon: LucideIcon; title: string; text: string; aim?: boolean }>) {
  return (
    <li className="min-w-0">
      <Link to={to} className="card flex h-full items-start gap-3 p-4 hover:bg-bg-hover focus-ring">
        <span aria-hidden="true"
          className={aim === true ? 'flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-aim-subtle text-aim' : 'flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-bg-hover text-muted'}>
          {createElement(icon, { size: 18 })}
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-text-strong">{title}</span>
          <span className="line-clamp-2 text-[13px] text-muted">{text}</span>
        </span>
      </Link>
    </li>
  )
}

export default function FormsEmpty() {
  const { t } = useTranslation('feedbackForms')
  const starters = STARTER_TEMPLATES.flatMap((id) => {
    const flow = templateById(id)
    return flow === undefined ? [] : [flow]
  })
  return (
    <section aria-labelledby="forms-empty-title" className="card space-y-4">
      <div>
        <h2 id="forms-empty-title" className="text-base font-semibold tracking-tight text-text-strong">{t('empty.title')}</h2>
        <p className="text-sm text-muted">{t('empty.description')}</p>
      </div>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label={t('empty.startsLabel')}>
        <StartTile to={pickerPath()} icon={Sparkles} title={t('describe.title')} text={t('empty.describeHint')} aim />
        {starters.map((flow) => (
          <StartTile key={flow.id} to={pickerPath(flow.id)} icon={flow.icon}
            title={t(`templates.${flow.id}.name`)} text={t(`templates.${flow.id}.purpose`)} />
        ))}
      </ul>
      <FormsIntroNote />
    </section>
  )
}
