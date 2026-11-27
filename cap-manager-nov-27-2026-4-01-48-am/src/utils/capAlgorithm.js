/**
 * CAP Manager – Smart Multi-Criteria & Multi-Day Shift-Aware CAP Distribution Engine
 * Pure JavaScript module (no UI dependencies)
 *
 * Shift & Fairness Rules:
 * 1. CAP Cycle Availability:
 *    - Members whose today Ca 2, Ca 3 AND next-day Ca 1 are ALL OFF are NOT eligible for CAP (0 CAP).
 * 2. Offer Time Window / Shift Matching (`useShiftMatching`):
 *    - `10h`, `21h30`, `23h` are shared group CAP deadlines ("giờ CAP chung").
 *    - Daytime / All-day offers (`10h`, "Cả ngày", e.g. 1769, 1706, 1551): workable all day, prioritized
 *      for Ca 1 next day & Ca 1-2 today.
 *    - Evening-only offers (`21h30`, `23h`, opening ~20h+, e.g. 936, 1132, 1134, 1260, 1257):
 *      require working `Ca 3` today (`!hasTodayCa3` members CANNOT work 20h+ offers when Ca 3 members exist).
 *    - Members working Ca 1, 2 today + Ca 1 tomorrow (no Ca 3 today) focus exclusively on All-day offers
 *      and accept fewer total CAP than full/Ca 3 workers.
 *    - Members working Ca 2, 3 today + Ca 1 tomorrow can work ALL offers normally.
 * 3. Tier Fairness & Leader Priority:
 *    - Non-leader members within the same shift tier receive as equal points & CAP as possible.
 *    - Leader receives only a gentle edge (+10 to +25 pt) when `leaderPriority` is 'medium'/'high'
 *      (not 'normal' or 'low'), unless points among eligible peers divide evenly.
 *    - New members with `newMemberMode === 'less'` receive noticeably fewer CAP (2-3 CAP below peers).
 */

import { addDaysToIso, getTodayDateString } from './storage.js';

