import { parseCapHour } from './capAlgorithm.js';
import { extractOfferNameCode } from './telegramMessages.js';

/**
 * Format a single member's CAP assignments grouped chronologically by Giờ CAP chung.
 */
export function formatMemberCapScheduleText({
  member,
  campaigns = [],
  matrix = {},
  stats = null,
  distributionDate = '',
  groupName = 'Nhóm 1',
}) {
  if (!member) return '';
  const mStat = stats?.memberTotalsMap?.[member.id];
  const assigned = [];

  for (const camp of campaigns) {
    const qty = Number(matrix?.[camp.id]?.[member.id] ?? 0);
    if (qty > 0) {
      assigned.push({
        code: extractOfferNameCode(camp),
        name: camp.name,
        capHour: camp.capHour || 'Khác',
        qty,
        pointsPerCap: Number(camp.pointsPerCap) || 0,
      });
    }
  }

  const totalCap = mStat
    ? mStat.totalCap
    : assigned.reduce((sum, item) => sum + item.qty, 0);
  const totalPoints = mStat
    ? mStat.totalPoints
    : assigned.reduce((sum, item) => sum + item.qty * item.pointsPerCap, 0);

  const header = `CAP ${distributionDate || 'hôm nay'} (${groupName}) – ${member.name}: ${totalCap} CAP (${totalPoints.toLocaleString('vi-VN')} point)`;

  if (assigned.length === 0) {
    return `${header}\n• Hôm nay chưa được chia CAP.`;
  }

  const byHour = new Map();
  for (const item of assigned) {
    const key = item.capHour || 'Khác';
    if (!byHour.has(key)) byHour.set(key, []);
    byHour.get(key).push(item);
  }

  const sortedHours = [...byHour.keys()].sort((a, b) => {
    const ha = parseCapHour(a);
    const hb = parseCapHour(b);
    if (ha === null && hb === null) return a.localeCompare(b);
    if (ha === null) return 1;
    if (hb === null) return -1;
    return ha - hb;
  });

  const lines = [header];
  for (const hour of sortedHours) {
    const list = byHour.get(hour);
    const itemsText = list.map((item) => `${item.code} (${item.qty})`).join(', ');
    lines.push(`• ${hour}: ${itemsText}`);
  }
  return lines.join('\n');
}

/**
 * Format the entire group's CAP summary for pasting into Zalo / Telegram.
 */
export function formatGroupDistributionSummaryText({
  groupName = 'Nhóm 1',
  distributionDate = '',
  members = [],
  campaigns = [],
  matrix = {},
  stats = null,
}) {
  const totalCap = stats?.assignedTotalCap ?? 0;
  const totalPts = stats?.assignedTotalPoints ?? 0;
  const lines = [
    `BẢNG CHIA CAP ${distributionDate || 'hôm nay'} – ${groupName} (${totalCap} CAP · ${totalPts.toLocaleString('vi-VN')} point)`,
  ];

  for (const mem of members) {
    const mStat = stats?.memberTotalsMap?.[mem.id];
    const mCap = mStat ? mStat.totalCap : 0;
    const mPts = mStat ? mStat.totalPoints : 0;

    if (mCap === 0) {
      lines.push(`- ${mem.name}: 0 CAP`);
      continue;
    }

    const byHour = new Map();
    for (const camp of campaigns) {
      const qty = Number(matrix?.[camp.id]?.[mem.id] ?? 0);
      if (qty <= 0) continue;
      const hour = camp.capHour || 'Khác';
      if (!byHour.has(hour)) byHour.set(hour, []);
      byHour.get(hour).push(`${extractOfferNameCode(camp)}(${qty})`);
    }

    const sortedHours = [...byHour.keys()].sort((a, b) => {
      const ha = parseCapHour(a);
      const hb = parseCapHour(b);
      if (ha === null && hb === null) return a.localeCompare(b);
      if (ha === null) return 1;
      if (hb === null) return -1;
      return ha - hb;
    });

    const detail = sortedHours
      .map((h) => `${h}: ${byHour.get(h).join(', ')}`)
      .join(' | ');
    lines.push(`- ${mem.name}: ${mCap} CAP (${mPts.toLocaleString('vi-VN')}p) -> ${detail}`);
  }

  return lines.join('\n');
}
