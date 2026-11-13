/**
 * @fileoverview The admin-only Dimensions and Source policies sections of Administration.
 * @module pages/Settings/DataGovernanceSections
 */
import { useTranslation } from 'react-i18next'
import { Layers, ShieldCheck } from 'lucide-react'
import DimensionsManager from '../../components/DimensionsManager/DimensionsManager'
import SourcesManager from '../../components/SourcesManager/SourcesManager'
import { SectionHeader } from '../Company/ContextParts'
import WorkspaceConfigNotice from '../../workspace/WorkspaceConfigNotice'
import { ConfigScopeContext } from '../../workspace/configScope'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

function Section({ icon, title, description, children }: Readonly<{
  icon: LucideIcon; title: string; description: string; children: ReactNode
}>) {
  return (
    <div className="card">
      <SectionHeader icon={icon} title={title} description={description} />
      {children}
    </div>
  )
}

export function DimensionsSection() {
  const { t } = useTranslation('settings')
  return (
    <Section icon={Layers} title={t('dimensions.title')} description={t('dimensions.description')}>
      {/* The deployment's dimensions from any address (inside a workspace the notice says so). */}
      <WorkspaceConfigNotice />
      <ConfigScopeContext.Provider value="deployment"><DimensionsManager /></ConfigScopeContext.Provider>
    </Section>
  )
}

/** Privacy & access → Source policies: source profiles and erasure (the Email inbox moved to Sources). */
export function SourcePoliciesSection() {
  const { t } = useTranslation('settings')
  return (
    <Section icon={ShieldCheck} title={t('sources.title')} description={t('sources.description')}>
      {/* The deployment's profiles, beside the deployment's erasure panels, from any address. */}
      <WorkspaceConfigNotice />
      <ConfigScopeContext.Provider value="deployment"><SourcesManager /></ConfigScopeContext.Provider>
    </Section>
  )
}
