import fs from 'node:fs';
import { bitbucketRepo, openPullRequest } from './bitbucket.ts';
import { assertIssueKey, jobPaths, readProject, type ProjectConfig } from './config.ts';
import { pushBranch } from './git.ts';
import { addComment, type Ticket } from './jira.ts';
import { readJob, writeJob, type JobRecord } from './job.ts';
import { formatIssues } from './review.ts';
import { dim, ok, step, warn } from './ui.ts';

/** Pushes the approved commit, opens the pull request (or finds the open one) and tells Jira. */
export async function publish(job: JobRecord, project: ProjectConfig, ticket: Ticket, work: string): Promise<void> {
  if (!job.approvedSha) throw new Error(`${job.key} has no approved commit to publish.`);
  step('Pull request');
  await pushBranch(project, work, job.approvedSha, job.branch);
  ok(`Pushed ${job.branch} at ${job.approvedSha.slice(0, 10)}`);

  const repo = bitbucketRepo(project.repo.url);
  if (!repo) {
    warn(`${project.repo.url} isn't a Bitbucket Cloud repository, so there's no pull request to open.`);
    return;
  }
  const pr = await openPullRequest(repo, {
    branch: job.branch,
    destination: job.baseBranch,
    title: `${ticket.key}: ${ticket.summary}`,
    description: prDescription(job, ticket),
  });
  job.pullRequest = { url: pr.url, id: pr.id };
  job.outcome = 'published';
  ok(`${pr.created ? 'Opened' : 'Updated'} pull request #${pr.id}: ${pr.url}`);

  const verdict = job.rounds.at(-1)?.review?.verdict;
  await notifyJira(
    ticket,
    [
      `aidev ${pr.created ? 'opened' : 'updated'} a pull request for this ticket: ${pr.url}`,
      verdict?.summary ?? '',
      `The checks passed, and an independent AI reviewer approved it in round ${job.rounds.length}. Please review it before merging.`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
}

/** `aidev publish <KEY>`: publishes an approved job again, for example after a network or Bitbucket failure. */
export async function publishJob(key: string): Promise<number> {
  assertIssueKey(key);
  const paths = jobPaths(key);
  if (!fs.existsSync(paths.meta)) throw new Error(`There's no job for ${key}. Start one with: aidev run ${key}`);
  const job = readJob(paths.meta);
  if (job.outcome !== 'approved' && job.outcome !== 'published') {
    throw new Error(`Only approved work gets a pull request, and ${key} ended as "${job.outcome}"${job.reason ? `: ${job.reason}` : ''}.`);
  }
  const project = readProject(job.projectFile);
  const ticket = JSON.parse(fs.readFileSync(paths.ticket, 'utf8')) as Ticket;
  try {
    await publish(job, project, ticket, paths.work);
  } finally {
    writeJob(paths.meta, job);
  }
  return 0;
}

/** Comments on the ticket, if it came from Jira. A failed comment is only a warning. */
export async function notifyJira(ticket: Ticket, text: string): Promise<void> {
  if (!ticket.url) return;
  try {
    await addComment(ticket.key, text);
    console.log(dim(`Commented on ${ticket.key} in Jira.`));
  } catch (err) {
    warn(`Couldn't comment on ${ticket.key} in Jira: ${(err as Error).message}`);
  }
}

export function prDescription(job: JobRecord, ticket: Ticket): string {
  const last = job.rounds.at(-1);
  const verdict = last?.review?.verdict;
  const title = ticket.url ? `[${ticket.key}](${ticket.url})` : ticket.key;
  const parts = [`**${title}: ${ticket.summary}**`];
  if (verdict) parts.push(verdict.summary);

  const notes = job.rounds.filter((r) => r.worker.text?.trim());
  if (notes.length) {
    parts.push("### The worker's notes");
    for (const r of notes) parts.push(notes.length > 1 ? `**Round ${r.round}:** ${r.worker.text!.trim()}` : r.worker.text!.trim());
  }

  const checks = last?.checks?.results ?? [];
  if (checks.length) parts.push('### Checks', checks.map((c) => `- \`${c.command}\` passed`).join('\n'));

  parts.push('### Review');
  const review = [`Approved by an independent AI reviewer in round ${job.rounds.length}. The reviewer didn't see the worker's reasoning.`];
  const repro = verdict?.reproduction;
  if (repro) review.push(`Reproduction test \`${repro.test}\`: fails without the fix, passes with it.`);
  parts.push(review.join(' '));
  const minor = verdict?.issues.filter((i) => i.severity === 'minor') ?? [];
  if (minor.length) parts.push(`Minor points the reviewer left open:\n\n${formatIssues(minor)}`);

  parts.push('---', '🤖 Generated with [Claude Code](https://claude.com/claude-code) by aidev. The worker and the reviewer are AI agents, so review this before merging.');
  return parts.join('\n\n');
}
