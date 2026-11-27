import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MEMBERS, DEFAULT_OFFERS, DEFAULT_SETTINGS } from '../data/defaultData.js';
import {
  autoDistributeCaps,
  canDividePointsEqually,
  computeDistributionStats,
  computeRolloverPointOffsets,
  detectDistributionShiftConflicts,
  getActiveOffers,
  getCapCycleShiftCount,
  getMemberPointWeight,
  getMemberTargetWeight,
  isEveningOnlyOffer,
  isMemberAvailableForCapCycle,
  parseCapHour,
  getShiftAffinity,
  sortOffersByPointsDesc,
} from './capAlgorithm.js';
import { addDaysToIso, getTodayDateString } from './storage.js';
import { buildDistributionWorkbook } from './excelService.js';
import {
  findDuplicateOfferCodes,
  mergeOffersByCode,
  parseQuickPastedOffers,
} from './offerParser.js';
import {
  formatGroupDistributionSummaryText,
  formatMemberCapScheduleText,
} from './shareText.js';

test('default offers are sorted by pointsPerCap descending and have exact IDs 1551..1260', () => {
  const sorted = sortOffersByPointsDesc(DEFAULT_OFFERS);
  assert.equal(sorted[0].code, '1769');
  assert.equal(sorted[0].pointsPerCap, 35);
  assert.equal(sorted[1].code, '1706');
  assert.equal(sorted[1].pointsPerCap, 30);
  assert.equal(sorted[sorted.length - 1].code, '1257');
  assert.equal(sorted[sorted.length - 1].pointsPerCap, 20);
});

test('autoDistributeCaps allocates exact offer CAP and exact group points', () => {
  const result = autoDistributeCaps(DEFAULT_MEMBERS, DEFAULT_OFFERS, DEFAULT_SETTINGS, 42);
  assert.equal(result.ok, true);
  assert.equal(result.stats.isAllValid, true);
  assert.equal(result.stats.expectedTotalCap, 49);
  assert.equal(result.stats.assignedTotalCap, 49);
  assert.equal(result.stats.expectedTotalPoints, 1285);
  assert.equal(result.stats.assignedTotalPoints, 1285);
});

test('shift-aware distribution uses Ca 2,3 today + Ca 1 next day and compensates evening workers', () => {
  const today = getTodayDateString();
  const tomorrow = addDaysToIso(today, 1);

  const members = [
    {
      id: 'm1',
      name: 'MorningNext',
      isLeader: false,
      isNew: false,
      active: true,
      priority: 'normal',
      shifts: ['ca1'],
      shiftSchedule: {
        [today]: ['ca1'], // No Ca2/Ca3 today
        [tomorrow]: ['ca1'], // Has Ca1 tomorrow -> gets 10h offers!
      },
    },
    {
      id: 'm2',
      name: 'EveningToday',
      isLeader: false,
      isNew: false,
      active: true,
      priority: 'normal',
      shifts: ['ca2', 'ca3'],
      shiftSchedule: {
        [today]: ['ca2', 'ca3'], // Has Ca2, Ca3 today -> gets 21h30/23h offers!
        [tomorrow]: ['ca2', 'ca3'], // No Ca1 tomorrow
      },
    },
  ];

  const offers = [
    { id: 'o1', code: '1769', name: '10h High', totalCap: 2, pointsPerCap: 30, capHour: '10h' },
    { id: 'o2', code: '1551', name: '10h Std', totalCap: 4, pointsPerCap: 25, capHour: '10h' },
    { id: 'o3', code: '936', name: '23h Std', totalCap: 4, pointsPerCap: 25, capHour: '23h' },
    { id: 'o4', code: '1257', name: '23h Low', totalCap: 2, pointsPerCap: 20, capHour: '23h' },
  ];

  const result = autoDistributeCaps(members, offers, { ...DEFAULT_SETTINGS, useShiftMatching: true }, 101, today);
  assert.equal(result.ok, true);

  const m1 = result.stats.memberTotalsMap['m1'];
  const m2 = result.stats.memberTotalsMap['m2'];

  assert.equal(m1.eveningCap, 0, 'Non-Ca3 member (Ca1 today + Ca1 tomorrow) must get 0 evening 23h CAP');
  assert.ok(m1.morningCap > m2.morningCap, `Next-day Ca1 member (${m1.morningCap}) should get more 10h CAP than non-Ca1 (${m2.morningCap})`);
  assert.ok(m2.eveningCap > m1.eveningCap, `Today Ca2/3 member (${m2.eveningCap}) should get evening 23h CAP`);
  assert.ok(m1.totalCap < m2.totalCap, `Non-Ca3 daytime-only member (${m1.totalCap}) should accept fewer total CAP than Ca3 worker (${m2.totalCap})`);
});

