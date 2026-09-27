import fs from 'node:fs';
import path from 'node:path';
import { PROMPTS_DIR, type ProjectConfig } from './config.ts';
import type { Ticket } from './jira.ts';
import { isBug } from './review.ts';

/** Fills {{name}} placeholders. Values are inserted as-is, so ticket text can't inject placeholders. */
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    if (!Object.hasOwn(values, name)) throw new Error(`The prompt template uses {{${name}}}, which has no value.`);
    return values[name];
  });
}

function render(name: string, values: Record<string, string>): string {
  return renderTemplate(fs.readFileSync(path.join(PROMPTS_DIR, name), 'utf8'), values);
}

function ticketValues(ticket: Ticket): Record<string, string> {
  return {
    key: ticket.key,
    summary: ticket.summary,
    type: ticket.type,
    labels: ticket.labels.join(', ') || 'none',
    url: ticket.url ?? 'n/a',
    description: ticket.description,
    comments: ticket.comments.length
      ? ticket.comments.map((c) => `**${c.author}** (${c.created}):\n${c.body}`).join('\n\n')
      : '(no comments)',
  };
}

function checksList(project: ProjectConfig): string {
  return project.checks.length
    ? project.checks.map((c) => `   - \`${c}\``).join('\n')
    : '   - (This project has no configured checks. Run whatever tests the repository has.)';
}

export function workerPrompt(ticket: Ticket, project: ProjectConfig, branch: string): string {
  return render('worker.md', {
    ...ticketValues(ticket),
    branch,
    baseBranch: project.repo.baseBranch,
    checks: checksList(project),
  });
}

/** The prompt for a later round, sent to the worker's resumed session. */
export function workerFixPrompt(ticket: Ticket, feedback: string, round: number, maxRounds: number): string {
  return render('worker-fix.md', { key: ticket.key, feedback, round: String(round), maxRounds: String(maxRounds) });
}

export function reviewerPrompt(
  ticket: Ticket,
  project: ProjectConfig,
  change: { branch: string; baseSha: string; headSha: string },
): string {
  const reproduction = isBug(ticket)
    ? 'This ticket is a bug, so the change must include a test that reproduces it. Prove it: put the non-test files back to the base version ' +
      `(\`git checkout ${change.baseSha} -- <files>\`), run the test and confirm it fails. Then restore them (\`git checkout HEAD -- .\`) ` +
      'and confirm it passes. Report the test, both results and the commands you ran under `reproduction`. Without that proof, the change is blocked.'
    : "This ticket isn't a bug, so no reproduction test is needed. Leave `reproduction` out.";
  return render('reviewer.md', {
    ...ticketValues(ticket),
    ...change,
    checks: checksList(project),
    reproduction,
  });
}
