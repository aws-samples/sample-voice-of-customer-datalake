/**
 * @fileoverview Where the Agents list leads to the setup guide (7.50.00), for administrators where the engineering
 * agents are on:
 *
 * - **Setup guide**, beside the list's title: the guide at the step it recommends, at any time;
 * - on a first visit, while nothing is set up (no GitHub connection, no engineering automation enabled) and no choice
 *   was made, a card offering **Help me set up** (the guide) or **Skip** (the card goes; the button stays). The choice
 *   is the deployment's (`PUT /agents/engineering/setup` `{intro}`), so another administrator is not asked again.
 *
 * @module pages/Agents/SetupGuide/SetupGuideEntry
 */
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Compass, Loader2 } from 'lucide-react'
import { engineeringConnectionsApi, engineeringConnectionsKeys } from '../../../api/engineeringConnectionsApi'
import { offersIntro } from './setupGuideRules'
import { SETUP_GUIDE_PATH } from './setupGuidePaths'
import { useSaveProgress, useSetupProgress } from './useSetupGuide'
import type { Agent } from '../../../api/agentsApi'
import type { SetupProgress } from '../../../api/engineeringSetupApi'

export function SetupGuideButton() {
  const { t } = useTranslation('agents')
  return (
    <Link className="btn btn-secondary" to={SETUP_GUIDE_PATH}>
      <Compass size={16} aria-hidden="true" /> {t('setupGuide.open')}
    </Link>
  )
}

function IntroCard({ progress }: Readonly<{ progress: SetupProgress }>) {
  const { t } = useTranslation('agents')
  const navigate = useNavigate()
  const save = useSaveProgress()
  const choose = (intro: 'started' | 'skipped') => save.mutate({ revision: progress.revision, intro }, {
    onSuccess: () => { if (intro === 'started') void navigate(SETUP_GUIDE_PATH) },
  })
  return (
    <section className="card p-4 space-y-2 border-accent/30" aria-labelledby="setup-intro-title" data-testid="setup-intro">
      <h2 id="setup-intro-title" className="flex items-center gap-2 text-sm font-semibold text-text-strong">
        <Compass size={16} className="text-accent" aria-hidden="true" /> {t('setupGuide.intro.title')}
      </h2>
      <p className="text-sm text-muted max-w-prose">{t('setupGuide.intro.body')}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary btn-sm" disabled={save.isPending} onClick={() => choose('started')}>
          {save.isPending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
          {t('setupGuide.intro.start')}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={save.isPending} onClick={() => choose('skipped')}>
          {t('setupGuide.intro.skip')}
        </button>
      </div>
      {save.isError && <p role="alert" className="text-[12px] text-danger">{t('setupGuide.saveFailed')}</p>}
    </section>
  )
}

/** The first visit's offer, above the list (nothing once a choice is made or anything is set up, or while reading). */
export function SetupIntro({ agents }: Readonly<{ agents: readonly Agent[] | undefined }>) {
  const progress = useSetupProgress(true)
  const connections = useQuery({ queryKey: engineeringConnectionsKeys.list(), queryFn: engineeringConnectionsApi.list })
  if (agents === undefined || progress.data === undefined || connections.data === undefined) return null
  if (!offersIntro(progress.data, { agents, connections: connections.data.connections })) return null
  return <IntroCard progress={progress.data} />
}
