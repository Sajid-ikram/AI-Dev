import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_LIMITS, DEFAULT_REVIEWER, DEFAULT_ROLE, assertIssueKey, assertProjectReady, parseProject } from '../src/config.ts';

const minimal = { name: 'app', repo: { url: 'https://bitbucket.org/ws/app.git' }, image: 'aidev-node' };

test('parseProject fills in defaults', () => {
  const project = parseProject('app.yaml', minimal);
  assert.equal(project.repo.baseBranch, 'main');
  assert.equal(project.repo.auth, 'bitbucket');
  assert.deepEqual(project.checks, []);
  assert.deepEqual(project.worker, { ...DEFAULT_ROLE, effort: undefined });
  assert.deepEqual(project.reviewer, { ...DEFAULT_REVIEWER, effort: undefined });
  assert.deepEqual(project.limits, DEFAULT_LIMITS);
});

test('parseProject reads role settings and lets an empty fallbackModel turn the fallback off', () => {
  const project = parseProject('app.yaml', { ...minimal, worker: { model: 'opus', fallbackModel: '', effort: 'xhigh', maxTurns: 50 } });
  assert.equal(project.worker.model, 'opus');
  assert.equal(project.worker.fallbackModel, undefined);
  assert.equal(project.worker.effort, 'xhigh');
  assert.equal(project.worker.maxTurns, 50);
  assert.equal(project.worker.timeoutMinutes, DEFAULT_ROLE.timeoutMinutes);
});

test('parseProject rejects bad values with the file name and field', () => {
  assert.throws(() => parseProject('app.yaml', { ...minimal, name: undefined }), /app\.yaml: name is required/);
  assert.throws(() => parseProject('app.yaml', { ...minimal, checks: 'npm test' }), /checks must be a list of commands/);
  assert.throws(() => parseProject('app.yaml', { ...minimal, checks: [{ run: 'x' }] }), /checks must be a list of commands/);
  assert.deepEqual(parseProject('app.yaml', { ...minimal, checks: ['make', false, 42] }).checks, ['make', 'false', '42']);
  assert.throws(() => parseProject('app.yaml', { ...minimal, worker: { effort: 'huge' } }), /worker\.effort must be one of/);
  assert.throws(() => parseProject('app.yaml', { ...minimal, limits: { memory: 'lots' } }), /limits\.memory/);
  assert.throws(() => parseProject('app.yaml', { ...minimal, repo: { url: 'x', auth: 'ssh' } }), /repo\.auth/);
  assert.throws(() => parseProject('app.yaml', { ...minimal, jiraProject: 'pot' }), /jiraProject/);
});

test('assertProjectReady catches placeholders', () => {
  const project = parseProject('app.yaml', { ...minimal, repo: { url: 'https://bitbucket.org/<workspace>/app.git' } });
  assert.throws(() => assertProjectReady(project), /placeholder/);
});

test('assertIssueKey accepts Jira keys only', () => {
  assertIssueKey('POT-12');
  assertIssueKey('MY_APP2-1');
  for (const bad of ['pot-12', 'POT', 'POT-', '../POT-1', 'POT-1/x']) assert.throws(() => assertIssueKey(bad));
});
