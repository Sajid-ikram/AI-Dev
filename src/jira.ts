import fs from 'node:fs';
import YAML from 'yaml';
import { requireEnv } from './config.ts';

export interface Ticket {
  key: string;
  summary: string;
  type: string;
  status?: string;
  priority?: string;
  labels: string[];
  description: string;
  comments: TicketComment[];
  url?: string;
}

export interface TicketComment {
  author: string;
  created: string;
  body: string;
}

/** The most recent comments given to the agent; older ones are usually stale. */
const MAX_COMMENTS = 10;

function jiraBaseUrl(): string {
  return requireEnv('JIRA_BASE_URL', 'to talk to Jira').replace(/\/+$/, '');
}

async function jiraRequest(key: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const email = requireEnv('JIRA_EMAIL', 'to talk to Jira');
  const token = requireEnv('JIRA_API_TOKEN', 'to talk to Jira');
  const res = await fetch(`${jiraBaseUrl()}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
      Accept: 'application/json',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Jira rejected the credentials (HTTP ${res.status}). Check JIRA_EMAIL and JIRA_API_TOKEN in .env.`);
  }
  if (res.status === 404) throw new Error(`Jira issue ${key} doesn't exist, or this account can't see it.`);
  if (!res.ok) throw new Error(`Jira returned HTTP ${res.status} for ${key}: ${(await res.text()).slice(0, 300)}`);
  // A transition answers 204 with no body.
  return res.status === 204 ? undefined : res.json();
}

export async function fetchTicket(key: string): Promise<Ticket> {
  const fields = 'summary,description,issuetype,status,priority,labels,comment';
  const issue = await jiraRequest(key, `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields}`);
  return ticketFromIssue(issue as JiraIssue, jiraBaseUrl());
}

interface Transition {
  id: string;
  name: string;
  to: { name: string };
}

/**
 * Moves the issue to the status named `status` (case doesn't matter), using whichever workflow
 * transition leads there. Resolves to false when it was already there.
 */
export async function moveTicket(key: string, status: string): Promise<boolean> {
  const issuePath = `/rest/api/3/issue/${encodeURIComponent(key)}`;
  const current = ((await jiraRequest(key, `${issuePath}?fields=status`)) as { fields: { status: { name: string } } }).fields.status.name;
  if (current.toLowerCase() === status.toLowerCase()) return false;
  const { transitions } = (await jiraRequest(key, `${issuePath}/transitions`)) as { transitions: Transition[] };
  const transition = pickTransition(transitions, status);
  if (!transition) {
    const targets = transitions.map((t) => t.to.name).join(', ');
    throw new Error(`${key} can't move from "${current}" to "${status}". Its workflow allows: ${targets || 'nothing'}.`);
  }
  await jiraRequest(key, `${issuePath}/transitions`, { method: 'POST', body: { transition: { id: transition.id } } });
  return true;
}

export function pickTransition(transitions: Transition[], status: string): Transition | undefined {
  return transitions.find((t) => t.to.name.toLowerCase() === status.toLowerCase());
}

