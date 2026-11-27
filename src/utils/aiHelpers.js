import {
  autoDistributeCaps,
  computeDistributionStats,
  getCampaignTimeBucket,
  getEligibleMembersForCampaign,
  normalizeMatrix,
  parseCapHour,
  sortOffersByPointsDesc,
} from './capAlgorithm.js';
import { addDaysToIso, createId } from './storage.js';
import { extractOfferNameCode } from './telegramMessages.js';

/**
 * Normalize AI-extracted offers into clean CAP Manager offer records ready for review/merge.
 * @param {Array<any>} rawItems
 * @param {Array<any>} existingOffers
 * @returns {{ offers: Array<any>, matchedCount: number, newCount: number }}
 */
export function normalizeAiParsedOffers(rawItems = [], existingOffers = []) {
  const existingByCode = new Map();
  for (const off of existingOffers || []) {
    if (off?.code) {
      existingByCode.set(String(off.code).trim().toLowerCase(), off);
    }
  }

  const seenCodes = new Set();
  const offers = [];
  let matchedCount = 0;
  let newCount = 0;

  for (const raw of Array.isArray(rawItems) ? rawItems : []) {
    const code = String(raw?.code || '').trim().slice(0, 50);
    const name = String(raw?.name || '').trim().slice(0, 200);
    if (!code && !name) continue;

    const resolvedCode = code || extractOfferNameCode({ name }) || `OF-${offers.length + 1}`;
    const codeKey = resolvedCode.toLowerCase();
    if (seenCodes.has(codeKey)) continue;
    seenCodes.add(codeKey);

    const existing = existingByCode.get(codeKey) || null;
    if (existing) matchedCount++;
    else newCount++;

    const rawHour = String(raw?.capHour || '').trim();
    const parsedHour = parseCapHour(rawHour);
    const cleanHour =
      parsedHour !== null
        ? rawHour.slice(0, 20)
        : existing?.capHour || '10h';

    const totalCapNum = Math.round(Number(raw?.totalCap));
    const totalCap =
      Number.isFinite(totalCapNum) && totalCapNum >= 0
        ? Math.min(10000, totalCapNum)
        : Number(existing?.totalCap ?? 5);

    const ptsNum = Math.round(Number(raw?.pointsPerCap));
    const pointsPerCap =
      Number.isFinite(ptsNum) && ptsNum > 0
        ? Math.min(100000, ptsNum)
        : Number(existing?.pointsPerCap ?? 25);

    const eligibilityType = ['all', 'exclude_new', 'custom'].includes(raw?.eligibilityType)
      ? raw.eligibilityType
      : existing?.eligibilityType || 'all';

    offers.push({
      id: existing?.id || createId('offer'),
      code: resolvedCode,
      name: name || existing?.name || resolvedCode,
      capHour: cleanHour,
      totalCap,
      pointsPerCap,
      timeWindow: String(raw?.timeWindow || existing?.timeWindow || `${cleanHour} (Cả ngày)`).slice(0, 80),
      note: String(raw?.note || existing?.note || '').trim().slice(0, 300),
      condition:
        eligibilityType === 'exclude_new'
          ? 'Không áp dụng cho thành viên mới'
          : existing?.condition || 'Tất cả thành viên',
      eligibilityType,
      eligibleMemberIds: Array.isArray(existing?.eligibleMemberIds) ? existing.eligibleMemberIds : [],
      hidden: Boolean(existing?.hidden),
      isExistingMatch: Boolean(existing),
    });
  }

  return { offers, matchedCount, newCount };
}

function buildMemberDiffs(members, prevStats, nextStats) {
  const diffs = [];
  for (const m of members || []) {
    const prev = prevStats?.memberTotalsMap?.[m.id];
    const next = nextStats?.memberTotalsMap?.[m.id];
    const prevCap = prev?.totalCap ?? 0;
    const nextCap = next?.totalCap ?? 0;
    const prevPoints = prev?.totalPoints ?? 0;
    const nextPoints = next?.totalPoints ?? 0;
    const deltaCap = nextCap - prevCap;
    const deltaPoints = nextPoints - prevPoints;
    if (deltaCap !== 0 || deltaPoints !== 0) {
      diffs.push({
        memberId: m.id,
        name: m.name,
        prevCap,
        nextCap,
        deltaCap,
        prevPoints,
        nextPoints,
        deltaPoints,
      });
    }
  }
  return diffs;
}

