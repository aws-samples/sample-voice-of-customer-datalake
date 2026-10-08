/**
 * @fileoverview The admin-only Dimensions and Sources tabs of Administration.
 * @module pages/Settings/DataGovernanceSections
 */
import { useTranslation } from 'react-i18next'
import { Layers, ShieldCheck } from 'lucide-react'
import DimensionsManager from '../../components/DimensionsManager/DimensionsManager'
import SourcesManager from '../../components/SourcesManager/SourcesManager'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

function Section({ icon: Icon, title, description, children }: Readonly<{
  icon: LucideIcon; title: string; description: string; children: ReactNode
}>) {
  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-1">
        <Icon className="text-accent" size={16} />
        <h2 className="text-lg font-semibold tracking-tight text-text-strong">{title}</h2>
      </div>
      <p className="text-sm text-muted mb-4">{description}</p>
      {children}
    </div>
  )
}

export function DimensionsSection() {
  const { t } = useTranslation('settings')
  return (
    <Section icon={Layers} title={t('dimensions.title')} description={t('dimensions.description')}>
      <DimensionsManager />
    </Section>
  )
}

export function SourcesSection() {
  const { t } = useTranslation('settings')
  return (
    <Section icon={ShieldCheck} title={t('sources.title')} description={t('sources.description')}>
      <SourcesManager />
    </Section>
  )
}