/** Adds a comment to the issue. Blank lines separate paragraphs, and URLs become links. */
export async function addComment(key: string, text: string): Promise<void> {
  await jiraRequest(key, `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { method: 'POST', body: { body: textToAdf(text) } });
}

export function textToAdf(text: string): AdfNode {
  const paragraphs = text.trim().replace(/\r\n/g, '\n').split(/\n{2,}/);
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map((p) => ({
      type: 'paragraph',
      content: p.split('\n').flatMap((line, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...linkify(line)]),
    })),
  };
}

function linkify(line: string): AdfNode[] {
  return line
    .split(/(https?:\/\/[^\s)>\]]+)/)
    .filter((part) => part !== '')
    .map((part) =>
      /^https?:\/\//.test(part) ? { type: 'text', text: part, marks: [{ type: 'link', attrs: { href: part } }] } : { type: 'text', text: part },
    );
}

interface JiraIssue {
  key: string;
  fields: {
    summary?: string;
    description?: AdfNode | string | null;
    issuetype?: { name?: string };
    status?: { name?: string };
    priority?: { name?: string } | null;
    labels?: string[];
    comment?: { comments?: { author?: { displayName?: string }; created?: string; body?: AdfNode | string }[] };
  };
}

export function ticketFromIssue(issue: JiraIssue, baseUrl: string): Ticket {
  const f = issue.fields;
  const comments = (f.comment?.comments ?? []).slice(-MAX_COMMENTS).map((c) => ({
    author: c.author?.displayName ?? 'unknown',
    created: c.created?.slice(0, 10) ?? '',
    body: richText(c.body),
  }));
  return {
    key: issue.key,
    summary: f.summary ?? '(no summary)',
    type: f.issuetype?.name ?? 'Task',
    status: f.status?.name,
    priority: f.priority?.name,
    labels: f.labels ?? [],
    description: richText(f.description) || '(no description)',
    comments,
    url: `${baseUrl}/browse/${issue.key}`,
  };
}

/**
 * Reads a ticket from a Markdown file instead of Jira, for trying things out and for replays.
 * The summary comes from `summary:` in YAML front matter or the first "# " heading.
 */
export function readTicketFile(file: string, key: string): Ticket {
  let body = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  let meta: Record<string, unknown> = {};
  const frontMatter = /^---\n([\s\S]*?)\n---\n?/.exec(body);
  if (frontMatter) {
    meta = (YAML.parse(frontMatter[1]) as Record<string, unknown> | null) ?? {};
    body = body.slice(frontMatter[0].length);
  }
  let summary = typeof meta.summary === 'string' ? meta.summary : undefined;
  if (!summary) {
    const heading = /^#\s+(.+)$/m.exec(body);
    if (heading) {
      summary = heading[1].trim();
      body = body.replace(heading[0], '');
    }
  }
  if (!summary) throw new Error(`${file} needs a summary: a "# " heading or "summary:" in front matter.`);
  return {
    key,
    summary,
    type: typeof meta.type === 'string' ? meta.type : 'Task',
    labels: Array.isArray(meta.labels) ? meta.labels.map(String) : [],
    description: body.trim() || '(no description)',
    comments: [],
  };
}

function richText(value: AdfNode | string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : adfToText(value);
}

// ---------- Atlassian Document Format to Markdown ----------

export interface AdfNode {
  type: string;
  /** Only on the root "doc" node. */
  version?: number;
  text?: string;
  attrs?: Record<string, any>;
  marks?: { type: string; attrs?: Record<string, any> }[];
  content?: AdfNode[];
}

const INLINE_TYPES = new Set(['text', 'hardBreak', 'mention', 'emoji', 'inlineCard', 'date', 'status', 'mediaInline']);

/** Converts Jira's rich text to Markdown. Unknown nodes fall back to their text, so nothing is dropped. */
export function adfToText(doc: AdfNode | null | undefined): string {
  if (!doc) return '';
  return renderBlocks(doc.content ?? []).replace(/\n{3,}/g, '\n\n').trim();
}

function renderBlocks(nodes: AdfNode[]): string {
  return nodes
    .map(renderBlock)
    .filter((s) => s !== '')
    .join('\n\n');
}

function renderBlock(node: AdfNode): string {
  const kids = node.content ?? [];
  switch (node.type) {
    case 'paragraph':
      return renderInline(kids);
    case 'heading':
      return `${'#'.repeat(Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 6))} ${renderInline(kids)}`;
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return renderList(node);
    case 'codeBlock':
      return '```' + (node.attrs?.language ?? '') + '\n' + kids.map((k) => k.text ?? '').join('') + '\n```';
    case 'blockquote':
    case 'panel':
      return prefixLines(renderBlocks(kids), '> ');
    case 'rule':
      return '---';
    case 'table':
      return renderTable(node);
    case 'mediaSingle':
    case 'mediaGroup':
    case 'media':
      return '[attachment]';
    case 'expand':
    case 'nestedExpand':
      return [node.attrs?.title ? `**${node.attrs.title}**` : '', renderBlocks(kids)].filter(Boolean).join('\n\n');
    case 'blockCard':
    case 'embedCard':
      return node.attrs?.url ?? '';
    default:
      return INLINE_TYPES.has(node.type) ? renderInline([node]) : renderBlocks(kids);
  }
}

function renderList(node: AdfNode): string {
  const start = Number(node.attrs?.order ?? 1);
  return (node.content ?? [])
    .map((item, i) => {
      const marker =
        node.type === 'orderedList'
          ? `${start + i}. `
          : node.type === 'taskList'
            ? item.attrs?.state === 'DONE' ? '- [x] ' : '- [ ] '
            : '- ';
      // Task items hold inline nodes directly; list items hold blocks, including nested lists.
      const body =
        item.type === 'taskItem'
          ? renderInline(item.content ?? [])
          : renderBlocks(item.content ?? []).replace(/\n\n/g, '\n');
      return marker + body.replace(/\n/g, '\n' + ' '.repeat(marker.length));
    })
    .join('\n');
}

function renderTable(node: AdfNode): string {
  const rows = (node.content ?? []).map((row) =>
    (row.content ?? []).map((cell) =>
      renderBlocks(cell.content ?? []).replace(/\s*\n+\s*/g, ' ').replace(/\|/g, '\\|'),
    ),
  );
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  return [line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n');
}

function renderInline(nodes: AdfNode[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'text':
          return applyMarks(n.text ?? '', n.marks);
        case 'hardBreak':
          return '\n';
        case 'mention':
          return n.attrs?.text ?? '@someone';
        case 'emoji':
          return n.attrs?.text ?? n.attrs?.shortName ?? '';
        case 'inlineCard':
          return n.attrs?.url ?? '';
        case 'date':
          return formatDate(n.attrs?.timestamp);
        case 'status':
          return `[${n.attrs?.text ?? ''}]`;
        case 'mediaInline':
          return '[attachment]';
        default:
          return n.content ? renderInline(n.content) : (n.text ?? '');
      }
    })
    .join('');
}

// Code goes innermost and links outermost, whatever order Jira lists the marks in.
const MARK_ORDER: Record<string, number> = { code: 0, strong: 1, em: 1, strike: 1, link: 2 };

function applyMarks(text: string, marks: AdfNode['marks'] = []): string {
  let out = text;
  for (const mark of [...marks].sort((a, b) => (MARK_ORDER[a.type] ?? 1) - (MARK_ORDER[b.type] ?? 1))) {
    if (mark.type === 'code') out = '`' + out + '`';
    else if (mark.type === 'strong') out = `**${out}**`;
    else if (mark.type === 'em') out = `_${out}_`;
    else if (mark.type === 'strike') out = `~~${out}~~`;
    else if (mark.type === 'link' && mark.attrs?.href) out = `[${out}](${mark.attrs.href})`;
  }
  return out;
}

function formatDate(timestamp: unknown): string {
  const date = new Date(Number(timestamp));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => (line ? prefix + line : prefix.trimEnd()))
    .join('\n');
}
