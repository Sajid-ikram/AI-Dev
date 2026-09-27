import fs from 'node:fs';
import type { AgentResult } from './agent.ts';
import type { ReviewIssue, Verdict } from './review.ts';

/**
 * running → blocked | failed | escalated | approved; approved → published once the branch is
 * pushed and the pull request is open.
 */
export type Outcome = 'running' | 'blocked' | 'failed' | 'escalated' | 'approved' | 'published';

export type AgentSummary = Omit<AgentResult, 'structuredOutput'>;

export interface RoundRecord {
  round: number;
  worker: AgentSummary;
  headSha: string;
  commits: string[];
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
  startedAt: string;
  finishedAt?: string;
  rounds: RoundRecord[];
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

export function writeJob(file: string, job: JobRecord): void {
  fs.writeFileSync(file, `${JSON.stringify(job, null, 2)}\n`);
}
