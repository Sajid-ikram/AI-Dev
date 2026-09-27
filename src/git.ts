import fs from 'node:fs';
import path from 'node:path';
import { WORKSPACE, gitIdentity, requireEnv, type ProjectConfig } from './config.ts';
import { exec, type ExecOptions } from './exec.ts';

export function git(args: string[], opts: ExecOptions = {}) {
  return exec('git', args, opts);
}

/**
 * Environment for git commands that talk to the remote. The token goes in an HTTP header set
 * through the environment, so it never lands in a repo's config, the command line or an error.
 */
function remoteEnv(project: ProjectConfig): NodeJS.ProcessEnv {
  // An empty credential.helper stops Git Credential Manager from popping up a login window.
  const config: [string, string][] = [['credential.helper', '']];
  if (project.repo.auth === 'bitbucket') {
    const token = requireEnv('BITBUCKET_TOKEN', `to clone ${project.repo.url}`);
    const basic = Buffer.from(`x-token-auth:${token}`).toString('base64');
    config.push(['http.extraHeader', `Authorization: Basic ${basic}`]);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_CONFIG_COUNT: String(config.length),
  };
  config.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/** Keeps a bare mirror of the project's repo in workspace/mirrors, so job clones don't hit the network. */
export async function syncMirror(project: ProjectConfig): Promise<string> {
  const mirror = path.join(WORKSPACE, 'mirrors', `${project.name}.git`);
  const env = remoteEnv(project);
  if (fs.existsSync(mirror)) {
    await git(['--git-dir', mirror, 'remote', 'set-url', 'origin', project.repo.url]);
    await git(['--git-dir', mirror, 'fetch', '--prune', '--quiet', 'origin'], { env });
  } else {
    fs.mkdirSync(path.dirname(mirror), { recursive: true });
    await git(['clone', '--mirror', '--quiet', project.repo.url, mirror], { env });
  }
  return mirror;
}

/**
 * Clones the mirror into the job's work folder on a new branch and returns the base commit.
 * Line-ending conversion is off: host git defaults to CRLF on Windows, but the agent works in Linux.
 */
export async function prepareWorkClone(opts: {
  mirror: string;
  work: string;
  project: ProjectConfig;
  branch: string;
  key: string;
}): Promise<string> {
  const { mirror, work, project, branch, key } = opts;
  await git(['clone', '--quiet', '-c', 'core.autocrlf=false', '--branch', project.repo.baseBranch, mirror, work]);
  await git(['remote', 'set-url', 'origin', project.repo.url], { cwd: work });
  const identity = gitIdentity();
  await git(['config', 'user.name', identity.name], { cwd: work });
  await git(['config', 'user.email', identity.email], { cwd: work });
  await git(['checkout', '--quiet', '-b', branch], { cwd: work });
  installCommitMsgHook(work, key);
  return (await git(['rev-parse', 'HEAD'], { cwd: work })).stdout.trim();
}

/** Rejects commits whose message doesn't start with the issue key, so Jira links every commit. */
function installCommitMsgHook(work: string, key: string): void {
  const hook = [
    '#!/bin/sh',
    '# Installed by aidev: every commit message must start with the Jira issue key.',
    `if ! head -n 1 "$1" | grep -Eq '^${key}([^0-9]|$)'; then`,
    `  echo "aidev: commit messages must start with ${key}, for example '${key}: Fix the login redirect'" >&2`,
    '  exit 1',
    'fi',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(work, '.git', 'hooks', 'commit-msg'), hook, { mode: 0o755 });
}

export interface WorkSummary {
  headSha: string;
  /** "<short sha> <subject>" for each commit on the branch, newest first. */
  commits: string[];
  /** Commit subjects that don't start with the issue key. */
  badMessages: string[];
  /** `git status --porcelain` output; empty when the tree is clean. */
  status: string;
  diff: string;
  uncommittedDiff: string;
}

export async function summarizeWork(work: string, baseSha: string, key: string): Promise<WorkSummary> {
  const run = async (args: string[]) => (await git(args, { cwd: work })).stdout;
  const commits = (await run(['log', '--format=%h %s', `${baseSha}..HEAD`])).split('\n').filter(Boolean);
  const keyPrefix = new RegExp(`^${key}([^0-9]|$)`);
  const status = (await run(['status', '--porcelain'])).trimEnd();
  return {
    headSha: (await run(['rev-parse', 'HEAD'])).trim(),
    commits,
    badMessages: commits.map((c) => c.slice(c.indexOf(' ') + 1)).filter((subject) => !keyPrefix.test(subject)),
    status,
    diff: await run(['diff', baseSha, 'HEAD']),
    uncommittedDiff: status ? await run(['diff', 'HEAD']) : '',
  };
}

export function branchName(key: string, summary: string): string {
  const slug = slugify(summary);
  return slug ? `ai/${key}-${slug}` : `ai/${key}`;
}

export function slugify(text: string, maxLength = 40): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= maxLength) return slug;
  const cut = slug.slice(0, maxLength + 1);
  const lastDash = cut.lastIndexOf('-');
  return (lastDash > maxLength / 2 ? cut.slice(0, lastDash) : slug.slice(0, maxLength)).replace(/-+$/, '');
}
