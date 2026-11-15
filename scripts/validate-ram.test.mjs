// scripts/validate-ram.sh: validate.sh's rebuildable caches in RAM behind links at their old paths, and the
// fallbacks (a reboot empties RAM; RAM off or unusable). Each test plants a repo root and a "RAM" folder in a temp dir.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const SCRIPT = new URL('./validate-ram.sh', import.meta.url).pathname;
const CACHES = ['.cache/codeql', '.cache/coverage', '.cache/audit', '.cache/validate/tsc'];
const base = mkdtempSync(join(tmpdir(), 'validate-ram-test-'));
after(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
/** A fresh repo root (with `files` written under it) and an empty RAM folder. */
function plant(files = {}) {
  n += 1;
  const root = join(base, `t${n}`, 'repo');
  const ram = join(base, `t${n}`, 'shm');
  mkdirSync(root, { recursive: true });
  mkdirSync(ram, { mode: 0o700 });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return { root, ram };
}
const run = (root, ram) => spawnSync('/bin/bash', [SCRIPT, root, ram], { encoding: 'utf8' });
const isLink = (path) => lstatSync(path).isSymbolicLink();

describe('validate-ram.sh', () => {
  it('moves every cache into RAM, keeps its contents and leaves a link at the old path', () => {
    const { root, ram } = plant({ '.cache/codeql/db-js/x': 'db', '.cache/validate/logs/run/timings.tsv': 'ok' });
    const result = run(root, ram);
    assert.equal(result.status, 0, result.stderr);
    const tree = result.stdout.trim();
    assert.ok(tree.startsWith(`${ram}/repo-`), tree);
    for (const rel of CACHES) {
      assert.ok(isLink(join(root, rel)), `${rel} is a link`);
      assert.ok(readlinkSync(join(root, rel)).startsWith(tree), `${rel} points into the tree's RAM folder`);
    }
    assert.equal(readFileSync(join(root, '.cache/codeql/db-js/x'), 'utf8'), 'db', 'the warm contents came along');
    assert.equal(readFileSync(join(tree, '.cache_codeql/db-js/x'), 'utf8'), 'db', 'and live in RAM');
    assert.ok(!isLink(join(root, '.cache/validate')), 'the step logs (what --failed reads) stay on disk');
    assert.ok(!isLink(join(root, '.cache/validate/logs')));
  });

  it('changes nothing on a second run', () => {
    const { root, ram } = plant({ '.cache/coverage/python.json': '{}' });
    const first = run(root, ram).stdout;
    const links = CACHES.map((rel) => readlinkSync(join(root, rel)));
    const again = run(root, ram);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout, first);
    assert.deepEqual(CACHES.map((rel) => readlinkSync(join(root, rel))), links);
    assert.equal(readFileSync(join(root, '.cache/coverage/python.json'), 'utf8'), '{}');
  });

  it('after a reboot (RAM emptied) makes the folders again: a cold run, every path usable', () => {
    const { root, ram } = plant({ '.cache/audit/py-assembly.json': '{}' });
    run(root, ram);
    rmSync(ram, { recursive: true, force: true });
    assert.ok(!existsSync(join(root, '.cache/audit')), 'the link dangles');
    const result = run(root, ram);
    assert.equal(result.status, 0, result.stderr);
    for (const rel of CACHES) {
      assert.ok(isLink(join(root, rel)));
      mkdirSync(join(root, rel, 'sub'), { recursive: true });   // what the steps do
    }
    assert.ok(!existsSync(join(root, '.cache/audit/py-assembly.json')), 'cold: the old cache is gone');
  });

  it('with RAM off, turns a dangling link into an empty folder and keeps a working link, naming it', () => {
    const { root, ram } = plant();
    const tree = run(root, ram).stdout.trim();
    rmSync(join(tree, '.cache_codeql'), { recursive: true });   // one cache's folder gone
    const result = run(root, '');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '', 'nothing in RAM to name');
    assert.ok(!isLink(join(root, '.cache/codeql')) && lstatSync(join(root, '.cache/codeql')).isDirectory());
    assert.ok(isLink(join(root, '.cache/coverage')), 'a link whose folder is there still works and stays');
    assert.match(result.stderr, /\.cache\/coverage still links to .*remove the link to keep it on disk/);
  });

  it('makes its folders closed to other users', () => {
    const { root, ram } = plant();
    rmSync(ram, { recursive: true });
    const tree = run(root, ram).stdout.trim();
    for (const dir of [ram, tree, join(tree, '.cache_audit'), join(ram, 't')]) {   // t/: the runs' TMPDIRs
      assert.equal(statSync(dir).mode & 0o777, 0o700, dir);
    }
  });

  it('refuses a RAM folder another user could open, or a link, and keeps the caches on disk', () => {
    const open = plant({ '.cache/coverage/a': '1' });
    chmodSync(open.ram, 0o777);                                  // e.g. made by someone else in the shared /dev/shm
    const viaOpen = run(open.root, open.ram);
    assert.equal(viaOpen.status, 0, viaOpen.stderr);
    assert.equal(viaOpen.stdout, '');
    assert.match(viaOpen.stderr, /not a folder only this user can open; the caches stay on disk/);
    assert.ok(!isLink(join(open.root, '.cache/coverage')));
    assert.deepEqual(readdirSync(open.ram), [], 'nothing is made inside a folder it refuses');

    const linked = plant();
    const elsewhere = join(base, `elsewhere-${n}`);
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, join(linked.ram, 'shm-link'));
    const viaLink = run(linked.root, join(linked.ram, 'shm-link'));
    assert.equal(viaLink.stdout, '');
    assert.match(viaLink.stderr, /the caches stay on disk/);
  });

  it('refuses a cache folder planted in its tree as a link, and keeps that cache on disk', () => {
    const { root, ram } = plant({ '.cache/audit/x': '1' });
    const tree = join(ram, `repo-${spawnSync('cksum', { input: root, encoding: 'utf8' }).stdout.split(' ')[0]}`);
    mkdirSync(tree, { mode: 0o700 });
    const elsewhere = join(base, `planted-${n}`);
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, join(tree, '.cache_audit'));
    const result = run(root, ram);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /\.cache_audit is not a folder only this user can open; \.cache\/audit stays on disk/);
    assert.ok(!isLink(join(root, '.cache/audit')));
    assert.equal(readFileSync(join(root, '.cache/audit/x'), 'utf8'), '1');
    assert.ok(isLink(join(root, '.cache/coverage')), 'the other caches still move');
  });

  it('refuses a relative RAM path (its links would point nowhere)', () => {
    const { root } = plant();
    const result = run(root, 'shm');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /must be an absolute path/);
    assert.ok(!existsSync(join(root, '.cache/coverage')) || !isLink(join(root, '.cache/coverage')));
  });

  it('keeps a cache on disk when copying it into RAM fails, and moves the others', () => {
    const { root, ram } = plant({ '.cache/codeql/db': 'x' });
    // A first run makes the tree; then one cache is back on disk with contents and its RAM folder cannot be written.
    const target = join(run(root, ram).stdout.trim(), '.cache_coverage');
    rmSync(join(root, '.cache/coverage'));                       // the link
    mkdirSync(join(root, '.cache/coverage'));
    writeFileSync(join(root, '.cache/coverage/a'), '1');
    chmodSync(target, 0o500);                                    // cp -a into it fails
    const result = run(root, ram);
    assert.ok(!existsSync(target), 'the half-copied folder is removed');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /copying \.cache\/coverage into .* failed .*it stays on disk/);
    assert.ok(!isLink(join(root, '.cache/coverage')));
    assert.equal(readFileSync(join(root, '.cache/coverage/a'), 'utf8'), '1');
    assert.ok(isLink(join(root, '.cache/codeql')));
  });

  it('points a link to another folder at the tree\'s own', () => {
    const { root, ram } = plant();
    const tree = run(root, ram).stdout.trim();
    rmSync(join(root, '.cache/audit'));
    const other = join(base, `other-${n}`);
    mkdirSync(other);
    symlinkSync(other, join(root, '.cache/audit'));
    assert.equal(run(root, ram).status, 0);
    assert.equal(readlinkSync(join(root, '.cache/audit')), join(tree, '.cache_audit'));
  });

  it('keeps the caches on disk when the RAM folder cannot be written', () => {
    const { root, ram } = plant({ '.cache/coverage/a': '1' });
    writeFileSync(join(ram, 'file'), '');
    const result = run(root, join(ram, 'file'));   // a folder under a file cannot be made
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /the caches stay on disk/);
    assert.ok(!isLink(join(root, '.cache/coverage')));
    assert.equal(readFileSync(join(root, '.cache/coverage/a'), 'utf8'), '1');
  });

  it('gives two trees of the same folder name their own RAM folders', () => {
    const a = plant();
    const b = plant();
    const treeA = run(a.root, a.ram).stdout.trim();
    const treeB = run(b.root, a.ram).stdout.trim();   // same RAM folder, both roots named "repo"
    assert.notEqual(treeA, treeB);
  });

  it('--run-tmp makes the run\'s TMPDIR and removes only the folders of runs no longer alive', () => {
    const { root, ram } = plant();
    run(root, ram);                                         // makes the private t/
    const runs = join(ram, 't');
    const dead = join(runs, '999999999');                   // no such pid
    mkdirSync(join(dead, 'ro', 'deep'), { recursive: true });
    writeFileSync(join(dead, 'ro', 'deep', 'f'), 'x');
    chmodSync(join(dead, 'ro'), 0o500);                     // a test left it read-only
    const alive = join(runs, String(process.pid));
    mkdirSync(alive);
    mkdirSync(join(runs, 't12x'));                          // not a run's folder
    const outside = join(base, `outside-${n}`);
    mkdirSync(join(outside, 'keep'), { recursive: true });
    symlinkSync(outside, join(runs, '888888888'));          // a link: never followed
    const result = spawnSync('/bin/bash', [SCRIPT, '--run-tmp', ram, '4242'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), join(runs, '4242'));
    assert.ok(lstatSync(join(runs, '4242')).isDirectory());
    assert.ok(!existsSync(dead), 'a dead run\'s folder goes, read-only parts too');
    assert.ok(existsSync(alive), 'a live run\'s folder stays');
    assert.ok(existsSync(join(runs, 't12x')));
    assert.ok(existsSync(join(outside, 'keep')), 'nothing behind a link is touched');
  });

  it('--run-tmp refuses a runs folder others could open; --remove empties read-only folders', () => {
    const { ram } = plant();
    mkdirSync(join(ram, 't'), { mode: 0o755 });
    chmodSync(join(ram, 't'), 0o755);
    const refused = spawnSync('/bin/bash', [SCRIPT, '--run-tmp', ram, '1'], { encoding: 'utf8' });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /not a folder only this user can open/);
    const tmp = join(base, `rm-${n}`, 'ro');
    mkdirSync(join(tmp, 'x'), { recursive: true });
    writeFileSync(join(tmp, 'x', 'f'), '1');
    chmodSync(join(tmp, 'x'), 0o500);
    assert.equal(spawnSync('/bin/bash', [SCRIPT, '--remove', tmp]).status, 0);
    assert.ok(!existsSync(tmp));
  });

  it('leaves a cache path that is a file on disk and says so', () => {
    const { root, ram } = plant({ '.cache/audit': 'not a folder' });
    const result = run(root, ram);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /\.cache\/audit is not a folder/);
    assert.equal(readFileSync(join(root, '.cache/audit'), 'utf8'), 'not a folder');
  });
});
