import * as fs from 'fs';
import * as path from 'path';

/**
 * Synth-time guard that prevents deploying a stale (or missing) frontend build.
 *
 * The frontend is shipped via `s3deploy.Source.asset('frontend/dist')`, which
 * packages whatever happens to be in `frontend/dist` at synth time — CDK does
 * NOT rebuild the frontend. If `dist` is older than the source (e.g. after
 * checking out a branch or editing `src/`), `cdk deploy` would silently ship an
 * out-of-date UI.
 *
 * This guard compares the modification time of `dist/index.html` against the
 * newest source input. If the build is missing or stale, synth fails with a
 * clear instruction to rebuild.
 *
 * Bypass (for rare, intentional cases) with:
 *   cdk deploy -c skipFrontendBuildCheck=true
 * or the environment variable SKIP_FRONTEND_BUILD_CHECK=1.
 */

export interface FrontendBuildCheckOptions {
  /** Absolute path to the frontend project root (the directory containing src/ and dist/). */
  frontendRoot: string;
  /** When true, the check logs a warning and returns without throwing. */
  skip?: boolean;
}

// Source inputs that, when newer than the build output, mean dist is stale.
const SOURCE_DIRS = ['src', 'public'];
const SOURCE_FILES = [
  'index.html',
  'vite.config.ts',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
  'package.json',
];
// Directories never relevant to build freshness.
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.vite', 'coverage']);

interface NewestFile {
  mtimeMs: number;
  filePath: string;
}

function trackNewestFile(targetPath: string, current: NewestFile): NewestFile {
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    return stat.mtimeMs > current.mtimeMs
      ? { mtimeMs: stat.mtimeMs, filePath: targetPath }
      : current;
  }
  if (!stat.isDirectory()) {
    return current;
  }
  let newest = current;
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) {
      continue;
    }
    newest = trackNewestFile(path.join(targetPath, entry.name), newest);
  }
  return newest;
}

function buildCommandHint(frontendRoot: string): string {
  const rel = path.relative(process.cwd(), frontendRoot) || '.';
  return `    cd ${rel} && npm run build`;
}

/**
 * Throws if `frontend/dist` is missing or older than the newest frontend source file.
 */
export function assertFrontendBuildFresh(options: FrontendBuildCheckOptions): void {
  const skip = options.skip || process.env.SKIP_FRONTEND_BUILD_CHECK === '1';
  if (skip) {
    // eslint-disable-next-line no-console
    console.warn(
      '⚠️  Frontend build freshness check skipped (skipFrontendBuildCheck). ' +
        'The contents of frontend/dist will be deployed as-is.'
    );
    return;
  }

  const { frontendRoot } = options;
  const distIndex = path.join(frontendRoot, 'dist', 'index.html');

  if (!fs.existsSync(distIndex)) {
    throw new Error(
      `Frontend build missing: ${distIndex} not found.\n` +
        `Build the frontend before deploying:\n` +
        `${buildCommandHint(frontendRoot)}\n` +
        `(or bypass with: cdk deploy -c skipFrontendBuildCheck=true)`
    );
  }

  const distMtimeMs = fs.statSync(distIndex).mtimeMs;

  let newest: NewestFile = { mtimeMs: 0, filePath: '' };
  const candidates = [
    ...SOURCE_DIRS.map((dir) => path.join(frontendRoot, dir)),
    ...SOURCE_FILES.map((file) => path.join(frontendRoot, file)),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      newest = trackNewestFile(candidate, newest);
    }
  }

  if (newest.mtimeMs > distMtimeMs) {
    const newestRel = path.relative(frontendRoot, newest.filePath);
    throw new Error(
      `Frontend dist is stale: a source file changed after the last build.\n` +
        `    Newest source : ${newestRel} (modified ${new Date(newest.mtimeMs).toISOString()})\n` +
        `    dist built     : ${new Date(distMtimeMs).toISOString()}\n` +
        `Rebuild the frontend before deploying:\n` +
        `${buildCommandHint(frontendRoot)}\n` +
        `(or bypass with: cdk deploy -c skipFrontendBuildCheck=true)`
    );
  }
}
