#!/usr/bin/env node
// npm run images:build -- <language> <tag> [--push] [--dry-run]   (from the repository root or voc-datalake/)
//
// Builds one engineering agent image (voc-datalake/templates/orchestration/images/<language>/Dockerfile, 7.56.00) with
// the command docs/deployment.md documents ("engineeringImages"): `docker buildx build --platform linux/arm64` from
// voc-datalake/, the build context every Dockerfile's COPY lines are written for.
//
// - Without --push: a LOCAL image only, `voc-eng-<language>:<tag>`, loaded into Docker (`--load`). No AWS call.
// - With --push: the account is the caller's (`aws sts get-caller-identity` under AWS_PROFILE, which must be set), the
//   repository the processing stack's output `EngineeringImageRepository<Language>` (PROCESSING_STACK, default
//   VocProcessingStack; `<prefix>-VocProcessingStack` on a prefixed deployment). A repository of another account is
//   refused. Docker logs in to the registry (the password goes on docker's stdin, never in an argv), the image is built
//   and pushed as `<repository>:<tag>`, and the pushed digest is printed, for `-c engineeringImages`.
// - --dry-run prints the commands and runs none.
//
// The build arguments default to the ones every image so far was built with; an environment variable of the same name
// overrides each. Tags are immutable in the stack's repositories, so `latest` is refused: give each build a new tag.
// Exit 0: built (and pushed); 1: a command failed; 2: the arguments or the environment are wrong.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LANGUAGES = ['java', 'node', 'python', 'rust'];
const BUILD_ARGS = {
  MOUNTPOINT_VERSION: '1.25.0',
  MOUNTPOINT_SHA256: '213db1c79ee03e4d83d213632e3de3b0c59cf5ad8f67869ef6347a722a03fba0',
  BOTO3_VERSION: '1.43.124',
};
const BUILD_ARG_SHAPES = {
  MOUNTPOINT_VERSION: /^\d+\.\d+\.\d+$/,
  MOUNTPOINT_SHA256: /^[0-9a-f]{64}$/,
  BOTO3_VERSION: /^\d+\.\d+\.\d+$/,
};
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const REPOSITORY_URI = /^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?\/([a-z0-9][a-z0-9._/-]{1,255})$/;
const USAGE = 'usage: npm run images:build -- <java|node|python|rust> <tag> [--push] [--dry-run]';
/** voc-datalake/: the build context (this file is voc-datalake/scripts/images-build.mjs). */
const CONTEXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class Refused extends Error {
  /** @param {string} message @param {number} code */
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** @param {string} word */
const capitalized = (word) => word.charAt(0).toUpperCase() + word.slice(1);

/** @param {string[]} argv the arguments after the script's name */
function parseArgs(argv) {
  const flags = new Set(argv.filter((word) => word.startsWith('--')));
  const words = argv.filter((word) => !word.startsWith('--'));
  const unknown = [...flags].filter((flag) => flag !== '--push' && flag !== '--dry-run');
  if (unknown.length > 0) throw new Refused(`unknown option ${unknown[0]}\n${USAGE}`, 2);
  const [language, tag, ...rest] = words;
  if (language === undefined || tag === undefined || rest.length > 0) throw new Refused(USAGE, 2);
  if (!LANGUAGES.includes(language)) throw new Refused(`no image for ${language}: one of ${LANGUAGES.join(', ')}`, 2);
  if (!TAG.test(tag) || tag === 'latest') {
    throw new Refused(`the tag ${tag} is not a new image tag (letters, digits, "_", "." and "-", never latest)`, 2);
  }
  return { language, tag, push: flags.has('--push'), dryRun: flags.has('--dry-run') };
}

/** @param {NodeJS.ProcessEnv} env */
function buildArgs(env) {
  return Object.entries(BUILD_ARGS).map(([name, fallback]) => {
    const value = env[name] || fallback;
    if (!BUILD_ARG_SHAPES[/** @type {keyof typeof BUILD_ARGS} */ (name)].test(value)) {
      throw new Refused(`${name}=${value} is not the shape it takes`, 2);
    }
    return ['--build-arg', `${name}=${value}`];
  }).flat();
}

/** @param {string} language @param {string} ref @param {boolean} push @param {string[]} args */
function buildCommand(language, ref, push, args) {
  return ['docker', 'buildx', 'build', '--platform', 'linux/arm64',
    '-f', `templates/orchestration/images/${language}/Dockerfile`, ...args, '-t', ref, push ? '--push' : '--load', '.'];
}

/**
 * Runs `argv` from voc-datalake/, no shell. `capture`: its stdout is answered (else it goes to the terminal).
 * @param {string[]} argv @param {{ capture?: boolean, input?: string }} [options]
 */
function run(argv, options = {}) {
  const [command, ...args] = argv;
  const done = spawnSync(String(command), args, {
    cwd: CONTEXT, encoding: 'utf8', input: options.input,
    stdio: [options.input === undefined ? 'inherit' : 'pipe', options.capture ? 'pipe' : 'inherit', 'inherit'],
  });
  if (done.error) throw new Refused(`${command} did not run (${done.error.message})`, 1);
  if (done.status !== 0) throw new Refused(`${argv.slice(0, 3).join(' ')} exited ${done.status}`, 1);
  return String(done.stdout ?? '').trim();
}

/** @param {string} text @param {string} what */
function json(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Refused(`${what} answered no JSON`, 1);
  }
}