/**
 * Apply structured AI natural-language distribution directives safely.
 * Supports direct edits (`transfers`, `pinCells`, `actionMode: 'edit_only'`),
 * temporary shift overrides, whole-member/offer locks, exclusions, and strong target adjustments.
 */
export function applyAiDistributionDirectives(directives, context) {
  const {
    members = [],
    campaigns = [],
    baseMatrix = {},
    lockedCells = {},
    settings = {},
    dateStr,
    rolloverOffsets = {},
    seed = 701,
  } = context || {};

  const prevStats = computeDistributionStats(baseMatrix, campaigns, members, dateStr);
  const nextMatrix = normalizeMatrix(baseMatrix, campaigns, members);
  const nextLocked = {};
  for (const camp of campaigns) {
    nextLocked[camp.id] = { ...(lockedCells?.[camp.id] || {}) };
  }

  const validMemberIds = new Set(members.map((m) => m.id));
  const validOfferIds = new Set(campaigns.map((c) => c.id));
  const appliedRules = [];

  let adjustedMembers = members.map((m) => ({
    ...m,
    shiftSchedule: { ...(m.shiftSchedule || {}) },
  }));

  // 1. Temporary shift overrides for this optimization run
  const hasShiftOverrides =
    Array.isArray(directives?.overrideMemberShifts) && directives.overrideMemberShifts.length > 0;
  for (const ov of directives?.overrideMemberShifts || []) {
    if (!validMemberIds.has(ov?.memberId) || !dateStr) continue;
    const targetDay = ov.day === 'tomorrow' ? addDaysToIso(dateStr, 1) : dateStr;
    const cleanShifts = Array.isArray(ov.shifts)
      ? ov.shifts.filter((s) => ['ca1', 'ca2', 'ca3'].includes(s))
      : [];
    adjustedMembers = adjustedMembers.map((m) =>
      m.id === ov.memberId
        ? {
            ...m,
            shiftSchedule: { ...(m.shiftSchedule || {}), [targetDay]: cleanShifts },
          }
        : m
    );
    const memName = members.find((m) => m.id === ov.memberId)?.name || ov.memberId;
    appliedRules.push(
      `Ca ${ov.day === 'tomorrow' ? 'ngày mai' : 'hôm nay'} của ${memName}: ${cleanShifts.length > 0 ? cleanShifts.join(', ') : 'Nghỉ'}`
    );
  }

  // 2. Whole-member & whole-offer locks
  for (const memId of directives?.lockMemberIds || []) {
    if (!validMemberIds.has(memId)) continue;
    for (const camp of campaigns) {
      nextLocked[camp.id][memId] = true;
    }
    const memName = members.find((m) => m.id === memId)?.name || memId;
    appliedRules.push(`Giữ nguyên CAP của ${memName}`);
  }

  for (const offerId of directives?.lockOfferIds || []) {
    if (!validOfferIds.has(offerId)) continue;
    for (const mem of members) {
      nextLocked[offerId][mem.id] = true;
    }
    const offCode = campaigns.find((c) => c.id === offerId)?.code || offerId;
    appliedRules.push(`Giữ nguyên offer ${offCode}`);
  }

  // 3. Whole-member exclusions & only-include lists
  const excludeSet = new Set(
    (directives?.excludeMemberIds || []).filter((id) => validMemberIds.has(id))
  );
  const onlyIncludeRaw = (directives?.onlyIncludeMemberIds || []).filter((id) =>
    validMemberIds.has(id)
  );
  if (onlyIncludeRaw.length > 0) {
    const includeSet = new Set(onlyIncludeRaw);
    for (const mem of members) {
      if (!includeSet.has(mem.id)) {
        excludeSet.add(mem.id);
      }
    }
  }
  for (const memId of excludeSet) {
    for (const camp of campaigns) {
      nextMatrix[camp.id][memId] = 0;
      nextLocked[camp.id][memId] = true;
    }
    const memName = members.find((m) => m.id === memId)?.name || memId;
    appliedRules.push(`Không chia CAP cho ${memName}`);
  }

  // 4. Hour-bucket exclusions & specific cell exclusions
  for (const item of directives?.excludeMemberFromHourBuckets || []) {
    if (!validMemberIds.has(item?.memberId)) continue;
    const targetBucket = String(item?.bucket || '').toLowerCase();
    for (const camp of campaigns) {
      const campBucket = getCampaignTimeBucket(camp.capHour);
      const cleanHour = String(camp.capHour || '').trim().toLowerCase();
      const matched =
        targetBucket === 'all' ||
        campBucket === targetBucket ||
        (targetBucket && cleanHour.includes(targetBucket));
      if (matched) {
        nextMatrix[camp.id][item.memberId] = 0;
        nextLocked[camp.id][item.memberId] = true;
      }
    }
    const memName = members.find((m) => m.id === item.memberId)?.name || item.memberId;
    appliedRules.push(`Không chia khung ${item.bucket} cho ${memName}`);
  }

  for (const cell of directives?.excludeCells || []) {
    if (!validMemberIds.has(cell?.memberId) || !validOfferIds.has(cell?.offerId)) continue;
    nextMatrix[cell.offerId][cell.memberId] = 0;
    nextLocked[cell.offerId][cell.memberId] = true;
  }

  // 5. Direct cell pins
  for (const pin of directives?.pinCells || []) {
    if (!validMemberIds.has(pin?.memberId) || !validOfferIds.has(pin?.offerId)) continue;
    const qty = Math.max(0, Math.min(500, Math.floor(Number(pin.qty) || 0)));
    nextMatrix[pin.offerId][pin.memberId] = qty;
    nextLocked[pin.offerId][pin.memberId] = true;
    const memName = members.find((m) => m.id === pin.memberId)?.name || pin.memberId;
    const offCode = campaigns.find((c) => c.id === pin.offerId)?.code || pin.offerId;
    appliedRules.push(`Ghim ${memName} = ${qty} CAP (${offCode})`);
  }

  // 6. Direct CAP transfers between members (preserves offer totals cleanly!)
  let hasTransfers = false;
  for (const tr of directives?.transfers || []) {
    const fromId = tr?.fromMemberId;
    const toId = tr?.toMemberId;
    if (!validMemberIds.has(fromId) || !validMemberIds.has(toId) || fromId === toId) continue;
    let remainingToMove = Math.max(1, Math.min(200, Math.floor(Number(tr.qty) || 1)));
    const preferredOffers =
      tr.offerId && validOfferIds.has(tr.offerId)
        ? campaigns.filter((c) => c.id === tr.offerId)
        : [...campaigns].sort((a, b) => {
            const toMem = adjustedMembers.find((m) => m.id === toId);
            const eligA = toMem
              ? getEligibleMembersForCampaign(a, adjustedMembers, dateStr, { useShiftMatching: true }).some(
                  (m) => m.id === toId
                )
              : false;
            const eligB = toMem
              ? getEligibleMembersForCampaign(b, adjustedMembers, dateStr, { useShiftMatching: true }).some(
                  (m) => m.id === toId
                )
              : false;
            if (eligA !== eligB) return eligA ? -1 : 1;
            return (Number(b.pointsPerCap) || 0) - (Number(a.pointsPerCap) || 0);
          });

    let movedTotal = 0;
    const movedCodes = [];
    for (const camp of preferredOffers) {
      if (remainingToMove <= 0) break;
      const available = Math.max(0, Math.floor(Number(nextMatrix[camp.id]?.[fromId]) || 0));
      if (available <= 0) continue;
      const take = Math.min(available, remainingToMove);
      nextMatrix[camp.id][fromId] = available - take;
      nextMatrix[camp.id][toId] = (Number(nextMatrix[camp.id][toId]) || 0) + take;
      nextLocked[camp.id][fromId] = true;
      nextLocked[camp.id][toId] = true;
      remainingToMove -= take;
      movedTotal += take;
      movedCodes.push(camp.code);
    }

    if (movedTotal > 0) {
      hasTransfers = true;
      const fromName = members.find((m) => m.id === fromId)?.name || fromId;
      const toName = members.find((m) => m.id === toId)?.name || toId;
      appliedRules.push(
        `Chuyển ${movedTotal} CAP (${movedCodes.join(', ')}) từ ${fromName} ➔ ${toName}`
      );
    }
  }

  // 7. Member target / priority directives
  const memberDirectivesById = {};
  for (const adj of directives?.memberTargetAdjustments || []) {
    if (!validMemberIds.has(adj?.memberId) || excludeSet.has(adj?.memberId)) continue;
    const mode = adj.mode;
    const rawVal = Math.round(Number(adj.value) || 0);
    if (mode === 'exact_cap') {
      memberDirectivesById[adj.memberId] = { kind: 'exact_cap', value: Math.max(0, rawVal) };
      const memName = members.find((m) => m.id === adj.memberId)?.name || adj.memberId;
      appliedRules.push(`Đặt mục tiêu ${memName} ≈ ${Math.max(0, rawVal)} CAP`);
    } else if (mode === 'delta_cap' && rawVal !== 0) {
      const currentCap = prevStats?.memberTotalsMap?.[adj.memberId]?.totalCap ?? 0;
      if ((prevStats?.assignedTotalCap ?? 0) > 0) {
        const target = Math.max(0, currentCap + rawVal);
        memberDirectivesById[adj.memberId] = { kind: 'exact_cap', value: target };
      } else {
        memberDirectivesById[adj.memberId] = { kind: 'delta_cap', value: rawVal };
      }
      const memName = members.find((m) => m.id === adj.memberId)?.name || adj.memberId;
      appliedRules.push(`${rawVal > 0 ? 'Tăng' : 'Giảm'} ${Math.abs(rawVal)} CAP cho ${memName}`);
    } else if (mode === 'boost' || mode === 'reduce') {
      memberDirectivesById[adj.memberId] = { kind: mode, value: 1 };
    }
  }

  const boostSet = new Set((directives?.boostMemberIds || []).filter((id) => validMemberIds.has(id)));
  const reduceSet = new Set((directives?.reduceMemberIds || []).filter((id) => validMemberIds.has(id)));

  for (const id of boostSet) {
    if (!memberDirectivesById[id] && !excludeSet.has(id)) {
      memberDirectivesById[id] = { kind: 'boost', value: 1 };
      const memName = members.find((m) => m.id === id)?.name || id;
      appliedRules.push(`Ưu tiên thêm cho ${memName}`);
    }
  }
  for (const id of reduceSet) {
    if (!memberDirectivesById[id] && !excludeSet.has(id)) {
      memberDirectivesById[id] = { kind: 'reduce', value: 1 };
      const memName = members.find((m) => m.id === id)?.name || id;
      appliedRules.push(`Giảm bớt tỷ lệ cho ${memName}`);
    }
  }

  adjustedMembers = adjustedMembers.map((m) => {
    const dir = memberDirectivesById[m.id];
    if (dir?.kind === 'boost') return { ...m, priority: 'high' };
    if (dir?.kind === 'reduce') return { ...m, priority: 'low' };
    return m;
  });

  const mergedRollover = { ...rolloverOffsets };
  for (const id of Object.keys(memberDirectivesById)) {
    const k = memberDirectivesById[id].kind;
    if (k === 'boost') {
      mergedRollover[id] = Math.max(-24, (Number(mergedRollover[id]) || 0) - 20);
    } else if (k === 'reduce') {
      mergedRollover[id] = Math.min(24, (Number(mergedRollover[id]) || 0) + 20);
    }
  }

  const hasSettingsPatch = Boolean(
    directives?.settingsPatch &&
      directives.settingsPatch.applySettings &&
      typeof directives.settingsPatch === 'object'
  );

  const nextSettings = {
    ...settings,
    ...(hasSettingsPatch
      ? {
          ...(typeof directives.settingsPatch.useShiftMatching === 'boolean'
            ? { useShiftMatching: directives.settingsPatch.useShiftMatching }
            : {}),
          ...(typeof directives.settingsPatch.useRolloverFairness === 'boolean'
            ? { useRolloverFairness: directives.settingsPatch.useRolloverFairness }
            : {}),
          ...( ['normal', 'low', 'medium', 'high'].includes(directives.settingsPatch.leaderPriority)
            ? { leaderPriority: directives.settingsPatch.leaderPriority }
            : {}),
          ...( ['less', 'normal'].includes(directives.settingsPatch.newMemberMode)
            ? { newMemberMode: directives.settingsPatch.newMemberMode }
            : {}),
        }
      : {}),
    useRolloverFairness:
      boostSet.size > 0 || reduceSet.size > 0 ? true : Boolean(settings?.useRolloverFairness),
  };

  // 8. Execute 'edit_only' cleanly when direct matrix edits keep offer totals valid
  const wantsEditOnly =
    directives?.actionMode === 'edit_only' &&
    Object.keys(memberDirectivesById).length === 0 &&
    !hasSettingsPatch &&
    !hasShiftOverrides &&
    excludeSet.size === 0 &&
    (hasTransfers || (directives?.pinCells?.length || 0) > 0);

  if (wantsEditOnly) {
    const editStats = computeDistributionStats(nextMatrix, campaigns, adjustedMembers, dateStr);
    if (editStats.isAllValid) {
      return {
        ok: true,
        matrix: editStats.matrix,
        stats: editStats,
        alternatives: [],
        lockedCells: nextLocked,
        memberDiffs: buildMemberDiffs(members, prevStats, editStats),
        appliedSummary: directives?.summary || appliedRules.join(' · ') || 'Đã cập nhật trực tiếp bảng chia CAP.',
      };
    }
  }

  const res = autoDistributeCaps(adjustedMembers, campaigns, nextSettings, seed, dateStr, {
    lockedCells: nextLocked,
    baseMatrix: nextMatrix,
    rolloverOffsets: mergedRollover,
    memberDirectivesById,
  });

  if (!res.ok) {
    return { ok: false, error: res.error, lockedCells: nextLocked };
  }

  return {
    ok: true,
    matrix: res.matrix,
    stats: res.stats,
    alternatives: res.alternatives || [],
    lockedCells: nextLocked,
    memberDiffs: buildMemberDiffs(members, prevStats, res.stats),
    appliedSummary: directives?.summary || appliedRules.join(' · ') || 'Đã áp dụng yêu cầu chia CAP.',
  };
}

