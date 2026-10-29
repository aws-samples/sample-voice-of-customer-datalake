/**
 * The outbound email deploy flag: `-c emailFrom=noreply@voc.example.com` (docs/deployment.md,
 * "Participant email and the feature-request board").
 *
 * OFF unless set. When set:
 * - VocCoreStack creates the feature-request board's own Cognito user pool, which sends its
 *   sign-in codes through SES from this address (Cognito's email OTP needs SES);
 * - VocApiStack lets `voc-engagement-api` send participant email (`ses:SendEmail` from exactly
 *   this address) and tells the SPA email is on (`features.email` in config.json).
 *
 * The operator verifies the SES identity of the address's domain (and leaves the SES sandbox)
 * before deploying; nothing here creates or verifies an SES identity.
 */
import type { Node } from 'constructs';
import { HOSTNAME_RE } from './inbound-email';

export interface EmailSender {
  /** The From address, trimmed, its domain lower-cased. */
  readonly address: string;
  /** The address's domain (lower case): the SES identity the operator verifies. */
  readonly domain: string;
}

/** The context key. */
const EMAIL_FROM_CONTEXT_KEY = 'emailFrom';

/** RFC 5321's limit on the part before the `@`. */
const MAX_LOCAL_PART_LENGTH = 64;
// The local part: dot-atom characters, no leading, trailing or doubled dot.
const LOCAL_PART_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;

function malformed(raw: unknown): Error {
  return new Error(
    `-c ${EMAIL_FROM_CONTEXT_KEY} must be a plain address such as noreply@voc.example.com, got ${JSON.stringify(raw)}`,
  );
}

/**
 * Parses an `emailFrom` value: undefined/null/'' = off; anything else must be a plain address
 * (`local@domain`, no display name). Throws at synth on a malformed value, so a typo fails the
 * deploy instead of shipping a board whose sign-in mail can never be sent.
 */
export function parseEmailSender(raw: unknown): EmailSender | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw malformed(raw);
  const value = raw.trim();
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) throw malformed(raw);
  const localPart = value.slice(0, at);
  const domain = value.slice(at + 1).toLowerCase();
  const localOk = localPart.length <= MAX_LOCAL_PART_LENGTH && LOCAL_PART_RE.test(localPart);
  if (!localOk || !HOSTNAME_RE.test(domain)) throw malformed(raw);
  return { address: `${localPart}@${domain}`, domain };
}

/** The `emailFrom` flag of this app, or undefined when outbound email is off. */
export function emailSenderOf(node: Node): EmailSender | undefined {
  return parseEmailSender(node.tryGetContext(EMAIL_FROM_CONTEXT_KEY));
}
