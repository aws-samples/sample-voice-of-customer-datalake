/**
 * @fileoverview Connect (todofeatures §6.1 / §6.3) — give external assistants
 * (Kiro, Copilot, Cowork, Amazon Quick, …) access to VoC over ONE global MCP
 * endpoint, with a personal token and a downloadable skill.
 *
 * Not admin-gated: a token acts as the user who mints it (their project and
 * category access, never admin, at most editor on a project). `?project=<id>`
 * pre-selects a project pin — the project MCP tab links here that way.
 *
 * @module pages/Connect
 */
import { useQuery } from '@tanstack/react-query'
import { Plug } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { connectApi, CONNECT_TOKENS_KEY } from '../../api/connectApi'
import { projectsApi } from '../../api/projectsApi'
import { projectsKey } from '../../api/projectQueryKeys'
import { useConfigStore } from '../../store/configStore'
import { globalEndpointUrl } from './connectSnippets'
import { EndpointCard } from './EndpointCard'
import { MintTokenForm } from './MintTokenForm'
import { TokenList } from './TokenList'
import type { ProjectChoice } from './MintTokenForm'

function useProjectChoices(): readonly ProjectChoice[] {
  // The shared projects list entry (Projects page, pickers, breadcrumbs).
  const { data } = useQuery({ queryKey: projectsKey(), queryFn: () => projectsApi.getProjects() })
  return useMemo(() => (data?.projects ?? []).map((p) => ({ project_id: p.project_id, name: p.name })), [data])
}

function ConnectBody({ apiEndpoint }: Readonly<{ apiEndpoint: string }>) {
  const { t } = useTranslation('common')
  const [searchParams] = useSearchParams()
  const projects = useProjectChoices()
  const tokens = useQuery({ queryKey: CONNECT_TOKENS_KEY, queryFn: () => connectApi.listTokens() })
  const projectNames = useMemo(() => new Map(projects.map((p) => [p.project_id, p.name])), [projects])

  if (tokens.isLoading) return <p className="text-sm text-muted">{t('connect.loading')}</p>
  if (tokens.isError || !tokens.data) {
    return <p role="alert" className="card text-sm text-danger">{t('connect.loadFailed')}</p>
  }
  return (
    <>
      <EndpointCard endpointUrl={globalEndpointUrl(apiEndpoint, tokens.data.endpoint_path)} />
      <MintTokenForm projects={projects} initialProjectId={searchParams.get('project') ?? ''}
        canMintAgentRunner={tokens.data.can_mint_agent_runner} />
      <TokenList tokens={tokens.data.tokens} projectNames={projectNames} />
    </>
  )
}

export default function Connect() {
  const { t } = useTranslation('common')
  const { config } = useConfigStore()
  return (
    <div className="max-w-3xl mx-auto min-w-0 w-full space-y-4 sm:space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-text-strong flex items-center gap-2">
          <Plug size={22} className="text-accent-text" aria-hidden="true" /> {t('connect.title')}
        </h1>
        <p className="text-sm text-muted mt-1">{t('connect.subtitle')}</p>
      </div>
      <div className="card text-sm text-text space-y-1">
        <p className="font-medium text-text-strong">{t('connect.actsAsTitle')}</p>
        <p>{t('connect.actsAsBody')}</p>
      </div>
      {config.apiEndpoint
        ? <ConnectBody apiEndpoint={config.apiEndpoint} />
        : <p className="card text-sm text-muted">{t('connect.notConfigured')}</p>}
    </div>
  )
}
