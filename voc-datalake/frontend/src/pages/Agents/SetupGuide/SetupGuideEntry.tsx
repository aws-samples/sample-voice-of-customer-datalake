/**
 * @fileoverview Where Agent orchestration leads to the setup guide (7.50.00; 7.52.00 C1, ux-agents-redesign part 1
 * §2.2-2.3), for administrators where the engineering agents are on:
 *
 * - **Setup guide · 2 of 4 done**, in the header (`btn-secondary`, Compass): the guide at the step it recommends, at
 *   any time, with its progress (setupGuideRules.ts `progressCount`); once the guide is finished, a quiet
 *   `btn-ghost` "Setup guide" with a check;
 * - **the first-run prompt**, inside the Engineering group's card above its rows: on a first visit, while nothing is
 *   set up (no GitHub connection, no engineering automation enabled) and no choice was made, "Set up the bug loop"
 *   with **Start the setup guide** (the page's one primary then) or **Not now** (the prompt goes; the button stays).
 *   The choice is the deployment's (`PUT /agents/engineering/setup` `{intro}`), so another administrator is not
 *   asked again.
 *
 * @module pages/Agents/SetupGuide/SetupGuideEntry
 */
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { CircleCheck, Compass, Loader2 } from 'lucide-react'
import { progressCount } from './setupGuideRules'
import { SETUP_GUIDE_PATH } from './setupGuidePaths'
import { useSaveProgress, useSetupGuide } from './useSetupGuide'
import type { SetupProgress } from '../../../api/engineeringSetupApi'

export function SetupGuideButton() {
  const { t } = useTranslation('agents')
  const guide = useSetupGuide(true)
  const { statuses } = guide
  if (statuses?.ready === 'done') {
    return (
      <Link className="btn btn-ghost" to={SETUP_GUIDE_PATH}>
        <CircleCheck size={16} className="text-ok" aria-hidden="true" /> {t('setupGuide.open')}
      </Link>
    )
  }
  const progress = statuses === undefined ? null : progressCount(statuses)
  return (
    <Link className="btn btn-secondary" to={SETUP_GUIDE_PATH}>
      <Compass size={16} aria-hidden="true" />
      {progress === null ? t('setupGuide.open') : t('shell.setupGuideProgress', { done: progress.done, total: progress.total })}
    </Link>
  )
}

function Prompt({ progress }: Readonly<{ progress: SetupProgress }>) {
  const { t } = useTranslation('agents')
  const navigate = useNavigate()
  const save = useSaveProgress()
  const choose = (intro: 'started' | 'skipped') => save.mutate({ revision: progress.revision, intro }, {
    onSuccess: () => { if (intro === 'started') void navigate(SETUP_GUIDE_PATH) },
  })
  return (
    <section className="flex items-start gap-3 border-b border-border px-4 py-4" aria-labelledby="setup-prompt-title" data-testid="setup-prompt">
      <Compass size={20} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
      <div className="min-w-0 space-y-2">
        <h3 id="setup-prompt-title" className="text-sm font-semibold text-text-strong">{t('automations.firstRun.title')}</h3>
        <p className="text-sm text-muted max-w-prose">{t('automations.firstRun.body')}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary btn-sm" aria-disabled={save.isPending || undefined}
            onClick={() => { if (!save.isPending) choose('started') }}>
            {save.isPending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            {t('automations.firstRun.start')}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={save.isPending} onClick={() => choose('skipped')}>
            {t('automations.firstRun.skip')}
          </button>
        </div>
        {save.isError && <p role="alert" className="text-[12px] text-danger">{t('setupGuide.saveFailed')}</p>}
      </div>
    </section>
  )
}

/** The first visit's prompt, inside the Engineering group's card (nothing once a choice is made, or while reading). */
export function SetupPrompt({ progress }: Readonly<{ progress: SetupProgress | null }>) {
  return progress === null ? null : <Prompt progress={progress} />
}
