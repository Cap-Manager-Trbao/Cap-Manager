import test from 'node:test';
import assert from 'node:assert/strict';
import { computeCapTableImageLayout } from './capTableImage.js';

test('computeCapTableImageLayout computes accurate offer/member CAP & point totals and excludes hidden offers', () => {
  const members = [
    { id: 'm1', name: 'Trung Bảo', active: true, shifts: ['ca1', 'ca2', 'ca3'] },
    { id: 'm2', name: 'Uyên', active: true, shifts: ['ca1', 'ca2'] },
    { id: 'm3', name: 'Chi Hon', active: true, isNew: true, shifts: [], shiftSchedule: { '2026-11-23': [] } },
  ];
  const campaigns = [
    { id: 'c1', name: '22038737 - Everydayhealth', capHour: '10h', totalCap: 4, pointsPerCap: 35 },
    { id: 'c2', name: '21997905 - Diabetes Snacks', capHour: '23h', totalCap: 3, pointsPerCap: 25 },
    { id: 'c3', name: 'Hidden Offer', capHour: '23h', totalCap: 5, pointsPerCap: 20, hidden: true },
  ];
  const matrix = {
    c1: { m1: 2, m2: 2, m3: 0 },
    c2: { m1: 2, m2: 1, m3: 0 },
    c3: { m1: 5, m2: 0, m3: 0 },
  };

  const layout = computeCapTableImageLayout({
    groupName: 'Nhóm 1',
    dateStr: '2026-11-23',
    members,
    campaigns,
    matrix,
    stats: { assignedTotalCap: 7, assignedTotalPoints: 215 },
  });

  assert.equal(layout.shortDate, '23/11');
  assert.equal(layout.offerCount, 2);
  assert.equal(layout.grandTotalCap, 7);
  assert.equal(layout.grandTotalPoints, 215);
  assert.deepEqual(layout.memberTotals, [4, 3, 0]);
  assert.deepEqual(layout.memberPointTotals, [120, 95, 0]);
  assert.equal(layout.rows[0].pointsPerCap, 35);
  assert.equal(layout.rows[0].rowTotal, 4);
  assert.equal(layout.rows[0].rowTotalPoints, 140);
  assert.equal(layout.rows[1].pointsPerCap, 25);
  assert.equal(layout.rows[1].rowTotal, 3);
  assert.equal(layout.rows[1].rowTotalPoints, 75);
  assert.equal(layout.memberHeaders[2].isNew, true);
  assert.equal(layout.memberHeaders[2].shiftTag, 'Nghỉ');
  assert.ok(layout.canvasWidth >= 720);
  assert.ok(layout.canvasHeight > 240);
});
