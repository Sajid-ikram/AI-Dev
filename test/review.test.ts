import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bitbucketRepo, reviewerRefs } from '../src/bitbucket.ts';
import { checksScript, parseChecksOutput } from '../src/checks.ts';
import { parseProject } from '../src/config.ts';
import { pickTransition, textToAdf, type Ticket } from '../src/jira.ts';
import type { JobRecord } from '../src/job.ts';
import { reviewerPrompt, workerFixPrompt } from '../src/prompts.ts';
import { prDescription } from '../src/publish.ts';
import { checksFeedback, judge, parseVerdict, type Verdict } from '../src/review.ts';

const ticket = (type: string): Ticket => ({ key: 'KAN-9', summary: 'Fix it', type, labels: [], description: 'd', comments: [], url: 'https://x.atlassian.net/browse/KAN-9' });
const verdict = (v: Partial<Verdict>): Verdict => ({ verdict: 'approve', summary: 'Looks right.', issues: [], ...v });

test('judge approves a clean verdict on a story', () => {
  assert.deepEqual(judge(verdict({}), ticket('Story')), { approved: true, problems: [] });
});

test('judge lets minor issues through but not blocking ones', () => {
  const minor = { severity: 'minor' as const, problem: 'naming' };
  const blocking = { severity: 'blocking' as const, problem: 'crash' };
  assert.equal(judge(verdict({ issues: [minor] }), ticket('Story')).approved, true);
  const r = judge(verdict({ issues: [minor, blocking] }), ticket('Story'));
  assert.equal(r.approved, false);
  assert.deepEqual(r.problems, [blocking]);
});

test('judge needs a proven reproduction test for a bug, even when the reviewer approves', () => {
  const none = judge(verdict({}), ticket('Bug'));
  assert.equal(none.approved, false);
  assert.match(none.problems[0].problem, /bug/);
  const unproven = judge(verdict({ reproduction: { test: 't', failsOnBase: false, passesOnBranch: true } }), ticket('bug'));
  assert.equal(unproven.approved, false);
  const proven = judge(verdict({ reproduction: { test: 't', failsOnBase: true, passesOnBranch: true } }), ticket('Bug'));
  assert.equal(proven.approved, true);
});

test('judge treats request_changes as not approved, even with only minor issues', () => {
  const minor = { severity: 'minor' as const, problem: 'rename x' };
  const r = judge(verdict({ verdict: 'request_changes', issues: [minor] }), ticket('Story'));
  assert.equal(r.approved, false);
  assert.deepEqual(r.problems, [minor]);
  const bare = judge(verdict({ verdict: 'request_changes', summary: 'Wrong screen.' }), ticket('Story'));
  assert.equal(bare.problems[0].problem, 'Wrong screen.');
});

test('parseVerdict rejects malformed output', () => {
  assert.equal(parseVerdict(undefined), undefined);
  assert.equal(parseVerdict({ verdict: 'maybe', summary: 's', issues: [] }), undefined);
  assert.equal(parseVerdict({ verdict: 'approve', summary: 's' }), undefined);
  assert.ok(parseVerdict({ verdict: 'approve', summary: 's', issues: [] }));
});

test('checks run between markers and stop at the first failure', () => {
  const script = checksScript(['npm ci', 'npm test'], '@@m');
  assert.match(script, /^cd \/work/);
  assert.match(script, /\(\nnpm ci\n\) < \/dev\/null 2>&1/);
  const out = ['@@m start 0', 'installed', '@@m exit 0 0', '@@m start 1', 'FAIL a.test', 'boom', '@@m exit 1 2', ''].join('\n');
  assert.deepEqual(parseChecksOutput(out, '@@m', ['npm ci', 'npm test']), [
    { command: 'npm ci', exitCode: 0, output: 'installed' },
    { command: 'npm test', exitCode: 2, output: 'FAIL a.test\nboom' },
  ]);
  const killed = parseChecksOutput('@@m start 0\nhalfway', '@@m', ['npm ci']);
  assert.deepEqual(killed, [{ command: 'npm ci', exitCode: null, output: 'halfway' }]);
});

test('checksFeedback shows the failing command and the end of its output', () => {
  const output = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  const text = checksFeedback({ passed: false, results: [{ command: 'npm test', exitCode: 1, output }] }, 'abcdef1234567');
  assert.match(text, /`npm test` failed with exit code 1/);
  assert.match(text, /line 199/);
  assert.doesNotMatch(text, /line 10\n/);
});

test('textToAdf makes paragraphs, line breaks and links', () => {
  assert.deepEqual(textToAdf('Hi\nsee https://a.b/c now\n\nBye'), {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Hi' },
          { type: 'hardBreak' },
          { type: 'text', text: 'see ' },
          { type: 'text', text: 'https://a.b/c', marks: [{ type: 'link', attrs: { href: 'https://a.b/c' } }] },
          { type: 'text', text: ' now' },
        ],
      },
      { type: 'paragraph', content: [{ type: 'text', text: 'Bye' }] },
    ],
  });
});

