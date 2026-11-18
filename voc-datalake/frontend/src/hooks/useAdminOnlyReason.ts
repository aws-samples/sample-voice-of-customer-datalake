/**
 * @fileoverview Why a control is off for a non-admin ("Admin access required"), translated
 * (`common:adminOnly`): the Tooltip, and the description, of a control that stays focusable with
 * `aria-disabled` because the route behind it is admin-gated server-side.
 *
 * The one wording for every such control, so one surface never says something different from another
 * about the same 403: `pages/Scrapers` (7.51.01: `AppConfigComponents`' Run and Delete,
 * `PluginConfigModal`'s Add/Save/Delete/Run and schedule toggle, `GeneratorConfigModal`'s Generate,
 * `TemplateSelector`'s scraper and import tiles, `LearnedMethodLine`) and, since the 7.54.00 settings
 * redesign, `pages/Settings` (`SourceCard`'s Enabled switch, `SourceCardSections`' Save to Secrets
 * Manager, `SourceCircuitNotice`'s Reset, `LogsSection`'s Clear), which used an English literal
 * (ADMIN_ONLY_TITLE, removed in 7.54.00) as a native `title` until then.
 *
 * The routes: `POST`/`DELETE /integrations/{source}/apps`, `PUT /integrations/{source}/credentials`,
 * `POST /sources/{source}/run`, `PUT /sources/{source}/enable|disable`, `POST /sources/{source}/reset`,
 * `POST /scrapers` (save), `POST /scrapers/analyze-url`, `DELETE /scrapers/{id}` plus
 * `POST /scrapers/{id}/run`, `DELETE /logs/validation/{source}`, and every `/scrapers/manual/*` and
 * `/s3-import/*` route (#242: importing writes customer data). The gate is the SERVER's and this string
 * is only the explanation: disabling a control is never the boundary. On `pages/Settings` the
 * non-admin state is defence in depth (`/admin` renders behind `AdminRoute`), kept so a card is safe to
 * reuse outside that route.
 *
 * Specs whose subject is the gate read the English catalogue's text (`@test/adminOnly`) rather than
 * restating it.
 *
 * @module hooks/useAdminOnlyReason
 */
import { useTranslation } from 'react-i18next'

/** The reason, or undefined for an admin (nothing to explain). */
export function useAdminOnlyReason(isAdmin: boolean): string | undefined {
  const { t } = useTranslation('common')
  return isAdmin ? undefined : t('adminOnly')
}
