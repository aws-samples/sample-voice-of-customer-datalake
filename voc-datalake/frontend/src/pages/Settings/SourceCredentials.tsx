/**
 * @fileoverview A source card's credentials (SourceCardSections.tsx `CredentialsSection`) with the fields its plugin
 * shows: the manifest's own, except on the deployment's GitHub Issues card (7.45.00), where "Sign in with" a token or
 * one of the deployment's GitHub Apps decides them (githubSignIn.ts).
 *
 * @module pages/Settings/SourceCredentials
 */
import type { ComponentProps } from 'react'
import { CredentialsSection } from './SourceCardSections'
import { GitHubSignInChoice } from './GitHubSignInChoice'
import { useGitHubSignIn } from './githubSignIn'
import type { PluginManifest } from '../../plugins/types'

type SectionProps = Omit<ComponentProps<typeof CredentialsSection>, 'fields' | 'lead'>

export default function SourceCredentials({ manifest, apiEndpoint, ...section }: Readonly<SectionProps & {
  manifest: PluginManifest
  apiEndpoint: string
}>) {
  // (the section is mounted only while the card is open: its reads are an administrator's, once configured)
  const signIn = useGitHubSignIn(manifest, {
    enabled: section.isAdmin && apiEndpoint !== '', credentials: section.credentials, onCredentialsChange: section.onCredentialsChange,
  })
  return (
    <CredentialsSection {...section} fields={signIn?.fields ?? manifest.config}
      lead={signIn === null ? null : <GitHubSignInChoice method={signIn.method} onChoose={signIn.choose} />} />
  )
}
