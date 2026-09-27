import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProject } from '../src/config.ts';
import { branchName, slugify } from '../src/git.ts';
import { renderTemplate, workerPrompt } from '../src/prompts.ts';

test('slugify makes short, safe branch names', () => {
  assert.equal(slugify('Fix the Login redirect!'), 'fix-the-login-redirect');
  assert.equal(slugify('Crème brûlée: add “recipes”'), 'creme-brulee-add-recipes');
  assert.equal(slugify('Show the game count on the home screen and in the drawer'), 'show-the-game-count-on-the-home-screen');
  assert.ok(slugify('x'.repeat(100)).length <= 40);
  assert.equal(branchName('POT-1', 'Add dark mode'), 'ai/POT-1-add-dark-mode');
  assert.equal(branchName('POT-1', '!!!'), 'ai/POT-1');
});

test('renderTemplate fills placeholders without expanding ones inside values', () => {
  assert.equal(renderTemplate('{{a}} and {{b}}', { a: '{{b}}', b: 'x' }), '{{b}} and x');
  assert.throws(() => renderTemplate('{{missing}}', {}), /missing/);
});

test('the worker prompt renders every placeholder', () => {
  const project = parseProject('p.yaml', {
    name: 'p',
    repo: { url: 'https://example.com/r.git', baseBranch: 'develop' },
    image: 'aidev-node',
    checks: ['npm test'],
  });
  const prompt = workerPrompt(
    { key: 'POT-3', summary: 'Add a {{thing}}', type: 'Bug', labels: [], description: 'Details', comments: [] },
    project,
    'ai/POT-3-add-a-thing',
  );
  assert.ok(!/\{\{(?!thing\}\})\w+\}\}/.test(prompt), 'no unfilled placeholders');
  assert.match(prompt, /Jira ticket POT-3\./);
  assert.match(prompt, /branch `ai\/POT-3-add-a-thing`, created from `develop`/);
  assert.match(prompt, /- `npm test`/);
  assert.match(prompt, /must start with `POT-3`/);
});
