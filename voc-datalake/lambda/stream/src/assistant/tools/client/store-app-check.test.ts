/**
 * create_app_connector checks the store before its approval card (#38): an invented App Store id or Google
 * Play package is refused with a reason the model can act on, a found app's name and developer go on the
 * card, and an unreadable store refuses nothing.
 */
import { describe, expect, it } from 'vitest';
import { ServiceError } from '../../../lib/errors.js';
import type { StoreAppLookup } from '../../../tools/store-app-lookup.js';
import type { ClientToolDefinition } from '../../types.js';
import { buildCatalogue } from '../catalogue.js';
import { fakeContext, fakeDeps } from '../test-fixtures.js';
import { missingStoreAppRefusal, storeIdentity } from './store-app-check.js';

const IOS = { source: 'app_reviews_ios', app_name: 'Example Air', app_id: '123456789' };
const ANDROID = { source: 'app_reviews_android', app_name: 'Example Air', package_name: 'com.example.air' };
const WEB = { source: 'web_reviews', app_name: 'Example Air Trustpilot', url: 'https://www.trustpilot.com/review/example.air' };

const FOUND: StoreAppLookup = { status: 'found', app: { name: 'Example Air: Flights', developer: 'Example Air Group', url: 'https://apps.apple.com/x' } };

/** The connector tool over a store that answers `answer`, and the lookups it was asked. */
function connector(answer: StoreAppLookup) {
  const asked: string[] = [];
  const deps = fakeDeps({}, {
    lookupStoreApp: (platform, id) => {
      asked.push(`${platform}:${id}`);
      return Promise.resolve(answer);
    },
  });
  const tool = buildCatalogue(deps).find((candidate) => candidate.name === 'create_app_connector');
  if (tool?.kind !== 'client') throw new ServiceError('no create_app_connector');
  return { tool: tool satisfies ClientToolDefinition, asked };
}

const admin = () => fakeContext('scrapers', {}, { isAdmin: true });

describe('create_app_connector precheck: the store must have the app', () => {
  it('refuses an App Store id no storefront has, telling the model how to find the real one', async () => {
    const { tool } = connector({ status: 'missing' });
    const refusal = await tool.precheck?.(IOS, admin());
    expect(refusal).toBe('No App Store app has id 123456789 (looked up in the 40 storefronts the iOS connector reads). '
      + 'Do not guess an id: find it with find_app_store_app, or ask the user.');
  });

  it('refuses a Google Play package whose page answers 404', async () => {
    const { tool } = connector({ status: 'missing' });
    expect(await tool.precheck?.(ANDROID, admin())).toContain('Google Play has no app com.example.air');
  });

  it('lets a found app through', async () => {
    const { tool, asked } = connector(FOUND);
    expect(await tool.precheck?.(IOS, admin())).toBeUndefined();
    expect(asked).toStrictEqual(['ios:123456789']);
  });

  it('refuses nothing when the store could not be read', async () => {
    const { tool } = connector({ status: 'unknown', reason: 'Google Play answered HTTP 503' });
    expect(await tool.precheck?.(ANDROID, admin())).toBeUndefined();
  });

  it('does not look up a web-reviews page', async () => {
    const { tool, asked } = connector({ status: 'missing' });
    expect(await tool.precheck?.(WEB, admin())).toBeUndefined();
    expect(asked).toStrictEqual([]);
  });
});

describe('create_app_connector card text', () => {
  it('names the store app and its developer, so the user can see it is the right company', async () => {
    const { tool } = connector(FOUND);
    expect(await tool.describe?.(IOS, admin()))
      .toBe("Add iOS app connector 'Example Air' (123456789). App Store: 'Example Air: Flights' by 'Example Air Group'.");
  });

  it('says the store could not be checked, and why', async () => {
    const { tool } = connector({ status: 'unknown', reason: 'Google Play answered HTTP 503' });
    expect(await tool.describe?.(ANDROID, admin()))
      .toBe("Add Android app connector 'Example Air' (com.example.air). Google Play could not be checked (Google Play answered HTTP 503).");
  });

  it('adds nothing for a found app the store gave no name for, nor for a web page', async () => {
    const { tool } = connector({ status: 'found', app: { name: '', developer: '', url: '' } });
    expect(await tool.describe?.(ANDROID, admin())).toBe("Add Android app connector 'Example Air' (com.example.air).");
    expect(await tool.describe?.(WEB, admin())).toBe(tool.summarize(WEB));
  });

  it('leaves out "by" when the store names no developer', async () => {
    const { tool } = connector({ status: 'found', app: { name: 'Example Air', developer: '', url: '' } });
    expect(await tool.describe?.(IOS, admin())).toBe("Add iOS app connector 'Example Air' (123456789). App Store: 'Example Air'.");
  });

  it('shares one store lookup between the precheck and the card of the same call', async () => {
    const { tool, asked } = connector(FOUND);
    const ctx = admin();
    await tool.precheck?.(IOS, ctx);
    await tool.describe?.(IOS, ctx);
    expect(asked).toStrictEqual(['ios:123456789']);
  });
});

describe('storeIdentity / missingStoreAppRefusal', () => {
  it('reads the store and id of each app source, nothing for a web page', () => {
    expect(storeIdentity(IOS)).toStrictEqual({ platform: 'ios', id: '123456789' });
    expect(storeIdentity(ANDROID)).toStrictEqual({ platform: 'android', id: 'com.example.air' });
    expect(storeIdentity(WEB)).toBeUndefined();
    expect(storeIdentity({ source: 'app_reviews_ios' })).toBeUndefined();
  });

  it('asks the given lookup and refuses only on missing', async () => {
    await expect(missingStoreAppRefusal(IOS, () => Promise.resolve(FOUND))).resolves.toBeUndefined();
    await expect(missingStoreAppRefusal(IOS, () => Promise.resolve({ status: 'missing' }))).resolves.toContain('No App Store app has id');
  });
});