/**
 * Aggregate exact multi-day stats from Firestore history & completions for AI Audit / Analytics Q&A.
 * Keeps data compact and deterministic so AI never guesses metrics.
 */
export function computeAnalyticsDataset(history = [], completions = {}, members = [], campaigns = []) {
  const sortedHistory = [...(Array.isArray(history) ? history : [])]
    .filter((h) => h && h.date && h.matrix)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, 30);

  const memberAcc = new Map();
  for (const mem of members) {
    if (!mem?.id) continue;
    memberAcc.set(mem.id, {
      memberId: mem.id,
      name: mem.name,
      isLeader: Boolean(mem.isLeader),
      isNew: Boolean(mem.isNew),
      active: mem.active !== false,
      daysParticipated: 0,
      totalCap: 0,
      totalPoints: 0,
      eveningCap: 0,
      morningCap: 0,
      completedCap: 0,
    });
  }

  const dailyRecords = [];

  for (const rec of sortedHistory) {
    const recMembers = Array.isArray(rec.members) && rec.members.length > 0 ? rec.members : members;
    const recOffers = sortOffersByPointsDesc(Array.isArray(rec.campaigns) ? rec.campaigns : campaigns);
    const recStats = computeDistributionStats(rec.matrix, recOffers, recMembers, rec.date);
    const dateComp = completions?.[rec.date] || {};

    let dayCompletedCap = 0;
    for (const mStat of recStats.memberStats) {
      if (!memberAcc.has(mStat.memberId)) {
        memberAcc.set(mStat.memberId, {
          memberId: mStat.memberId,
          name: mStat.name,
          isLeader: mStat.isLeader,
          isNew: mStat.isNew,
          active: mStat.active,
          daysParticipated: 0,
          totalCap: 0,
          totalPoints: 0,
          eveningCap: 0,
          morningCap: 0,
          completedCap: 0,
        });
      }
      const acc = memberAcc.get(mStat.memberId);
      if (mStat.totalCap > 0) acc.daysParticipated += 1;
      acc.totalCap += mStat.totalCap;
      acc.totalPoints += mStat.totalPoints;
      acc.eveningCap += mStat.eveningCap;
      acc.morningCap += mStat.morningCap;

      let memDoneDay = 0;
      for (const camp of recOffers) {
        const qty = Number(rec.matrix?.[camp.id]?.[mStat.memberId] || 0);
        if (qty > 0 && dateComp?.[camp.id]?.[mStat.memberId]) {
          memDoneDay += qty;
        }
      }
      acc.completedCap += memDoneDay;
      dayCompletedCap += memDoneDay;
    }

    dailyRecords.push({
      date: rec.date,
      totalCap: recStats.assignedTotalCap,
      totalPoints: recStats.assignedTotalPoints,
      completedCap: dayCompletedCap,
      capSpread: recStats.capSpread,
      pointSpread: recStats.pointSpread,
      offerCount: recOffers.length,
    });
  }

  const memberSummaries = [...memberAcc.values()].map((m) => ({
    ...m,
    completionRatePct: m.totalCap > 0 ? Math.round((m.completedCap / m.totalCap) * 100) : 0,
    avgCapPerDay: m.daysParticipated > 0 ? Number((m.totalCap / m.daysParticipated).toFixed(1)) : 0,
  }));

  return {
    dayCount: dailyRecords.length,
    dateRange:
      dailyRecords.length > 0
        ? `${dailyRecords[dailyRecords.length - 1].date} -> ${dailyRecords[0].date}`
        : 'Chưa có lịch sử',
    memberSummaries,
    dailyRecords: dailyRecords.slice(0, 14),
  };
}

