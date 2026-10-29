/**
 * VocApiStack's route consolidation (5.47.00, the 2026-10-29 route plan).
 *
 * - CORS preflight on exactly the resources that serve a browser method: the RestApi lost its
 *   `defaultCorsPreflightOptions`, which put a MOCK `OPTIONS` on every path-only parent too.
 * - `/feedback`, `/scrapers/manual`, `/data-explorer`, `/integrations`, `/sources`, `/connect` and
 *   `/chat` folded into proxies: every path the SPA, the assistant and MCP call still reaches the
 *   same Lambda, behind the same authorizer.
 * - Deployability: at most ONE variable path part per level. API Gateway refuses a `{proxy+}` beside
 *   a `{param}`, and CloudFormation creates new resources before it deletes old ones, so a swap of
 *   one for the other at the same level fails on every environment already deployed.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import {
  RefSchema, apiMethods, apiTemplate, apiTemplateAllPlugins, functionIdForHandler, nonOptions, resolveMethod,
} from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';

beforeAll(() => {
  apiTemplate();
  apiTemplateAllPlugins();
}, SYNTH_TIMEOUT_MS * 2);

/** The two synth shapes: webhook receivers exist only with their plugin on. */
const TEMPLATE_SHAPES: [string, () => Template][] = [['no plugins', apiTemplate], ['every plugin', apiTemplateAllPlugins]];

/** Paths whose methods a browser never calls cross-origin: a provider's signed server-to-server POST. */
const isWebhook = (path: string) => path.startsWith('/webhooks/');

function pathsWith(template: Template, keep: (verb: string) => boolean): Set<string> {
  return new Set(apiMethods(template).filter((m) => keep(m.httpMethod)).map((m) => m.path));
}

describe('CORS preflight on exactly the method-bearing resources', () => {
  it.each(TEMPLATE_SHAPES)(
    'gives every browser-facing resource with a method a preflight (%s)',
    (_shape, template) => {
      const preflighted = pathsWith(template(), (verb) => verb === 'OPTIONS');
      const missing = [...pathsWith(template(), (verb) => verb !== 'OPTIONS')]
        .filter((path) => !isWebhook(path) && !preflighted.has(path));
      expect([...missing].sort(byCodeUnit)).toStrictEqual([]);
    },
  );

  it.each(TEMPLATE_SHAPES)(
    'puts no preflight on a path-only parent or a webhook receiver (%s)',
    (_shape, template) => {
      const served = pathsWith(template(), (verb) => verb !== 'OPTIONS');
      const stray = [...pathsWith(template(), (verb) => verb === 'OPTIONS')]
        .filter((path) => isWebhook(path) || !served.has(path));
      expect([...stray].sort(byCodeUnit)).toStrictEqual([]);
    },
  );

  it.each(['/', '/chat', '/metrics', '/settings', '/integrations', '/sources', '/data-explorer', '/connect', '/mcp'])(
    'drops the preflight of the path-only parent %s',
    (path) => {
      expect(pathsWith(apiTemplate(), (verb) => verb === 'OPTIONS').has(path)).toBe(false);
    },
  );

  it('keeps the webhook receiver (plugin on) without a preflight', () => {
    const webhook = apiMethods(apiTemplateAllPlugins()).filter((m) => isWebhook(m.path)).map((m) => m.route);
    expect(webhook).toStrictEqual(['POST /webhooks/github_issues']);
  });

  it('answers every preflight with the gateway MOCK (no compute)', () => {
    const types = new Set(apiMethods(apiTemplate()).filter((m) => m.httpMethod === 'OPTIONS').map((m) => m.integrationType));
    expect([...types]).toStrictEqual(['MOCK']);
  });
});

/** `verb path` → the Lambda handler file that must serve it, after the consolidation. */
const CONSOLIDATED_ROUTES: [string, string, string][] = [
  ['GET', '/feedback/urgent', 'metrics_handler.py'],
  ['GET', '/feedback/fb_1/similar', 'metrics_handler.py'],
  ['PUT', '/feedback/fb_1/dimensions', 'feedback_edit_handler.py'],
  ['GET', '/metrics/release-watch', 'metrics_handler.py'],
  ['POST', '/scrapers/manual/parse', 'manual_import_handler.py'],
  ['GET', '/scrapers/manual/parse/job_1', 'manual_import_handler.py'],
  ['POST', '/scrapers/manual/confirm', 'manual_import_handler.py'],
  ['POST', '/scrapers/manual/csv-upload', 'manual_import_handler.py'],
  ['POST', '/scrapers/manual/json-upload', 'manual_import_handler.py'],
  ['GET', '/scrapers/scr_1/status', 'scrapers_handler.py'],
  ['GET', '/data-explorer/s3/preview', 'data_explorer_handler.py'],
  ['GET', '/integrations/status', 'integrations_handler.py'],
  ['PUT', '/integrations/webscraper/credentials', 'integrations_handler.py'],
  ['GET', '/sources/status', 'integrations_handler.py'],
  ['PUT', '/sources/webscraper/enable', 'integrations_handler.py'],
  ['POST', '/sources/webscraper/reset', 'integrations_handler.py'],
  ['GET', '/chat/conversations/_list', 'chat_handler.py'],
  ['POST', '/chat/conversations/conv_1/cancel', 'chat_handler.py'],
  ['DELETE', '/connect/tokens/tok_1', 'mcp_tokens_handler.py'],
];