test('new member receives noticeably fewer CAP than standard members without starvation', () => {
  const result = autoDistributeCaps(DEFAULT_MEMBERS, DEFAULT_OFFERS, {
    ...DEFAULT_SETTINGS,
    leaderPriority: 'medium',
    newMemberMode: 'less',
  }, 100);
  assert.equal(result.ok, true);

  const leader = result.stats.memberTotalsMap['mem-trung-bao'];
  const newMember = result.stats.memberTotalsMap['mem-chi-hon'];
  const standards = result.stats.memberStats.filter((m) => !m.isLeader && !m.isNew);
  const avgStdCap = standards.reduce((s, m) => s + m.totalCap, 0) / standards.length;

  assert.ok(leader.totalCap >= avgStdCap, `Leader CAP (${leader.totalCap}) should be >= standard avg (${avgStdCap})`);
  assert.ok(
    newMember.totalCap <= avgStdCap - 3,
    `New member CAP (${newMember.totalCap}) should be at least 3 CAP less than standard avg (${avgStdCap})`
  );
  assert.ok(newMember.totalCap >= 3, `New member CAP (${newMember.totalCap}) should not be starved`);
});

test('Ca3 standard peers and non-Ca3 peers receive balanced points while non-Ca3 focuses on all-day offers with fewer CAP and 0 evening CAP', () => {
  const result = autoDistributeCaps(DEFAULT_MEMBERS, DEFAULT_OFFERS, DEFAULT_SETTINGS, 101);
  assert.equal(result.ok, true);
  assert.equal(result.autoEqualizedLeader, false);

  const leader = result.stats.memberTotalsMap['mem-trung-bao'];
  const ca3Standards = result.stats.memberStats.filter(
    (m) => !m.isLeader && !m.isNew && m.todayShifts.includes('ca3')
  );
  const ca3MaxPts = Math.max(...ca3Standards.map((m) => m.totalPoints));
  const ca3MinPts = Math.min(...ca3Standards.map((m) => m.totalPoints));
  const avgCa3Pts = ca3Standards.reduce((s, m) => s + m.totalPoints, 0) / ca3Standards.length;
  const avgCa3Cap = ca3Standards.reduce((s, m) => s + m.totalCap, 0) / ca3Standards.length;

  assert.ok(
    ca3MaxPts - ca3MinPts <= 10,
    `Ca3 standard point spread (${ca3MaxPts - ca3MinPts}) should be <= 10 point`
  );
  assert.ok(
    leader.totalPoints >= ca3MaxPts,
    `Leader points (${leader.totalPoints}) should be >= Ca3 peer max (${ca3MaxPts})`
  );
  assert.ok(
    leader.totalPoints - ca3MinPts <= 30,
    `Leader should only be slightly higher (${leader.totalPoints} vs ${ca3MinPts})`
  );

  // Uyen (Ca1, Ca2) and Chi Hon (Ca1, Ca2, new) work NO Ca3 today -> strictly 0 evening (21h30/23h) CAP and fewer total CAP,
  // while Uyen still keeps near-equal total points with Ca3 peers via high-point all-day offers!
  const uyen = result.stats.memberTotalsMap['mem-uyen'];
  const chiHon = result.stats.memberTotalsMap['mem-chi-hon'];
  assert.equal(uyen.eveningCap, 0, 'Non-Ca3 member (Ca1,2 today + Ca1 tomorrow) must get 0 evening (20h+) CAP');
  assert.equal(chiHon.eveningCap, 0, 'Non-Ca3 new member must get 0 evening (20h+) CAP');
  assert.ok(uyen.totalCap < avgCa3Cap, `Non-Ca3 standard member (${uyen.totalCap}) should take fewer CAP than Ca3 peers (${avgCa3Cap})`);
  assert.ok(
    Math.abs(uyen.totalPoints - avgCa3Pts) <= 15,
    `Non-Ca3 standard member points (${uyen.totalPoints}) should stay within 15pt of Ca3 avg (${avgCa3Pts})`
  );
  assert.ok(chiHon.totalCap <= uyen.totalCap - 3, `New non-Ca3 member (${chiHon.totalCap}) should take noticeably fewer CAP than standard non-Ca3 (${uyen.totalCap})`);

  // Huy Bao works Ca1, Ca3 today -> gets both morning & evening CAP normally
  const huyBao = result.stats.memberTotalsMap['mem-huy-bao'];
  assert.ok(huyBao.morningCap > 0 && huyBao.eveningCap > 0, 'Ca3 + Ca1-next-day member gets both morning and evening CAP normally');
});

