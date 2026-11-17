/**
 * Why a control is off for a non-admin, because the route behind it is admin-gated
 * server-side. Since 7.51.01 `pages/Scrapers` says it in a Tooltip, translated
 * (`common:adminOnly`, `hooks/useAdminOnlyReason`), on a control that stays focusable
 * (`aria-disabled`); this English literal is the `title` that `pages/Settings` keeps
 * until the 7.54 settings redesign (native_title.json), and what the specs assert
 * (the English catalogue says the same).
 *
 * Declared once, and HERE rather than under one page, because two pages now render
 * such a control: `pages/Scrapers` (`AppConfigComponents`' Run and Delete,
 * `PluginConfigModal`'s Add/Save/Delete/Run and schedule toggle,
 * `GeneratorConfigModal`'s Generate — where this wording came from — and
 * `ScraperEditor`'s Save and Auto-detect, `TemplateSelector`'s scraper
 * templates) and `pages/Settings` (`SourceCard`'s Enabled toggle,
 * `LogsSection`'s Clear). It began in
 * `pages/Scrapers/constants.ts`, which was right while Scrapers was the only page
 * with a gated control; the Settings toggle calls the same
 * `PUT /sources/{source}/enable|disable` pair, so a page-local home would have
 * meant either a cross-page import or a second literal — and a per-file literal is
 * how one surface ends up saying something different from another about the same
 * 403.
 *
 * The routes: `POST`/`DELETE /integrations/{source}/apps`,
 * `POST /sources/{source}/run`, `PUT /sources/{source}/enable|disable`,
 * `POST /scrapers` (save), `POST /scrapers/analyze-url`, `DELETE /scrapers/{id}`
 * plus `POST /scrapers/{id}/run` (all admin-only: they write the shared scraper
 * credentials secret, drive scheduled scraping and spend Bedrock; so
 * `ScraperEditor` opens read-only and `TemplateSelector` disables the scraper
 * templates for a non-admin), `DELETE /logs/validation/{source}`, and
 * `PUT /settings/brand` (the Settings header Save; #242: shared deployment config), and every
 * `/scrapers/manual/*` and `/s3-import/*` route (#242: importing writes customer data;
 * `TemplateSelector`'s paste / JSON / CSV / S3 import tiles, `SourceCard`'s S3 file explorer). None of
 * them were once gated — a `users`-group caller could write the shared API-credentials secret and
 * invoke an ingestor — so the gate is the SERVER's and this string is only the
 * explanation. Disabling a control is never the boundary.
 *
 * On `pages/Settings` the non-admin state is defence in depth, not a state a user meets: `/admin`
 * renders behind `AdminRoute`, and `useIsAdmin()` is true in a DEV build without Cognito, so
 * `SourceCard`'s and `LogsSection`'s disabled controls are reachable only from their unit tests.
 * They stay gated so the card is safe to reuse outside that route.
 *
 * The literal is NOT routed through i18n: `GeneratorConfigModal` carried it before it
 * was consolidated here. Scrapers now reads the translated key instead; Settings'
 * tooltips stay English until their redesign. `frontend/scripts/i18n-check.mjs`
 * cannot catch the rest either way: it reports a DIRECTORY in which no file calls
 * `useTranslation` at all, and `Settings/` is mixed.
 *
 * Every assertion on this string imports the constant instead of restating it, so
 * translating it is a change to this file alone and cannot fail a test whose
 * subject is the admin gate.
 */
export const ADMIN_ONLY_TITLE = 'Admin access required'
