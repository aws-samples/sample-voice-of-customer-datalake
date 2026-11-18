/**
 * The browser the browser-capable ingestors drive (`infrastructure.ingestor.browser`, the web_reviews plugin), made
 * on VocIngestionStack only when such a plugin is enabled (docs/web-reviews.md → Blocked sites, Sessions and
 * profiles). Resources are created on the stack itself (logical ids `WebReviewsBrowser*`).
 *
 * - **Web Bot Auth** (`-c webReviewsBotAuth`, on by default): the deployment's own custom browser
 *   (`AWS::BedrockAgentCore::BrowserCustom`, named `voc_web_reviews`, `<prefix>_voc_web_reviews` under a deployment
 *   prefix) with browser signing on and the public network. AgentCore signs every request it makes (the
 *   `Signature`, `Signature-Agent` and `Signature-Input` headers of the draft IETF Web Bot Auth protocol), so a site's
 *   bot control (Cloudflare, HUMAN, Akamai, DataDome, F5) can verify that it is Amazon Bedrock AgentCore. The site
 *   owner still decides what signed agents may do. The feature is in Preview. Its execution role carries the trust
 *   policy the AgentCore guide asks for (`bedrock-agentcore.amazonaws.com`, `aws:SourceAccount` this account,
 *   `aws:SourceArn` this account's AgentCore resources in the region) and NO policy: signing needs no permission.
 *   Name, Description, NetworkConfiguration, BrowserSigning and ExecutionRoleArn are create-only, so changing one
 *   replaces the browser, which holds no data. Off: the AWS-managed `aws.browser.v1` (unsigned), as before 7.41.00,
 *   and nothing is made for it.
 * - **A browser profile** (`-c webReviewsBrowserProfile`, on by default): `AWS::BedrockAgentCore::BrowserProfile`, same
 *   name. A run starts its session with the profile (cookies and local storage of the review sites: consent, the
 *   sites' own tokens) and saves the session into it before stopping it, so the next run starts where this one ended.
 *   One per deployment, shared by every workspace's runs: they read public pages only and never sign in, so a
 *   profile holds no workspace's data; concurrent runs each save, the last save wins.
 *
 * The ingestor's environment names what was made: `BROWSER_IDENTIFIER` (the custom browser's id; unset = the managed
 * browser) and `BROWSER_PROFILE_IDENTIFIER` (unset = no profile), read by plugins/web_reviews/ingestor/agentcore_browser.py.
 *
 * Cost: none while idle. Sessions bill per second of CPU and memory, as on `aws.browser.v1`; the custom browser and
 * its role cost nothing; a profile is stored at Amazon S3 Standard rates (kilobytes of cookies and local storage).
 */
import * as cdk from 'aws-cdk-lib';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';

import { agentCoreTrust } from '../utils/agentcore-trust';
import { webReviewsBotAuth, webReviewsBrowserProfile } from '../utils/web-reviews-browser';
import { type BrowserGrant, managedBrowserArn } from './ingestion-roles';

/** The ingestor's env var naming the browser its sessions start on (unset: the AWS-managed `aws.browser.v1`). */
export const BROWSER_IDENTIFIER_ENV = 'BROWSER_IDENTIFIER';
/** The ingestor's env var naming the profile its sessions load and save (unset: no profile). */
export const BROWSER_PROFILE_IDENTIFIER_ENV = 'BROWSER_PROFILE_IDENTIFIER';
/** The base of the browser's and the profile's names (`uniqueName` → `agentCoreName`: `[<prefix>_]voc_web_reviews`). */
export const WEB_REVIEWS_BROWSER_BASE_NAME = 'voc_web_reviews';

interface IngestorBrowserProps {
  /** An AgentCore name (lib/utils/naming.ts `agentCoreName`), the browser's and the profile's. */
  readonly name: string;
  /** Web Bot Auth: the deployment's own signing browser; false: the AWS-managed `aws.browser.v1`. */
  readonly signing: boolean;
  /** A browser profile the sessions load and save. */
  readonly profile: boolean;
}

/** What the browser plugins' roles are granted, and what their ingestors are told. */
export interface IngestorBrowser extends BrowserGrant {
  /** `BROWSER_IDENTIFIER` and `BROWSER_PROFILE_IDENTIFIER`, each only when the resource it names was made. */
  readonly environment: Record<string, string>;
}

/** The execution role signing needs: trusted by AgentCore for this account's resources in the region, no policy. */
function signingRole(stack: cdk.Stack): iam.Role {
  return new iam.Role(stack, 'WebReviewsBrowserRole', {
    assumedBy: agentCoreTrust(stack),
    description: 'Web Reviews browser (Web Bot Auth): AgentCore signs its requests; no permissions',
  });
}

function signingBrowser(stack: cdk.Stack, name: string): bedrockagentcore.CfnBrowserCustom {
  return new bedrockagentcore.CfnBrowserCustom(stack, 'WebReviewsBrowser', {
    name,
    description: 'Web Reviews: signs every request (Web Bot Auth)',
    networkConfiguration: { networkMode: 'PUBLIC' },
    browserSigning: { enabled: true },
    executionRoleArn: signingRole(stack).roleArn,
  });
}

/** The browser (and profile) of the stack's browser plugins, as their roles and environments need them. */
function createIngestorBrowser(stack: cdk.Stack, { name, signing, profile }: IngestorBrowserProps): IngestorBrowser {
  const environment: Record<string, string> = {};
  let arn = managedBrowserArn(stack);
  if (signing) {
    const browser = signingBrowser(stack, name);
    arn = browser.attrBrowserArn;
    environment[BROWSER_IDENTIFIER_ENV] = browser.attrBrowserId;
  }
  if (!profile) return { arn, environment };
  const browserProfile = new bedrockagentcore.CfnBrowserProfile(stack, 'WebReviewsBrowserProfile', {
    name,
    description: 'Web Reviews: the review sites\' cookies and local storage, kept between runs',
  });
  environment[BROWSER_PROFILE_IDENTIFIER_ENV] = browserProfile.attrProfileId;
  return { arn, profileArn: browserProfile.attrProfileArn, environment };
}

/**
 * The stack's browser, made on first use (none without a browser plugin) under the name `name()` gives then; the two
 * flags are read (strictly) when this is built, whatever the plugins.
 */
export class LazyIngestorBrowser {
  private browser?: IngestorBrowser;
  private readonly signing: boolean;
  private readonly profile: boolean;

  constructor(private readonly stack: cdk.Stack, private readonly name: () => string) {
    this.signing = webReviewsBotAuth(stack);
    this.profile = webReviewsBrowserProfile(stack);
  }

  get(): IngestorBrowser {
    this.browser ??= createIngestorBrowser(this.stack, { name: this.name(), signing: this.signing, profile: this.profile });
    return this.browser;
  }
}
