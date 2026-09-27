import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LoopDetector, usageLimit } from '../src/agent.ts';
import { parseProject } from '../src/config.ts';
import type { JobRecord } from '../src/job.ts';
import { decide } from '../src/watch.ts';
import { DEFAULT_PROTECTED_PATHS, checkToolUse, globToRegExp, protectedBy } from '../src/watchdog/policy.ts';

const P = DEFAULT_PROTECTED_PATHS;
const bash = (command: string) => checkToolUse('Bash', { command }, P);

test('globs match paths the way the patterns read', () => {
  assert.ok(globToRegExp('.github/**').test('.github/workflows/ci.yml'));
  assert.ok(globToRegExp('**/.env').test('.env'));
  assert.ok(globToRegExp('**/.env').test('app/config/.env'));
  assert.ok(!globToRegExp('**/.env').test('app/.env.example'));
  assert.ok(globToRegExp('**/*.jks').test('android/app/upload.jks'));
  assert.ok(!globToRegExp('bitbucket-pipelines.yml').test('app/bitbucket-pipelines.yml'));
  assert.ok(globToRegExp('app/?.txt').test('app/a.txt'));
  assert.equal(protectedBy('.claude/settings.json', P), '.claude/**');
  assert.equal(protectedBy('app/lib/main.dart', P), undefined);
});

test('edits to protected files are blocked, others are not', () => {
  assert.match(checkToolUse('Write', { file_path: '/work/.github/workflows/x.yml' }, P) ?? '', /protected \(\.github\/\*\*\)/);
  assert.match(checkToolUse('Edit', { file_path: '/work/.claude/settings.json' }, P) ?? '', /protected/);
  assert.match(checkToolUse('NotebookEdit', { notebook_path: '/work/.git/config' }, P) ?? '', /protected/);
  assert.equal(checkToolUse('Edit', { file_path: '/work/app/lib/main.dart' }, P), undefined);
  assert.equal(checkToolUse('Write', { file_path: '/tmp/scratch.txt' }, P), undefined);
  assert.equal(checkToolUse('Read', { file_path: '/work/.github/workflows/x.yml' }, P), undefined);
  // A project's own patterns count too.
  const project = parseProject('p.yaml', { name: 'p', repo: { url: 'x' }, image: 'i', protectedPaths: ['app/android/**'] });
  assert.match(checkToolUse('Edit', { file_path: '/work/app/android/build.gradle' }, project.protectedPaths) ?? '', /app\/android\/\*\*/);
});

test('dangerous commands are blocked', () => {
  for (const cmd of [
    'git push origin HEAD',
    'git -C /work push',
    'cd /work && git push --force',
    'git commit --no-verify -m "KAN-1: x"',
    'git commit -nm x',
    'git config core.hooksPath /tmp',
    'rm .git/hooks/commit-msg',
    'rm -rf /work',
    'rm -rf .',
    'rm -fr /',
    'echo x > .github/workflows/ci.yml',
    "sed -i 's/a/b/' bitbucket-pipelines.yml",
  ]) {
    assert.ok(bash(cmd), `should block: ${cmd}`);
  }
});

test('everyday commands are allowed', () => {
  for (const cmd of [
    'cd app && flutter test',
    'git add -A && git commit -m "KAN-1: handle the -n flag"',
    'git commit -m "KAN-1: fix" --amend',
    'git log --oneline > /tmp/log.txt',
    'rm -rf ./build app/.dart_tool',
    'git status && git diff',
    'cat .github/workflows/ci.yml',
    'npm test -- --push-state',
  ]) {
    assert.equal(bash(cmd), undefined, `should allow: ${cmd}`);
  }
});

test('the loop detector fires on the fifth identical call in a row', () => {
  const loops = new LoopDetector(5);
  const call = { command: 'flutter test' };
  assert.deepEqual([1, 2, 3, 4].map(() => loops.see('Bash', call)), [false, false, false, false]);
  assert.equal(loops.see('Bash', call), true);
  const other = new LoopDetector(3);
  other.see('Bash', call);
  other.see('Bash', call);
  other.see('Read', { file_path: 'x' });
  assert.equal(other.see('Bash', call), false, 'a different call in between resets the count');
  assert.equal(other.see('TodoWrite', {}), false);
});

test('usage limits come from rejected rate_limit_events, except paid-only models', () => {
  assert.deepEqual(usageLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1790812800 } }), { resetsAt: 1790812800000 });
  assert.deepEqual(usageLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }), { resetsAt: undefined });
  assert.equal(usageLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }), undefined);
  assert.equal(usageLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', errorCode: 'credits_required' } }), undefined);
  assert.equal(usageLimit({ type: 'assistant' }), undefined);
});

test('the watcher starts new tickets and ones a person moved back', () => {
  const job = (outcome: JobRecord['outcome'], leftPickUp?: boolean) => ({ outcome, leftPickUp }) as JobRecord;
  assert.equal(decide(undefined), 'start');
  assert.equal(decide(job('running')), 'skip');
  assert.equal(decide(job('paused')), 'skip');
  assert.equal(decide(job('blocked', true)), 'start');
  assert.equal(decide(job('published', true)), 'start');
  assert.equal(decide(job('failed')), 'stuck-in-queue', "aidev couldn't move it, so being in the queue says nothing");
  assert.equal(decide({} as JobRecord), 'stuck-in-queue', 'a job from before outcomes existed');
});
