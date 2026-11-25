const test = require('node:test');
const assert = require('node:assert/strict');

test('safeName prevents traversal and Windows reserved names', async () => {
  const { safeName } = await import('./safe-name.ts');
  assert.equal(safeName('..'), '未命名');
  assert.equal(safeName('CON'), '_CON');
  assert.equal(safeName('series. '), 'series');
  assert.equal(safeName('Drama/Season 1'), 'Drama Season 1');
});