/**
 * Pure CAP transfer helper: moves `qty` units of `offerId` from `fromMemberId` to `toMemberId`.
 * Updates both the saved day record (and stats) and optionally the active draft matrix.
 * @param {{
 *   matrix?: Record<string, any>,
 *   record?: any,
 *   completions?: Record<string, any>,
 *   dateStr: string,
 *   offerId: string,
 *   fromMemberId: string,
 *   toMemberId: string,
 *   qty: number,
 *   members: Array<any>,
 *   campaigns: Array<any>,
 * }} params
 */
export function applyCapTransferToState({
  matrix = null,
  record = null,
  completions = {},
  dateStr,
  offerId,
  fromMemberId,
  toMemberId,
  qty,
  members = [],
  campaigns = [],
}) {
  const transferQty = Math.floor(Number(qty) || 0);
  if (transferQty <= 0) {
    return { ok: false, error: 'Số CAP nhượng phải lớn hơn 0.' };
  }
  if (!fromMemberId || !toMemberId || fromMemberId === toMemberId) {
    return { ok: false, error: 'Người nhượng và người nhận phải khác nhau.' };
  }

  const sourceMatrix = record?.matrix || matrix;
  const sourceMembers =
    Array.isArray(record?.members) && record.members.length > 0 ? record.members : members;
  const sourceOffers =
    Array.isArray(record?.campaigns) && record.campaigns.length > 0 ? record.campaigns : campaigns;

  if (!sourceMatrix || !sourceMatrix[offerId]) {
    return { ok: false, error: 'Không tìm thấy offer trong bảng chia CAP ngày này.' };
  }

  const currentFrom = Math.max(0, Math.floor(Number(sourceMatrix[offerId]?.[fromMemberId]) || 0));
  if (currentFrom < transferQty) {
    return {
      ok: false,
      error: `Thành viên nhượng chỉ đang có ${currentFrom} CAP ở offer này (không đủ ${transferQty} CAP).`,
    };
  }

  const applyToMat = (mat) => {
    if (!mat) return null;
    const next = structuredClone(mat);
    if (!next[offerId]) next[offerId] = {};
    const prevFrom = Math.max(0, Math.floor(Number(next[offerId][fromMemberId]) || 0));
    const prevTo = Math.max(0, Math.floor(Number(next[offerId][toMemberId]) || 0));
    next[offerId][fromMemberId] = Math.max(0, prevFrom - transferQty);
    next[offerId][toMemberId] = prevTo + transferQty;
    return next;
  };

  const nextRecordMatrix = record ? applyToMat(record.matrix) : null;
  const nextGroupMatrix = matrix ? applyToMat(matrix) : null;

  let nextRecord = null;
  if (record && nextRecordMatrix) {
    const recomputed = computeDistributionStats(
      nextRecordMatrix,
      sourceOffers,
      sourceMembers,
      record.date || dateStr
    );
    nextRecord = {
      ...record,
      matrix: recomputed.matrix,
      stats: {
        assignedTotalCap: recomputed.assignedTotalCap,
        expectedTotalCap: recomputed.expectedTotalCap,
        assignedTotalPoints: recomputed.assignedTotalPoints,
        capSpread: recomputed.capSpread,
        pointSpread: recomputed.pointSpread,
      },
    };
  }

  const nextCompletions = structuredClone(completions || {});
  const remainingFrom = nextRecordMatrix
    ? nextRecordMatrix[offerId]?.[fromMemberId] ?? 0
    : nextGroupMatrix?.[offerId]?.[fromMemberId] ?? 0;

  if (remainingFrom === 0 && nextCompletions?.[dateStr]?.[offerId]?.[fromMemberId]) {
    delete nextCompletions[dateStr][offerId][fromMemberId];
  }

  return {
    ok: true,
    nextRecord,
    nextGroupMatrix,
    nextCompletions,
  };
}