test('pull request reviewers go to Bitbucket by account ID or UUID', () => {
  assert.deepEqual(reviewerRefs(['712020:abc-1', '{2388bc8b-80d1}']), [{ account_id: '712020:abc-1' }, { uuid: '{2388bc8b-80d1}' }]);
  const withReviewers = parseProject('p.yaml', { name: 'p', repo: { url: 'x' }, image: 'i', prReviewers: ['712020:abc-1'] });
  assert.deepEqual(withReviewers.prReviewers, ['712020:abc-1']);
  assert.deepEqual(parseProject('p.yaml', { name: 'p', repo: { url: 'x' }, image: 'i' }).prReviewers, []);
});

test('Jira moves pick the transition by its target status', () => {
  const transitions = [
    { id: '21', name: 'Start', to: { name: 'In Progress' } },
    { id: '31', name: 'Review it', to: { name: 'In Review' } },
  ];
  assert.equal(pickTransition(transitions, 'in review')?.id, '31');
  assert.equal(pickTransition(transitions, 'Done'), undefined);
  const statuses = { pickUp: 'AI Tasks', working: 'In Progress', prOpened: 'In Review', stuck: 'To Do' };
  assert.deepEqual(parseProject('p.yaml', { name: 'p', repo: { url: 'x' }, image: 'i', jiraStatus: statuses }).jiraStatus, statuses);
  assert.deepEqual(parseProject('p.yaml', { name: 'p', repo: { url: 'x' }, image: 'i' }).jiraStatus, {
    pickUp: undefined,
    working: undefined,
    prOpened: undefined,
    stuck: undefined,
  });
  assert.throws(() => parseProject('p.yaml', { name: 'p', repo: { url: 'x' }, image: 'i', jiraStatus: { done: 'Done' } }), /unknown keys: done/);
});

test('bitbucketRepo reads Bitbucket Cloud URLs only', () => {
  assert.deepEqual(bitbucketRepo('https://bitbucket.org/sajid_ikram/potato-proto.git'), { workspace: 'sajid_ikram', slug: 'potato-proto' });
  assert.deepEqual(bitbucketRepo('https://me@bitbucket.org/ws/app'), { workspace: 'ws', slug: 'app' });
  assert.equal(bitbucketRepo('https://github.com/a/b.git'), undefined);
  assert.equal(bitbucketRepo('C:/repos/app'), undefined);
});

const project = parseProject('p.yaml', { name: 'p', repo: { url: 'https://bitbucket.org/w/p.git' }, image: 'aidev-flutter', checks: ['flutter test'] });
const change = { branch: 'ai/KAN-9-fix-it', baseSha: 'base123', headSha: 'head456' };

test('the reviewer prompt asks for a reproduction on bugs only', () => {
  const bug = reviewerPrompt(ticket('Bug'), project, change);
  assert.match(bug, /git checkout base123 -- <files>/);
  assert.match(bug, /commit `head456`, on branch `ai\/KAN-9-fix-it`/);
  assert.match(bug, /- `flutter test`/);
  assert.doesNotMatch(bug, /\{\{\w+\}\}/);
  assert.match(reviewerPrompt(ticket('Story'), project, change), /no reproduction test is needed/);
});

test('the fix prompt carries the feedback and the round', () => {
  const prompt = workerFixPrompt(ticket('Story'), 'Rename the button.', 2, 3);
  assert.match(prompt, /^Your work on KAN-9 isn't ready yet\. Round 2 of 3/);
  assert.match(prompt, /Rename the button\./);
  assert.doesNotMatch(prompt, /\{\{\w+\}\}/);
});

test('the pull request description has the summary, notes, checks and review', () => {
  const job: JobRecord = {
    key: 'KAN-9',
    project: 'p',
    projectFile: 'p.yaml',
    branch: change.branch,
    baseBranch: 'main',
    baseSha: change.baseSha,
    outcome: 'approved',
    local: false,
    startedAt: '',
    approvedSha: change.headSha,
    rounds: [
      { round: 1, worker: { exitCode: 0, isError: false, text: 'Removed the icon.' }, headSha: 'a', commits: [] },
      {
        round: 2,
        worker: { exitCode: 0, isError: false, text: 'Added the test.' },
        headSha: change.headSha,
        commits: [],
        checks: { passed: true, results: [{ command: 'flutter test', exitCode: 0 }] },
        review: {
          agent: { exitCode: 0, isError: false },
          approved: true,
          problems: [],
          verdict: verdict({
            summary: 'Removes the icon everywhere.',
            issues: [{ severity: 'minor', problem: 'Old comment' }],
            reproduction: { test: 'app bar has no account button', failsOnBase: true, passesOnBranch: true },
          }),
        },
      },
    ],
  };
  const text = prDescription(job, ticket('Bug'));
  assert.match(text, /^\*\*\[KAN-9\]\(https:\/\/x\.atlassian\.net\/browse\/KAN-9\): Fix it\*\*/);
  assert.match(text, /Removes the icon everywhere\./);
  assert.match(text, /\*\*Round 1:\*\* Removed the icon\.\n\n\*\*Round 2:\*\* Added the test\./);
  assert.match(text, /- `flutter test` passed/);
  assert.match(text, /in round 2/);
  assert.match(text, /Reproduction test `app bar has no account button`/);
  assert.match(text, /\[minor\] Old comment/);
  assert.match(text, /Generated with \[Claude Code\]/);
});
