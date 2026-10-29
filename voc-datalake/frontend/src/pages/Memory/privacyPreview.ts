/**
 * @fileoverview What the server will hide in a memory before it is stored.
 *
 * A mirror of `lambda/shared/memory_policy.py` → `redact_personal_data`: emails,
 * credential-shaped tokens, payment card numbers (Luhn + an issuer prefix of that
 * length, `shared/pii_redaction.py` → `is_payment_card`) and phone-shaped numbers
 * (9+ digits with a `+` or separators, not a date) become `[redacted]`. A bare digit
 * run (a timestamp, an order id) is kept unless it is a card number. The server stays the authority; this only lets the form say so
 * BEFORE saving instead of silently changing the text. Keep the patterns in step
 * with the Python ones (the cases in `memoryHelpers.test.ts` are the same shapes).
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

const BARE_DIGITS_RE = /^\d+$/

/** [lowest prefix, highest prefix, lengths issued]: the issuer table of `pii_redaction._CARD_NETWORKS`. */
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i)
const CARD_NETWORKS: readonly (readonly [number, number, readonly number[]])[] = [
  [4, 4, [13, 16, 19]], [34, 34, [15]], [37, 37, [15]], [51, 55, [16]], [2221, 2720, [16]],
  [300, 305, range(14, 19)], [36, 36, range(14, 19)], [38, 39, range(14, 19)], [3528, 3589, range(16, 19)],
  [50, 50, range(13, 19)], [56, 69, range(13, 19)],
]

function luhnValid(digits: string): boolean {
  const sum = [...digits].reverse().reduce((total, ch, index) => {
    const digit = Number(ch) * (index % 2 === 1 ? 2 : 1)
    return total + (digit > 9 ? digit - 9 : digit)
  }, 0)
  return sum % 10 === 0
}

function isPaymentCard(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '')
  const issued = CARD_NETWORKS.some(([low, high, lengths]) => {
    const prefix = Number(digits.slice(0, String(low).length))
    return prefix >= low && prefix <= high && lengths.includes(digits.length)
  })
  return issued && luhnValid(digits)
}

function isPhone(candidate: string): boolean {
  if (isPaymentCard(candidate)) return true
  const digits = [...candidate].filter((ch) => ch >= '0' && ch <= '9').length
  return digits >= PHONE_MIN_DIGITS && !BARE_DIGITS_RE.test(candidate) && !ISO_DATE_RE.test(candidate)
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
