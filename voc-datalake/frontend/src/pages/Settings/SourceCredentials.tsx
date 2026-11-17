/**
 * @fileoverview A source card's credentials (SourceCardSections.tsx `CredentialsSection`) with the fields its plugin
 * shows: the manifest's own, except on the deployment's GitHub Issues card (7.45.00; githubSignIn.ts), which signs in
 * with one of the deployment's GitHub Apps or a token (App-first since 7.50.02). While the deployment's connections
 * manage that source (7.50.02: Agents → Connections configures it), the card says so and keeps its fields behind
 * "Configure manually (advanced)".
 *
 * @module pages/Settings/SourceCredentials
 */
import type { ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'
import { CredentialsSection } from './SourceCardSections'
import { GitHubSignInChoice, ManagedByConnection } from './GitHubSignInChoice'
import { useGitHubSignIn } from './githubSignIn'
import type { PluginManifest } from '../../plugins/types'

type SectionProps = Omit<ComponentProps<typeof CredentialsSection>, 'fields' | 'lead'>

export default function SourceCredentials({ manifest, apiEndpoint, ...section }: Readonly<SectionProps & {
  manifest: PluginManifest
  apiEndpoint: string
}>) {
  const { t } = useTranslation('settings')
  // (the section is mounted only while the card is open: its reads are an administrator's, once configured)
  const signIn = useGitHubSignIn(manifest, {
    enabled: section.isAdmin && apiEndpoint !== '', credentials: section.credentials, onCredentialsChange: section.onCredentialsChange,
  })
  if (signIn === null) return <CredentialsSection {...section} fields={manifest.config} />
  const fields = (
    <CredentialsSection {...section} credentials={signIn.credentials} fields={signIn.fields}
      lead={<GitHubSignInChoice signIn={signIn} />} />
  )
  if (signIn.managed.length === 0) return fields
  return (
    <div className="space-y-3">
      <ManagedByConnection count={signIn.managed.length} />
      <details className="rounded-lg border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium text-text-strong focus-ring rounded-sm">
          {t('sourceCard.githubSignIn.manual')}
        </summary>
        <div className="mt-3">{fields}</div>
      </details>
    </div>
  )
}