test('parseCapHour and getShiftAffinity classify today Ca2/3 + next-day Ca1 accurately', () => {
  assert.equal(parseCapHour('10h'), 10);
  assert.equal(parseCapHour('21h30'), 21.5);
  assert.equal(parseCapHour('23h'), 23);
  assert.equal(getShiftAffinity('10h', { todayShifts: ['ca3'], nextDayShifts: ['ca1'] }), 1.0);
  assert.ok(getShiftAffinity('10h', { todayShifts: ['ca1'], nextDayShifts: ['ca3'] }) < 0.3);
  assert.equal(getShiftAffinity('23h', { todayShifts: ['ca2', 'ca3'], nextDayShifts: ['ca1'] }), 1.0);
  assert.ok(getShiftAffinity('23h', { todayShifts: ['ca1'], nextDayShifts: ['ca1'] }) < 0.3);
});

test('computeDistributionStats detects manual over/under allocation mismatches', () => {
  const result = autoDistributeCaps(DEFAULT_MEMBERS, DEFAULT_OFFERS, DEFAULT_SETTINGS, 1);
  const editedMatrix = structuredClone(result.matrix);
  editedMatrix['offer-1551']['mem-trung-bao'] += 2;

  const stats = computeDistributionStats(editedMatrix, DEFAULT_OFFERS, DEFAULT_MEMBERS);
  assert.equal(stats.isAllValid, false);
  assert.equal(stats.invalidCampaigns.length, 1);
  assert.equal(stats.invalidCampaigns[0].code, '1551');
  assert.equal(stats.invalidCampaigns[0].status, 'over');
  assert.equal(stats.invalidCampaigns[0].diff, 2);
});

test('buildDistributionWorkbook creates 3 formatted sheets and rejects mismatched totals', () => {
  const result = autoDistributeCaps(DEFAULT_MEMBERS, DEFAULT_OFFERS, DEFAULT_SETTINGS, 11);
  const wbRes = buildDistributionWorkbook({
    matrix: result.matrix,
    campaigns: DEFAULT_OFFERS,
    members: DEFAULT_MEMBERS,
    dateLabel: getTodayDateString(),
  });

  assert.equal(wbRes.ok, true);
  assert.deepEqual(wbRes.workbook.SheetNames, [
    'CHIA CAP CHI TIẾT',
    'TỔNG HỢP THÀNH VIÊN',
    'THỐNG KÊ',
  ]);

  const badMatrix = structuredClone(result.matrix);
  badMatrix['offer-1134']['mem-hieu'] = (badMatrix['offer-1134']['mem-hieu'] || 0) + 1;
  const badWbRes = buildDistributionWorkbook({
    matrix: badMatrix,
    campaigns: DEFAULT_OFFERS,
    members: DEFAULT_MEMBERS,
    dateLabel: getTodayDateString(),
  });
  assert.equal(badWbRes.ok, false);
});

test('loadFromStorage returns stored null without falling back to default', async () => {
  const { loadFromStorage } = await import('./storage.js');
  const prevWindow = globalThis.window;
  try {
    const store = new Map([['k_null', 'null'], ['k_obj', '{"a":1}']]);
    globalThis.window = {
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
      },
    };
    assert.equal(loadFromStorage('k_null', { fallback: true }), null);
    assert.deepEqual(loadFromStorage('k_obj', null), { a: 1 });
    assert.deepEqual(loadFromStorage('k_missing', { fallback: true }), { fallback: true });
  } finally {
    globalThis.window = prevWindow;
  }
});

test('hashPassword and verifyPassword produce 64-char hex SHA-256 and validate correctly', async () => {
  const { hashPassword, verifyPassword } = await import('./passwordCrypto.js');
  const { salt, passwordHash } = await hashPassword('secret123');
  assert.ok(salt.length >= 8);
  assert.match(passwordHash, /^[a-f0-9]{64}$/);
  assert.equal(await verifyPassword('secret123', salt, passwordHash), true);
  assert.equal(await verifyPassword('wrongpass', salt, passwordHash), false);
});

