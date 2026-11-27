import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getSavedDatesSet,
  getSavedDistributionForDate,
  hasMatrixChangesSinceSaved,
} from './dashboardSchedule.js';

const sampleCampaigns = [
  { id: 'c1', code: '1551', name: 'Offer 1', totalCap: 5, pointsPerCap: 25, capHour: '10h' },
  { id: 'c2', code: '936', name: 'Offer 2', totalCap: 3, pointsPerCap: 20, capHour: '23h' },
];

const sampleMembers = [
  { id: 'm1', name: 'Trung Bảo' },
  { id: 'm2', name: 'Hiếu' },
];

test('getSavedDistributionForDate returns null when date has no saved record', () => {
  const history = [
    { id: 'h1', date: '2026-11-22', savedAt: '2026-11-22T08:00:00.000Z' },
  ];
  assert.equal(getSavedDistributionForDate(history, '2026-11-23'), null);
  assert.equal(getSavedDistributionForDate([], '2026-11-22'), null);
});

test('getSavedDistributionForDate returns latest saved record when multiple exist on same date', () => {
  const history = [
    { id: 'h-old', date: '2026-11-22', savedAt: '2026-11-22T07:00:00.000Z', note: 'Old' },
    { id: 'h-new', date: '2026-11-22', savedAt: '2026-11-22T09:30:00.000Z', note: 'Latest' },
  ];
  const found = getSavedDistributionForDate(history, '2026-11-22');
  assert.equal(found?.id, 'h-new');
  assert.equal(found?.note, 'Latest');
});

test('getSavedDatesSet collects unique valid YYYY-MM-DD dates', () => {
  const set = getSavedDatesSet([
    { id: 'h1', date: '2026-11-21' },
    { id: 'h2', date: '2026-11-22' },
    { id: 'h3', date: '2026-11-22' },
    { id: 'h4', date: 'invalid' },
  ]);
  assert.equal(set.size, 2);
  assert.equal(set.has('2026-11-21'), true);
  assert.equal(set.has('2026-11-22'), true);
  assert.equal(set.has('2026-11-23'), false);
});

test('hasMatrixChangesSinceSaved detects draft edits vs saved snapshot accurately', () => {
  const saved = {
    id: 'h1',
    date: '2026-11-22',
    campaigns: sampleCampaigns,
    members: sampleMembers,
    matrix: {
      c1: { m1: 3, m2: 2 },
      c2: { m1: 1, m2: 2 },
    },
  };

  assert.equal(hasMatrixChangesSinceSaved(null, saved.matrix, sampleCampaigns, sampleMembers), true);
  assert.equal(
    hasMatrixChangesSinceSaved(
      saved,
      { c1: { m1: 3, m2: 2 }, c2: { m1: 1, m2: 2 } },
      sampleCampaigns,
      sampleMembers
    ),
    false
  );
  assert.equal(
    hasMatrixChangesSinceSaved(
      saved,
      { c1: { m1: 2, m2: 3 }, c2: { m1: 1, m2: 2 } },
      sampleCampaigns,
      sampleMembers
    ),
    true
  );
});
