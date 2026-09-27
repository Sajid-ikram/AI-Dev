import fs from 'node:fs';
import type { AgentResult } from './agent.ts';
import type { ReviewIssue, Verdict } from './review.ts';

/**
 * running → paused (a usage limit or Ctrl+C) → running again, until blocked | failed | escalated |
 * approved. Approved becomes published once the branch is pushed and the pull request is open.
 */
export type Outcome = 'running' | 'paused' | 'blocked' | 'failed' | 'escalated' | 'approved' | 'published';

/** Outcomes a job doesn't move on from by itself. */
export const FINISHED: readonly Outcome[] = ['blocked', 'failed', 'escalated', 'approved', 'published'];

/** Where a job continues: the worker step of a round, or its protected-files check, checks and review. */
export interface ResumePoint {
  round: number;
  step: 'worker' | 'verify';
}

export type AgentSummary = Omit<AgentResult, 'structuredOutput'>;

export interface RoundRecord {
  round: number;
  worker: AgentSummary;
  headSha: string;
  commits: string[];
  /** Protected files the round's commits changed, which sent the work straight back. */
  protectedFiles?: string[];
  checks?: { passed: boolean; stopped?: string; results: { command: string; exitCode: number | null }[] };
  review?: { agent: AgentSummary; verdict?: Verdict; approved: boolean; problems: ReviewIssue[] };
}

/** workspace/jobs/<KEY>/job.json: what happened, and what `aidev publish` needs. */
export interface JobRecord {
  key: string;
  project: string;
  projectFile: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  outcome: Outcome;
  reason?: string;
  /** Run with --local: no push, pull request or Jira update, even after a resume. */
  local: boolean;
  /** The process working on the job. A "running" job whose process is gone was cut off by a crash or restart. */
  pid?: number;
  startedAt: string;
  finishedAt?: string;
  rounds: RoundRecord[];
  /** Where to continue after a pause. */
  resumePoint?: ResumePoint;
  /** When a paused job may continue (ISO time). */
  pausedUntil?: string;
  /** The worker's Claude session, resumed in later rounds and after a pause. */
  session?: string;
  /** Feedback waiting for the worker's next round. */
  feedback?: string;
  /**
   * aidev moved the ticket out of the pick-up status. Finding it there again means a person
   * moved it back, which `aidev watch` takes as a request to try again.
   */
  leftPickUp?: boolean;
  /** The commit the reviewer approved; the one that gets pushed. */
  approvedSha?: string;
  pullRequest?: { url: string; id: number };
}

export function agentSummary(result: AgentResult): AgentSummary {
  const { structuredOutput: _, ...summary } = result;
  return summary;
}

export function readJob(file: string): JobRecord {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as JobRecord;
}

/** The job record, or undefined when there's none. */
export function tryReadJob(file: string): JobRecord | undefined {
  return fs.existsSync(file) ? readJob(file) : undefined;
}

export function writeJob(file: string, job: JobRecord): void {
  fs.writeFileSync(file, `${JSON.stringify(job, null, 2)}\n`);
}
