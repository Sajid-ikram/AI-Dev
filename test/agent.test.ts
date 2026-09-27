import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeCommand, describeEvent } from '../src/agent.ts';
import { DEFAULT_LIMITS, DEFAULT_ROLE } from '../src/config.ts';
import { dockerRunArgs } from '../src/docker.ts';

test('claudeCommand never uses --bare, which would ignore the OAuth token', () => {
  const args = claudeCommand({ ...DEFAULT_ROLE, effort: 'high' });
  assert.ok(!args.includes('--bare'));
  assert.deepEqual(args.slice(0, 2), ['claude', '--print']);
  for (const flag of ['--dangerously-skip-permissions', '--verbose']) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  assert.equal(args[args.indexOf('--fallback-model') + 1], 'sonnet');
  assert.equal(args[args.indexOf('--effort') + 1], 'high');
});

test('claudeCommand adds resume, tool limits and a JSON schema', () => {
  const args = claudeCommand(DEFAULT_ROLE, { resume: 'abc', tools: ['Bash', 'Read'], jsonSchema: { type: 'object' } });
  assert.equal(args[args.indexOf('--resume') + 1], 'abc');
  assert.equal(args[args.indexOf('--tools') + 1], 'Bash,Read');
  assert.equal(args[args.indexOf('--json-schema') + 1], '{"type":"object"}');
  assert.ok(!claudeCommand(DEFAULT_ROLE).includes('--resume'));
});

test('claudeCommand skips a fallback that equals the model', () => {
  assert.ok(!claudeCommand({ ...DEFAULT_ROLE, model: 'opus', fallbackModel: 'opus' }).includes('--fallback-model'));
  assert.ok(!claudeCommand({ ...DEFAULT_ROLE, fallbackModel: undefined }).includes('--fallback-model'));
});

test('dockerRunArgs locks the container down and passes secrets by name only', () => {
  const args = dockerRunArgs({
    name: 'aidev-t-1-worker',
    image: 'aidev-base',
    mounts: [{ source: 'E:\\AI Dev\\workspace\\jobs\\T-1\\work', target: '/work' }],
    env: ['CLAUDE_CODE_OAUTH_TOKEN'],
    limits: DEFAULT_LIMITS,
    labels: { 'aidev.job': 'T-1' },
    command: ['claude', '--print'],
  });
  const joined = args.join(' ');
  for (const flag of ['--user 1000:1000', '--cap-drop ALL', '--security-opt no-new-privileges', '--memory 8g', '--pids-limit 2048']) {
    assert.ok(joined.includes(flag), flag);
  }
  assert.equal(args[args.indexOf('--env') + 1], 'CLAUDE_CODE_OAUTH_TOKEN');
  assert.ok(!args.some((a) => a.includes('docker.sock')));
  assert.ok(!args.includes('--privileged'));
  assert.deepEqual(args.slice(-3), ['aidev-base', 'claude', '--print']);
  assert.throws(() => dockerRunArgs({ name: 'x', image: 'i', mounts: [{ source: 'a,b', target: '/w' }], env: [], limits: DEFAULT_LIMITS, labels: {}, command: [] }));
});

test('describeEvent summarizes text and tool calls', () => {
  const out = describeEvent({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Looking at\nthe tests.' },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/work/app/lib/main.dart' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'flutter test' } },
      ],
    },
  });
  assert.ok(out);
  const lines = out.split('\n');
  assert.equal(lines[0], 'Looking at the tests.');
  assert.match(lines[1], /Edit app\/lib\/main\.dart/);
  assert.match(lines[2], /Bash flutter test/);
  assert.equal(describeEvent({ type: 'assistant', parent_tool_use_id: 'x', message: { content: [{ type: 'text', text: 'hi' }] } }), undefined);
  assert.equal(describeEvent({ type: 'user' }), undefined);
  assert.match(describeEvent({ type: 'system', subtype: 'api_retry', attempt: 2, error: 'rate_limit' }) ?? '', /retry 2: rate_limit/);
  assert.match(
    describeEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', errorCode: 'credits_required' } }) ?? '',
    /Usage limit: rejected \(credits_required\)/,
  );
  assert.equal(describeEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }), undefined);
});