test('members off Ca 2, 3 today and Ca 1 tomorrow receive 0 CAP and do not distort spread', () => {
  const today = getTodayDateString();
  const tomorrow = addDaysToIso(today, 1);

  const testMembers = DEFAULT_MEMBERS.map((m) => {
    if (m.id === 'mem-hoai') {
      // Worked only Ca1 today (Ca2, Ca3 off) and works Ca2, Ca3 tomorrow (Ca1 off) -> 0 CAP!
      return {
        ...m,
        shiftSchedule: {
          [today]: ['ca1'],
          [tomorrow]: ['ca2', 'ca3'],
        },
      };
    }
    if (m.id === 'mem-hieu') {
      // Completely off today and off tomorrow -> 0 CAP!
      return {
        ...m,
        shiftSchedule: {
          [today]: [],
          [tomorrow]: [],
        },
      };
    }
    if (m.id === 'mem-uyen') {
      // Ca2, Ca3 off today, BUT works Ca1 tomorrow -> STILL eligible for 10h CAP!
      return {
        ...m,
        shiftSchedule: {
          [today]: ['ca1'],
          [tomorrow]: ['ca1'],
        },
      };
    }
    return m;
  });

  assert.equal(isMemberAvailableForCapCycle(testMembers.find((m) => m.id === 'mem-hoai'), today), false);
  assert.equal(isMemberAvailableForCapCycle(testMembers.find((m) => m.id === 'mem-hieu'), today), false);
  assert.equal(isMemberAvailableForCapCycle(testMembers.find((m) => m.id === 'mem-uyen'), today), true);

  const result = autoDistributeCaps(testMembers, DEFAULT_OFFERS, DEFAULT_SETTINGS, 77, today);
  assert.equal(result.ok, true);
  assert.equal(result.stats.isAllValid, true);
  assert.equal(result.stats.assignedTotalCap, 49);

  const hoaiStat = result.stats.memberTotalsMap['mem-hoai'];
  const hieuStat = result.stats.memberTotalsMap['mem-hieu'];
  const uyenStat = result.stats.memberTotalsMap['mem-uyen'];

  assert.equal(hoaiStat.totalCap, 0, 'Member off Ca 2,3 today and Ca 1 tomorrow must get 0 CAP');
  assert.equal(hoaiStat.totalPoints, 0);
  assert.equal(hieuStat.totalCap, 0, 'Fully resting member must get 0 CAP');
  assert.equal(hieuStat.totalPoints, 0);
  assert.ok(uyenStat.totalCap > 0, 'Member off Ca 2,3 today but working Ca 1 tomorrow must still receive CAP');
  assert.equal(uyenStat.eveningCap, 0, 'Member working only Ca 1 tomorrow without Ca 3 today gets 0 evening CAP');
  assert.ok(uyenStat.totalCap < result.stats.memberTotalsMap['mem-huy-bao'].totalCap, 'Non-Ca3 member gets fewer CAP than Ca3 worker');
});

test('autoDistributeCaps returns helpful error when all active members are off Ca 2, 3 today and Ca 1 tomorrow', () => {
  const today = getTodayDateString();
  const tomorrow = addDaysToIso(today, 1);
  const allResting = DEFAULT_MEMBERS.map((m) => ({
    ...m,
    shiftSchedule: {
      [today]: ['ca1'],
      [tomorrow]: ['ca2', 'ca3'],
    },
  }));
  const result = autoDistributeCaps(allResting, DEFAULT_OFFERS, DEFAULT_SETTINGS, 1, today);
  assert.equal(result.ok, false);
  assert.match(result.error, /Ca 2, Ca 3/);
});

test('when all members work and points divide evenly, Leader priority is skipped and everyone receives equal points', () => {
  const today = getTodayDateString();
  const tomorrow = addDaysToIso(today, 1);
  const allWorking = DEFAULT_MEMBERS.map((m) => ({
    ...m,
    isNew: false,
    shiftSchedule: {
      [today]: ['ca1', 'ca2', 'ca3'],
      [tomorrow]: ['ca1', 'ca2', 'ca3'],
    },
  }));

  // 48 CAP * 25 point = 1.200 point across 6 members -> exact 200 point each!
  const evenOffers = [
    { id: 'e1', code: '1769', name: 'Offer 10h A', totalCap: 18, pointsPerCap: 25, capHour: '10h' },
    { id: 'e2', code: '936', name: 'Offer 23h B', totalCap: 18, pointsPerCap: 25, capHour: '23h' },
    { id: 'e3', code: '1551', name: 'Offer 10h C', totalCap: 12, pointsPerCap: 25, capHour: '10h' },
  ];

  assert.equal(canDividePointsEqually(evenOffers, allWorking, allWorking), true);

  const result = autoDistributeCaps(
    allWorking,
    evenOffers,
    { ...DEFAULT_SETTINGS, leaderPriority: 'high', newMemberMode: 'normal' },
    42,
    today
  );
  assert.equal(result.ok, true);
  assert.equal(result.autoEqualizedLeader, true);
  assert.equal(result.stats.pointSpread, 0, 'All 6 members including Leader must receive exact equal 200 points');
  for (const stat of result.stats.memberStats) {
    assert.equal(stat.totalPoints, 200);
    assert.equal(stat.totalCap, 8);
  }
});

test('autoDistributeCaps preserves lockedCells and rejects over-locked offers', () => {
  const today = getTodayDateString();
  const baseMatrix = {
    'offer-1769': {
      'mem-trung-bao': 3,
      'mem-huy-bao': 0,
    },
  };
  const lockedCells = {
    'offer-1769': {
      'mem-trung-bao': true,
      'mem-huy-bao': true,
    },
  };

  const res = autoDistributeCaps(DEFAULT_MEMBERS, DEFAULT_OFFERS, DEFAULT_SETTINGS, 42, today, {
    lockedCells,
    baseMatrix,
  });
  assert.equal(res.ok, true);
  assert.equal(res.stats.isAllValid, true);
  assert.equal(res.matrix['offer-1769']['mem-trung-bao'], 3, 'Locked cell value 3 must stay untouched');
  assert.equal(res.matrix['offer-1769']['mem-huy-bao'], 0, 'Locked cell value 0 must stay untouched');

  const overLocked = autoDistributeCaps(DEFAULT_MEMBERS, DEFAULT_OFFERS, DEFAULT_SETTINGS, 42, today, {
    lockedCells: { 'offer-1769': { 'mem-trung-bao': true } },
    baseMatrix: { 'offer-1769': { 'mem-trung-bao': 99 } },
  });
  assert.equal(overLocked.ok, false);
  assert.match(overLocked.error, /vượt quá Tổng CAP/);
});

