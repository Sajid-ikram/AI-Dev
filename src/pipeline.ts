import fs from 'node:fs';
import path from 'node:path';
import { runAgent, type AgentResult } from './agent.ts';
import { ROOT, assertIssueKey, assertProjectReady, claudeAuthVar, findProject, jobPaths, type JobPaths } from './config.ts';
import { assertDocker, imageExists } from './docker.ts';
import { branchName, git, prepareWorkClone, summarizeWork, syncMirror, type WorkSummary } from './git.ts';
import { fetchTicket, readTicketFile } from './jira.ts';
import { workerPrompt } from './prompts.ts';
import { dim, formatDuration, indent, step, warn } from './ui.ts';

export interface RunOptions {
  key: string;
  /** Project name, or a path to a project .yaml file. */
  project?: string;
  /** Read the ticket from this Markdown file instead of Jira. */
  ticketFile?: string;
  /** Delete the job folder from an earlier run first. */
  fresh: boolean;
}

/** Longer diffs are only saved to diff.patch, not printed. */
const MAX_PRINTED_DIFF_LINES = 400;

/** ticket → clone → worker in a container → show the diff. Resolves to the process exit code. */
export async function runTicket(opts: RunOptions): Promise<number> {
  const { key } = opts;
  assertIssueKey(key);
  const project = findProject(key, opts.project);
  assertProjectReady(project);
  const authVar = claudeAuthVar();
  await assertDocker();
  if (!(await imageExists(project.image))) {
    throw new Error(`The Docker image ${project.image} doesn't exist yet. Build it with: aidev build ${project.image.replace(/^aidev-/, '')}`);
  }
  const job = jobPaths(key);
  if (fs.existsSync(job.dir) && !opts.fresh) {
    throw new Error(`${path.relative(ROOT, job.dir)} exists from an earlier run. Pass --fresh to delete it and start over.`);
  }

  step('Ticket');
  const ticket = opts.ticketFile ? readTicketFile(opts.ticketFile, key) : await fetchTicket(key);
  console.log(`${ticket.key} (${ticket.type}): ${ticket.summary}`);

  fs.rmSync(job.dir, { recursive: true, force: true, maxRetries: 3 });
  fs.mkdirSync(job.claude, { recursive: true });
  writeJson(job.ticket, ticket);

  step(`Repository: ${project.name}`);
  const mirror = await syncMirror(project);
  const branch = branchName(key, ticket.summary);
  const baseSha = await prepareWorkClone({ mirror, work: job.work, project, branch, key });
  console.log(`Branch ${branch}, from ${project.repo.baseBranch} at ${baseSha.slice(0, 10)}`);

  const prompt = workerPrompt(ticket, project, branch);
  fs.writeFileSync(job.workerPrompt, prompt);

  step(`Worker: ${project.worker.model} in ${project.image}`);
  const startedAt = new Date();
  const result = await runAgent({
    role: 'worker',
    jobKey: key,
    image: project.image,
    work: job.work,
    claudeDir: job.claude,
    eventsFile: job.events,
    logFile: job.workerLog,
    prompt,
    config: project.worker,
    limits: project.limits,
    authVar,
  });
  const finishedAt = new Date();

  const work = await summarizeWork(job.work, baseSha, key);
  fs.writeFileSync(job.diff, work.diff);
  if (work.uncommittedDiff) fs.writeFileSync(job.uncommitted, work.uncommittedDiff);
  if (result.text) fs.writeFileSync(job.workerResult, `${result.text}\n`);
  const { text: _, ...worker } = result;
  writeJson(job.meta, {
    key,
    project: project.name,
    branch,
    baseBranch: project.repo.baseBranch,
    baseSha,
    headSha: work.headSha,
    commits: work.commits,
    startedAt,
    finishedAt,
    worker,
  });

  await showResult({ key, branch, baseSha, job, result, work, elapsedMs: finishedAt.getTime() - startedAt.getTime() });
  return !result.isError && !result.stopped && !isBlocked(result) && work.commits.length > 0 ? 0 : 1;
}

/** The worker prompt asks it to start its final message with BLOCKED: when it can't go on. */
function isBlocked(result: AgentResult): boolean {
  return result.text?.trimStart().startsWith('BLOCKED:') ?? false;
}

async function showResult(r: {
  key: string;
  branch: string;
  baseSha: string;
  job: JobPaths;
  result: AgentResult;
  work: WorkSummary;
  elapsedMs: number;
}): Promise<void> {
  const { result, work } = r;
  step('Result');
  const facts = [
    result.stopped
      ? `stopped (${result.stopped})`
      : result.error
        ? `failed (${result.error})`
        : isBlocked(result)
          ? 'blocked, needs an answer'
          : (result.subtype ?? `no result, exit code ${result.exitCode}`),
  ];
  if (result.numTurns !== undefined) facts.push(`${result.numTurns} turns`);
  facts.push(formatDuration(r.elapsedMs));
  if (result.costUsd !== undefined) facts.push(`est. $${result.costUsd.toFixed(2)}`);
  console.log(`Worker: ${facts.join(', ')}`);

  if (work.commits.length) {
    console.log(`\nCommits on ${r.branch}:`);
    console.log(indent(work.commits.join('\n')));
  } else if (!isBlocked(result)) {
    warn('The worker made no commits.');
  }
  if (work.badMessages.length) warn(`These commit messages don't start with ${r.key}:\n${indent(work.badMessages.join('\n'))}`);
  if (work.status) warn(`The worker left uncommitted changes (saved to uncommitted.patch):\n${indent(work.status)}`);

  if (work.diff) {
    console.log('');
    await git(['--no-pager', 'diff', '--stat', r.baseSha, 'HEAD'], { cwd: r.job.work, inherit: true });
    const lines = work.diff.split('\n').length;
    if (lines <= MAX_PRINTED_DIFF_LINES) {
      console.log('');
      await git(['--no-pager', 'diff', r.baseSha, 'HEAD'], { cwd: r.job.work, inherit: true });
    } else {
      console.log(dim(`\nThe diff is ${lines} lines long, so it's only saved to diff.patch.`));
    }
  }

  if (result.text) console.log(`\nWorker's summary:\n${indent(result.text)}`);
  console.log(dim(`\nSaved in ${path.relative(ROOT, r.job.dir)}: diff.patch, events.jsonl, worker-prompt.md, job.json, and the clone in work/.`));
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
