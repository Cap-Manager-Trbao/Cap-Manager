import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAiDistributionDirectives,
  applyCapTransferToState,
  computeAnalyticsDataset,
  normalizeAiParsedOffers,
} from './aiHelpers.js';
import { DEFAULT_MEMBERS, DEFAULT_OFFERS, DEFAULT_SETTINGS } from '../data/defaultData.js';

describe('aiHelpers', () => {
  it('normalizes AI-extracted offers and flags existing matches', () => {
    const res = normalizeAiParsedOffers(
      [
        { code: '1769', name: 'Updated Cocktail', capHour: '10h', totalCap: 9, pointsPerCap: 40 },
        { code: '9999', name: 'Brand New Offer', capHour: '23h', totalCap: 4, pointsPerCap: 30, eligibilityType: 'exclude_new' },
      ],
      DEFAULT_OFFERS
    );

    assert.equal(res.offers.length, 2);
    assert.equal(res.matchedCount, 1);
    assert.equal(res.newCount, 1);
    assert.equal(res.offers[0].id, 'offer-1769');
    assert.equal(res.offers[0].isExistingMatch, true);
    assert.equal(res.offers[1].eligibilityType, 'exclude_new');
    assert.equal(res.offers[1].isExistingMatch, false);
  });

  it('applies AI natural-language directives without breaking offer CAP totals', () => {
    const dateStr = '2026-11-23';
    const allWorkingMembers = DEFAULT_MEMBERS.map((m) => ({
      ...m,
      shifts: ['ca1', 'ca2', 'ca3'],
      shiftSchedule: {
        '2026-11-23': ['ca1', 'ca2', 'ca3'],
        '2026-11-24': ['ca1', 'ca2', 'ca3'],
      },
    }));

    const res = applyAiDistributionDirectives(
      {
        summary: 'Không chia khung 23h cho Uyên, ưu tiên thêm cho Hoài',
        excludeMemberFromHourBuckets: [{ memberId: 'mem-uyen', bucket: '23h' }],
        boostMemberIds: ['mem-hoai'],
      },
      {
        members: allWorkingMembers,
        campaigns: DEFAULT_OFFERS,
        baseMatrix: {},
        lockedCells: {},
        settings: DEFAULT_SETTINGS,
        dateStr,
      }
    );

    assert.equal(res.ok, true);
    assert.equal(res.stats.isAllValid, true);
    for (const camp of DEFAULT_OFFERS) {
      if (camp.capHour === '23h') {
        assert.equal(res.matrix[camp.id]['mem-uyen'], 0);
        assert.equal(res.lockedCells[camp.id]['mem-uyen'], true);
      }
    }
  });

  it('computes accurate multi-day analytics dataset from history & completions', () => {
    const members = DEFAULT_MEMBERS.slice(0, 2);
    const campaigns = DEFAULT_OFFERS.slice(0, 2);
    const history = [
      {
        id: 'hist-1',
        date: '2026-11-22',
        members,
        campaigns,
        matrix: {
          [campaigns[0].id]: { [members[0].id]: 3, [members[1].id]: 3 },
          [campaigns[1].id]: { [members[0].id]: 2, [members[1].id]: 3 },
        },
      },
    ];
    const completions = {
      '2026-11-22': {
        [campaigns[0].id]: { [members[0].id]: true },
      },
    };

    const dataset = computeAnalyticsDataset(history, completions, members, campaigns);
    assert.equal(dataset.dayCount, 1);
    assert.equal(dataset.dailyRecords[0].totalCap, 11);
    assert.equal(dataset.dailyRecords[0].completedCap, 3);
    const tb = dataset.memberSummaries.find((m) => m.memberId === members[0].id);
    assert.equal(tb.totalCap, 5);
    assert.equal(tb.completedCap, 3);
    assert.equal(tb.completionRatePct, 60);
  });

  it('executes CAP transfer atomically across saved record, group matrix, and completions', () => {
    const members = DEFAULT_MEMBERS.slice(0, 2);
    const campaigns = DEFAULT_OFFERS.slice(0, 2);
    const offerId = campaigns[0].id;
    const matrix = {
      [offerId]: { [members[0].id]: 2, [members[1].id]: 1 },
      [campaigns[1].id]: { [members[0].id]: 1, [members[1].id]: 1 },
    };
    const record = {
      id: 'hist-today',
      date: '2026-11-23',
      members,
      campaigns,
      matrix: structuredClone(matrix),
    };
    const completions = {
      '2026-11-23': {
        [offerId]: { [members[0].id]: true },
      },
    };

    const res = applyCapTransferToState({
      matrix,
      record,
      completions,
      dateStr: '2026-11-23',
      offerId,
      fromMemberId: members[0].id,
      toMemberId: members[1].id,
      qty: 2,
      members,
      campaigns,
    });

    assert.equal(res.ok, true);
    assert.equal(res.nextRecord.matrix[offerId][members[0].id], 0);
    assert.equal(res.nextRecord.matrix[offerId][members[1].id], 3);
    assert.equal(res.nextGroupMatrix[offerId][members[0].id], 0);
    assert.equal(res.nextGroupMatrix[offerId][members[1].id], 3);
    assert.equal(res.nextCompletions['2026-11-23'][offerId][members[0].id], undefined);
  });

  it('executes direct edit_only CAP transfers cleanly and tracks memberDiffs', () => {
    const dateStr = '2026-11-23';
    const members = DEFAULT_MEMBERS.slice(0, 3);
    const campaigns = [
      { ...DEFAULT_OFFERS[0], totalCap: 6 },
      { ...DEFAULT_OFFERS[1], totalCap: 6 },
    ];
    const baseMatrix = {
      [campaigns[0].id]: { [members[0].id]: 3, [members[1].id]: 1, [members[2].id]: 2 },
      [campaigns[1].id]: { [members[0].id]: 2, [members[1].id]: 2, [members[2].id]: 2 },
    };

    const res = applyAiDistributionDirectives(
      {
        summary: 'Chuyển 2 CAP từ Trung Bảo sang Huy Bảo',
        actionMode: 'edit_only',
        transfers: [
          {
            fromMemberId: members[0].id,
            toMemberId: members[1].id,
            qty: 2,
            offerId: campaigns[0].id,
          },
        ],
      },
      {
        members,
        campaigns,
        baseMatrix,
        lockedCells: {},
        settings: DEFAULT_SETTINGS,
        dateStr,
      }
    );

    assert.equal(res.ok, true);
    assert.equal(res.matrix[campaigns[0].id][members[0].id], 1);
    assert.equal(res.matrix[campaigns[0].id][members[1].id], 3);
    assert.equal(res.matrix[campaigns[0].id][members[2].id], 2);
    assert.equal(res.matrix[campaigns[1].id][members[0].id], 2);
    assert.equal(res.lockedCells[campaigns[0].id][members[0].id], true);
    assert.equal(res.lockedCells[campaigns[0].id][members[1].id], true);
    assert.equal(res.memberDiffs.find((d) => d.memberId === members[0].id)?.deltaCap, -2);
    assert.equal(res.memberDiffs.find((d) => d.memberId === members[1].id)?.deltaCap, 2);
  });

  it('honors lockMemberIds, excludeMemberIds, and memberTargetAdjustments without invalidating offer CAPs', () => {
    const dateStr = '2026-11-23';
    const allWorkingMembers = DEFAULT_MEMBERS.map((m) => ({
      ...m,
      shifts: ['ca1', 'ca2', 'ca3'],
      shiftSchedule: {
        '2026-11-23': ['ca1', 'ca2', 'ca3'],
        '2026-11-24': ['ca1', 'ca2', 'ca3'],
      },
    }));

    // Build an initial valid matrix
    const initRes = applyAiDistributionDirectives(
      { summary: 'Khởi tạo', actionMode: 'reoptimize' },
      {
        members: allWorkingMembers,
        campaigns: DEFAULT_OFFERS,
        baseMatrix: {},
        lockedCells: {},
        settings: DEFAULT_SETTINGS,
        dateStr,
      }
    );
    assert.equal(initRes.ok, true);
    const lockedMemberId = allWorkingMembers[0].id;
    const lockedSnapshot = {};
    for (const c of DEFAULT_OFFERS) {
      lockedSnapshot[c.id] = initRes.matrix[c.id][lockedMemberId];
    }

    const excludedMemberId = allWorkingMembers[1].id;
    const boostedMemberId = allWorkingMembers[2].id;

    const res = applyAiDistributionDirectives(
      {
        summary: 'Giữ nguyên người 1, cho người 2 nghỉ, bù thêm cho người 3',
        actionMode: 'reoptimize',
        lockMemberIds: [lockedMemberId],
        excludeMemberIds: [excludedMemberId],
        memberTargetAdjustments: [{ memberId: boostedMemberId, mode: 'exact_cap', value: 14 }],
        overrideMemberShifts: [
          { memberId: allWorkingMembers[3].id, day: 'today', shifts: ['ca1'] },
        ],
      },
      {
        members: allWorkingMembers,
        campaigns: DEFAULT_OFFERS,
        baseMatrix: initRes.matrix,
        lockedCells: {},
        settings: DEFAULT_SETTINGS,
        dateStr,
      }
    );

    assert.equal(res.ok, true);
    assert.equal(res.stats.isAllValid, true);
    for (const c of DEFAULT_OFFERS) {
      assert.equal(res.matrix[c.id][lockedMemberId], lockedSnapshot[c.id]);
      assert.equal(res.matrix[c.id][excludedMemberId], 0);
    }
    const boostedTotal = res.stats.memberTotalsMap[boostedMemberId]?.totalCap ?? 0;
    assert.ok(boostedTotal >= 11, `Expected boosted member >= 11 CAP, got ${boostedTotal}`);
  });
});
