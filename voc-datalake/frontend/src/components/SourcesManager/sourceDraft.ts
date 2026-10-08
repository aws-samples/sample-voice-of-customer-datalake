/**
 * @fileoverview The editable copy of the source profiles and its checks.
 *
 * Retention is edited as text (an empty field = keep forever) and parsed on
 * save, so a half-typed number never turns into a stored one.
 *
 * @module components/SourcesManager/sourceDraft
 */
import {
  MANUAL_IMPORT_SOURCE, MAX_RETENTION_DAYS, MAX_SOURCE_PROFILES, MIN_RETENTION_DAYS, SOURCE_ID_RE, defaultSourceProfile,
} from '../../api/sourceProfilesApi'
import { DEFAULT_RETENTION_DAYS } from './piiPolicy'
import type { SourceProfile } from '../../api/sourceProfilesApi'

export interface DraftProfile {
  profile: SourceProfile
  keepForever: boolean
  /** The days as typed; read only when `keepForever` is off. */
  retentionText: string
  tagsValid: boolean
}

export function toDraft(profiles: readonly SourceProfile[]): DraftProfile[] {
  return profiles.map((profile) => ({
    profile,
    keepForever: profile.retention_days === null,
    retentionText: profile.retention_days === null ? String(DEFAULT_RETENTION_DAYS) : String(profile.retention_days),
    tagsValid: true,
  }))
}

/** The stored retention of a draft row: null for keep-forever, NaN when the typed days are unusable. */
function parseRetention({ keepForever, retentionText }: Pick<DraftProfile, 'keepForever' | 'retentionText'>): number | null {
  if (keepForever) return null
  const days = retentionText.trim() === '' ? Number.NaN : Number(retentionText)
  return Number.isInteger(days) && days >= MIN_RETENTION_DAYS && days <= MAX_RETENTION_DAYS ? days : Number.NaN
}

export function toWire(draft: readonly DraftProfile[]): SourceProfile[] {
  return draft.map((row) => ({
    ...row.profile,
    label: row.profile.label.trim() === '' ? row.profile.id : row.profile.label.trim(),
    retention_days: parseRetention(row),
  }))
}

/**
 * The web scraper plugin's id is never an item's source: each scraper's reviews
 * carry the SCRAPER'S NAME as `source_platform` (docs/source-policies.md).
 */
const WEB_SCRAPER_PLUGIN_ID = 'webscraper'

/**
 * Source ids items really carry: every enabled plugin except the web scraper,
 * `feedback_form`, `manual_import`, and each scraper name that is a valid
 * profile id (a name outside the id format cannot be profiled).
 */
export function knownSourceIds(pluginIds: readonly string[], scraperNames: readonly string[] = []): string[] {
  const plugins = pluginIds.filter((id) => id !== WEB_SCRAPER_PLUGIN_ID)
  const scrapers = scraperNames.filter((name) => SOURCE_ID_RE.test(name))
  return [...new Set([...plugins, ...scrapers, 'feedback_form', MANUAL_IMPORT_SOURCE])]
}

export function newProfile(id: string): DraftProfile {
  return { profile: defaultSourceProfile(id), keepForever: true, retentionText: String(DEFAULT_RETENTION_DAYS), tagsValid: true }
}

export interface ProfileProblem {
  messageKey: string
  params: Record<string, string | number>
}

const PROBLEMS = {
  tooMany: { messageKey: 'components:sourcesManager.problems.tooMany' },
  retention: { messageKey: 'components:sourcesManager.problems.retention' },
  tags: { messageKey: 'components:sourcesManager.problems.tags' },
  idFormat: { messageKey: 'components:sourcesManager.problems.idFormat' },
  idDuplicate: { messageKey: 'components:sourcesManager.problems.idDuplicate' },
} as const

/** The first thing stopping a save, or null. */
export function draftProblem(draft: readonly DraftProfile[]): ProfileProblem | null {
  if (draft.length > MAX_SOURCE_PROFILES) return { messageKey: PROBLEMS.tooMany.messageKey, params: { max: MAX_SOURCE_PROFILES } }
  const badRetention = draft.find((d) => Number.isNaN(parseRetention(d)))
  if (badRetention !== undefined) {
    return { messageKey: PROBLEMS.retention.messageKey, params: { name: badRetention.profile.label, min: MIN_RETENTION_DAYS, max: MAX_RETENTION_DAYS } }
  }
  const badTags = draft.find((d) => !d.tagsValid)
  return badTags === undefined ? null : { messageKey: PROBLEMS.tags.messageKey, params: { name: badTags.profile.label } }
}

/** Why a new id cannot be added (a translation key), or null. */
export function newIdProblem(id: string, draft: readonly DraftProfile[]): string | null {
  if (!SOURCE_ID_RE.test(id)) return PROBLEMS.idFormat.messageKey
  if (draft.some((d) => d.profile.id === id)) return PROBLEMS.idDuplicate.messageKey
  return null
}