test('computeRolloverPointOffsets compensates previous day point deficit when useRolloverFairness is enabled', () => {
  const prevDate = '2026-11-19';
  const curDate = '2026-11-20';
  const nextDate = '2026-11-21';

  const peers = [
    { id: 'p1', name: 'A', isLeader: false, isNew: false, active: true, shiftSchedule: { [curDate]: ['ca1', 'ca2', 'ca3'], [nextDate]: ['ca1', 'ca2', 'ca3'] } },
    { id: 'p2', name: 'B', isLeader: false, isNew: false, active: true, shiftSchedule: { [curDate]: ['ca1', 'ca2', 'ca3'], [nextDate]: ['ca1', 'ca2', 'ca3'] } },
  ];

  const prevCampaigns = [
    { id: 'c1', code: '100', name: 'High', totalCap: 2, pointsPerCap: 40, capHour: '10h' },
    { id: 'c2', code: '200', name: 'Low', totalCap: 2, pointsPerCap: 20, capHour: '23h' },
  ];

  const history = [
    {
      id: 'h1',
      date: prevDate,
      members: peers,
      campaigns: prevCampaigns,
      matrix: {
        c1: { p1: 2, p2: 0 }, // p1 had 80 pts
        c2: { p1: 0, p2: 2 }, // p2 had 40 pts -> avg 60, p1=+20, p2=-20
      },
    },
  ];

  const rollover = computeRolloverPointOffsets(history, peers, curDate);
  assert.equal(rollover.sourceDate, prevDate);
  assert.equal(rollover.offsetsByMemberId.p1, 9);
  assert.equal(rollover.offsetsByMemberId.p2, -9);

  const curCampaigns = [
    { id: 'c3', code: '300', name: 'High', totalCap: 2, pointsPerCap: 35, capHour: '10h' },
    { id: 'c4', code: '400', name: 'Low', totalCap: 2, pointsPerCap: 20, capHour: '23h' },
  ];
  const res = autoDistributeCaps(
    peers,
    curCampaigns,
    { ...DEFAULT_SETTINGS, useRolloverFairness: true, leaderPriority: 'low' },
    11,
    curDate,
    { rolloverOffsets: rollover.offsetsByMemberId }
  );
  assert.equal(res.ok, true);
  assert.ok(
    res.stats.memberTotalsMap.p2.totalPoints > res.stats.memberTotalsMap.p1.totalPoints,
    'Member who trailed yesterday should receive more points today when rollover is enabled'
  );
});

test('parseQuickPastedOffers parses Google Sheets tab rows and matches existing codes', () => {
  const raw = [
    'ID\tName\tGiờ CAP\tTổng CAP\tĐiểm/CAP',
    '1769\tEverydayHealth Updated\t10h\t8\t40',
    '9999\tBrand New Offer\t23h\t4\t30',
    '1551\tOnly Two Columns',
    '8888\tBrand New Two Cols',
  ].join('\n');

  const res = parseQuickPastedOffers(raw, DEFAULT_OFFERS);
  assert.equal(res.ok, true);
  assert.equal(res.offers.length, 4);
  assert.equal(res.matchedCount, 2);
  assert.equal(res.newCount, 2);

  assert.equal(res.offers[0].id, 'offer-1769');
  assert.equal(res.offers[0].totalCap, 8);
  assert.equal(res.offers[0].pointsPerCap, 40);
  assert.equal(res.offers[1].code, '9999');
  assert.equal(res.offers[1].isExistingMatch, false);
  assert.equal(res.offers[2].capHour, '10h');
  assert.equal(res.offers[2].totalCap, 12);
  assert.equal(res.offers[3].code, '8888');
  assert.equal(res.offers[3].totalCap, 5);
});