/** The repository the stack's output names for `language`, held to the caller's account. @param {string} language */
function repository(language) {
  const account = String(json(run(['aws', 'sts', 'get-caller-identity', '--output', 'json'], { capture: true }),
    'aws sts get-caller-identity').Account ?? '');
  const stack = process.env.PROCESSING_STACK || 'VocProcessingStack';
  const key = `EngineeringImageRepository${capitalized(language)}`;
  const outputs = json(run(['aws', 'cloudformation', 'describe-stacks', '--stack-name', stack,
    '--query', 'Stacks[0].Outputs', '--output', 'json'], { capture: true }), 'aws cloudformation describe-stacks');
  const found = Array.isArray(outputs) ? outputs.find((output) => output?.OutputKey === key) : undefined;
  if (found === undefined) {
    throw new Refused(`${stack} has no output ${key}: deploy it with -c engineeringAgents=true (7.56.00 or later), or set `
      + 'PROCESSING_STACK=<prefix>-VocProcessingStack', 2);
  }
  const uri = REPOSITORY_URI.exec(String(found.OutputValue));
  if (uri === null) throw new Refused(`${key} is not an ECR repository URI: ${String(found.OutputValue)}`, 2);
  const [, owner, region, name] = uri;
  if (owner !== account) {
    throw new Refused(`${key} is a repository of account ${owner}, and AWS_PROFILE is account ${account}: refused`, 2);
  }
  return { uri: uri[0], registry: uri[0].slice(0, uri[0].indexOf('/')), region: String(region), name: String(name) };
}

/** @param {{ language: string, tag: string }} wanted @param {string[]} args */
function push(wanted, args) {
  if (!process.env.AWS_PROFILE) throw new Refused('--push takes the account from AWS_PROFILE: set it', 2);
  const target = repository(wanted.language);
  const password = run(['aws', 'ecr', 'get-login-password', '--region', target.region], { capture: true });
  run(['docker', 'login', '--username', 'AWS', '--password-stdin', target.registry], { input: password });
  run(buildCommand(wanted.language, `${target.uri}:${wanted.tag}`, true, args));
  const digest = run(['aws', 'ecr', 'describe-images', '--region', target.region, '--repository-name', target.name,
    '--image-ids', `imageTag=${wanted.tag}`, '--query', 'imageDetails[0].imageDigest', '--output', 'text'],
  { capture: true });
  console.log(`pushed ${target.uri}:${wanted.tag} ${digest}`);
}

/** @param {{ language: string, tag: string, push: boolean }} wanted @param {string[]} args */
function dryRun(wanted, args) {
  const key = `EngineeringImageRepository${capitalized(wanted.language)}`;
  const commands = wanted.push
    ? [['aws', 'sts', 'get-caller-identity'],
      ['aws', 'cloudformation', 'describe-stacks', '--stack-name', process.env.PROCESSING_STACK || 'VocProcessingStack'],
      ['aws', 'ecr', 'get-login-password'], ['docker', 'login', '--username', 'AWS', '--password-stdin', `<${key}'s registry>`],
      buildCommand(wanted.language, `<${key}>:${wanted.tag}`, true, args), ['aws', 'ecr', 'describe-images']]
    : [buildCommand(wanted.language, `voc-eng-${wanted.language}:${wanted.tag}`, false, args)];
  for (const command of commands) console.log(command.join(' '));
}

/** @param {string[]} argv */
function main(argv) {
  const wanted = parseArgs(argv);
  const args = buildArgs(process.env);
  if (wanted.dryRun) return dryRun(wanted, args);
  if (wanted.push) return push(wanted, args);
  run(buildCommand(wanted.language, `voc-eng-${wanted.language}:${wanted.tag}`, false, args));
  console.log(`built voc-eng-${wanted.language}:${wanted.tag} (local only: nothing was pushed)`);
  return undefined;
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof Refused)) throw error;
  console.error(`images:build: ${error.message}`);
  process.exitCode = error.code;
}
