/**
 * @fileoverview What the server will hide in a memory before it is stored.
 *
 * A mirror of `lambda/shared/memory_policy.py` → `redact_personal_data`: emails,
 * credential-shaped tokens and phone-shaped numbers (9+ digits, not a date) become
 * `[redacted]`. The server stays the authority; this only lets the form say so
 * BEFORE saving instead of silently changing the text. Keep the patterns in step
 * with the Python ones (the cases in `privacyPreview.test.ts` are the same shapes).
 *
 * @module pages/Memory/privacyPreview
 */

/** The marker the server writes where it hid something. */
const REDACTED_MARKER = '[redacted]'

// Python's `\w` is Unicode-aware; `[\p{L}\p{N}_]` with the `u` flag is the same class.
// Emails are found per whitespace-separated word (bounded, so no backtracking blow-up).
const EMAIL_IN_WORD_RE = /[\p{L}\p{N}_.+-]{1,64}@[\p{L}\p{N}_-]{1,63}(?:\.[\p{L}\p{N}_-]{1,63}){1,8}/u
const SECRETISH_RE = /\b(AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,})\b/g
const PHONE_CANDIDATE_RE = /(?<![\p{L}\p{N}_])\+?\d[\d\s().-]{7,}\d(?![\p{L}\p{N}_])/gu
const ISO_DATE_RE = /\d{4}-\d{2}-\d{2}/
/** A phone number has at least 9 digits; fewer is a date, a version or an amount. */
const PHONE_MIN_DIGITS = 9

function isPhone(candidate: string): boolean {
  const digits = [...candidate].filter((ch) => ch >= '0' && ch <= '9').length
  return digits >= PHONE_MIN_DIGITS && !ISO_DATE_RE.test(candidate)
}

/** The email addresses in `text`, each as the server's pattern would match it. */
function emailsIn(text: string): string[] {
  return text.split(/\s+/).filter((word) => word.includes('@')).flatMap((word) => {
    const match = EMAIL_IN_WORD_RE.exec(word)
    return match === null ? [] : [match[0]]
  })
}

function replaceAll(text: string, parts: readonly string[]): string {
  return parts.reduce((out, part) => out.split(part).join(REDACTED_MARKER), text)
}

/**
 * The parts of `text` the server will replace with `[redacted]`, in the order the
 * server applies its rules (emails, then credentials, then phone numbers), each
 * once. Empty when nothing will be hidden.
 */
export function detailsToHide(text: string): string[] {
  const emails = emailsIn(text)
  const afterEmails = replaceAll(text, emails)
  const secrets = [...afterEmails.matchAll(SECRETISH_RE)].map((m) => m[0])
  const afterSecrets = afterEmails.replace(SECRETISH_RE, REDACTED_MARKER)
  const phones = [...afterSecrets.matchAll(PHONE_CANDIDATE_RE)].map((m) => m[0]).filter(isPhone)
  return [...new Set([...emails, ...secrets, ...phones].map((part) => part.trim()))]
}

/** True when the stored statement had something hidden for privacy. */
export function wasRedacted(statement: string): boolean {
  return statement.includes(REDACTED_MARKER)
}
