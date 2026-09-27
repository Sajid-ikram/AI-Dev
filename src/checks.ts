import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { Limits } from './config.ts';
import { dockerRunArgs } from './docker.ts';
import { exec } from './exec.ts';

const CHECKS_TIMEOUT_MINUTES = 30;

export interface CheckResult {
  command: string;
  /** null when the check didn't finish, because the container was stopped. */
  exitCode: number | null;
  output: string;
}

export interface ChecksOutcome {
  passed: boolean;
  /** One entry per check that ran. They stop at the first failure. */
  results: CheckResult[];
  stopped?: 'timeout';
}

/**
 * Runs the project's checks, in order, in one sandbox container over `dir`, so state such as
 * downloaded packages carries from one check to the next. No credentials go in: the checks
 * run code the agent wrote.
 */
export async function runChecks(opts: {
  jobKey: string;
  image: string;
  dir: string;
  checks: string[];
  limits: Limits;
  logFile: string;
}): Promise<ChecksOutcome> {
  if (opts.checks.length === 0) return { passed: true, results: [] };
  const marker = `@@aidev-${randomUUID()}`;
  const name = `aidev-${opts.jobKey.toLowerCase()}-checks-${Date.now().toString(36)}`;
  const args = dockerRunArgs({
    name,
    image: opts.image,
    mounts: [{ source: opts.dir, target: '/work' }],
    env: [],
    limits: opts.limits,
    labels: { 'aidev.job': opts.jobKey, 'aidev.role': 'checks' },
    command: ['sh', '-s'],
  });

  let stopped: 'timeout' | undefined;
  const timer = setTimeout(() => {
    stopped = 'timeout';
    exec('docker', ['kill', name], { allowFail: true }).catch(() => {});
  }, CHECKS_TIMEOUT_MINUTES * 60_000);
  let res;
  try {
    res = await exec('docker', args, { input: checksScript(opts.checks, marker), allowFail: true });
  } finally {
    clearTimeout(timer);
  }
  fs.writeFileSync(opts.logFile, res.stdout + (res.stderr.trim() ? `\n--- stderr\n${res.stderr}` : ''));

  const results = parseChecksOutput(res.stdout, marker, opts.checks);
  const passed = !stopped && results.length === opts.checks.length && results.every((r) => r.exitCode === 0);
  return { passed, results, stopped };
}

/**
 * A shell script that runs each check from /work between marker lines and stops at the first
 * failure. Each check's stdin is /dev/null, so a check can't swallow the rest of this script.
 */
export function checksScript(checks: string[], marker: string): string {
  const lines = ['cd /work || exit 97'];
  checks.forEach((check, i) => {
    lines.push(`echo "${marker} start ${i}"`, '(', check, ') < /dev/null 2>&1', 'code=$?', `echo "${marker} exit ${i} $code"`, '[ "$code" -eq 0 ] || exit 0');
  });
  return `${lines.join('\n')}\n`;
}

export function parseChecksOutput(stdout: string, marker: string, checks: string[]): CheckResult[] {
  const results: CheckResult[] = [];
  let current: { index: number; lines: string[] } | undefined;
  for (const line of stdout.split('\n')) {
    if (line.startsWith(`${marker} `)) {
      const [, kind, index, code] = line.split(' ');
      if (kind === 'start') {
        current = { index: Number(index), lines: [] };
      } else if (kind === 'exit' && current) {
        results.push({ command: checks[current.index], exitCode: Number(code), output: current.lines.join('\n').trimEnd() });
        current = undefined;
      }
    } else {
      current?.lines.push(line);
    }
  }
  if (current) results.push({ command: checks[current.index], exitCode: null, output: current.lines.join('\n').trimEnd() });
  return results;
}