test('shareText formats individual member schedule chronologically and full group summary', () => {
  const result = autoDistributeCaps(DEFAULT_MEMBERS, DEFAULT_OFFERS, DEFAULT_SETTINGS, 42, '2026-11-20');
  const member = DEFAULT_MEMBERS[0];
  const memberText = formatMemberCapScheduleText({
    member,
    campaigns: DEFAULT_OFFERS,
    matrix: result.matrix,
    stats: result.stats,
    distributionDate: '2026-11-20',
    groupName: 'Nhóm 1',
  });
  assert.match(memberText, /CAP 2026-11-20 \(Nhóm 1\)/);
  assert.match(memberText, new RegExp(member.name));

  const groupText = formatGroupDistributionSummaryText({
    groupName: 'Nhóm 1',
    distributionDate: '2026-11-20',
    members: DEFAULT_MEMBERS,
    campaigns: DEFAULT_OFFERS,
    matrix: result.matrix,
    stats: result.stats,
  });
  assert.match(groupText, /BẢNG CHIA CAP 2026-11-20 – Nhóm 1/);
  assert.match(groupText, /49 CAP/);
});

test('mergeOffersByCode deduplicates Excel/paste imports by offer code and preserves existing IDs', () => {
  const existing = [
    { id: 'offer-1769', code: '1769', name: 'Old Name', totalCap: 5, pointsPerCap: 35, capHour: '10h' },
    { id: 'offer-1551', code: '1551', name: 'Keep Me', totalCap: 12, pointsPerCap: 25, capHour: '10h' },
  ];
  const incoming = [
    { id: 'temp-1', code: '1769', name: 'First Import', totalCap: 6, pointsPerCap: 35, capHour: '10h' },
    { id: 'temp-2', code: '1769', name: 'Latest Import', totalCap: 9, pointsPerCap: 40, capHour: '21h30' },
    { id: 'temp-3', code: '2045', name: 'New Offer', totalCap: 4, pointsPerCap: 30, capHour: '23h' },
  ];

  const { merged, updatedCount, addedCount, duplicateInImportCount } = mergeOffersByCode(
    existing,
    incoming
  );

  assert.equal(merged.length, 3);
  assert.equal(updatedCount, 1);
  assert.equal(addedCount, 1);
  assert.equal(duplicateInImportCount, 1);

  const updated1769 = merged.find((o) => o.code === '1769');
  assert.equal(updated1769.id, 'offer-1769', 'Must preserve existing document/offer ID on merge');
  assert.equal(updated1769.name, 'Latest Import');
  assert.equal(updated1769.totalCap, 9);
  assert.equal(updated1769.capHour, '21h30');

  assert.deepEqual(
    findDuplicateOfferCodes([
      ...existing,
      { id: 'dup', code: '1551', name: 'Dup 1551', totalCap: 1, pointsPerCap: 20 },
    ]),
    [{ code: '1551', count: 2 }]
  );
  assert.deepEqual(findDuplicateOfferCodes(merged), []);
});

test('isEveningOnlyOffer distinguishes all-day 10h offers from 20h+ (21h30/23h) offers and detectDistributionShiftConflicts flags mismatches', () => {
  for (const camp of DEFAULT_OFFERS) {
    const isEve = isEveningOnlyOffer(camp);
    if (['1769', '1706', '1551'].includes(camp.code)) {
      assert.equal(isEve, false, `Offer ${camp.code} should be all-day / 10h`);
    } else {
      assert.equal(isEve, true, `Offer ${camp.code} should be evening-only (20h+)`);
    }
  }

  const today = getTodayDateString();
  const staleMatrix = {
    'offer-936': { 'mem-uyen': 2 }, // Uyen works Ca1, Ca2 (NO Ca3 today!)
  };
  const conflicts = detectDistributionShiftConflicts(staleMatrix, DEFAULT_OFFERS, DEFAULT_MEMBERS, today, true);
  assert.equal(conflicts.hasConflicts, true);
  assert.equal(conflicts.nonCa3OnEvening.length, 1);
  assert.equal(conflicts.nonCa3OnEvening[0].name, 'Uyên');
  assert.equal(conflicts.nonCa3OnEvening[0].offerCode, '936');

  // Leader manually pinning an overtime evening cell suppresses the shift-conflict nag
  const pinnedOvertime = detectDistributionShiftConflicts(
    staleMatrix,
    DEFAULT_OFFERS,
    DEFAULT_MEMBERS,
    today,
    true,
    { 'offer-936': { 'mem-uyen': true } }
  );
  assert.equal(pinnedOvertime.hasConflicts, false);
});

