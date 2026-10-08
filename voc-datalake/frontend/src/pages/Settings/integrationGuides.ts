/**
 * @fileoverview Setup-help content for every credential on Administration →
 * Integrations (the Figma and GitHub design-system tokens). Translation keys are
 * held here as data (`*Key: 'settings:…'`, which the i18n gate verifies); the
 * failure messages are the backend's own user-safe reasons, quoted verbatim
 * from `lambda/shared/design_references.py` because the reference row shows
 * them untranslated.
 *
 * Third-party facts were checked against the providers' official docs:
 * - Figma token steps: https://developers.figma.com/docs/rest-api/personal-access-tokens/
 * - Figma scopes (file_content:read): https://developers.figma.com/docs/rest-api/scopes/
 * - GET /v1/files/:key needs file_content:read: https://developers.figma.com/docs/rest-api/file-endpoints/
 * - GitHub fine-grained token steps, org approval, pre-filled URL parameters:
 *   https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
 * - GitHub "Get repository content" needs Contents (read), works unauthenticated
 *   for public repositories: https://docs.github.com/en/rest/repos/contents?apiVersion=2022-11-28
 *
 * @module pages/Settings/integrationGuides
 */
import type { IntegrationsStatus } from '../../api/designSystemApi'

type IntegrationProvider = keyof IntegrationsStatus

interface GuideLink {
  readonly href: string
  readonly labelKey: string
}

interface GuideFailure {
  /** The backend's reason, shown verbatim on the failed reference. */
  readonly message: string
  readonly meaningKey: string
}

export interface IntegrationGuide {
  readonly provider: IntegrationProvider
  readonly titleKey: string
  readonly summaryKey: string
  readonly purposeKey: string
  readonly stepKeys: readonly { readonly textKey: string }[]
  readonly links: readonly GuideLink[]
  readonly permissionsKey: string
  readonly linkFormatKey: string
  readonly failures: readonly GuideFailure[]
  readonly securityKey: string
}

/** Shared by both providers: the reason text is identical apart from the provider name. */
const rateLimited = (what: string): GuideFailure => ({
  message: `${what} rate-limited the request; try again later`,
  meaningKey: 'settings:integrationGuide.failRateLimited',
})

const FIGMA_GUIDE: IntegrationGuide = {
  provider: 'figma',
  titleKey: 'settings:integrationGuide.figma.title',
  summaryKey: 'settings:integrationGuide.figma.summary',
  purposeKey: 'settings:integrationGuide.figma.purpose',
  stepKeys: [
    { textKey: 'settings:integrationGuide.figma.step1' },
    { textKey: 'settings:integrationGuide.figma.step2' },
    { textKey: 'settings:integrationGuide.figma.step3' },
    { textKey: 'settings:integrationGuide.figma.step4' },
    { textKey: 'settings:integrationGuide.figma.step5' },
  ],
  links: [
    { href: 'https://developers.figma.com/docs/rest-api/personal-access-tokens/', labelKey: 'settings:integrationGuide.figma.docsTokens' },
    { href: 'https://developers.figma.com/docs/rest-api/scopes/', labelKey: 'settings:integrationGuide.figma.docsScopes' },
  ],
  permissionsKey: 'settings:integrationGuide.figma.permissions',
  linkFormatKey: 'settings:integrationGuide.figma.linkFormat',
  failures: [
    { message: 'No Figma token configured (Settings → Design system → Integrations)', meaningKey: 'settings:integrationGuide.failMissing' },
    { message: 'Figma refused access — check the token in Settings → Design system', meaningKey: 'settings:integrationGuide.figma.failRefused' },
    { message: 'Figma could not find it (or the token cannot see it)', meaningKey: 'settings:integrationGuide.figma.failNotFound' },
    { message: 'Not a Figma file link (expected https://www.figma.com/file/<key>/… or /design/<key>/…)', meaningKey: 'settings:integrationGuide.failBadLink' },
    rateLimited('Figma'),
  ],
  securityKey: 'settings:integrationGuide.figma.security',
}

/**
 * The pre-filled "new fine-grained token" form: name, description and
 * Contents read (Metadata read is added by GitHub) — documented URL parameters.
 */
const GITHUB_NEW_TOKEN_URL =
  'https://github.com/settings/personal-access-tokens/new?name=VoC+design+system&description=Read-only+design+references+for+VoC&contents=read'

const GITHUB_GUIDE: IntegrationGuide = {
  provider: 'github',
  titleKey: 'settings:integrationGuide.github.title',
  summaryKey: 'settings:integrationGuide.github.summary',
  purposeKey: 'settings:integrationGuide.github.purpose',
  stepKeys: [
    { textKey: 'settings:integrationGuide.github.step1' },
    { textKey: 'settings:integrationGuide.github.step2' },
    { textKey: 'settings:integrationGuide.github.step3' },
    { textKey: 'settings:integrationGuide.github.step4' },
    { textKey: 'settings:integrationGuide.github.step5' },
  ],
  links: [
    { href: GITHUB_NEW_TOKEN_URL, labelKey: 'settings:integrationGuide.github.newToken' },
    {
      href: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
      labelKey: 'settings:integrationGuide.github.docsTokens',
    },
  ],
  permissionsKey: 'settings:integrationGuide.github.permissions',
  linkFormatKey: 'settings:integrationGuide.github.linkFormat',
  failures: [
    { message: 'GitHub refused access — check the token in Settings → Design system', meaningKey: 'settings:integrationGuide.github.failRefused' },
    { message: 'GitHub could not find it (or the token cannot see it)', meaningKey: 'settings:integrationGuide.github.failNotFound' },
    { message: 'No design tokens, CSS, Tailwind config or README found at that location', meaningKey: 'settings:integrationGuide.github.failNoFiles' },
    { message: 'Not a GitHub repository link (expected https://github.com/<owner>/<repo>)', meaningKey: 'settings:integrationGuide.failBadLink' },
    rateLimited('GitHub'),
  ],
  securityKey: 'settings:integrationGuide.github.security',
}

export const INTEGRATION_GUIDES: readonly IntegrationGuide[] = [FIGMA_GUIDE, GITHUB_GUIDE]