describe('consolidated routes keep their Lambda and their authorizer', () => {
  it.each(CONSOLIDATED_ROUTES)('routes %s %s to %s behind Cognito', (verb, path, handlerFile) => {
    const method = resolveMethod(apiMethods(apiTemplate()), verb, path);
    expect(method?.integrationFunctionId, `${verb} ${path}`).toBe(functionIdForHandler(apiTemplate(), handlerFile));
    expect([method?.authorizationType, method?.hasAuthorizerId]).toStrictEqual(['COGNITO_USER_POOLS', true]);
  });

  it('keeps POST /chat/stream on its own static resource beside the /chat proxy', () => {
    const method = resolveMethod(apiMethods(apiTemplate()), 'POST', '/chat/stream');
    expect(method?.route).toBe('POST /chat/stream');
    expect(method?.authorizationType).toBe('COGNITO_USER_POOLS');
  });

  it('has the Cognito authorizer on every method of every consolidated proxy', () => {
    const prefixes = ['/feedback/', '/metrics/', '/scrapers/', '/data-explorer/', '/integrations/', '/sources/', '/connect/', '/chat/'];
    const unauthorized = nonOptions(apiTemplate())
      .filter((m) => m.path.endsWith('{proxy+}') && prefixes.some((prefix) => m.path.startsWith(prefix)))
      .filter((m) => m.authorizationType !== 'COGNITO_USER_POOLS' || !m.hasAuthorizerId)
      .map((m) => m.route);
    expect(unauthorized).toStrictEqual([]);
  });

  it('wires no DELETE (and no ANY) under /data-explorer', () => {
    expect(resolveMethod(apiMethods(apiTemplate()), 'DELETE', '/data-explorer/s3')).toBeUndefined();
    expect(resolveMethod(apiMethods(apiTemplate()), 'DELETE', '/data-explorer/feedback')).toBeUndefined();
  });

  it('routes no write verb to the read-only metrics Lambda under /feedback', () => {
    const metrics = functionIdForHandler(apiTemplate(), 'metrics_handler.py');
    const writes = nonOptions(apiTemplate())
      .filter((m) => m.path.startsWith('/feedback') && !m.path.startsWith('/feedback-forms'))
      .filter((m) => m.integrationFunctionId === metrics && m.httpMethod !== 'GET')
      .map((m) => m.route);
    expect(writes).toStrictEqual([]);
  });
});

const ResourceSchema = z.object({ Properties: z.object({ PathPart: z.string(), ParentId: z.unknown() }) });

/** Parent key → the variable path parts (`{x}`, `{x+}`) declared directly under it. */
function variablePartsByParent(template: Template): Map<string, string[]> {
  const byParent = new Map<string, string[]>();
  for (const resource of Object.values(template.findResources('AWS::ApiGateway::Resource'))) {
    const { PathPart, ParentId } = ResourceSchema.parse(resource).Properties;
    if (!PathPart.startsWith('{')) continue;
    const ref = RefSchema.safeParse(ParentId);
    const parent = ref.success ? ref.data.Ref : '<root>';
    byParent.set(parent, [...(byParent.get(parent) ?? []), PathPart]);
  }
  return byParent;
}

describe('deployable over an existing environment', () => {
  it.each(TEMPLATE_SHAPES)(
    'declares at most one variable path part per level (%s)',
    (_shape, template) => {
      const clashes = [...variablePartsByParent(template()).values()].filter((parts) => parts.length > 1);
      expect(clashes).toStrictEqual([]);
    },
  );

  it.each([
    ['/feedback/{id}'], ['/integrations/{source}'], ['/sources/{source}'],
  ])('keeps %s, so no {proxy+} sibling has to replace it', (path) => {
    expect(apiMethods(apiTemplate()).some((m) => m.path === path)).toBe(true);
  });
});
