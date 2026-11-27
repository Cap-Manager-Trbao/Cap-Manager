import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCalendarDateHeader, getDateRange } from './storage.js';

test('formatCalendarDateHeader formats valid ISO date and safely falls back on undefined/malformed input', () => {
  assert.deepEqual(formatCalendarDateHeader('2026-11-27'), {
    shortDate: '27/11',
    weekday: 'T6',
  });

  const fallbackUndefined = formatCalendarDateHeader(undefined);
  assert.match(fallbackUndefined.shortDate, /^\d{2}\/\d{2}$/);
  assert.ok(fallbackUndefined.weekday);

  const fallbackBad = formatCalendarDateHeader('invalid');
  assert.match(fallbackBad.shortDate, /^\d{2}\/\d{2}$/);
  assert.ok(fallbackBad.weekday);
});

test('getDateRange returns exact requested count of consecutive ISO dates', () => {
  const dates = getDateRange('2026-11-27', 7);
  assert.equal(dates.length, 7);
  assert.equal(dates[0], '2026-11-27');
  assert.equal(dates[6], '2026-12-03');
});
