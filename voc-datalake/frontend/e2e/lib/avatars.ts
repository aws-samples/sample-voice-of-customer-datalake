/**
 * Which S3 avatar objects belong to a set of personas: the read-only proof that
 * a project delete swept them (s3 step 12).
 *
 * The key layout is `lambda/shared/avatar.py`'s:
 * - current: content-addressed, one new key per image,
 *   `avatars/{persona_id}/{sha256[:24]}.{ext}` (`avatar_object_key`);
 * - legacy: the flat `avatars/{persona_id}.{ext}` (`avatar_object_keys`, one per
 *   historical extension).
 * QA 3.00.00 S4: the proof listed only the flat keys, so on 3.00.00 it found
 * nothing before the delete and could never see a leftover.
 */
import { execFileSync } from 'node:child_process'

export const AVATAR_PREFIX = 'avatars/'
/** `_HISTORICAL_EXTENSIONS` of shared/avatar.py (legacy flat keys only). */
const LEGACY_EXTENSIONS: readonly string[] = ['jpeg', 'png', 'jpg', 'webp']

/** Is `key` one of `personaId`'s avatar objects, in either layout? */
export function isAvatarKeyOf(key: string, personaId: string): boolean {
  if (personaId === '') return false
  const base = `${AVATAR_PREFIX}${personaId}`
  if (LEGACY_EXTENSIONS.some((ext) => key === `${base}.${ext}`)) return true
  // Nested: exactly one segment under the persona's own prefix (`persona_1/` never matches `persona_10/`).
  if (!key.startsWith(`${base}/`)) return false
  const file = key.slice(base.length + 1)
  return file !== '' && !file.includes('/')
}

/** The keys in `keys` that are avatars of `personaIds`, sorted. */
export function avatarKeysOf(personaIds: readonly string[], keys: readonly string[]): string[] {
  return keys.filter((key) => personaIds.some((id) => isAvatarKeyOf(key, id))).sort()
}

/** The S3 key of a signed CDN avatar URL (`https://cdn/avatars/…?Signature=…`), else null. */
export function avatarKeyOfUrl(url: string): string | null {
  try {
    const key = decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ''))
    return key.startsWith(AVATAR_PREFIX) ? key : null
  } catch {
    return null
  }
}

/** Every key under `prefix` in `bucket` (read-only `aws s3api list-objects-v2`, the CLI pages itself). */
function listKeys(bucket: string, prefix: string): string[] {
  const out = execFileSync('aws', [
    's3api', 'list-objects-v2', '--bucket', bucket, '--prefix', prefix, '--query', 'Contents[].Key', '--output', 'json',
  ], { encoding: 'utf8', timeout: 60_000 })
  const parsed: unknown = JSON.parse(out.trim() === '' ? 'null' : out)
  return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []
}

/**
 * The avatar objects of these personas that exist now, in both layouts. One list
 * per persona (prefix `avatars/{id}`, which covers the nested keys and the flat
 * ones); `isAvatarKeyOf` drops a neighbour such as `avatars/{id}0/…`.
 */
export function existingAvatarKeys(bucket: string, personaIds: readonly string[]): string[] {
  const ids = [...new Set(personaIds.filter((id) => id !== ''))]
  return avatarKeysOf(ids, ids.flatMap((id) => listKeys(bucket, `${AVATAR_PREFIX}${id}`)))
}
