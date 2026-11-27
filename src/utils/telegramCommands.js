import {
  computeDistributionStats,
  getMemberEffectiveShiftsForDay,
  getMemberShiftsOnDate,
  parseCapHour,
} from './capAlgorithm.js';
import { addDaysToIso } from './storage.js';
import {
  escapeTelegramHtml,
  extractOfferNameCode,
  formatShortDateVi,
  getDefaultBotIcon,
  getDefaultBotLabel,
} from './telegramMessages.js';

/**
 * Remove Vietnamese diacritics and normalize whitespace for resilient matching.
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeVietnameseText(raw) {
  return String(raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize Telegram @username into lowercase handle without leading '@'.
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeTelegramUsername(raw) {
  return String(raw || '')
    .trim()
    .replace(/^@+/, '')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .toLowerCase()
    .slice(0, 64);
}

/**
 * Deterministic 8-char hex FNV-1a hash so Telegram callback_data stays well under 64 bytes.
 * @param {string} str
 * @returns {string}
 */
export function shortCallbackHash(str) {
  let hash = 0x811c9dc5;
  const text = String(str || '');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Convert YYYY-MM-DD to compact YYMMDD for callback_data.
 * @param {string} dateStr
 * @returns {string}
 */
export function encodeCompactDate(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  return `${m[1].slice(2)}${m[2]}${m[3]}`;
}

/**
 * Convert YYMMDD back to YYYY-MM-DD.
 * @param {string} compact
 * @returns {string}
 */
export function decodeCompactDate(compact) {
  const m = String(compact || '').match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!m) return '';
  return `20${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * Match a Telegram sender (`from: { id, username, first_name, last_name }`) to a group member.
 * Priority: telegramUserId -> @telegramUsername -> unique normalized display name fallback.
 * @param {{ id?: string | number, username?: string, first_name?: string, last_name?: string } | null | undefined} fromUser
 * @param {Array<any>} members
 * @returns {{ member: any | null, matchType: 'userId' | 'username' | 'name' | 'none' }}
 */
export function matchTelegramSenderToMember(fromUser, members = []) {
  if (!fromUser || !Array.isArray(members) || members.length === 0) {
    return { member: null, matchType: 'none' };
  }

  const tgId = fromUser.id !== undefined && fromUser.id !== null ? String(fromUser.id).trim() : '';
  if (tgId) {
    const byId = members.find((m) => m && String(m.telegramUserId || '').trim() === tgId);
    if (byId) return { member: byId, matchType: 'userId' };
  }

  const tgUser = normalizeTelegramUsername(fromUser.username);
  if (tgUser) {
    const byUsername = members.find(
      (m) => m && normalizeTelegramUsername(m.telegramUsername) === tgUser
    );
    if (byUsername) return { member: byUsername, matchType: 'username' };
  }

  const candidateNames = [
    [fromUser.first_name, fromUser.last_name].filter(Boolean).join(' '),
    fromUser.first_name || '',
    fromUser.last_name || '',
  ]
    .map(normalizeVietnameseText)
    .filter((s) => s.length >= 2);

  for (const cand of candidateNames) {
    const matches = members.filter((m) => m && normalizeVietnameseText(m.name) === cand);
    if (matches.length === 1) {
      return { member: matches[0], matchType: 'name' };
    }
  }

  return { member: null, matchType: 'none' };
}

/**
 * Find a member by @username or Vietnamese name query (exact first, then unique partial).
 * @param {string} rawQuery
 * @param {Array<any>} members
 * @returns {any | null}
 */
export function resolveMemberByQuery(rawQuery, members = []) {
  const clean = String(rawQuery || '').trim();
  if (!clean || !Array.isArray(members) || members.length === 0) return null;

  if (clean.startsWith('@')) {
    const handle = normalizeTelegramUsername(clean);
    if (!handle) return null;
    const byHandle = members.find(
      (m) => m && normalizeTelegramUsername(m.telegramUsername) === handle
    );
    if (byHandle) return byHandle;
  }

  const normQuery = normalizeVietnameseText(clean.replace(/^@+/, ''));
  if (!normQuery) return null;

  const exact = members.filter((m) => m && normalizeVietnameseText(m.name) === normQuery);
  if (exact.length === 1) return exact[0];

  const partial = members.filter((m) => m && normalizeVietnameseText(m.name).includes(normQuery));
  if (partial.length === 1) return partial[0];

  return null;
}

/**
 * Find an offer by code, numeric prefix in offer.name, or partial name.
 * @param {string} rawQuery
 * @param {Array<any>} campaigns
 * @returns {any | null}
 */
export function resolveOfferByQuery(rawQuery, campaigns = []) {
  const clean = String(rawQuery || '').trim().toLowerCase();
  if (!clean || !Array.isArray(campaigns) || campaigns.length === 0) return null;

  const exactCode = campaigns.find(
    (c) =>
      c &&
      (String(c.code || '').trim().toLowerCase() === clean ||
        extractOfferNameCode(c).toLowerCase() === clean)
  );
  if (exactCode) return exactCode;

  const normQuery = normalizeVietnameseText(clean);
  const partial = campaigns.filter(
    (c) =>
      c &&
      (normalizeVietnameseText(c.code).includes(normQuery) ||
        normalizeVietnameseText(c.name).includes(normQuery))
  );
  if (partial.length === 1) return partial[0];
  return null;
}

/**
 * Parse Telegram bot slash commands (supports /cmd@BotUsername).
 * @param {string} rawText
 * @returns {{
 *   type: 'none' | 'unknown' | 'help' | 'link' | 'cap' | 'ca' | 'tiendo' | 'nhuong',
 *   commandName?: string,
 *   mentionedBot?: string,
 *   argsText: string,
 *   shifts?: Array<string>,
 *   isOff?: boolean,
 *   dayOffset?: number,
 *   qty?: number,
 *   offerQuery?: string,
 *   targetQuery?: string,
 *   note?: string,
 * }}
 */
export function parseTelegramCommand(rawText) {
  const text = String(rawText || '').trim();
  if (!text.startsWith('/')) {
    return { type: 'none', argsText: '' };
  }

  const match = text.match(/^\/([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/);
  if (!match) {
    return { type: 'none', argsText: '' };
  }

  const cmd = match[1].toLowerCase();
  const mentionedBot = String(match[2] || '').trim().toLowerCase();
  const argsText = String(match[3] || '').trim();

  if (cmd === 'start' || cmd === 'help') {
    return { type: 'help', commandName: cmd, mentionedBot, argsText };
  }

  if (cmd === 'link') {
    return { type: 'link', commandName: cmd, mentionedBot, argsText };
  }

  if (cmd === 'cap') {
    return { type: 'cap', commandName: cmd, mentionedBot, argsText, targetQuery: argsText };
  }

  if (cmd === 'tiendo' || cmd === 'progress') {
    return { type: 'tiendo', commandName: cmd, mentionedBot, argsText };
  }

  if (cmd === 'ca') {
    const norm = normalizeVietnameseText(argsText);
    const dayOffset = /\b(hom nay|nay|today)\b/.test(norm) ? 0 : 1;
    const isOff = /\b(nghi|off|khong lam)\b/.test(norm);
    const shifts = [];
    if (!isOff) {
      if (/\bca\s*1\b/.test(norm) || /\b1\b/.test(norm)) shifts.push('ca1');
      if (/\bca\s*2\b/.test(norm) || /\b2\b/.test(norm)) shifts.push('ca2');
      if (/\bca\s*3\b/.test(norm) || /\b3\b/.test(norm)) shifts.push('ca3');
    }
    return { type: 'ca', commandName: cmd, mentionedBot, argsText, shifts, isOff, dayOffset };
  }

  if (cmd === 'nhuong' || cmd === 'swap') {
    // Format: /nhuong <qty> <offerCode> <@receiver|ten> [note]
    // Also support: /nhuong <offerCode> <@receiver|ten> (defaults qty=1)
    const tokens = argsText.split(/\s+/).filter(Boolean);
    let qty = 1;
    let offerQuery = '';
    let targetTokens = [];

    if (tokens.length >= 2 && /^\d+$/.test(tokens[0])) {
      qty = Math.max(1, Math.min(100, Number(tokens[0])));
      offerQuery = tokens[1] || '';
      targetTokens = tokens.slice(2);
    } else if (tokens.length >= 2) {
      offerQuery = tokens[0] || '';
      targetTokens = tokens.slice(1);
    }

    const targetQuery = targetTokens[0] || '';
    const note = targetTokens.slice(1).join(' ').slice(0, 160);

    return {
      type: 'nhuong',
      commandName: cmd,
      mentionedBot,
      argsText,
      qty,
      offerQuery,
      targetQuery,
      note,
    };
  }

  return { type: 'unknown', commandName: cmd, mentionedBot, argsText };
}

/**
 * Parse compact Telegram callback_data payloads.
 * @param {string} rawData
 */
export function parseCallbackData(rawData) {
  const data = String(rawData || '').trim();
  const parts = data.split(':');
  const action = parts[0] || '';

  if (action === 'cd' && parts.length === 4) {
    return {
      type: 'toggle_cap_done',
      dateStr: decodeCompactDate(parts[1]),
      offerHash: parts[2],
      memberHash: parts[3],
    };
  }
  if (action === 'ca' && parts.length === 3) {
    return {
      type: 'mark_all_done',
      dateStr: decodeCompactDate(parts[1]),
      memberHash: parts[2],
    };
  }
  if (action === 'my' && parts.length === 2) {
    return {
      type: 'open_my_cap',
      dateStr: decodeCompactDate(parts[1]),
    };
  }
  if (action === 'pg' && parts.length === 2) {
    return {
      type: 'show_progress',
      dateStr: decodeCompactDate(parts[1]),
    };
  }
  if (action === 'sh' && parts.length === 3) {
    return {
      type: 'toggle_shift',
      dateStr: decodeCompactDate(parts[1]),
      shiftCode: parts[2], // 'ca1' | 'ca2' | 'ca3' | 'off' | 'me'
    };
  }
  if (action === 'tk' && parts.length === 2) {
    return {
      type: 'approve_transfer',
      transferId: parts[1],
    };
  }
  if (action === 'tr' && parts.length === 2) {
    return {
      type: 'reject_transfer',
      transferId: parts[1],
    };
  }

  return { type: 'unknown' };
}

/**
 * Build inline keyboard shown under published CAP distribution photo/message.
 * @param {string} dateStr
 */
export function buildDistributionPublishKeyboard(dateStr) {
  const d = encodeCompactDate(dateStr);
  if (!d) return undefined;
  return {
    inline_keyboard: [
      [
        { text: '✅ Tích xong CAP của tôi', callback_data: `my:${d}` },
        { text: '📊 Tiến độ nhóm', callback_data: `pg:${d}` },
      ],
    ],
  };
}

/**
 * Build inline keyboard for a specific member's CAP checklist (used for /cap & "Tích xong CAP của tôi").
 * @param {{ dateStr: string, member: any, campaigns?: Array<any>, matrix?: Record<string, any>, completionsForDate?: Record<string, any> }} params
 */
export function buildMemberCapChecklistKeyboard({
  dateStr,
  member,
  campaigns = [],
  matrix = {},
  completionsForDate = {},
}) {
  const d = encodeCompactDate(dateStr);
  if (!d || !member?.id) return undefined;

  const mHash = shortCallbackHash(member.id);
  const rows = [];
  let row = [];
  let hasUnfinished = false;

  for (const camp of campaigns) {
    if (!camp?.id) continue;
    const qty = Math.max(0, Math.floor(Number(matrix?.[camp.id]?.[member.id]) || 0));
    if (qty <= 0) continue;

    const isDone = Boolean(completionsForDate?.[camp.id]?.[member.id]);
    if (!isDone) hasUnfinished = true;

    const shortCode = extractOfferNameCode(camp) || camp.code || 'Offer';
    const icon = isDone ? '✅' : '⬜';
    const label = `${icon} ${shortCode} (${qty})`;
    row.push({
      text: label.slice(0, 32),
      callback_data: `cd:${d}:${shortCallbackHash(camp.id)}:${mHash}`,
    });
    if (row.length === 2) {
      rows.push(row);
      row = [];
    }
  }

  if (row.length > 0) rows.push(row);
  if (rows.length === 0) return undefined;

  if (hasUnfinished) {
    rows.push([{ text: '✨ Đánh dấu xong toàn bộ hôm nay', callback_data: `ca:${d}:${mHash}` }]);
  }

  return { inline_keyboard: rows };
}

/**
 * Build inline keyboard for quick next-day shift registration on 11:00 reminder & /ca.
 * @param {string} targetDateStr
 */
export function buildShiftReminderKeyboard(targetDateStr) {
  const d = encodeCompactDate(targetDateStr);
  if (!d) return undefined;
  return {
    inline_keyboard: [
      [
        { text: 'Ca 1', callback_data: `sh:${d}:ca1` },
        { text: 'Ca 2', callback_data: `sh:${d}:ca2` },
        { text: 'Ca 3', callback_data: `sh:${d}:ca3` },
        { text: 'Nghỉ', callback_data: `sh:${d}:off` },
      ],
      [{ text: '👀 Xem lịch ca của tôi', callback_data: `sh:${d}:me` }],
    ],
  };
}

/**
 * Build Leader approval keyboard for a CAP transfer request.
 * @param {string} transferId
 */
export function buildTransferApprovalKeyboard(transferId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Leader Duyệt', callback_data: `tk:${transferId}` },
        { text: '❌ Từ chối', callback_data: `tr:${transferId}` },
      ],
    ],
  };
}

/**
 * Format personal CAP schedule message for a member on a given date.
 * @param {{ member: any, dateStr: string, campaigns?: Array<any>, matrix?: Record<string, any>, completionsForDate?: Record<string, any> }} params
 */
export function formatMemberTelegramCapMessage({
  member,
  dateStr,
  campaigns = [],
  matrix = {},
  completionsForDate = {},
}) {
  if (!member) return 'Không tìm thấy thông tin thành viên.';
  const shortDate = formatShortDateVi(dateStr);
  const assigned = [];
  let totalCap = 0;
  let doneCap = 0;
  let totalPoints = 0;

  for (const camp of campaigns) {
    if (!camp?.id) continue;
    const qty = Math.max(0, Math.floor(Number(matrix?.[camp.id]?.[member.id]) || 0));
    if (qty <= 0) continue;
    const isDone = Boolean(completionsForDate?.[camp.id]?.[member.id]);
    const pts = Number(camp.pointsPerCap) || 0;
    totalCap += qty;
    totalPoints += qty * pts;
    if (isDone) doneCap += qty;
    assigned.push({
      code: extractOfferNameCode(camp) || camp.code,
      capHour: camp.capHour || '',
      qty,
      pts,
      isDone,
    });
  }

  assigned.sort((a, b) => {
    const ha = parseCapHour(a.capHour);
    const hb = parseCapHour(b.capHour);
    if (ha === null && hb === null) return 0;
    if (ha === null) return 1;
    if (hb === null) return -1;
    return ha - hb;
  });

  if (assigned.length === 0) {
    return `🎩 <b>${escapeTelegramHtml(member.name)}</b> hiện chưa có CAP nào trong bảng chia ngày <b>${escapeTelegramHtml(shortDate)}</b> ạ.`;
  }

  const lines = [
    `🎩 <b>Lịch CAP của ${escapeTelegramHtml(member.name)} – Ngày ${escapeTelegramHtml(shortDate)}</b>`,
    `Tổng: <b>${totalCap} CAP</b> (<b>${totalPoints.toLocaleString('vi-VN')} point</b>) · Đã xong: <b>${doneCap}/${totalCap} CAP</b>`,
    '',
  ];

  for (const item of assigned) {
    const icon = item.isDone ? '✅' : '⬜';
    const hourPart = item.capHour ? `[${escapeTelegramHtml(item.capHour)}] ` : '';
    lines.push(
      `${icon} ${hourPart}<code>${escapeTelegramHtml(item.code)}</code>: <b>${item.qty} CAP</b> (${item.qty * item.pts}p)`
    );
  }

  lines.push('', 'Bấm trực tiếp các nút bên dưới để tích hoàn thành theo thời gian thực ạ:');
  return lines.join('\n');
}

/**
 * Compute progress metrics and unfinished members list for a saved day's CAP distribution.
 */
export function computeCompletionProgress({
  members = [],
  campaigns = [],
  matrix = {},
  completionsForDate = {},
  dateStr = '',
}) {
  const stats = computeDistributionStats(matrix, campaigns, members, dateStr);
  let totalCap = 0;
  let completedCap = 0;
  const unfinishedByMember = [];
  const completedMembers = [];

  for (const mem of members) {
    if (!mem?.id) continue;
    let memTotal = 0;
    let memDone = 0;
    const pendingOffers = [];

    for (const camp of campaigns) {
      if (!camp?.id) continue;
      const qty = Math.max(0, Math.floor(Number(matrix?.[camp.id]?.[mem.id]) || 0));
      if (qty <= 0) continue;
      memTotal += qty;
      totalCap += qty;
      if (completionsForDate?.[camp.id]?.[mem.id]) {
        memDone += qty;
        completedCap += qty;
      } else {
        pendingOffers.push({
          code: extractOfferNameCode(camp) || camp.code,
          capHour: camp.capHour || '',
          qty,
        });
      }
    }

    if (memTotal > 0) {
      if (pendingOffers.length === 0) {
        completedMembers.push({ member: mem, totalCap: memTotal });
      } else {
        unfinishedByMember.push({
          member: mem,
          totalCap: memTotal,
          doneCap: memDone,
          remainingCap: memTotal - memDone,
          pendingOffers,
        });
      }
    }
  }

  const percent = totalCap > 0 ? Math.round((completedCap / totalCap) * 100) : 0;

  return {
    totalCap,
    completedCap,
    percent,
    completedMembers,
    unfinishedByMember,
    stats,
  };
}

/**
 * Format member tag cleanly (mentions @telegramUsername if present, otherwise bold display name).
 * @param {any} member
 * @returns {string}
 */
export function formatTelegramMemberTag(member) {
  const nameHtml = `<b>${escapeTelegramHtml(member?.name || 'Thành viên')}</b>`;
  const handle = normalizeTelegramUsername(member?.telegramUsername);
  return handle ? `${nameHtml} (@${escapeTelegramHtml(handle)})` : nameHtml;
}

/**
 * Format real-time CAP progress message (/tiendo or inline button).
 * @param {{ groupName?: string, dateStr?: string, members?: Array<any>, campaigns?: Array<any>, matrix?: Record<string, any>, completionsForDate?: Record<string, any>, appLink?: string }} params
 */
export function formatTelegramProgressMessage({
  groupName = 'Nhóm 1',
  dateStr = '',
  members = [],
  campaigns = [],
  matrix = {},
  completionsForDate = {},
  appLink = '',
}) {
  const shortDate = formatShortDateVi(dateStr);
  const progress = computeCompletionProgress({
    members,
    campaigns,
    matrix,
    completionsForDate,
    dateStr,
  });

  if (progress.totalCap === 0) {
    return `🎩 Nhóm <b>${escapeTelegramHtml(groupName)}</b> chưa lưu bảng chia CAP cho ngày <b>${escapeTelegramHtml(shortDate)}</b> ạ.`;
  }

  const lines = [
    `📊 <b>Tiến độ CAP ngày ${escapeTelegramHtml(shortDate)} – ${escapeTelegramHtml(groupName)}</b>`,
    `Hoàn thành: <b>${progress.completedCap}/${progress.totalCap} CAP (${progress.percent}%)</b>`,
    '',
  ];

  if (progress.completedMembers.length > 0) {
    lines.push(
      `✅ <b>Đã xong hết:</b> ${progress.completedMembers
        .map((x) => `${escapeTelegramHtml(x.member.name)} (${x.totalCap})`)
        .join(', ')}`
    );
  }

  if (progress.unfinishedByMember.length > 0) {
    lines.push(`⏳ <b>Chưa hoàn thành (${progress.unfinishedByMember.length} người):</b>`);
    for (const item of progress.unfinishedByMember) {
      const offerList = item.pendingOffers
        .map((o) => `${escapeTelegramHtml(o.code)}(${o.qty})`)
        .join(', ');
      lines.push(
        `• ${formatTelegramMemberTag(item.member)}: còn <b>${item.remainingCap} CAP</b> — ${offerList}`
      );
    }
  } else {
    lines.push('🎉 Cả nhà đã hoàn thành 100% CAP hôm nay rồi ạ!');
  }

  if (appLink) {
    lines.push('', `🔗 <a href="${escapeTelegramHtml(appLink)}">Mở Dashboard tích hoàn thành</a>`);
  }

  return lines.join('\n');
}

/**
 * Format scheduled pre-cutoff unfinished CAP nudge message.
 * @param {{ groupId?: string, groupName?: string, dateStr?: string, members?: Array<any>, campaigns?: Array<any>, matrix?: Record<string, any>, completionsForDate?: Record<string, any>, appLink?: string }} params
 */
export function formatTelegramCutoffNudgeMessage({
  groupId = '',
  groupName = 'Nhóm 1',
  dateStr = '',
  members = [],
  campaigns = [],
  matrix = {},
  completionsForDate = {},
  appLink = '',
}) {
  const progress = computeCompletionProgress({
    members,
    campaigns,
    matrix,
    completionsForDate,
    dateStr,
  });

  if (progress.totalCap === 0 || progress.unfinishedByMember.length === 0) {
    return '';
  }

  const shortDate = formatShortDateVi(dateStr);
  const botIcon = getDefaultBotIcon(groupId);
  const botLabel = getDefaultBotLabel(groupId);
  const lines = [
    `${botIcon} <b>${botLabel} nhắc nhẹ – Còn CAP chưa tích xong (${escapeTelegramHtml(shortDate)})</b>`,
    `Hiện nhóm <b>${escapeTelegramHtml(groupName)}</b> đạt <b>${progress.completedCap}/${progress.totalCap} CAP (${progress.percent}%)</b>. Các thành viên còn CAP nhớ kiểm tra &amp; bấm tích hoàn thành trước giờ chốt nhé:`,
    '',
  ];

  for (const item of progress.unfinishedByMember) {
    const offerList = item.pendingOffers
      .map((o) => `${escapeTelegramHtml(o.code)}(${o.qty})`)
      .join(', ');
    lines.push(
      `• ${formatTelegramMemberTag(item.member)}: còn <b>${item.remainingCap} CAP</b> (${offerList})`
    );
  }

  if (appLink) {
    lines.push('', `🔗 <a href="${escapeTelegramHtml(appLink)}">Mở Dashboard tích CAP ngay</a>`);
  }
  return lines.join('\n');
}

/**
 * Format end-of-day summary message (deterministic fallback or when AI butler is off).
 * @param {{ groupName?: string, dateStr?: string, members?: Array<any>, campaigns?: Array<any>, matrix?: Record<string, any>, completionsForDate?: Record<string, any> }} params
 */
export function formatTelegramDailySummaryMessage({
  groupName = 'Nhóm 1',
  dateStr = '',
  members = [],
  campaigns = [],
  matrix = {},
  completionsForDate = {},
}) {
  const progress = computeCompletionProgress({
    members,
    campaigns,
    matrix,
    completionsForDate,
    dateStr,
  });
  if (progress.totalCap === 0) return '';

  const shortDate = formatShortDateVi(dateStr);
  const nextDate = addDaysToIso(dateStr, 1);
  const shortNext = formatShortDateVi(nextDate);
  const nextWorking = members
    .filter((m) => m && m.active !== false)
    .map((m) => {
      const sh = getMemberShiftsOnDate(m, nextDate);
      return `${escapeTelegramHtml(m.name)}: ${sh.length > 0 ? sh.map((s) => s.toUpperCase()).join('/') : 'Nghỉ'}`;
    });

  const lines = [
    `🌙 <b>Tổng kết cuối ngày ${escapeTelegramHtml(shortDate)} – ${escapeTelegramHtml(groupName)}</b>`,
    `• Hoàn thành: <b>${progress.completedCap}/${progress.totalCap} CAP (${progress.percent}%)</b>`,
    `• Tổng điểm bảng chia: <b>${progress.stats.assignedTotalPoints.toLocaleString('vi-VN')} point</b>`,
  ];

  if (progress.unfinishedByMember.length > 0) {
    lines.push(
      `• Còn tồn chưa tích: ${progress.unfinishedByMember
        .map((x) => `${escapeTelegramHtml(x.member.name)} (${x.remainingCap})`)
        .join(', ')}`
    );
  } else {
    lines.push('• Tuyệt vời! Cả nhóm đã hoàn thành 100% CAP hôm nay.');
  }

  if (nextWorking.length > 0) {
    lines.push('', `📅 <b>Lịch ca dự kiến ngày mai (${escapeTelegramHtml(shortNext)}):</b>`, nextWorking.join(' · '));
  }

  return lines.join('\n');
}

/**
 * Build help text listing supported 2-way Telegram commands.
 */
export function formatTelegramHelpMessage(groupName = 'Nhóm', groupId = '') {
  const botIcon = getDefaultBotIcon(groupId);
  const botLabel = getDefaultBotLabel(groupId);
  const mentionHint =
    groupId === 'group-1' ? 'Quản gia / Bot / AI' : 'Bot / AI';
  return [
    `${botIcon} <b>Hướng dẫn ${botLabel} 2 chiều – ${escapeTelegramHtml(groupName)}</b>`,
    '',
    '• <code>/link Tên của bạn</code> — Liên kết tài khoản Telegram với tên trong bảng CAP',
    '• <code>/cap</code> — Xem lịch CAP hôm nay &amp; bấm nút tích hoàn thành',
    '• <code>/ca ca1 ca3</code> hoặc <code>/ca nghi</code> — Đăng ký nhanh ca làm ngày mai (thêm <code>nay</code> nếu sửa hôm nay)',
    '• <code>/tiendo</code> — Xem % hoàn thành &amp; danh sách CAP chưa xong',
    '• <code>/nhuong 1 1769 @Ten</code> — Gửi đề xuất nhượng 1 CAP offer 1769 chờ Leader duyệt',
    '',
    `💡 Ngoài ra bạn có thể nhắn tự nhiên (khi nhắc ${mentionHint}, tag @bot hoặc reply tin nhắn của Bot) như: <i>"mai cho Huy Bảo xin nghỉ ca 3"</i> hoặc <i>"xong offer 1769 rồi"</i>.`,
  ].join('\n');
}

/**
 * Format compact summary of a member's shifts for a given date.
 */
export function formatMemberShiftSummaryText(member, dateStr) {
  const { todayShifts } = getMemberEffectiveShiftsForDay(member, dateStr);
  if (!todayShifts || todayShifts.length === 0) return 'Nghỉ cả ngày';
  return todayShifts
    .map((s) => (s === 'ca1' ? 'Ca 1' : s === 'ca2' ? 'Ca 2' : s === 'ca3' ? 'Ca 3' : s))
    .join(', ');
}
