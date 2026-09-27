import fs from 'node:fs';
import path from 'node:path';
import { WORKSPACE, jobPaths, listProjects, type ProjectConfig } from './config.ts';
import { interruptRequested } from './interrupt.ts';
import { searchIssues } from './jira.ts';
import { FINISHED, tryReadJob, type JobRecord } from './job.ts';
import { isAlive, resumeTicket, runTicket } from './pipeline.ts';
import { dim, step, warn } from './ui.ts';

const LOCK_FILE = path.join(WORKSPACE, 'watch.lock');
/** A ticket whose job threw is left alone this long before another try. */
const COOLDOWN_MS = 15 * 60_000;

export interface WatchOptions {
  intervalSeconds: number;
  /** Look once, do at most one job, then exit. */
  once: boolean;
}

type Work = { kind: 'resume'; key: string; why: string } | { kind: 'start'; key: string; project: ProjectConfig; why: string };

interface WatchState {
  /** Tickets already warned about, so each warning shows once. */
  warned: Set<string>;
  /** Tickets whose job threw, and until when to leave them alone. */
  cooldown: Map<string, number>;
}

/**
 * `aidev watch`: polls Jira for tickets in each project's pick-up status and works through them,
 * one at a time. Paused jobs continue once their usage limit resets, and jobs a crash or restart
 * cut off continue where they stopped.
 */
export async function watch(opts: WatchOptions): Promise<number> {
  const projects = listProjects().filter((p) => p.jiraProject && p.jiraStatus.pickUp);
  if (projects.length === 0) {
    throw new Error('No project config sets both jiraProject and jiraStatus.pickUp, so there are no tickets to watch for.');
  }
  acquireLock();
  try {
    const queues = projects.map((p) => `${p.jiraProject} "${p.jiraStatus.pickUp}"`).join(', ');
    console.log(`Watching ${queues}, every ${opts.intervalSeconds} s. Press Ctrl+C to stop.`);
    const state: WatchState = { warned: new Set(), cooldown: new Map() };
    let idleSaid = false;
    while (!interruptRequested()) {
      let next: Work | undefined;
      try {
        next = await findWork(projects, state);
      } catch (err) {
        warn(`${clock()} Couldn't check for work: ${(err as Error).message}`);
      }
      if (next) {
        idleSaid = false;
        step(`${clock()} ${next.kind === 'resume' ? 'Continuing' : 'Starting'} ${next.key} (${next.why})`);
        try {
          if (next.kind === 'resume') await resumeTicket(next.key);
          else await runTicket({ key: next.key, project: next.project.file, fresh: true, local: false });
        } catch (err) {
          warn(`${next.key} stopped with an error: ${(err as Error).message}`);
          state.cooldown.set(next.key, Date.now() + COOLDOWN_MS);
        }
        if (opts.once) break;
        continue;
      }
      if (opts.once) break;
      if (!idleSaid) console.log(dim(`${clock()} Nothing to do. Checking every ${opts.intervalSeconds} s.`));
      idleSaid = true;
      await sleep(opts.intervalSeconds * 1000);
    }
  } finally {
    releaseLock();
  }
  return 0;
}

async function findWork(projects: ProjectConfig[], state: WatchState): Promise<Work | undefined> {
  const now = Date.now();
  const jobs = readAllJobs();

  // First, jobs that stopped partway: cut off by a crash or restart, or paused and now due.
  for (const job of jobs) {
    if (job.outcome === 'running' && !(job.pid && isAlive(job.pid))) return { kind: 'resume', key: job.key, why: 'aidev stopped while it was running' };
    if (job.outcome === 'paused' && Date.parse(job.pausedUntil ?? '') <= now) return { kind: 'resume', key: job.key, why: `paused by ${job.reason ?? 'something'}` };
  }

  // While a usage limit is in force, anything new would hit it too.
  const limited = jobs.find((j) => j.outcome === 'paused' && j.reason === 'a usage limit');
  if (limited) {
    const note = `limit:${limited.pausedUntil}`;
    if (!state.warned.has(note)) {
      state.warned.add(note);
      console.log(dim(`${clock()} Waiting for the usage limit to reset (${new Date(limited.pausedUntil!).toLocaleString()}) before starting anything new.`));
    }
    return undefined;
  }

  for (const project of projects) {
    const pickUp = project.jiraStatus.pickUp!;
    const issues = await searchIssues(`project = "${project.jiraProject}" AND status = "${pickUp}" ORDER BY priority DESC, created ASC`);
    for (const issue of issues) {
      if ((state.cooldown.get(issue.key) ?? 0) > now) continue;
      const job = tryReadJob(jobPaths(issue.key).meta);
      const decision = decide(job);
      if (decision === 'start') return { kind: 'start', key: issue.key, project, why: job ? `moved back to "${pickUp}"` : 'new ticket' };
      if (decision === 'stuck-in-queue' && !state.warned.has(issue.key)) {
        state.warned.add(issue.key);
        warn(
          `${issue.key} is in "${pickUp}", but aidev already finished it (${job?.outcome ?? 'an older run'}) and didn't move it out, ` +
            `so it can't tell whether you want another try. Move it out and back, or run: aidev run ${issue.key} --fresh`,
        );
      }
    }
  }
  return undefined;
}

/** What to do with a ticket found in the pick-up status, given its job, if any. */
export function decide(job: JobRecord | undefined): 'start' | 'skip' | 'stuck-in-queue' {
  if (!job) return 'start';
  // Continued by the resume step, once it's due.
  if (job.outcome === 'running' || job.outcome === 'paused') return 'skip';
  // aidev moved it out when it finished, so a person has moved it back: another try.
  if (FINISHED.includes(job.outcome) && job.leftPickUp) return 'start';
  return 'stuck-in-queue';
}

function readAllJobs(): JobRecord[] {
  const dir = path.join(WORKSPACE, 'jobs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((key) => {
    try {
      const job = tryReadJob(jobPaths(key).meta);
      return job ? [job] : [];
    } catch {
      return [];
    }
  });
}

function acquireLock(): void {
  fs.mkdirSync(WORKSPACE, { recursive: true });
  if (fs.existsSync(LOCK_FILE)) {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (pid && pid !== process.pid && isAlive(pid)) throw new Error(`aidev watch is already running, in process ${pid}.`);
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
}

function releaseLock(): void {
  fs.rmSync(LOCK_FILE, { force: true });
}

/** Waits, but wakes up early for Ctrl+C. */
async function sleep(ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until && !interruptRequested()) {
    await new Promise((r) => setTimeout(r, Math.min(1000, until - Date.now())));
  }
}

function clock(): string {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
