import assert from 'node:assert/strict';
import test from 'node:test';
import { isTargetClosedError } from './playwright-helpers';

test('isTargetClosedError matches page was closed variants raised from challenge wait', () => {
  assert.equal(isTargetClosedError(new Error('Browser page was closed while waiting for manual CAPTCHA resolution')), true);
  assert.equal(isTargetClosedError(new Error('Target closed')), true);
  assert.equal(isTargetClosedError(new Error('Completely unrelated error')), false);
});
