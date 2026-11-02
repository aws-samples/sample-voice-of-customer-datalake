/**
 * The connector-version an API-side raw writer records (lambda/shared/raw_versions.py `app_connector`)
 * is the platform release, handed to the manual-import Lambda as APP_VERSION at synth
 * (lib/utils/connector-version.ts). Plugins record their manifest version (ingestion-stack.test.ts,
 * api-stack-webhook-env.test.ts).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, it, expect } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';
import { apiTemplate, serviceEnvironment } from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { appVersion, pluginVersion } from '../utils/connector-version';

const repoFile = (...segments: string[]) => readFileSync(join(__dirname, '..', '..', '..', ...segments), 'utf-8');
const ROOT_VERSION = z.object({ version: z.string() }).parse(JSON.parse(repoFile('package.json'))).version;

describe('raw connector versions', () => {
  let template: Template;
  beforeAll(() => {
    template = apiTemplate();
  }, SYNTH_TIMEOUT_MS);

  it('the app version is the repo-root package.json version', () => {
    expect(appVersion()).toBe(ROOT_VERSION);
  });

  it('the manual-import Lambda (paste, CSV and JSON archives) carries it as APP_VERSION', () => {
    expect(serviceEnvironment(template, 'voc-manual-import-api')['APP_VERSION']).toBe(ROOT_VERSION);
  });

  it('APP_VERSION is the variable the Python helper reads', () => {
    expect(repoFile('voc-datalake', 'lambda', 'shared', 'raw_versions.py')).toContain("os.environ.get('APP_VERSION')");
  });

  it('a plugin records its manifest version, or unversioned', () => {
    expect(pluginVersion({ version: '1.2.3' })).toBe('1.2.3');
    expect(pluginVersion({})).toBe('unversioned');
  });
});
