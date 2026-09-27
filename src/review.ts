import type { ChecksOutcome } from './checks.ts';
import type { Ticket } from './jira.ts';

export interface ReviewIssue {
  severity: 'blocking' | 'minor';
  file?: string;
  problem: string;
  fix?: string;
}

export interface Verdict {
  verdict: 'approve' | 'request_changes';
  summary: string;
  issues: ReviewIssue[];
  reproduction?: {
    test: string;
    failsOnBase: boolean;
    passesOnBranch: boolean;
    evidence?: string;
  };
}

/** The reviewer's final answer, enforced by Claude Code's --json-schema. */
export const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'request_changes'] },
    summary: {
      type: 'string',
      description: 'Two to four sentences for the pull request: what the change does and how you verified it.',
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocking', 'minor'] },
          file: { type: 'string', description: 'Path, with a line number if it helps.' },
          problem: { type: 'string' },
          fix: { type: 'string', description: 'What the worker should change.' },
        },
        required: ['severity', 'problem'],
        additionalProperties: false,
      },
    },
    reproduction: {
      type: 'object',
      description: 'Required when the ticket is a bug.',
      properties: {
        test: { type: 'string', description: 'The test that reproduces the bug.' },
        failsOnBase: { type: 'boolean' },
        passesOnBranch: { type: 'boolean' },
        evidence: { type: 'string', description: 'The commands you ran and what they showed.' },
      },
      required: ['test', 'failsOnBase', 'passesOnBranch'],
      additionalProperties: false,
    },
  },
  required: ['verdict', 'summary', 'issues'],
  additionalProperties: false,
};

export function parseVerdict(value: unknown): Verdict | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Partial<Verdict>;
  if ((v.verdict !== 'approve' && v.verdict !== 'request_changes') || typeof v.summary !== 'string' || !Array.isArray(v.issues)) {
    return undefined;
  }
  return v as Verdict;
}

export function isBug(ticket: Ticket): boolean {
  return /^bug$/i.test(ticket.type.trim());
}

/**
 * Decides whether a verdict lets the work through. Beyond the reviewer's own call, a bug fix
 * needs a test the reviewer saw fail on the base commit and pass on the branch.
 */
export function judge(verdict: Verdict, ticket: Ticket): { approved: boolean; problems: ReviewIssue[] } {
  const problems = verdict.issues.filter((i) => i.severity === 'blocking');
  if (isBug(ticket)) {
    const r = verdict.reproduction;
    if (!r || !r.failsOnBase || !r.passesOnBranch) {
      problems.push({
        severity: 'blocking',
        problem: r
          ? `The ticket is a bug, and the reproduction test (${r.test}) doesn't fail on the base commit and pass on this branch (fails on base: ${r.failsOnBase}, passes on branch: ${r.passesOnBranch}).`
          : "The ticket is a bug, but there's no test proven to fail on the base commit and pass on this branch.",
        fix: 'Add a test that reproduces the bug: it must fail without your fix and pass with it.',
      });
    }
  }
  // A reviewer that asks for changes without naming a blocking issue still gets its way.
  if (verdict.verdict === 'request_changes' && problems.length === 0) problems.push(...verdict.issues);
  if (verdict.verdict === 'request_changes' && problems.length === 0) {
    problems.push({ severity: 'blocking', problem: verdict.summary });
  }
  return { approved: problems.length === 0, problems };
}

export function formatIssues(issues: ReviewIssue[]): string {
  return issues
    .map((issue, i) => {
      const where = issue.file ? ` (${issue.file})` : '';
      const fix = issue.fix ? `\n   Fix: ${issue.fix}` : '';
      return `${i + 1}. [${issue.severity}]${where} ${issue.problem}${fix}`;
    })
    .join('\n');
}

/** Tells the worker what the reviewer wants changed. */
export function reviewFeedback(verdict: Verdict, problems: ReviewIssue[]): string {
  const minor = verdict.issues.filter((i) => i.severity === 'minor' && !problems.includes(i));
  let text = `An independent reviewer requested changes.\n\nReviewer's summary: ${verdict.summary}\n\nWhat to fix:\n${formatIssues(problems)}`;
  if (minor.length) text += `\n\nMinor points (fix them if they're quick):\n${formatIssues(minor)}`;
  return text;
}

/** Longest tail of a failing check's output passed back to the worker. */
const MAX_FEEDBACK_LINES = 120;

/** Tells the worker which check failed on its commit, with the end of its output. */
export function checksFeedback(outcome: ChecksOutcome, headSha: string): string {
  const failed = outcome.results.find((r) => r.exitCode !== 0);
  if (!failed) return `The project's checks didn't finish on your commit ${headSha.slice(0, 10)}: they hit the ${outcome.stopped ?? 'time'} limit.`;
  const lines = failed.output.split('\n');
  const tail = lines.slice(-MAX_FEEDBACK_LINES).join('\n');
  const how = failed.exitCode === null ? "didn't finish (it hit the time limit)" : `failed with exit code ${failed.exitCode}`;
  const head = `The project's checks failed on your commit ${headSha.slice(0, 10)}, in a fresh clone.\n\n\`${failed.command}\` ${how}.`;
  if (!failed.output.trim()) return `${head} It printed nothing.`;
  const intro = lines.length > MAX_FEEDBACK_LINES ? `The last ${MAX_FEEDBACK_LINES} lines of its output:` : 'Its output:';
  return `${head} ${intro}\n\n\`\`\`\n${tail}\n\`\`\``;
}
