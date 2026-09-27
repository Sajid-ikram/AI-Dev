import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { adfToText, readTicketFile, ticketFromIssue, type AdfNode } from '../src/jira.ts';

const doc = (...content: AdfNode[]): AdfNode => ({ type: 'doc', content });
const p = (...content: AdfNode[]): AdfNode => ({ type: 'paragraph', content });
const text = (t: string, marks?: AdfNode['marks']): AdfNode => ({ type: 'text', text: t, marks });
const li = (...content: AdfNode[]): AdfNode => ({ type: 'listItem', content });

test('adfToText renders paragraphs, headings and inline marks', () => {
  const out = adfToText(
    doc(
      { type: 'heading', attrs: { level: 2 }, content: [text('Steps')] },
      p(text('Run '), text('flutter test', [{ type: 'code' }]), text(' and see '), text('docs', [{ type: 'link', attrs: { href: 'https://x.dev' } }])),
      p(text('line one'), { type: 'hardBreak' }, text('line two')),
    ),
  );
  assert.equal(out, '## Steps\n\nRun `flutter test` and see [docs](https://x.dev)\n\nline one\nline two');
});

test('adfToText renders nested and ordered lists', () => {
  const out = adfToText(
    doc(
      { type: 'bulletList', content: [li(p(text('a')), { type: 'bulletList', content: [li(p(text('a1')))] }), li(p(text('b')))] },
      { type: 'orderedList', attrs: { order: 3 }, content: [li(p(text('third'))), li(p(text('fourth')))] },
    ),
  );
  assert.equal(out, '- a\n  - a1\n- b\n\n3. third\n4. fourth');
});

test('adfToText renders code blocks, quotes, tables and unknown nodes', () => {
  const cell = (t: string): AdfNode => ({ type: 'tableCell', content: [p(text(t))] });
  const out = adfToText(
    doc(
      { type: 'codeBlock', attrs: { language: 'dart' }, content: [text('void main() {}')] },
      { type: 'blockquote', content: [p(text('quoted'))] },
      { type: 'table', content: [{ type: 'tableRow', content: [cell('h1'), cell('h2')] }, { type: 'tableRow', content: [cell('a|b'), cell('c')] }] },
      { type: 'someFutureNode', content: [p(text('still here'))] },
      { type: 'mediaSingle', content: [{ type: 'media' }] },
    ),
  );
  assert.equal(
    out,
    '```dart\nvoid main() {}\n```\n\n> quoted\n\n| h1 | h2 |\n| --- | --- |\n| a\\|b | c |\n\nstill here\n\n[attachment]',
  );
});

test('adfToText handles empty input', () => {
  assert.equal(adfToText(null), '');
  assert.equal(adfToText(doc()), '');
});

test('ticketFromIssue maps Jira fields and keeps the last comments', () => {
  const comments = Array.from({ length: 12 }, (_, i) => ({
    author: { displayName: `User ${i}` },
    created: '2026-09-01T10:00:00.000+0000',
    body: doc(p(text(`comment ${i}`))),
  }));
  const ticket = ticketFromIssue(
    {
      key: 'POT-7',
      fields: {
        summary: 'Fix crash',
        description: doc(p(text('It crashes'))),
        issuetype: { name: 'Bug' },
        labels: ['mobile'],
        comment: { comments },
      },
    },
    'https://site.atlassian.net',
  );
  assert.equal(ticket.type, 'Bug');
  assert.equal(ticket.description, 'It crashes');
  assert.equal(ticket.url, 'https://site.atlassian.net/browse/POT-7');
  assert.equal(ticket.comments.length, 10);
  assert.deepEqual(ticket.comments[0], { author: 'User 2', created: '2026-09-01', body: 'comment 2' });
});

test('readTicketFile reads front matter or a heading', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-'));
  const withMeta = path.join(dir, 'a.md');
  fs.writeFileSync(withMeta, '---\nsummary: From meta\ntype: Bug\nlabels: [x]\n---\nBody text\r\n');
  assert.deepEqual(readTicketFile(withMeta, 'T-1'), {
    key: 'T-1',
    summary: 'From meta',
    type: 'Bug',
    labels: ['x'],
    description: 'Body text',
    comments: [],
  });
  const withHeading = path.join(dir, 'b.md');
  fs.writeFileSync(withHeading, '# From heading\n\nDo the thing.\n');
  const ticket = readTicketFile(withHeading, 'T-2');
  assert.equal(ticket.summary, 'From heading');
  assert.equal(ticket.type, 'Task');
  assert.equal(ticket.description, 'Do the thing.');
  const noSummary = path.join(dir, 'c.md');
  fs.writeFileSync(noSummary, 'just text');
  assert.throws(() => readTicketFile(noSummary, 'T-3'), /needs a summary/);
});
