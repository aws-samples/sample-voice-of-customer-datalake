/**
 * ENABLED_SOURCES (issue #256): the integrations and logs Lambdas are told which
 * plugins this deployment enabled, so `GET /sources/status` and the `/logs/*`
 * listings stop fanning out over a hardcoded triple. Read by
 * `lambda/shared/enabled_sources.py`; a missing or stale value degrades those
 * routes quietly (no plugin listed), which no Python test can see — hence here.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { z } from 'zod';

import {
  apiTemplate, apiTemplateAllPlugins, discoverPluginIds, serviceEnvironment, synthApiTemplate,
} from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';
import type { Template } from 'aws-cdk-lib/assertions';

beforeAll(() => {
  apiTemplate();
  apiTemplateAllPlugins();
}, SYNTH_TIMEOUT_MS);

const READERS = ['voc-integrations-api', 'voc-logs-api'] as const;

/** ENABLED_SOURCES of `service`, parsed as the handler parses it, sorted. */
function enabledSources(template: Template, service: string): string[] {
  const raw = z.string().parse(serviceEnvironment(template, service).ENABLED_SOURCES);
  return z.array(z.string()).parse(JSON.parse(raw)).sort(byCodeUnit);
}

describe('ENABLED_SOURCES is rendered from pluginStatus at synth time', () => {
  it.each(READERS)('%s lists every enabled plugin on disk', (service) => {
    expect(enabledSources(apiTemplateAllPlugins(), service)).toStrictEqual(discoverPluginIds());
  });

  it.each(READERS)('%s lists none when no plugin is enabled', (service) => {
    expect(enabledSources(apiTemplate(), service)).toStrictEqual([]);
  });

  it('drops an enabled id that has no plugin directory', () => {
    const template = synthApiTemplate({}, ['webscraper', 'not_a_plugin']);
    expect(READERS.map((service) => enabledSources(template, service)))
      .toStrictEqual([['webscraper'], ['webscraper']]);
  }, SYNTH_TIMEOUT_MS);
});