test('single-shift cycle workers (Uyen Ca1,2->2,3 and Long Ca1->1) receive noticeably fewer CAP and points than multi-shift Ca1,2,3 worker Hoai', () => {
  const today = '2026-11-22';
  const tomorrow = '2026-11-23';
  const team = [
    { id: 'mem-trung-bao', name: 'Trung Bảo', isLeader: true, isNew: false, active: true, priority: 'normal', shiftSchedule: { [today]: ['ca2', 'ca3'], [tomorrow]: ['ca2', 'ca3'] } },
    { id: 'mem-hieu', name: 'Hiếu', isLeader: false, isNew: false, active: true, priority: 'normal', shiftSchedule: { [today]: ['ca2', 'ca3'], [tomorrow]: ['ca2', 'ca3'] } },
    { id: 'mem-huy-bao', name: 'Huy Bảo', isLeader: false, isNew: false, active: true, priority: 'normal', shiftSchedule: { [today]: ['ca2', 'ca3'], [tomorrow]: ['ca2', 'ca3'] } },
    { id: 'mem-uyen', name: 'Uyên', isLeader: false, isNew: false, active: true, priority: 'normal', shiftSchedule: { [today]: ['ca1', 'ca2'], [tomorrow]: ['ca2', 'ca3'] } },
    { id: 'mem-hoai', name: 'Hoài', isLeader: false, isNew: false, active: true, priority: 'normal', shiftSchedule: { [today]: ['ca1', 'ca2', 'ca3'], [tomorrow]: ['ca2', 'ca3'] } },
    { id: 'mem-chi-hon', name: 'Chi Hon', isLeader: false, isNew: true, active: true, priority: 'normal', shiftSchedule: { [today]: ['ca2', 'ca3'], [tomorrow]: ['ca2', 'ca3'] } },
    { id: 'mem-long', name: 'Long', isLeader: false, isNew: false, active: true, priority: 'normal', shiftSchedule: { [today]: ['ca1'], [tomorrow]: ['ca1'] } },
  ];

  assert.equal(getCapCycleShiftCount(team[4], today), 2); // Hoai: today Ca2 + Ca3
  assert.equal(getCapCycleShiftCount(team[3], today), 1); // Uyen: only today Ca2
  assert.equal(getCapCycleShiftCount(team[6], today), 1); // Long: only tomorrow Ca1

  const res = autoDistributeCaps(
    team,
    DEFAULT_OFFERS,
    { ...DEFAULT_SETTINGS, leaderPriority: 'medium', newMemberMode: 'normal', useShiftMatching: true },
    101,
    today
  );
  assert.equal(res.ok, true);

  const hoai = res.stats.memberTotalsMap['mem-hoai'];
  const uyen = res.stats.memberTotalsMap['mem-uyen'];
  const longMem = res.stats.memberTotalsMap['mem-long'];
  const hieu = res.stats.memberTotalsMap['mem-hieu'];

  assert.equal(hoai.totalPoints, hieu.totalPoints, 'Multi-shift Hoai should match Hieu points');
  assert.ok(hoai.totalCap >= uyen.totalCap + 3, `Hoai (${hoai.totalCap}) should receive >=3 more CAP than 1-shift Uyen (${uyen.totalCap})`);
  assert.ok(hoai.totalCap >= longMem.totalCap + 3, `Hoai (${hoai.totalCap}) should receive >=3 more CAP than 1-shift Long (${longMem.totalCap})`);
  assert.ok(hoai.totalPoints > uyen.totalPoints + 40, `Multi-shift Hoai (${hoai.totalPoints}pt) should earn clearly more points than 1-shift Uyen (${uyen.totalPoints}pt)`);
  assert.equal(uyen.eveningCap, 0);
  assert.equal(longMem.eveningCap, 0);
});

test('leaderPriority "normal" (Chia binh thuong) assigns Leader equal weight and equal points with same-shift peers', () => {
  const today = '2026-11-22';
  const tomorrow = '2026-11-23';
  const equalPeers = [
    { id: 'leader', name: 'Trung Bảo', isLeader: true, isNew: false, active: true, priority: 'normal', shiftSchedule: { [today]: ['ca2', 'ca3'], [tomorrow]: ['ca2', 'ca3'] } },
    { id: 'm1', name: 'Hiếu', isLeader: false, isNew: false, active: true, priority: 'normal', shiftSchedule: { [today]: ['ca2', 'ca3'], [tomorrow]: ['ca2', 'ca3'] } },
    { id: 'm2', name: 'Huy Bảo', isLeader: false, isNew: false, active: true, priority: 'normal', shiftSchedule: { [today]: ['ca2', 'ca3'], [tomorrow]: ['ca2', 'ca3'] } },
    { id: 'm3', name: 'Hoài', isLeader: false, isNew: false, active: true, priority: 'normal', shiftSchedule: { [today]: ['ca2', 'ca3'], [tomorrow]: ['ca2', 'ca3'] } },
  ];

  // Exactly divisible total: 4 * 120 = 480 pts across 4 identical-schedule members
  const campaigns = [
    { id: 'c1', code: '101', name: 'Offer 30', totalCap: 8, pointsPerCap: 30, capHour: '10h' },
    { id: 'c2', code: '102', name: 'Offer 20', totalCap: 12, pointsPerCap: 20, capHour: '23h' },
  ];

  const cfg = { ...DEFAULT_SETTINGS, leaderPriority: 'normal', newMemberMode: 'normal' };
  assert.equal(getMemberTargetWeight(equalPeers[0], cfg), 1.0);
  assert.equal(getMemberPointWeight(equalPeers[0], cfg), 1.0);

  const res = autoDistributeCaps(equalPeers, campaigns, cfg, 77, today);
  assert.equal(res.ok, true);
  assert.equal(res.stats.pointSpread, 0, 'With leaderPriority normal and divisible offers, pointSpread should be 0');
  assert.equal(res.stats.capSpread, 0, 'With leaderPriority normal and divisible offers, capSpread should be 0');

  // Even when points are NOT evenly divisible (e.g. +20pt extra), normal mode should NOT force Leader higher than peers
  // across non-divisible offers compared to 'high' priority
  const nonDivisibleCamps = [
    { id: 'c1', code: '101', name: 'Offer 35', totalCap: 4, pointsPerCap: 35, capHour: '10h' },
    { id: 'c2', code: '102', name: 'Offer 25', totalCap: 9, pointsPerCap: 25, capHour: '23h' },
  ];
  const resNormal = autoDistributeCaps(equalPeers, nonDivisibleCamps, cfg, 55, today);
  const resHigh = autoDistributeCaps(equalPeers, nonDivisibleCamps, { ...cfg, leaderPriority: 'high' }, 55, today);
  assert.equal(resNormal.ok, true);
  assert.equal(resHigh.ok, true);
  assert.ok(resNormal.stats.pointSpread <= 25, 'Normal mode keeps Leader and peers tightly balanced');
  assert.ok(
    resHigh.stats.memberTotalsMap.leader.totalPoints >= resNormal.stats.memberTotalsMap.leader.totalPoints,
    'High leader priority should give Leader >= normal leader priority points'
  );
});

