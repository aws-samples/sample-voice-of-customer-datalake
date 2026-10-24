/**
 * The email inbox deploy flags (docs/email-intake.md). OFF unless `-c inboundEmailDomain` is set:
 * without it nothing at all is created (no SES rule, bucket, queue or Lambda).
 *
 * - `inboundEmailDomain=voc.example.com` — the domain SES receives for (a hostname).
 * - `inboundEmailHostedZoneId=Z…` — optional: a Route 53 public zone CDK writes the MX record
 *   (and the identity's DKIM CNAMEs) into. `inboundEmailHostedZoneName` names the zone; it
 *   defaults to the domain's parent (`voc.example.com` -> `example.com`).
 * - `inboundEmailRuleSet=<name>` — optional: add the VoC rule to this EXISTING receipt rule set
 *   (normally the region's active one). Without it CDK creates its own rule set, which an
 *   operator must activate: CDK NEVER activates a rule set (one is active per region, and
 *   activating ours would switch every other receiving rule off).
 * - `inboundEmailCreateIdentity=false` — skip the SES domain identity (when it already exists).
 */
import type { Node } from 'constructs';
import { booleanContextFlag } from './context-flag';

export interface InboundEmailConfig {
  readonly domain: string;
  readonly hostedZoneId?: string;
  readonly hostedZoneName?: string;
  /** The existing rule set to join; undefined = create (and output) our own. */
  readonly existingRuleSet?: string;
  readonly createIdentity: boolean;
}

/** Base physical name of the receipt rule, and of the rule set CDK creates when none is given. */
export const INBOUND_EMAIL_RULE_BASE_NAME = 'voc-email-intake';

// A DNS hostname: labels of 1-63 letters, digits or inner hyphens, at least two labels, <= 253.
const HOSTNAME_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ZONE_ID_RE = /^Z[A-Z0-9]{1,31}$/;
// SES rule set names: letters, digits, '.', '_' and '-', 1-64, starting and ending alphanumeric.
const RULE_SET_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

function optionalText(raw: unknown, key: string): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw new Error(`-c ${key} must be a string, got ${JSON.stringify(raw)}`);
  return raw.trim();
}

function checked(value: string | undefined, pattern: RegExp, key: string, what: string): string | undefined {
  if (value !== undefined && !pattern.test(value)) {
    throw new Error(`-c ${key}=${JSON.stringify(value)} is not ${what}`);
  }
  return value;
}

/** The domain's parent zone: `voc.example.com` -> `example.com` (the domain itself for `example.com`). */
function parentZone(domain: string): string {
  const labels = domain.split('.');
  return labels.length > 2 ? labels.slice(1).join('.') : domain;
}

function zoneName(raw: unknown, domain: string): string {
  const name = checked(optionalText(raw, 'inboundEmailHostedZoneName')?.toLowerCase().replace(/\.$/, ''),
    HOSTNAME_RE, 'inboundEmailHostedZoneName', 'a hostname') ?? parentZone(domain);
  if (domain !== name && !domain.endsWith(`.${name}`)) {
    throw new Error(`-c inboundEmailDomain=${domain} is not inside the hosted zone ${name}`);
  }
  return name;
}

/** The inbox flags, or undefined when the inbox is off. Throws at synth on a malformed value. */
export function inboundEmailConfig(node: Node): InboundEmailConfig | undefined {
  const domain = checked(optionalText(node.tryGetContext('inboundEmailDomain'), 'inboundEmailDomain')?.toLowerCase(),
    HOSTNAME_RE, 'inboundEmailDomain', 'a hostname such as voc.example.com');
  if (domain === undefined) return undefined;
  const hostedZoneId = checked(optionalText(node.tryGetContext('inboundEmailHostedZoneId'), 'inboundEmailHostedZoneId'),
    ZONE_ID_RE, 'inboundEmailHostedZoneId', 'a Route 53 hosted zone id');
  const existingRuleSet = checked(optionalText(node.tryGetContext('inboundEmailRuleSet'), 'inboundEmailRuleSet'),
    RULE_SET_RE, 'inboundEmailRuleSet', 'an SES receipt rule set name');
  const createIdentity = booleanContextFlag(node.tryGetContext('inboundEmailCreateIdentity'),
    'inboundEmailCreateIdentity', true, 'Use -c inboundEmailCreateIdentity=true|false.');
  return {
    domain,
    ...(hostedZoneId === undefined ? {} : {
      hostedZoneId, hostedZoneName: zoneName(node.tryGetContext('inboundEmailHostedZoneName'), domain),
    }),
    ...(existingRuleSet === undefined ? {} : { existingRuleSet }),
    createIdentity,
  };
}

/**
 * The settings Lambda's view of the inbox (Settings → Email inbox): `{}` when it is off, so a
 * deployment without the flag synthesizes exactly as before. `ownRuleSetName` is called only when
 * the inbox is on, so an off deployment registers no extra physical name.
 */
export function inboundEmailSettingsEnv(node: Node, ownRuleSetName: () => string): Record<string, string> {
  const config = inboundEmailConfig(node);
  if (config === undefined) return {};
  return {
    INBOUND_EMAIL_DOMAIN: config.domain,
    INBOUND_EMAIL_RULE_SET: config.existingRuleSet ?? ownRuleSetName(),
    INBOUND_EMAIL_RULE_SET_OWNED: config.existingRuleSet === undefined ? '1' : '0',
  };
}
