/**
 * @fileoverview The Connect page's "Sign in with your account" card (MCP OAuth, docs/mcp.md): per
 * client, the snippet that connects it with no token at all. Kiro, Claude Code and Cursor are the
 * verified clients; web assistants (the `web` client, only when the deployment configured their
 * callbacks) are marked untested until someone signs in with them live.
 *
 * @module pages/Connect/OAuthSignInCard
 */
import { useTranslation } from 'react-i18next'
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard'
import type { OAuthSummary } from '../../api/oauthSummarySchema'
import { CopyButton } from './CopyButton'
import { claudeCodeCommand, oauthMcpJson } from './oauthSnippets'

interface Snippet {
  kind: 'kiro' | 'claude-code' | 'cursor'
  labelKey: string
  build: (endpointUrl: string) => string
}

/** The verified desktop clients, in the order the card lists them. */
const SNIPPETS: readonly Snippet[] = [
  { kind: 'kiro', labelKey: 'connect.oauth.kiro', build: oauthMcpJson },
  { kind: 'claude-code', labelKey: 'connect.oauth.claudeCode', build: claudeCodeCommand },
  { kind: 'cursor', labelKey: 'connect.oauth.cursor', build: oauthMcpJson },
]

export function OAuthSignInCard({ endpointUrl, oauth }: Readonly<{ endpointUrl: string; oauth: OAuthSummary }>) {
  const { t } = useTranslation('common')
  const { copy, copiedKey } = useCopyToClipboard()
  const kinds = new Set(oauth.clients.map((client) => client.kind))
  return (
    <section className="card space-y-4" aria-labelledby="connect-oauth-title">
      <div className="space-y-1">
        <h2 id="connect-oauth-title" className="text-base font-semibold text-text-strong">{t('connect.oauth.title')}</h2>
        <p className="text-sm text-text">{t('connect.oauth.body')}</p>
      </div>
      {SNIPPETS.filter((snippet) => kinds.has(snippet.kind)).map((snippet) => {
        const text = snippet.build(endpointUrl)
        return (
          <div key={snippet.kind} className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[12px] font-medium text-muted">{t(snippet.labelKey)}</p>
              <CopyButton text={text} copyKey={`oauth-${snippet.kind}`} copiedKey={copiedKey} onCopy={copy} />
            </div>
            <pre tabIndex={0} role="region" aria-label={t(snippet.labelKey)}
              className="overflow-x-auto rounded-md bg-bg-hover p-3 text-[12px] focus-ring" data-testid={`connect-oauth-${snippet.kind}`}>
              {text}
            </pre>
          </div>
        )
      })}
      <p className="text-[12px] text-muted">{t('connect.oauth.consentHint')}</p>
      <p className="text-[12px] text-muted" data-testid="connect-oauth-web">
        {kinds.has('web') ? t('connect.oauth.webUntested') : t('connect.oauth.webNotConfigured')}
      </p>
    </section>
  )
}
