/**
 * @fileoverview The fixed row lists of the user approval cards: one row per
 * field the write touches, in a fixed order, each with a `compare` string so an
 * update can diff before → after row by row (`./FieldDiff` renders them).
 *
 * Design tokens: a role is a label (`badge-muted`); enabled / disabled is a
 * state (`badge-ok` / `badge-muted`).
 *
 * @module assistant/approvals/previews/userRows
 */
import type { ReactNode } from 'react'
import { roleOf, sortedStrings } from '../userSchemas'
import type { UserRecord } from '../userSchemas'
import type { CategoryScope, SourceGrant } from '../../../api/categoryAccessApi'
import type { FieldRow } from './FieldDiff'
import { Lines, Muted } from './ScraperValues'

type Translate = (key: string, options?: Record<string, unknown>) => string

const K = 'assistantTools:preview.users'

function jsonRow(key: string, label: string, value: ReactNode, compare: unknown): FieldRow {
  return { key, label, value, compare: JSON.stringify(compare) }
}

function nameRow(key: 'given_name' | 'family_name', labelKey: string, value: string, t: Translate): FieldRow {
  return jsonRow(key, t(`${K}.${labelKey}`), value === '' ? <Muted text={t(`${K}.notSet`)} /> : value, value)
}

/** Email, role and names — every field a create writes, in a fixed order. */
export function identityRows(user: UserRecord, t: Translate): FieldRow[] {
  const role = roleOf(user.groups)
  return [
    jsonRow('email', t(`${K}.email`), user.email, user.email),
    jsonRow('role', t(`${K}.role`), <span className="badge badge-muted">{t(role === 'admins' ? `${K}.roleAdmins` : `${K}.roleUsers`)}</span>, role),
    nameRow('given_name', 'firstName', user.given_name, t),
    nameRow('family_name', 'lastName', user.family_name, t),
  ]
}

/** The identity rows plus the account state — every field an update can change. */
export function userRows(user: UserRecord, t: Translate): FieldRow[] {
  const state = user.enabled
    ? <span className="badge badge-ok">{t(`${K}.enabled`)}</span>
    : <span className="badge badge-muted">{t(`${K}.disabled`)}</span>
  return [...identityRows(user, t), jsonRow('enabled', t(`${K}.account`), state, user.enabled)]
}

function sourcesValue(sourceGrant: SourceGrant, t: Translate): ReactNode {
  if (sourceGrant.mode === 'list') return <Lines items={sortedStrings(sourceGrant.sources)} empty={t('assistantTools:preview.scraper.none')} />
  return <span>{t(sourceGrant.mode === 'default' ? `${K}.defaultSources` : `${K}.allSources`)}</span>
}

/** Categories and sources — what a grant stores, in a fixed order (lists compared as sets). */
export function accessRows(grant: CategoryScope, sourceGrant: SourceGrant, t: Translate): FieldRow[] {
  const categories = grant.all
    ? <span>{t(`${K}.allCategories`)}</span>
    : <Lines items={sortedStrings(grant.categories)} empty={t('assistantTools:preview.scraper.none')} />
  return [
    jsonRow('categories', t(`${K}.categories`), categories, grant.all ? '*' : sortedStrings(grant.categories)),
    jsonRow('sources', t(`${K}.sources`), sourcesValue(sourceGrant, t), { mode: sourceGrant.mode, sources: sortedStrings(sourceGrant.sources) }),
  ]
}
