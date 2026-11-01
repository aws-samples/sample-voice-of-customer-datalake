/**
 * The `title` on every control the UI disables because the route behind it is
 * admin-gated server-side.
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
 * NOT routed through i18n, and that is a decision rather than an oversight — but a
 * weak one, recorded so the next reader does not have to guess.
 * `GeneratorConfigModal` carried this exact literal before it was consolidated, so
 * the constant inherits the omission rather than introducing it, and consolidating
 * first means translating it later is a one-line change at a single definition
 * site. The surrounding pages ARE translated (`PluginConfigModal` alone has three
 * `useTranslation` calls), so the inconsistency is real: a non-English user gets
 * these tooltips in English.
 *
 * `frontend/scripts/i18n-check.mjs` cannot catch it either way, so nothing will
 * prompt the fix. Its heuristic reports a DIRECTORY in which no file calls
 * `useTranslation` at all — and both `Scrapers/` and `Settings/` are mixed, so
 * `AppConfigComponents.tsx` and `SourceCard.tsx` (zero calls each) are invisible
 * because their directories as a whole are exempt.
 *
 * Every assertion on this string imports the constant instead of restating it, so
 * translating it is a change to this file alone and cannot fail a test whose
 * subject is the admin gate.
 */
export const ADMIN_ONLY_TITLE = 'Admin access required'
