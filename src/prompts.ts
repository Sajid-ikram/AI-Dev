import fs from 'node:fs';
import path from 'node:path';
import { PROMPTS_DIR, type ProjectConfig } from './config.ts';
import type { Ticket } from './jira.ts';

/** Fills {{name}} placeholders. Values are inserted as-is, so ticket text can't inject placeholders. */
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    if (!Object.hasOwn(values, name)) throw new Error(`The prompt template uses {{${name}}}, which has no value.`);
    return values[name];
  });
}

export function workerPrompt(ticket: Ticket, project: ProjectConfig, branch: string): string {
  const template = fs.readFileSync(path.join(PROMPTS_DIR, 'worker.md'), 'utf8');
  return renderTemplate(template, {
    key: ticket.key,
    summary: ticket.summary,
    type: ticket.type,
    labels: ticket.labels.join(', ') || 'none',
    url: ticket.url ?? 'n/a',
    description: ticket.description,
    comments: ticket.comments.length
      ? ticket.comments.map((c) => `**${c.author}** (${c.created}):\n${c.body}`).join('\n\n')
      : '(no comments)',
    branch,
    baseBranch: project.repo.baseBranch,
    checks: project.checks.length
      ? project.checks.map((c) => `   - \`${c}\``).join('\n')
      : '   - (This project has no configured checks. Run whatever tests the repository has.)',
  });
}