function createRng(seed = 1) {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Sort offers by pointsPerCap descending, then totalCap descending.
 */
export function sortOffersByPointsDesc(offers) {
  return [...(offers || [])].sort((a, b) => {
    const pDiff = (Number(b.pointsPerCap) || 0) - (Number(a.pointsPerCap) || 0);
    if (pDiff !== 0) return pDiff;
    const cDiff = (Number(b.totalCap) || 0) - (Number(a.totalCap) || 0);
    if (cDiff !== 0) return cDiff;
    return String(a.code || '').localeCompare(String(b.code || ''));
  });
}

/**
 * Filter out offers marked `hidden: true` so they are excluded from CAP distribution.
 */
export function getActiveOffers(offers) {
  return (Array.isArray(offers) ? offers : []).filter((offer) => offer && !offer.hidden);
}

function isCellLocked(lockedCells, campId, memId) {
  return Boolean(lockedCells && lockedCells[campId] && lockedCells[campId][memId]);
}

/**
 * Compute gentle rollover point offsets from the latest saved history snapshot strictly before `currentDistributionDate`.
 */
export function computeRolloverPointOffsets(historyRecords, members, currentDistributionDate) {
  if (!Array.isArray(historyRecords) || historyRecords.length === 0 || !Array.isArray(members) || members.length === 0) {
    return { sourceDate: null, sourceRecordId: null, offsetsByMemberId: {} };
  }

  const targetDate = currentDistributionDate || getTodayDateString();
  const candidates = historyRecords
    .filter((rec) => rec && rec.date && rec.date < targetDate && rec.matrix && Array.isArray(rec.campaigns))
    .sort((a, b) => {
      const dateCmp = String(b.date || '').localeCompare(String(a.date || ''));
      if (dateCmp !== 0) return dateCmp;
      return String(b.savedAt || '').localeCompare(String(a.savedAt || ''));
    });

  const latest = candidates[0];
  if (!latest) {
    return { sourceDate: null, sourceRecordId: null, offsetsByMemberId: {} };
  }

  const prevStats = computeDistributionStats(
    latest.matrix,
    latest.campaigns,
    Array.isArray(latest.members) && latest.members.length > 0 ? latest.members : members,
    latest.date
  );

  const baselineStats = prevStats.memberStats.filter(
    (s) => s.active !== false && !s.isNew && s.totalCap > 0
  );
  if (baselineStats.length < 2) {
    return { sourceDate: latest.date, sourceRecordId: latest.id || null, offsetsByMemberId: {} };
  }

  const avgPrevPts =
    baselineStats.reduce((sum, s) => sum + s.totalPoints, 0) / baselineStats.length;

  const offsetsByMemberId = {};
  for (const mem of members) {
    if (mem.active === false || mem.isNew) {
      offsetsByMemberId[mem.id] = 0;
      continue;
    }
    const prevM = prevStats.memberTotalsMap[mem.id];
    if (!prevM || prevM.totalCap <= 0) {
      offsetsByMemberId[mem.id] = 0;
      continue;
    }
    const rawDelta = Math.round((prevM.totalPoints - avgPrevPts) * 0.45);
    offsetsByMemberId[mem.id] = Math.max(-16, Math.min(16, rawDelta));
  }

  return {
    sourceDate: latest.date,
    sourceRecordId: latest.id || null,
    offsetsByMemberId,
  };
}

/**
 * Parse a CAP hour label like "10h", "21h30", "23h", "14h45" into decimal hours [0..24).
 */
export function parseCapHour(capHourStr) {
  if (capHourStr === null || capHourStr === undefined) return null;
  const text = String(capHourStr).trim().toLowerCase();
  if (!text) return null;

  const match = text.match(/(\d{1,2})\s*(?:h|:)\s*(\d{1,2})?/);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  if (!Number.isFinite(hour) || hour < 0 || hour > 24) return null;
  if (!Number.isFinite(minute) || minute < 0 || minute >= 60) return null;
  return hour + minute / 60;
}

/**
 * Classify an offer's CAP hour into shift bucket:
 * - 'morning' (10h -> All-day / daytime / Ca 1 next day)
 * - 'afternoon' (13h30-18h59 -> Ca 2 today)
 * - 'evening' (19h-23h59 -> 21h30 / 23h offers opening ~20h+, requires Ca 3 today)
 */
export function getCampaignTimeBucket(capHourStr) {
  const h = parseCapHour(capHourStr);
  if (h === null) return 'any';
  if (h >= 6 && h < 13.5) return 'morning';
  if (h >= 13.5 && h < 19) return 'afternoon';
  return 'evening';
}

/**
 * True if an offer is evening/night-only (20h+ / 21h30 / 23h) and NOT an all-day offer.
 * Members without `ca3` today (e.g. Ca 1, 2 today + Ca 1 tomorrow) cannot work these offers.
 */
export function isEveningOnlyOffer(campaign) {
  const h = parseCapHour(campaign?.capHour);
  const tw = String(campaign?.timeWindow || '').trim().toLowerCase();
  if (h !== null) {
    if (h >= 19) return true;
    return /(?:20|21|22|23)\s*h/.test(tw) && !tw.includes('cả ngày') && !tw.includes('10h');
  }
  if (!tw || tw.includes('cả ngày')) return false;
  return /(?:20|21|22|23)\s*h/.test(tw);
}

/**
 * Get a member's shifts for a given ISO date, falling back to member.shifts.
 */
export function getMemberShiftsOnDate(member, dateStr) {
  if (member?.shiftSchedule && Array.isArray(member.shiftSchedule[dateStr])) {
    return member.shiftSchedule[dateStr];
  }
  if (Array.isArray(member?.shifts) && member.shifts.length > 0) {
    return member.shifts;
  }
  return ['ca1', 'ca2', 'ca3'];
}

/**
 * Get effective shifts relevant for distributing CAP on `distributionDate`:
 * - `todayShifts`: shifts on `distributionDate`
 * - `nextDayShifts`: shifts on `distributionDate + 1`
 */
export function getMemberEffectiveShiftsForDay(member, distributionDate) {
  const baseDate = distributionDate || getTodayDateString();
  const nextDate = addDaysToIso(baseDate, 1);
  return {
    todayShifts: getMemberShiftsOnDate(member, baseDate),
    nextDayShifts: getMemberShiftsOnDate(member, nextDate),
  };
}

export function isMemberCa3Worker(member, distributionDate = null) {
  const { todayShifts } = getMemberEffectiveShiftsForDay(member, distributionDate);
  return todayShifts.includes('ca3');
}

/**
 * Count how many shifts in the CAP distribution cycle [today Ca2, today Ca3, tomorrow Ca1] a member works.
 * - 0: off entire cycle (0 CAP)
 * - 1: single-shift worker in this CAP cycle (e.g. only today Ca2, or only tomorrow Ca1) -> fewer CAP & points
 * - 2-3: multi-shift worker in this CAP cycle -> full (if Ca3) or daytime 2-shift tier
 */
export function getCapCycleShiftCount(member, distributionDate = null) {
  if (!member || member.active === false) return 0;
  const { todayShifts, nextDayShifts } = getMemberEffectiveShiftsForDay(member, distributionDate);
  let count = 0;
  if (todayShifts.includes('ca2')) count += 1;
  if (todayShifts.includes('ca3')) count += 1;
  if (nextDayShifts.includes('ca1')) count += 1;
  return count;
}

/**
 * Compute shift affinity [0.05 .. 1.0] between an offer's CAP hour and member's shifts:
 * - All-day / 10h offers:
 *   - 1.0 for Ca 1 next day or Ca 1+2 today + Ca 1 next day
 *   - 0.72 for Ca 2,3 today without Ca 1 next day (still workable during today's Ca 2)
 * - Evening 21h30 / 23h offers (20h+):
 *   - 1.0 for Ca 3 today
 *   - < 0.2 for non-Ca3 members (hard-filtered by eligibility whenever any Ca3 member exists)
 */
export function getShiftAffinity(capHourStr, shiftsInput) {
  const bucket = getCampaignTimeBucket(capHourStr);
  if (bucket === 'any') return 1.0;

  let todayShifts;
  let nextDayShifts;

  if (Array.isArray(shiftsInput)) {
    todayShifts = shiftsInput.length > 0 ? shiftsInput : ['ca1', 'ca2', 'ca3'];
    nextDayShifts = todayShifts;
  } else if (shiftsInput && typeof shiftsInput === 'object') {
    todayShifts = Array.isArray(shiftsInput.todayShifts) ? shiftsInput.todayShifts : ['ca1', 'ca2', 'ca3'];
    nextDayShifts = Array.isArray(shiftsInput.nextDayShifts) ? shiftsInput.nextDayShifts : todayShifts;
  } else {
    todayShifts = ['ca1', 'ca2', 'ca3'];
    nextDayShifts = todayShifts;
  }

  const hasTodayCa2 = todayShifts.includes('ca2');
  const hasTodayCa3 = todayShifts.includes('ca3');
  const hasNextCa1 = nextDayShifts.includes('ca1');

  // All-day / 10h offers
  if (bucket === 'morning') {
    if (hasNextCa1) return 1.0;
    if (hasTodayCa2 || hasTodayCa3) return 0.76;
    return 0.25;
  }

  // Afternoon (13h30-18h59)
  if (bucket === 'afternoon') {
    if (hasTodayCa2) return 1.0;
    if (hasTodayCa3) return 0.65;
    return 0.2;
  }

  // Evening / Night (21h30, 23h — opens ~20h+)
  if (hasTodayCa3) return 1.0;
  if (hasTodayCa2 && !hasNextCa1) return 0.45;
  if (hasNextCa1) return 0.05;
  return 0.15;
}

/**
 * A member can participate in CAP distribution on `distributionDate` ONLY if:
 * - They are active (`member.active !== false`), AND
 * - They work AT LEAST ONE shift in the CAP cycle:
 *   today's Ca 2 (`ca2`), today's Ca 3 (`ca3`), OR next day's Ca 1 (`ca1`).
 */
export function isMemberAvailableForCapCycle(member, distributionDate = null) {
  if (!member || member.active === false) return false;
  const { todayShifts, nextDayShifts } = getMemberEffectiveShiftsForDay(member, distributionDate);
  return (
    todayShifts.includes('ca2') ||
    todayShifts.includes('ca3') ||
    nextDayShifts.includes('ca1')
  );
}

/**
 * Determine which active, shift-available members are eligible for a given offer.
 * When `useShiftMatching` is true and `campaign` is evening-only (`21h30`, `23h`),
 * restricts eligibility to members working `ca3` today (if at least one Ca3 member is eligible).
 */
export function getEligibleMembersForCampaign(
  campaign,
  members,
  distributionDate = null,
  options = {}
) {
  const activeMembers = members.filter((m) => isMemberAvailableForCapCycle(m, distributionDate));
  const type = campaign.eligibilityType || 'all';

  let eligible = activeMembers;
  if (type === 'exclude_new') {
    eligible = activeMembers.filter((m) => !m.isNew);
  } else if (type === 'custom' && Array.isArray(campaign.eligibleMemberIds) && campaign.eligibleMemberIds.length > 0) {
    const allowed = new Set(campaign.eligibleMemberIds);
    eligible = activeMembers.filter((m) => allowed.has(m.id));
  }

  const useShiftMatching = options?.useShiftMatching !== false;
  if (useShiftMatching && isEveningOnlyOffer(campaign)) {
    const ca3Eligible = eligible.filter((m) => isMemberCa3Worker(m, distributionDate));
    if (ca3Eligible.length > 0) {
      return ca3Eligible;
    }
  }

  return eligible;
}

/**
 * Detect whether the currently saved `matrix` conflicts with updated member shifts
 * (e.g. a resting member still holds CAP, or a non-Ca3 member holds 21h30/23h CAP while Ca3 peers exist).
 */
export function detectDistributionShiftConflicts(
  matrix,
  campaigns,
  members,
  distributionDate = null,
  useShiftMatching = true,
  lockedCells = {}
) {
  const unavailableWithCap = [];
  const nonCa3OnEvening = [];
  if (!matrix || !Array.isArray(campaigns) || !Array.isArray(members)) {
    return { hasConflicts: false, unavailableWithCap, nonCa3OnEvening };
  }

  const targetDate = distributionDate || getTodayDateString();
  const participating = members.filter((m) => isMemberAvailableForCapCycle(m, targetDate));

  for (const mem of members) {
    let memCap = 0;
    for (const camp of campaigns) {
      memCap += Number(matrix?.[camp.id]?.[mem.id] || 0);
    }
    if (memCap > 0 && !isMemberAvailableForCapCycle(mem, targetDate)) {
      unavailableWithCap.push({ memberId: mem.id, name: mem.name, cap: memCap });
    }
  }

  if (useShiftMatching) {
    for (const camp of campaigns) {
      if (!isEveningOnlyOffer(camp)) continue;
      const baseEligible = getEligibleMembersForCampaign(camp, participating, targetDate, {
        useShiftMatching: false,
      });
      const ca3Exists = baseEligible.some((m) => isMemberCa3Worker(m, targetDate));
      if (!ca3Exists) continue;

      for (const mem of participating) {
        if (isMemberCa3Worker(mem, targetDate)) continue;
        if (isCellLocked(lockedCells, camp.id, mem.id)) continue;
        const qty = Number(matrix?.[camp.id]?.[mem.id] || 0);
        if (qty > 0) {
          nonCa3OnEvening.push({
            memberId: mem.id,
            name: mem.name,
            offerCode: camp.code,
            cap: qty,
          });
        }
      }
    }
  }

  return {
    hasConflicts: unavailableWithCap.length > 0 || nonCa3OnEvening.length > 0,
    unavailableWithCap,
    nonCa3OnEvening,
  };
}

function gcd(a, b) {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x;
}

/**
 * True when participating members share the same shift tier (no non-Ca3 exclusion split),
 * no active new-member CAP suppression conflicts, and total points divide evenly across participating members.
 */
export function canDividePointsEqually(
  campaigns,
  participatingMembers,
  activeMembers,
  options = {}
) {
  if (!Array.isArray(participatingMembers) || participatingMembers.length === 0) return false;
  if (!Array.isArray(activeMembers) || participatingMembers.length === 0) {
    return false;
  }

  const distributionDate = options?.distributionDate || null;
  const useShiftMatching = options?.useShiftMatching !== false;
  const newMemberMode = options?.newMemberMode || 'less';

  if (newMemberMode === 'less' && participatingMembers.some((m) => m.isNew && !m.isLeader)) {
    return false;
  }

  if (useShiftMatching && distributionDate) {
    const ca3Count = participatingMembers.filter((m) => isMemberCa3Worker(m, distributionDate)).length;
    if (ca3Count > 0 && ca3Count < participatingMembers.length) {
      // Mixed Ca3 and non-Ca3 members: non-Ca3 members cannot take evening offers and take fewer CAP
      return false;
    }
    const singleCycleCount = participatingMembers.filter(
      (m) => getCapCycleShiftCount(m, distributionDate) === 1
    ).length;
    if (singleCycleCount > 0 && singleCycleCount < participatingMembers.length) {
      // Mixed 1-shift vs multi-shift members in the CAP cycle
      return false;
    }
  }

  let totalPointsAll = 0;
  let pointsGcd = 0;
  for (const camp of campaigns || []) {
    const cap = Math.round(Number(camp.totalCap) || 0);
    const pts = Number(camp.pointsPerCap) || 0;
    if (cap > 0 && pts > 0) {
      totalPointsAll += cap * pts;
      pointsGcd = pointsGcd === 0 ? pts : gcd(pointsGcd, pts);
    }
  }

  const n = participatingMembers.length;
  if (totalPointsAll <= 0 || totalPointsAll % n !== 0) return false;
  const perMemberPts = totalPointsAll / n;
  if (pointsGcd > 0 && perMemberPts % pointsGcd !== 0) return false;
  return true;
}

/**
 * Target relative CAP count weight for an active member.
 */
export function getMemberTargetWeight(member, config) {
  let weight = 1.0;

  if (member.priority === 'high') {
    weight += 0.08;
  } else if (member.priority === 'low') {
    weight -= 0.08;
  }

  if (member.isLeader && !config.skipLeaderPriority) {
    if (config.leaderPriority === 'high') {
      weight += 0.12;
    } else if (config.leaderPriority === 'medium') {
      weight += 0.06;
    } else {
      // 'normal' (Chia bình thường) or 'low': no extra CAP weight for Leader
      weight += 0.0;
    }
  }

  const cycleCount = config.cycleShiftCountById?.[member.id] ?? 2;
  if (config.hasMixedShiftCount && cycleCount === 1) {
    // Member works only 1 shift in the entire CAP cycle -> noticeably fewer CAP
    weight *= 0.56;
  } else if (config.hasMixedCa3Split && !config.isCa3WorkerById?.[member.id]) {
    // Member works 2 shifts in cycle (today Ca2 + tomorrow Ca1) without Ca3 -> slightly fewer CAP
    weight *= 0.74;
  }

  if (member.isNew && !member.isLeader && config.newMemberMode === 'less') {
    weight *= 0.44;
  }

  const aiDir = config.memberDirectivesById?.[member.id];
  if (aiDir) {
    if (aiDir.kind === 'boost') weight *= 1.38;
    else if (aiDir.kind === 'reduce') weight *= 0.62;
  }

  return Math.max(0.18, weight);
}

/**
 * Target relative POINTS weight for an active member.
 * - Single-cycle-shift members (cycleShiftCount === 1 when mixed with multi-shift peers) take lower points (0.64)
 * - 2-shift daytime members (today Ca2 + tomorrow Ca1, no Ca3) keep ~0.96 so they match Ca3 peers via high-pt all-day offers
 * - New members in 'less' mode use 0.44 so point optimization does not pull their CAP count back up
 */
export function getMemberPointWeight(member, config) {
  let weight = 1.0;
  const cycleCount = config.cycleShiftCountById?.[member.id] ?? 2;

  if (member.isNew && !member.isLeader && config.newMemberMode === 'less') {
    weight = 0.44;
  } else if (config.hasMixedShiftCount && cycleCount === 1) {
    weight = 0.64;
  } else if (member.isLeader) {
    if (
      config.skipLeaderPriority ||
      config.leaderPriority === 'low' ||
      config.leaderPriority === 'normal'
    ) {
      weight = 1.0;
    } else if (config.leaderPriority === 'high') {
      weight = 1.08;
    } else {
      weight = 1.05;
    }
  } else if (config.hasMixedCa3Split && !config.isCa3WorkerById?.[member.id]) {
    weight = 0.96;
  } else if (member.priority === 'high') {
    weight = 1.02;
  } else if (member.priority === 'low') {
    weight = 0.98;
  }

  const aiDir = config.memberDirectivesById?.[member.id];
  if (aiDir) {
    if (aiDir.kind === 'boost') weight *= 1.35;
    else if (aiDir.kind === 'reduce') weight *= 0.65;
  }

  return weight;
}

export function createEmptyMatrix(campaigns, members) {
  const matrix = {};
  for (const camp of campaigns) {
    matrix[camp.id] = {};
    for (const mem of members) {
      matrix[camp.id][mem.id] = 0;
    }
  }
  return matrix;
}

export function normalizeMatrix(matrix, campaigns, members) {
  const next = {};
  for (const camp of campaigns) {
    next[camp.id] = {};
    const row = (matrix && matrix[camp.id]) || {};
    for (const mem of members) {
      const val = Number(row[mem.id]);
      next[camp.id][mem.id] = Number.isFinite(val) && val >= 0 ? Math.floor(val) : 0;
    }
  }
  return next;
}

export function computeDistributionStats(matrix, campaigns, members, distributionDate = null) {
  const safeMatrix = normalizeMatrix(matrix, campaigns, members);
  const targetDate = distributionDate || getTodayDateString();

  const memberTotals = {};
  for (const mem of members) {
    const effective = getMemberEffectiveShiftsForDay(mem, targetDate);
    const availableForCap = isMemberAvailableForCapCycle(mem, targetDate);
    memberTotals[mem.id] = {
      memberId: mem.id,
      memberCode: mem.memberCode || '',
      name: mem.name,
      isLeader: Boolean(mem.isLeader),
      isNew: Boolean(mem.isNew),
      active: mem.active !== false,
      availableForCap,
      priority: mem.priority || 'normal',
      todayShifts: effective.todayShifts,
      nextDayShifts: effective.nextDayShifts,
      totalCap: 0,
      totalPoints: 0,
      campaignCount: 0,
      avgPointsPerCap: 0,
      morningCap: 0,
      eveningCap: 0,
    };
  }

  const campaignValidation = [];
  let expectedTotalCap = 0;
  let expectedTotalPoints = 0;
  let assignedTotalCap = 0;
  let assignedTotalPoints = 0;

  for (const camp of campaigns) {
    const targetCap = Math.max(0, Math.round(Number(camp.totalCap) || 0));
    const pointsPerCap = Math.max(0, Number(camp.pointsPerCap) || 0);
    const bucket = getCampaignTimeBucket(camp.capHour);
    expectedTotalCap += targetCap;
    expectedTotalPoints += targetCap * pointsPerCap;

    let rowSum = 0;
    let participants = 0;
    for (const mem of members) {
      const qty = safeMatrix[camp.id][mem.id] || 0;
      rowSum += qty;
      if (qty > 0) {
        participants += 1;
        memberTotals[mem.id].totalCap += qty;
        memberTotals[mem.id].totalPoints += qty * pointsPerCap;
        memberTotals[mem.id].campaignCount += 1;
        if (bucket === 'morning') memberTotals[mem.id].morningCap += qty;
        if (bucket === 'evening') memberTotals[mem.id].eveningCap += qty;
      }
    }

    assignedTotalCap += rowSum;
    assignedTotalPoints += rowSum * pointsPerCap;

    const diff = rowSum - targetCap;
    campaignValidation.push({
      campaignId: camp.id,
      code: camp.code,
      name: camp.name,
      capHour: camp.capHour || '',
      targetCap,
      assignedCap: rowSum,
      diff,
      status: diff === 0 ? 'valid' : diff > 0 ? 'over' : 'under',
      participants,
      pointsPerCap,
    });
  }

  const memberStatsList = members.map((mem) => {
    const stat = memberTotals[mem.id];
    stat.avgPointsPerCap = stat.totalCap > 0 ? Number((stat.totalPoints / stat.totalCap).toFixed(2)) : 0;
    return stat;
  });

  const activeStats = memberStatsList.filter((m) => m.active);
  const participatingStats = memberStatsList.filter(
    (m) => m.active && (m.availableForCap || m.totalCap > 0)
  );
  const spreadSource =
    participatingStats.length > 0
      ? participatingStats
      : activeStats.length > 0
        ? activeStats
        : memberStatsList;

  let maxCapMember = null;
  let minCapMember = null;
  let maxPointsMember = null;
  let minPointsMember = null;

  for (const stat of spreadSource) {
    if (!maxCapMember || stat.totalCap > maxCapMember.totalCap) {
      maxCapMember = stat;
    }
    if (!minCapMember || stat.totalCap < minCapMember.totalCap) {
      minCapMember = stat;
    }
    if (!maxPointsMember || stat.totalPoints > maxPointsMember.totalPoints) {
      maxPointsMember = stat;
    }
    if (!minPointsMember || stat.totalPoints < minPointsMember.totalPoints) {
      minPointsMember = stat;
    }
  }

  const capSpread = maxCapMember && minCapMember ? maxCapMember.totalCap - minCapMember.totalCap : 0;
  const pointSpread = maxPointsMember && minPointsMember ? maxPointsMember.totalPoints - minPointsMember.totalPoints : 0;

  const nonLeaderActiveStats = spreadSource.filter((m) => !m.isLeader);
  let nonLeaderPointSpread = 0;
  if (nonLeaderActiveStats.length > 1) {
    const ptsList = nonLeaderActiveStats.map((m) => m.totalPoints);
    nonLeaderPointSpread = Math.max(...ptsList) - Math.min(...ptsList);
  }

  const invalidCampaigns = campaignValidation.filter((c) => c.status !== 'valid');
  const isAllValid = invalidCampaigns.length === 0 && assignedTotalCap === expectedTotalCap && assignedTotalPoints === expectedTotalPoints;

  return {
    matrix: safeMatrix,
    memberStats: memberStatsList,
    memberTotalsMap: memberTotals,
    campaignValidation,
    invalidCampaigns,
    isAllValid,
    expectedTotalCap,
    expectedTotalPoints,
    assignedTotalCap,
    assignedTotalPoints,
    capSpread,
    pointSpread,
    nonLeaderPointSpread,
    maxCapMember,
    minCapMember,
    maxPointsMember,
    minPointsMember,
  };
}

function evaluateCandidateCost(
  matrix,
  campaigns,
  activeMembers,
  eligibleByCampaignId,
  targetsByMemberId,
  effectiveShiftsByMemberId,
  config
) {
  const capWeightFactor = config.capBalanceLevel === 'high' ? 1.15 : 0.6;
  const pointWeightFactor = config.pointBalanceLevel === 'high' ? 2.8 : 1.15;
  const useShifts = config.useShiftMatching !== false;

  const memberCaps = {};
  const memberPoints = {};
  for (const mem of activeMembers) {
    memberCaps[mem.id] = 0;
    memberPoints[mem.id] = 0;
  }

  let concentrationPenalty = 0;
  let shiftMismatchPenalty = 0;

  for (const camp of campaigns) {
    const eligible = eligibleByCampaignId[camp.id];
    const k = eligible.length || 1;
    const idealPerCamp = camp.totalCap / k;
    const pts = camp.pointsPerCap;

    for (const mem of eligible) {
      const qty = matrix[camp.id][mem.id] || 0;
      memberCaps[mem.id] += qty;
      memberPoints[mem.id] += qty * pts;

      const excess = qty - idealPerCamp;
      concentrationPenalty += excess * excess * 0.28;
      if (camp.totalCap <= 8 && k >= 4 && qty >= 3) {
        concentrationPenalty += (qty - 2) * 1.1;
      }

      if (useShifts && qty > 0) {
        const affinity = getShiftAffinity(camp.capHour, effectiveShiftsByMemberId[mem.id]);
        const penaltyScale = affinity < 0.2 ? 9.0 : affinity < 0.5 ? 2.5 : 0.65;
        shiftMismatchPenalty += qty * (1 - affinity) * penaltyScale;
      }
    }
  }

  const pointUnit = 25;
  const rolloverOffsets = config.useRolloverFairness ? config.rolloverOffsets || {} : {};
  const memberDirectivesById = config.memberDirectivesById || {};
  const effectivePointsById = {};
  let capDeviationCost = 0;
  let pointDeviationCost = 0;

  const capsArray = [];
  for (const mem of activeMembers) {
    const cap = memberCaps[mem.id];
    const pts = memberPoints[mem.id];
    const target = targetsByMemberId[mem.id];
    const rolloverDelta = Number(rolloverOffsets[mem.id]) || 0;
    const hasAiOverride = Boolean(memberDirectivesById[mem.id]);
    effectivePointsById[mem.id] = pts + rolloverDelta;
    capsArray.push(cap);

    const normCapDiff = (cap - target.targetCap) / Math.max(1, target.avgCap * 0.65);
    const normPtsDiff = (pts - target.targetPoints) / pointUnit;

    const dirMultiplier = hasAiOverride
      ? memberDirectivesById[mem.id]?.kind === 'exact_cap' || memberDirectivesById[mem.id]?.kind === 'delta_cap'
        ? 4.2
        : 2.4
      : 1.0;
    capDeviationCost += normCapDiff * normCapDiff * dirMultiplier;
    pointDeviationCost += normPtsDiff * normPtsDiff * (hasAiOverride ? 1.8 : 1.0);
  }

  const avgCap = capsArray.reduce((a, b) => a + b, 0) / Math.max(1, capsArray.length);
  const isCa3Worker = (m) => !config.hasMixedCa3Split || Boolean(config.isCa3WorkerById?.[m.id]);
  const isSingleShiftWorker = (m) =>
    Boolean(config.hasMixedShiftCount) && (config.cycleShiftCountById?.[m.id] ?? 2) === 1;
  const includeLeaderInMainPool =
    config.skipLeaderPriority ||
    config.leaderPriority === 'low' ||
    config.leaderPriority === 'normal';

  // Multi-shift standard peers (exclude members with explicit AI quantity overrides from peer spread penalty)
  const multiShiftStandardPeers = activeMembers.filter(
    (m) =>
      !memberDirectivesById[m.id] &&
      !isSingleShiftWorker(m) &&
      (includeLeaderInMainPool || !m.isLeader) &&
      (config.newMemberMode !== 'less' || !m.isNew)
  );
  const ca3Peers = multiShiftStandardPeers.filter((m) => isCa3Worker(m));
  const twoShiftNonCa3Peers = config.hasMixedCa3Split
    ? multiShiftStandardPeers.filter((m) => !isCa3Worker(m))
    : [];
  const singleShiftPeers = config.hasMixedShiftCount
    ? activeMembers.filter(
        (m) =>
          !memberDirectivesById[m.id] &&
          isSingleShiftWorker(m) &&
          (includeLeaderInMainPool || !m.isLeader) &&
          (config.newMemberMode !== 'less' || !m.isNew)
      )
    : [];

  const allStandardPeers =
    multiShiftStandardPeers.length > 0 ? multiShiftStandardPeers : singleShiftPeers;

  const primaryPool = ca3Peers.length > 0 ? ca3Peers : allStandardPeers;
  const peerEffPts = primaryPool.map((m) => effectivePointsById[m.id]);
  const peerCaps = primaryPool.map((m) => memberCaps[m.id]);
  const peerMaxPts = peerEffPts.length > 0 ? Math.max(...peerEffPts) : 0;
  const peerMinPts = peerEffPts.length > 0 ? Math.min(...peerEffPts) : 0;
  const peerAvgPts =
    peerEffPts.length > 0 ? peerEffPts.reduce((a, b) => a + b, 0) / peerEffPts.length : 0;
  const peerAvgCap =
    peerCaps.length > 0 ? peerCaps.reduce((a, b) => a + b, 0) / peerCaps.length : avgCap;

  const mainSpreadPts = peerMaxPts - peerMinPts;
  const mainCapSpread =
    peerCaps.length > 1 ? Math.max(...peerCaps) - Math.min(...peerCaps) : 0;

  // Quadratic penalty on spread within multi-shift Ca3 peers
  const spreadNorm = mainSpreadPts / pointUnit;
  let spreadCost = spreadNorm * 3.4 + spreadNorm * spreadNorm * 2.2;

  // 2-shift non-Ca3 members (today Ca2 + tomorrow Ca1) match multi-shift peer points via high-pt all-day offers
  if (twoShiftNonCa3Peers.length > 0 && ca3Peers.length > 0) {
    const maxBudget =
      config.allDayPointsTotal > 0
        ? (config.allDayPointsTotal * 0.85) / (twoShiftNonCa3Peers.length + singleShiftPeers.length * 0.55)
        : Infinity;
    const targetCrossPts = Math.min(peerAvgPts * 0.96, maxBudget);

    for (const m of twoShiftNonCa3Peers) {
      const gapNorm = Math.abs(effectivePointsById[m.id] - targetCrossPts) / pointUnit;
      spreadCost += gapNorm * 2.8 + gapNorm * gapNorm * 1.9;
    }

    if (twoShiftNonCa3Peers.length > 1) {
      const ptsList = twoShiftNonCa3Peers.map((m) => effectivePointsById[m.id]);
      const sNorm = (Math.max(...ptsList) - Math.min(...ptsList)) / pointUnit;
      spreadCost += sNorm * 2.8 + sNorm * sNorm * 1.8;
    }
  }

  // Single-shift peers (only 1 shift in the CAP cycle, e.g. Uyen or Long) stay balanced with EACH OTHER,
  // and remain strictly below multi-shift peers in both CAP and points.
  if (singleShiftPeers.length > 1) {
    const ssPts = singleShiftPeers.map((m) => effectivePointsById[m.id]);
    const ssCaps = singleShiftPeers.map((m) => memberCaps[m.id]);
    const ssSpreadNorm = (Math.max(...ssPts) - Math.min(...ssPts)) / pointUnit;
    spreadCost += ssSpreadNorm * 3.0 + ssSpreadNorm * ssSpreadNorm * 2.0;
    const ssCapDiff = Math.max(...ssCaps) - Math.min(...ssCaps);
    if (ssCapDiff > 1) {
      spreadCost += (ssCapDiff - 1) * 2.2;
    }
  }

  let roleOrderPenalty = 0;
  for (const mem of activeMembers) {
    if (memberDirectivesById[mem.id]) continue;
    const cap = memberCaps[mem.id];
    const pts = effectivePointsById[mem.id];
    const isCa3 = isCa3Worker(mem);
    const isSingle = isSingleShiftWorker(mem);

    // 1. Leader gentle margin (only when !skipLeaderPriority && leaderPriority not 'normal'/'low' && full-cycle peer)
    if (mem.isLeader && !includeLeaderInMainPool && isCa3 && !isSingle) {
      if (cap < peerAvgCap - 0.1) {
        roleOrderPenalty += (peerAvgCap - cap) * 1.5;
      }
      const desiredMin = peerMaxPts + (config.leaderPriority === 'high' ? 10 : 5);
      if (pts < desiredMin) {
        const deficit = (desiredMin - pts) / pointUnit;
        roleOrderPenalty += deficit * 1.8 + deficit * deficit * 2.5;
      }
      const maxExtra = config.leaderPriority === 'high' ? 30 : 22;
      if (pts - peerAvgPts > maxExtra) {
        const over = (pts - peerAvgPts - maxExtra) / pointUnit;
        roleOrderPenalty += over * 3.2 + over * over * 5.0;
      }
    }

    // 2A. Single-cycle-shift standard member (e.g. only 1 shift in [today Ca2, today Ca3, tomorrow Ca1]):
    // Receives noticeably fewer CAP (~2-3.5 fewer) AND lower points than multi-shift members like Hoai/Hieu/Huy Bao.
    if (isSingle && !mem.isNew && multiShiftStandardPeers.length > 0) {
      const desiredMaxSingleCap = Math.max(2, Math.floor(peerAvgCap * 0.65));
      if (cap > desiredMaxSingleCap) {
        const overCap = cap - desiredMaxSingleCap;
        roleOrderPenalty += overCap * 5.0 + overCap * overCap * 2.5;
      }
      if (cap >= peerAvgCap - 1.2) {
        roleOrderPenalty += (cap - (peerAvgCap - 1.2)) * 3.5;
      }
      const desiredMaxSinglePts = peerAvgPts * 0.78;
      if (pts > desiredMaxSinglePts) {
        const overPts = (pts - desiredMaxSinglePts) / pointUnit;
        roleOrderPenalty += overPts * 3.5 + overPts * overPts * 2.2;
      }
      if (cap < 2 && peerAvgCap >= 4) {
        roleOrderPenalty += (2 - cap) * 5.0;
      }
    } else if (config.hasMixedCa3Split && !isCa3 && !mem.isNew) {
      // 2B. 2-shift non-Ca3 member (today Ca2 + tomorrow Ca1, no Ca3): fewer CAP than Ca3 peers while keeping point balance
      const targetMaxNonCa3Cap = Math.max(1, peerAvgCap - 1.2);
      if (cap > targetMaxNonCa3Cap) {
        roleOrderPenalty += (cap - targetMaxNonCa3Cap) * 3.6;
      }
    }

    // 3. New member with 'less' receives clearly fewer CAP (~45-52% of multi-shift standard peers, at least 3 CAP lower)
    if (mem.isNew && !mem.isLeader && config.newMemberMode === 'less') {
      const stdAvgCap =
        allStandardPeers.length > 0
          ? allStandardPeers.reduce((s, m) => s + memberCaps[m.id], 0) / allStandardPeers.length
          : peerAvgCap;
      const desiredMaxCap =
        stdAvgCap >= 6
          ? Math.max(2, Math.min(Math.floor(stdAvgCap * 0.52), Math.floor(stdAvgCap - 3)))
          : stdAvgCap >= 4
            ? Math.max(1, Math.min(Math.floor(stdAvgCap * 0.55), Math.floor(stdAvgCap - 2)))
            : 1;
      if (cap > desiredMaxCap) {
        const excessCap = cap - desiredMaxCap;
        roleOrderPenalty += excessCap * 6.5 + excessCap * excessCap * 3.5;
      }
      const minNewCap = stdAvgCap >= 7 ? 3 : stdAvgCap >= 4 ? 2 : 1;
      if (cap < minNewCap) {
        roleOrderPenalty += (minNewCap - cap) * 6.0;
      }
    }
  }

  const capSpreadPenalty =
    mainCapSpread > 1 ? (mainCapSpread - 1) * 1.4 + (mainCapSpread - 1) * (mainCapSpread - 1) * 0.8 : mainCapSpread * 0.25;

  return (
    capWeightFactor * (capDeviationCost * 1.7 + capSpreadPenalty) +
    pointWeightFactor * (pointDeviationCost * 1.3 + spreadCost) +
    concentrationPenalty +
    shiftMismatchPenalty +
    roleOrderPenalty
  );
}

function runSingleTrial(
  campaigns,
  activeMembers,
  allMembers,
  eligibleByCampaignId,
  targetsByMemberId,
  effectiveShiftsByMemberId,
  config,
  seed
) {
  const rng = createRng(seed);
  const matrix = createEmptyMatrix(campaigns, allMembers);
  const useShifts = config.useShiftMatching !== false;
  const lockedCells = config.lockedCells || {};
  const baseMatrix = config.baseMatrix || {};

  const memberCaps = {};
  const memberPoints = {};
  for (const mem of activeMembers) {
    memberCaps[mem.id] = 0;
    memberPoints[mem.id] = 0;
  }

  for (const camp of campaigns) {
    for (const mem of allMembers) {
      if (isCellLocked(lockedCells, camp.id, mem.id)) {
        const lockedVal = Math.max(0, Math.floor(Number(baseMatrix?.[camp.id]?.[mem.id]) || 0));
        matrix[camp.id][mem.id] = lockedVal;
        if (memberCaps[mem.id] !== undefined) {
          memberCaps[mem.id] += lockedVal;
          memberPoints[mem.id] += lockedVal * camp.pointsPerCap;
        }
      }
    }
  }

  // Distribute tightest-eligibility & highest-point offers first
  const sortedCampaigns = [...campaigns].sort((a, b) => {
    const eligDiff = eligibleByCampaignId[a.id].length - eligibleByCampaignId[b.id].length;
    if (eligDiff !== 0) return eligDiff;
    const ptsDiff = b.pointsPerCap - a.pointsPerCap;
    if (ptsDiff !== 0) return ptsDiff;
    return b.totalCap - a.totalCap;
  });

  const capWeightFactor = config.capBalanceLevel === 'high' ? 1.15 : 0.6;
  const pointWeightFactor = config.pointBalanceLevel === 'high' ? 2.5 : 1.1;

  // Phase 1: Greedy unit-by-unit assignment
  for (const camp of sortedCampaigns) {
    const eligibleAll = eligibleByCampaignId[camp.id];
    const unlockedEligible = eligibleAll.filter((m) => !isCellLocked(lockedCells, camp.id, m.id));
    const totalNeeded = Math.max(0, Math.round(Number(camp.totalCap) || 0));
    let lockedSum = 0;
    for (const m of allMembers) {
      if (isCellLocked(lockedCells, camp.id, m.id)) {
        lockedSum += matrix[camp.id][m.id] || 0;
      }
    }
    const remainingNeeded = Math.max(0, totalNeeded - lockedSum);
    if (remainingNeeded === 0 || unlockedEligible.length === 0) continue;

    const idealPerCamp = totalNeeded / Math.max(1, eligibleAll.length);

    for (let unit = 0; unit < remainingNeeded; unit++) {
      let bestMember = unlockedEligible[0];
      let bestScore = Infinity;

      for (const mem of unlockedEligible) {
        const target = targetsByMemberId[mem.id];
        const nextCap = memberCaps[mem.id] + 1;
        const nextPts = memberPoints[mem.id] + camp.pointsPerCap;
        const currentInCamp = matrix[camp.id][mem.id];

        const capRatio = (nextCap - target.targetCap) / Math.max(1, target.avgCap);
        const ptsRatio = (nextPts - target.targetPoints) / Math.max(1, target.avgPoints);
        const campSpreadPenalty = (currentInCamp + 1 - idealPerCamp) * 0.4;
        const shiftCost = useShifts
          ? (1 - getShiftAffinity(camp.capHour, effectiveShiftsByMemberId[mem.id])) * 0.95
          : 0;
        const tieNoise = rng() * 0.04;

        const score =
          capWeightFactor * capRatio +
          pointWeightFactor * ptsRatio +
          campSpreadPenalty +
          shiftCost +
          tieNoise;

        if (score < bestScore) {
          bestScore = score;
          bestMember = mem;
        }
      }

      matrix[camp.id][bestMember.id] += 1;
      memberCaps[bestMember.id] += 1;
      memberPoints[bestMember.id] += camp.pointsPerCap;
    }
  }

  let currentCost = evaluateCandidateCost(
    matrix,
    campaigns,
    activeMembers,
    eligibleByCampaignId,
    targetsByMemberId,
    effectiveShiftsByMemberId,
    config
  );

  const evalCurrent = () =>
    evaluateCandidateCost(
      matrix,
      campaigns,
      activeMembers,
      eligibleByCampaignId,
      targetsByMemberId,
      effectiveShiftsByMemberId,
      config
    );

  // Phase 2: Iterative Local Search (1-transfer, 1-for-1 cross swap, 2-for-1 swap, and 2-pair bridge)
  for (let pass = 0; pass < 10; pass++) {
    let improved = false;

    // 2A: Same-offer 1-CAP transfer
    for (const camp of campaigns) {
      const eligible = eligibleByCampaignId[camp.id];
      if (eligible.length < 2) continue;

      for (let i = 0; i < eligible.length; i++) {
        const a = eligible[i];
        if (isCellLocked(lockedCells, camp.id, a.id) || matrix[camp.id][a.id] <= 0) continue;

        for (let j = 0; j < eligible.length; j++) {
          if (i === j || matrix[camp.id][a.id] <= 0) continue;
          const b = eligible[j];
          if (isCellLocked(lockedCells, camp.id, b.id)) continue;

          matrix[camp.id][a.id] -= 1;
          matrix[camp.id][b.id] += 1;
          const newCost = evalCurrent();
          if (newCost < currentCost - 1e-6) {
            currentCost = newCost;
            improved = true;
          } else {
            matrix[camp.id][a.id] += 1;
            matrix[camp.id][b.id] -= 1;
          }
        }
      }
    }

    // 2B: Cross-offer 1-for-1 swap
    for (let c1Idx = 0; c1Idx < campaigns.length; c1Idx++) {
      const c1 = campaigns[c1Idx];
      const elig1 = eligibleByCampaignId[c1.id];
      if (elig1.length < 2) continue;

      for (let c2Idx = c1Idx + 1; c2Idx < campaigns.length; c2Idx++) {
        const c2 = campaigns[c2Idx];
        if (
          c1.pointsPerCap === c2.pointsPerCap &&
          getCampaignTimeBucket(c1.capHour) === getCampaignTimeBucket(c2.capHour)
        ) {
          continue;
        }
        const elig2Set = new Set(eligibleByCampaignId[c2.id].map((m) => m.id));

        for (let i = 0; i < elig1.length; i++) {
          const a = elig1[i];
          if (isCellLocked(lockedCells, c1.id, a.id) || isCellLocked(lockedCells, c2.id, a.id)) continue;
          if (!elig2Set.has(a.id) || matrix[c1.id][a.id] <= 0) continue;

          for (let j = 0; j < elig1.length; j++) {
            if (i === j || matrix[c1.id][a.id] <= 0) continue;
            const b = elig1[j];
            if (isCellLocked(lockedCells, c1.id, b.id) || isCellLocked(lockedCells, c2.id, b.id)) continue;
            if (!elig2Set.has(b.id) || matrix[c2.id][b.id] <= 0) continue;

            matrix[c1.id][a.id] -= 1;
            matrix[c1.id][b.id] += 1;
            matrix[c2.id][b.id] -= 1;
            matrix[c2.id][a.id] += 1;

            const newCost = evalCurrent();
            if (newCost < currentCost - 1e-6) {
              currentCost = newCost;
              improved = true;
            } else {
              matrix[c1.id][a.id] += 1;
              matrix[c1.id][b.id] -= 1;
              matrix[c2.id][b.id] += 1;
              matrix[c2.id][a.id] -= 1;
            }
          }
        }
      }
    }

    // 2C: 2-for-1 cross swap (e.g., 1 high-pt CAP <-> 2 low-pt CAP) to equalize points across non-divisible tiers
    if (!improved && campaigns.length >= 2) {
      outer21: for (const cHigh of campaigns) {
        const eligH = eligibleByCampaignId[cHigh.id];
        if (eligH.length < 2) continue;
        for (const cLow of campaigns) {
          if (cHigh.id === cLow.id || cHigh.pointsPerCap <= cLow.pointsPerCap) continue;
          const eligLSet = new Set(eligibleByCampaignId[cLow.id].map((m) => m.id));

          for (const a of eligH) {
            if (isCellLocked(lockedCells, cHigh.id, a.id) || isCellLocked(lockedCells, cLow.id, a.id)) continue;
            if (!eligLSet.has(a.id) || matrix[cHigh.id][a.id] < 1) continue;

            for (const b of eligH) {
              if (a.id === b.id || !eligLSet.has(b.id)) continue;
              if (isCellLocked(lockedCells, cHigh.id, b.id) || isCellLocked(lockedCells, cLow.id, b.id)) continue;
              if (matrix[cLow.id][b.id] < 2) continue;

              matrix[cHigh.id][a.id] -= 1;
              matrix[cHigh.id][b.id] += 1;
              matrix[cLow.id][b.id] -= 2;
              matrix[cLow.id][a.id] += 2;

              const newCost = evalCurrent();
              if (newCost < currentCost - 1e-6) {
                currentCost = newCost;
                improved = true;
                break outer21;
              }

              matrix[cHigh.id][a.id] += 1;
              matrix[cHigh.id][b.id] -= 1;
              matrix[cLow.id][b.id] += 2;
              matrix[cLow.id][a.id] -= 2;
            }
          }
        }
      }
    }

    // 2D: 2-pair intermediate bridge swap (high -> mid -> low) to close residual 5-15pt gaps
    if (!improved && campaigns.length >= 2 && activeMembers.length >= 3) {
      const ptsMap = {};
      for (const m of activeMembers) {
        let sum = Number(config.useRolloverFairness ? config.rolloverOffsets?.[m.id] : 0) || 0;
        for (const c of campaigns) sum += (matrix[c.id][m.id] || 0) * c.pointsPerCap;
        ptsMap[m.id] = sum;
      }
      const sorted = [...activeMembers].sort((a, b) => ptsMap[b.id] - ptsMap[a.id]);
      const highList = sorted.slice(0, Math.min(2, sorted.length));
      const lowList = sorted.slice(Math.max(0, sorted.length - 2));

      outerBridge: for (const highM of highList) {
        for (const lowM of lowList) {
          if (highM.id === lowM.id) continue;
          for (const mid of activeMembers) {
            if (mid.id === highM.id || mid.id === lowM.id) continue;
            for (const c1 of campaigns) {
              if (isCellLocked(lockedCells, c1.id, highM.id) || isCellLocked(lockedCells, c1.id, mid.id)) continue;
              if (matrix[c1.id][highM.id] <= 0 || !eligibleByCampaignId[c1.id].some((m) => m.id === mid.id)) continue;
              for (const c2 of campaigns) {
                if (c1.id === c2.id || c2.pointsPerCap >= c1.pointsPerCap) continue;
                if (isCellLocked(lockedCells, c2.id, mid.id) || isCellLocked(lockedCells, c2.id, highM.id)) continue;
                if (matrix[c2.id][mid.id] <= 0 || !eligibleByCampaignId[c2.id].some((m) => m.id === highM.id)) continue;

                matrix[c1.id][highM.id] -= 1;
                matrix[c1.id][mid.id] += 1;
                matrix[c2.id][mid.id] -= 1;
                matrix[c2.id][highM.id] += 1;

                for (const c3 of campaigns) {
                  if (isCellLocked(lockedCells, c3.id, mid.id) || isCellLocked(lockedCells, c3.id, lowM.id)) continue;
                  if (matrix[c3.id][mid.id] <= 0 || !eligibleByCampaignId[c3.id].some((m) => m.id === lowM.id)) continue;
                  for (const c4 of campaigns) {
                    if (c3.id === c4.id || c4.pointsPerCap >= c3.pointsPerCap) continue;
                    if (isCellLocked(lockedCells, c4.id, lowM.id) || isCellLocked(lockedCells, c4.id, mid.id)) continue;
                    if (matrix[c4.id][lowM.id] <= 0 || !eligibleByCampaignId[c4.id].some((m) => m.id === mid.id)) continue;

                    matrix[c3.id][mid.id] -= 1;
                    matrix[c3.id][lowM.id] += 1;
                    matrix[c4.id][lowM.id] -= 1;
                    matrix[c4.id][mid.id] += 1;

                    const newCost = evalCurrent();
                    if (newCost < currentCost - 1e-6) {
                      currentCost = newCost;
                      improved = true;
                      break outerBridge;
                    }

                    matrix[c3.id][mid.id] += 1;
                    matrix[c3.id][lowM.id] -= 1;
                    matrix[c4.id][lowM.id] += 1;
                    matrix[c4.id][mid.id] -= 1;
                  }
                }

                matrix[c1.id][highM.id] += 1;
                matrix[c1.id][mid.id] -= 1;
                matrix[c2.id][mid.id] += 1;
                matrix[c2.id][highM.id] -= 1;
              }
            }
          }
        }
      }
    }

    if (!improved) break;
  }

  return { matrix, cost: currentCost };
}

/**
 * Main entry point: Auto-distribute CAP across members and offers for `distributionDate`.
 * Supports optional `options.lockedCells`, `options.baseMatrix`, and `options.rolloverOffsets`.
 */
export function autoDistributeCaps(
  members,
  campaigns,
  config = {},
  baseSeed = Date.now(),
  distributionDate = null,
  options = {}
) {
  const targetDate = distributionDate || getTodayDateString();
  const lockedCells = options?.lockedCells || {};
  const baseMatrix = options?.baseMatrix || {};
  const rolloverOffsets = options?.rolloverOffsets || {};
  const memberDirectivesById = options?.memberDirectivesById || {};

  const safeConfig = {
    leaderPriority: config.leaderPriority || 'medium',
    newMemberMode: config.newMemberMode || 'less',
    capBalanceLevel: config.capBalanceLevel || 'high',
    pointBalanceLevel: config.pointBalanceLevel || 'high',
    useShiftMatching: config.useShiftMatching !== false,
    useRolloverFairness: Boolean(config.useRolloverFairness),
    optimizationTrials: Math.max(25, Math.min(40, Number(config.optimizationTrials) || 25)),
  };

  if (!Array.isArray(members) || members.length === 0) {
    return { ok: false, error: 'Chưa có thành viên nào trong danh sách.' };
  }

  const activeMembers = members.filter((m) => m.active !== false);
  if (activeMembers.length === 0) {
    return { ok: false, error: 'Không có thành viên nào đang bật trạng thái hoạt động.' };
  }

  const participatingMembers = activeMembers.filter((m) =>
    isMemberAvailableForCapCycle(m, targetDate)
  );
  if (participatingMembers.length === 0) {
    return {
      ok: false,
      error: 'Không có thành viên nào làm Ca 2, Ca 3 hôm nay hoặc Ca 1 sáng mai để chia CAP.',
    };
  }

  if (!Array.isArray(campaigns) || campaigns.length === 0) {
    return { ok: false, error: 'Chưa có offer nào để phân chia CAP.' };
  }

  const eligibleByCampaignId = {};
  let totalCapAll = 0;
  let totalPointsAll = 0;
  let allDayCapTotal = 0;
  let allDayPointsTotal = 0;

  for (const camp of campaigns) {
    const cap = Number(camp.totalCap);
    const pts = Number(camp.pointsPerCap);
    if (!Number.isFinite(cap) || cap < 0) {
      return { ok: false, error: `Số CAP của offer "${camp.code || camp.name}" không hợp lệ.` };
    }
    if (!Number.isFinite(pts) || pts < 0) {
      return { ok: false, error: `Điểm/CAP của offer "${camp.code || camp.name}" không hợp lệ.` };
    }

    const eligible = getEligibleMembersForCampaign(camp, participatingMembers, targetDate, {
      useShiftMatching: safeConfig.useShiftMatching,
    });
    let lockedSum = 0;
    for (const mem of members) {
      if (isCellLocked(lockedCells, camp.id, mem.id)) {
        lockedSum += Math.max(0, Math.floor(Number(baseMatrix?.[camp.id]?.[mem.id]) || 0));
      }
    }

    const roundedCap = Math.round(cap);
    if (lockedSum > roundedCap) {
      return {
        ok: false,
        error: `Offer "${camp.code} - ${camp.name}" có tổng CAP đã ghim (${lockedSum}) vượt quá Tổng CAP (${roundedCap}).`,
      };
    }

    const unlockedEligible = eligible.filter((m) => !isCellLocked(lockedCells, camp.id, m.id));
    if (roundedCap - lockedSum > 0 && unlockedEligible.length === 0) {
      return {
        ok: false,
        error: `Offer "${camp.code} - ${camp.name}" vẫn còn ${roundedCap - lockedSum} CAP chưa chia nhưng các ô hợp lệ đều đang bị ghim/khóa.`,
      };
    }

    eligibleByCampaignId[camp.id] = eligible;
    totalCapAll += roundedCap;
    totalPointsAll += roundedCap * pts;
    if (!isEveningOnlyOffer(camp)) {
      allDayCapTotal += roundedCap;
      allDayPointsTotal += roundedCap * pts;
    }
  }

  const isCa3WorkerById = {};
  const cycleShiftCountById = {};
  let ca3Count = 0;
  let singleShiftCount = 0;
  for (const mem of participatingMembers) {
    const isCa3 = isMemberCa3Worker(mem, targetDate);
    const cycleCount = getCapCycleShiftCount(mem, targetDate);
    isCa3WorkerById[mem.id] = isCa3;
    cycleShiftCountById[mem.id] = cycleCount;
    if (isCa3) ca3Count += 1;
    if (cycleCount === 1) singleShiftCount += 1;
  }
  const hasMixedCa3Split =
    safeConfig.useShiftMatching && ca3Count > 0 && ca3Count < participatingMembers.length;
  const hasMixedShiftCount =
    safeConfig.useShiftMatching && singleShiftCount > 0 && singleShiftCount < participatingMembers.length;

  const hasNonZeroRollover =
    safeConfig.useRolloverFairness &&
    participatingMembers.some((m) => (Number(rolloverOffsets[m.id]) || 0) !== 0);

  const hasAiMemberOverrides = Object.keys(memberDirectivesById).length > 0;
  const skipLeaderPriority =
    !hasAiMemberOverrides &&
    !hasNonZeroRollover &&
    canDividePointsEqually(campaigns, participatingMembers, activeMembers, {
      distributionDate: targetDate,
      useShiftMatching: safeConfig.useShiftMatching,
      newMemberMode: safeConfig.newMemberMode,
    });

  const effectiveConfig = {
    ...safeConfig,
    skipLeaderPriority,
    hasMixedCa3Split,
    hasMixedShiftCount,
    isCa3WorkerById,
    cycleShiftCountById,
    allDayCapTotal,
    allDayPointsTotal,
    lockedCells,
    baseMatrix,
    rolloverOffsets,
    memberDirectivesById,
  };

  const capWeights = {};
  const pointWeights = {};
  let capWeightSum = 0;
  let pointWeightSum = 0;
  const effectiveShiftsByMemberId = {};

  for (const mem of participatingMembers) {
    const cw = getMemberTargetWeight(mem, effectiveConfig);
    const pw = getMemberPointWeight(mem, effectiveConfig);
    capWeights[mem.id] = cw;
    pointWeights[mem.id] = pw;
    capWeightSum += cw;
    pointWeightSum += pw;
    effectiveShiftsByMemberId[mem.id] = getMemberEffectiveShiftsForDay(mem, targetDate);
  }

  // When non-Ca3 members exist, cap their combined target CAP within available all-day capacity (88%)
  const nonCa3Members = hasMixedCa3Split
    ? participatingMembers.filter((m) => !isCa3WorkerById[m.id])
    : [];
  const maxNonCa3TotalCap = allDayCapTotal * 0.88;
  const maxNonCa3TotalPts = allDayPointsTotal * 0.88;
  let rawNonCa3CapSum = 0;
  let rawNonCa3PtsSum = 0;
  for (const m of nonCa3Members) {
    rawNonCa3CapSum += totalCapAll * (capWeights[m.id] / capWeightSum);
    rawNonCa3PtsSum += totalPointsAll * (pointWeights[m.id] / pointWeightSum);
  }

  const avgCap = totalCapAll / participatingMembers.length;
  const avgPoints = totalPointsAll / participatingMembers.length;
  const avgPtsPerCapGlobal = totalCapAll > 0 ? totalPointsAll / totalCapAll : 25;
  const targetsByMemberId = {};

  if (hasMixedCa3Split && (rawNonCa3CapSum > maxNonCa3TotalCap || rawNonCa3PtsSum > maxNonCa3TotalPts)) {
    const capScale = rawNonCa3CapSum > 0 ? Math.min(1, maxNonCa3TotalCap / rawNonCa3CapSum) : 1;
    const ptsScale = rawNonCa3PtsSum > 0 ? Math.min(1, maxNonCa3TotalPts / rawNonCa3PtsSum) : 1;
    const assignedNonCa3Cap = rawNonCa3CapSum * capScale;
    const assignedNonCa3Pts = rawNonCa3PtsSum * ptsScale;
    const ca3Members = participatingMembers.filter((m) => isCa3WorkerById[m.id]);
    const ca3CwSum = ca3Members.reduce((s, m) => s + capWeights[m.id], 0) || 1;
    const ca3PwSum = ca3Members.reduce((s, m) => s + pointWeights[m.id], 0) || 1;

    for (const mem of participatingMembers) {
      const rolloverDelta = safeConfig.useRolloverFairness ? Number(rolloverOffsets[mem.id]) || 0 : 0;
      if (!isCa3WorkerById[mem.id]) {
        targetsByMemberId[mem.id] = {
          weight: capWeights[mem.id],
          targetCap: totalCapAll * (capWeights[mem.id] / capWeightSum) * capScale,
          targetPoints: Math.max(0, totalPointsAll * (pointWeights[mem.id] / pointWeightSum) * ptsScale - rolloverDelta),
          avgCap,
          avgPoints,
        };
      } else {
        targetsByMemberId[mem.id] = {
          weight: capWeights[mem.id],
          targetCap: (totalCapAll - assignedNonCa3Cap) * (capWeights[mem.id] / ca3CwSum),
          targetPoints: Math.max(0, (totalPointsAll - assignedNonCa3Pts) * (pointWeights[mem.id] / ca3PwSum) - rolloverDelta),
          avgCap,
          avgPoints,
        };
      }
    }
  } else {
    for (const mem of participatingMembers) {
      const capShare = capWeights[mem.id] / capWeightSum;
      const ptsShare = pointWeights[mem.id] / pointWeightSum;
      const rolloverDelta = safeConfig.useRolloverFairness ? Number(rolloverOffsets[mem.id]) || 0 : 0;
      targetsByMemberId[mem.id] = {
        weight: capWeights[mem.id],
        targetCap: totalCapAll * capShare,
        targetPoints: Math.max(0, totalPointsAll * ptsShare - rolloverDelta),
        avgCap,
        avgPoints,
      };
    }
  }

  // Apply explicit exact_cap / delta_cap overrides cleanly while re-balancing the remaining pool
  const explicitCapFixedIds = new Set();
  let fixedCapSum = 0;
  let fixedPtsSum = 0;
  for (const mem of participatingMembers) {
    const aiDir = memberDirectivesById[mem.id];
    if (!aiDir || (aiDir.kind !== 'exact_cap' && aiDir.kind !== 'delta_cap')) continue;
    const baseTargetCap = targetsByMemberId[mem.id].targetCap;
    const rawTarget =
      aiDir.kind === 'exact_cap'
        ? Math.max(0, Math.round(Number(aiDir.value) || 0))
        : Math.max(0, Math.round(baseTargetCap + (Number(aiDir.value) || 0)));
    const boundedTarget = Math.min(totalCapAll, rawTarget);
    const estPts = boundedTarget * avgPtsPerCapGlobal;
    targetsByMemberId[mem.id] = {
      ...targetsByMemberId[mem.id],
      targetCap: boundedTarget,
      targetPoints: estPts,
    };
    explicitCapFixedIds.add(mem.id);
    fixedCapSum += boundedTarget;
    fixedPtsSum += estPts;
  }

  if (explicitCapFixedIds.size > 0 && explicitCapFixedIds.size < participatingMembers.length) {
    const restMembers = participatingMembers.filter((m) => !explicitCapFixedIds.has(m.id));
    const remCap = Math.max(0, totalCapAll - fixedCapSum);
    const remPts = Math.max(0, totalPointsAll - fixedPtsSum);
    const restBaseCapSum = restMembers.reduce((s, m) => s + (targetsByMemberId[m.id]?.targetCap || 0), 0) || 1;
    const restBasePtsSum = restMembers.reduce((s, m) => s + (targetsByMemberId[m.id]?.targetPoints || 0), 0) || 1;
    for (const m of restMembers) {
      const prevT = targetsByMemberId[m.id];
      targetsByMemberId[m.id] = {
        ...prevT,
        targetCap: remCap * (prevT.targetCap / restBaseCapSum),
        targetPoints: remPts * (prevT.targetPoints / restBasePtsSum),
      };
    }
  }

  const candidates = [];
  const seenSignatures = new Set();

  for (let t = 0; t < safeConfig.optimizationTrials; t++) {
    const trialSeed = (Number(baseSeed) + t * 7919) >>> 0;
    const trial = runSingleTrial(
      campaigns,
      participatingMembers,
      members,
      eligibleByCampaignId,
      targetsByMemberId,
      effectiveShiftsByMemberId,
      effectiveConfig,
      trialSeed
    );

    const stats = computeDistributionStats(trial.matrix, campaigns, members, targetDate);
    const sig = stats.memberStats.map((m) => `${m.totalCap}:${m.totalPoints}:${m.morningCap}`).join('|');

    if (!seenSignatures.has(sig)) {
      seenSignatures.add(sig);
      candidates.push({
        matrix: trial.matrix,
        cost: trial.cost,
        stats,
      });
    }
  }

  candidates.sort((a, b) => a.cost - b.cost);
  const best = candidates[0];

  return {
    ok: true,
    matrix: best.matrix,
    stats: best.stats,
    cost: best.cost,
    autoEqualizedLeader: skipLeaderPriority,
    alternatives: candidates.slice(0, 3),
  };
}
