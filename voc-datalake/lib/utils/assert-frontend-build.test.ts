/**
 * Tests for assert-frontend-build.ts - the synth-time guard that blocks
 * deploying a missing or stale frontend/dist.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertFrontendBuildFresh } from './assert-frontend-build';

function makeFrontend(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-guard-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const x = 1;');
  fs.writeFileSync(path.join(root, 'index.html'), '<html></html>');
  return root;
}

function buildDist(root: string): void {
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'index.html'), 'built');
}

function setMtimeSecondsAgo(filePath: string, secondsAgo: number): void {
  const t = (Date.now() - secondsAgo * 1000) / 1000;
  fs.utimesSync(filePath, t, t);
}

function ageAllSources(root: string, secondsAgo: number): void {
  setMtimeSecondsAgo(path.join(root, 'src', 'app.ts'), secondsAgo);
  setMtimeSecondsAgo(path.join(root, 'index.html'), secondsAgo);
}

describe('assertFrontendBuildFresh', () => {
  const created: string[] = [];

  function newFrontend(): string {
    const root = makeFrontend();
    created.push(root);
    return root;
  }

  beforeEach(() => {
    delete process.env.SKIP_FRONTEND_BUILD_CHECK;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    while (created.length > 0) {
      fs.rmSync(created.pop() as string, { recursive: true, force: true });
    }
  });

  it('throws when dist/index.html is missing', () => {
    const root = newFrontend();
    expect(() => assertFrontendBuildFresh({ frontendRoot: root })).toThrow(/Frontend build missing/);
  });

  it('throws when a source file is newer than the build (stale)', () => {
    const root = newFrontend();
    buildDist(root);
    setMtimeSecondsAgo(path.join(root, 'dist', 'index.html'), 100);
    setMtimeSecondsAgo(path.join(root, 'src', 'app.ts'), 10);
    expect(() => assertFrontendBuildFresh({ frontendRoot: root })).toThrow(/Frontend dist is stale/);
  });

  it('names the newest stale source file in the error', () => {
    const root = newFrontend();
    buildDist(root);
    setMtimeSecondsAgo(path.join(root, 'dist', 'index.html'), 100);
    ageAllSources(root, 100);
    setMtimeSecondsAgo(path.join(root, 'src', 'app.ts'), 5);
    expect(() => assertFrontendBuildFresh({ frontendRoot: root })).toThrow(/src\/app\.ts/);
  });

  it('passes when the build is newer than all sources (fresh)', () => {
    const root = newFrontend();
    buildDist(root);
    ageAllSources(root, 100);
    setMtimeSecondsAgo(path.join(root, 'dist', 'index.html'), 10);
    expect(() => assertFrontendBuildFresh({ frontendRoot: root })).not.toThrow();
  });

  it('treats the root index.html as a source input', () => {
    const root = newFrontend();
    buildDist(root);
    setMtimeSecondsAgo(path.join(root, 'dist', 'index.html'), 50);
    setMtimeSecondsAgo(path.join(root, 'src', 'app.ts'), 100); // older
    setMtimeSecondsAgo(path.join(root, 'index.html'), 5);      // newer than dist
    expect(() => assertFrontendBuildFresh({ frontendRoot: root })).toThrow(/index\.html/);
  });

  it('bypasses the check when skip is true', () => {
    const root = newFrontend();
    buildDist(root);
    setMtimeSecondsAgo(path.join(root, 'dist', 'index.html'), 100);
    setMtimeSecondsAgo(path.join(root, 'src', 'app.ts'), 10); // stale
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => assertFrontendBuildFresh({ frontendRoot: root, skip: true })).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it('bypasses the check when SKIP_FRONTEND_BUILD_CHECK=1', () => {
    const root = newFrontend();
    buildDist(root);
    setMtimeSecondsAgo(path.join(root, 'dist', 'index.html'), 100);
    setMtimeSecondsAgo(path.join(root, 'src', 'app.ts'), 10); // stale
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.SKIP_FRONTEND_BUILD_CHECK = '1';
    expect(() => assertFrontendBuildFresh({ frontendRoot: root })).not.toThrow();
  });
});
