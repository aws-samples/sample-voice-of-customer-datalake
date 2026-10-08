/**
 * @fileoverview Administration → Integrations: the write-only Figma / GitHub
 * tokens the design system's references are refreshed with
 * (todofeatures §6.1 — secrets are admin configuration, so they moved here
 * from Knowledge → Company → Design system). MCP access is per user and lives
 * in Connect, so this tab only points there.
 *
 * @module pages/Settings/IntegrationsSection
 */
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { KeyRound } from 'lucide-react'
import { designSystemApi, designSystemKey } from '../../api/designSystemApi'
import DesignIntegrations from '../Company/DesignIntegrations'
import { QueryState, SectionHeader } from '../Company/ContextParts'
import IntegrationSetupGuide from './IntegrationSetupGuide'

export default function IntegrationsSection() {
  const { t } = useTranslation('settings')
  // The same entry as Knowledge → Company → Design system: the status is part of that document.
  const query = useQuery({ queryKey: designSystemKey(), queryFn: designSystemApi.get })
  return (
    <div className="card space-y-4">
      <SectionHeader icon={KeyRound} title={t('integrations.title')} description={t('integrations.description')} />
      <QueryState isLoading={query.isLoading} isError={query.isError} onRetry={() => void query.refetch()} />
      {query.data ? <DesignIntegrations status={query.data.integrations} /> : null}
      <IntegrationSetupGuide />
      <p className="text-xs text-muted">
        {t('integrations.mcpHint')} <Link to="/connect" className="link">{t('integrations.mcpLink')}</Link>
      </p>
    </div>
  )
}