test('offers with totalCap = 0 distribute 0 CAP cleanly without validation errors', () => {
  const today = '2026-11-24';
  const zeroOfferMixed = [
    { id: 'o-zero', code: '999', name: 'Paused Offer', totalCap: 0, pointsPerCap: 35, capHour: '10h' },
    { id: 'o-live', code: '1769', name: 'Active Offer', totalCap: 6, pointsPerCap: 25, capHour: '10h' },
  ];

  const mixedRes = autoDistributeCaps(DEFAULT_MEMBERS, zeroOfferMixed, DEFAULT_SETTINGS, 42, today);
  assert.equal(mixedRes.ok, true);
  assert.equal(mixedRes.stats.isAllValid, true);
  assert.equal(mixedRes.stats.expectedTotalCap, 6);
  assert.equal(mixedRes.stats.assignedTotalCap, 6);
  for (const m of DEFAULT_MEMBERS) {
    assert.equal(mixedRes.matrix['o-zero'][m.id] || 0, 0);
  }

  const allZeroOffers = [
    { id: 'o-z1', code: '991', name: 'Paused Offer A', totalCap: 0, pointsPerCap: 30, capHour: '10h' },
    { id: 'o-z2', code: '992', name: 'Paused Offer B', totalCap: 0, pointsPerCap: 20, capHour: '23h' },
  ];
  const zeroRes = autoDistributeCaps(DEFAULT_MEMBERS, allZeroOffers, DEFAULT_SETTINGS, 42, today);
  assert.equal(zeroRes.ok, true);
  assert.equal(zeroRes.stats.isAllValid, true);
  assert.equal(zeroRes.stats.expectedTotalCap, 0);
  assert.equal(zeroRes.stats.assignedTotalCap, 0);
});

test('getActiveOffers excludes hidden offers and preserves hidden flag on paste/merge', () => {
  const offers = [
    { id: 'offer-1769', code: '1769', name: 'Visible Offer', totalCap: 6, pointsPerCap: 35, capHour: '10h', hidden: false },
    { id: 'offer-1551', code: '1551', name: 'Hidden Offer', totalCap: 12, pointsPerCap: 25, capHour: '10h', hidden: true },
  ];

  const active = getActiveOffers(offers);
  assert.equal(active.length, 1);
  assert.equal(active[0].code, '1769');

  const dist = autoDistributeCaps(DEFAULT_MEMBERS, active, DEFAULT_SETTINGS, 42, '2026-11-24');
  assert.equal(dist.ok, true);
  assert.equal(dist.stats.expectedTotalCap, 6);
  assert.equal(dist.stats.assignedTotalCap, 6);

  const pasted = parseQuickPastedOffers(
    'ID\tName\tGiờ CAP chung\tTổng CAP\tĐiểm/CAP\n1551\tUpdated Hidden Offer\t10h\t10\t25',
    offers
  );
  assert.equal(pasted.ok, true);
  assert.equal(pasted.offers[0].hidden, true);

  const { merged } = mergeOffersByCode(offers, pasted.offers);
  const matched1551 = merged.find((o) => o.code === '1551');
  assert.equal(matched1551.hidden, true);
  assert.equal(matched1551.totalCap, 10);
});




