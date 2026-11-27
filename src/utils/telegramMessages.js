import { getMemberEffectiveShiftsForDay } from './capAlgorithm.js';
import { addDaysToIso } from './storage.js';

/**
 * Parse offer code from offer.name (e.g. "21997905 - EverydayHealth - Diabetes Snacks" -> "21997905"),
 * falling back to offer.code if offer.name does not contain a numeric prefix/token.
 */
export function extractOfferNameCode(offer) {
  if (!offer) return '';
  const name = String(offer.name || '').trim();
  if (name) {
    const leadingMatch = name.match(/^(\d{2,15})\b/);
    if (leadingMatch) {
      return leadingMatch[1];
    }
    const tokenMatch = name.match(/\b(\d{3,15})\b/);
    if (tokenMatch) {
      return tokenMatch[1];
    }
  }
  return String(offer.code || offer.id || '').trim();
}

/**
 * Validate a Telegram group/channel chat ID (e.g. "-1001234567890", "-4512345678", or "@groupname").
 * Empty string is allowed when Telegram is disabled; non-empty values must match Telegram ID syntax.
 */
export function isValidTelegramChatId(rawChatId, { allowEmpty = false } = {}) {
  const clean = String(rawChatId || '').trim();
  if (!clean) return allowEmpty;
  return /^-?\d{5,20}$/.test(clean) || /^@[a-zA-Z0-9_]{5,32}$/.test(clean);
}

export function escapeTelegramHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function formatShortDateVi(dateStr) {
  if (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const [, m, d] = dateStr.split('-');
    return `${d}/${m}`;
  }
  return String(dateStr || 'hôm nay');
}

export function buildDashboardShareLink(baseUrl, groupId, dateStr, tab = '') {
  const fallback = 'http://localhost:3000';
  const cleanBase = String(baseUrl || fallback).trim().replace(/\/+$/, '');
  const params = new URLSearchParams();
  if (groupId) params.set('groupId', String(groupId));
  if (dateStr) params.set('date', String(dateStr));
  if (tab) params.set('tab', String(tab));
  const query = params.toString();
  return query ? `${cleanBase}/?${query}` : cleanBase;
}

/**
 * Resolve public base URL across AI Studio, Render (RENDER_EXTERNAL_URL),
 * Koyeb (KOYEB_PUBLIC_DOMAIN), reverse-proxy request headers, or localhost.
 */
export function resolveAppBaseUrl({
  env = {},
  protocol = '',
  host = '',
  port = 3000,
} = {}) {
  const normalizeHttpUrl = (raw) => {
    const clean = String(raw || '').trim();
    if (!clean || clean.includes('MY_APP_URL')) return '';
    if (/^https?:\/\//i.test(clean)) return clean.replace(/\/+$/, '');
    return '';
  };

  const explicitUrl = normalizeHttpUrl(env.APP_URL);
  if (explicitUrl) return explicitUrl;

  const renderUrl = normalizeHttpUrl(env.RENDER_EXTERNAL_URL);
  if (renderUrl) return renderUrl;

  const koyebRaw = String(env.KOYEB_PUBLIC_DOMAIN || '').trim();
  if (koyebRaw) {
    const withProto = /^https?:\/\//i.test(koyebRaw) ? koyebRaw : `https://${koyebRaw}`;
    const normalizedKoyeb = normalizeHttpUrl(withProto);
    if (normalizedKoyeb) return normalizedKoyeb;
  }

  const cleanHost = String(host || '').split(',')[0].trim();
  if (cleanHost) {
    const cleanProto = String(protocol || 'http').split(',')[0].trim().toLowerCase();
    const safeProto = cleanProto === 'https' ? 'https' : 'http';
    return `${safeProto}://${cleanHost}`;
  }

  const safePort = Number.isFinite(Number(port)) && Number(port) > 0 ? Number(port) : 3000;
  return `http://localhost:${safePort}`;
}

/**
 * Return current date & time parts in Asia/Ho_Chi_Minh (UTC+7).
 */
export function getVietnamDateTimeParts(now = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const map = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const rawHour = Number(map.hour);
  return {
    dateStr: `${map.year}-${map.month}-${map.day}`,
    hour: rawHour === 24 ? 0 : rawHour,
    minute: Number(map.minute),
  };
}

/**
 * Determine whether a scheduled daily Telegram job should run now (VN time),
 * allowing a bounded catch-up window after target HH:MM (for serverless cold starts)
 * while strictly deduplicating against `lastSentDate`.
 */
export function shouldRunScheduledJob({
  targetHHMM = '11:00',
  curHour,
  curMinute,
  dateStr,
  lastSentDate = '',
  catchUpMinutes = 180,
}) {
  if (!dateStr || lastSentDate === dateStr) return false;
  const match = String(targetHHMM || '').trim().match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return false;
  const targetTotal = Number(match[1]) * 60 + Number(match[2]);
  const curTotal = Number(curHour) * 60 + Number(curMinute);
  if (!Number.isFinite(curTotal)) return false;
  const maxWindow = Math.max(10, Number(catchUpMinutes) || 10);
  return curTotal >= targetTotal && curTotal <= targetTotal + maxWindow;
}

/**
 * Compute deterministic lightweight hash of a CAP distribution matrix for Telegram delivery dedupe.
 */
export function computeDistributionMatrixHash(campaigns = [], members = [], matrix = {}) {
  const campIds = (Array.isArray(campaigns) ? campaigns : [])
    .filter((c) => c && c.id)
    .map((c) => String(c.id))
    .sort();
  const memIds = (Array.isArray(members) ? members : [])
    .filter((m) => m && m.id)
    .map((m) => String(m.id))
    .sort();
  const parts = [];
  for (const cId of campIds) {
    for (const mId of memIds) {
      const qty = Math.max(0, Math.floor(Number(matrix?.[cId]?.[mId]) || 0));
      if (qty > 0) {
        parts.push(`${cId}:${mId}=${qty}`);
      }
    }
  }
  const canonical = parts.join('|');
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < canonical.length; i++) {
    const ch = canonical.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= ch + ((i + 1) & 0xff);
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return `m-${h1.toString(36)}-${h2.toString(36)}-${parts.length}`;
}

export function stripTelegramHtml(html) {
  return String(html || '')
    .replace(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<\/?(b|strong|i|em|code|pre|u|s)>/gi, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

/**
 * Compute per-(member, offer) CAP deltas between a previously saved record and the new snapshot.
 * Uses extractOfferNameCode(offer) (e.g. 21997905 from offer.name) for clear identification in Telegram.
 */
export function computeDistributionDiff(
  prevRecord,
  nextSnapshot,
  fallbackCampaigns = [],
  fallbackMembers = []
) {
  if (!prevRecord || !nextSnapshot) return [];

  const prevCampaigns = Array.isArray(prevRecord.campaigns) ? prevRecord.campaigns : [];
  const nextCampaigns =
    Array.isArray(nextSnapshot.campaigns) && nextSnapshot.campaigns.length > 0
      ? nextSnapshot.campaigns
      : fallbackCampaigns;

  const prevMembers = Array.isArray(prevRecord.members) ? prevRecord.members : [];
  const nextMembers =
    Array.isArray(nextSnapshot.members) && nextSnapshot.members.length > 0
      ? nextSnapshot.members
      : fallbackMembers;

  const offerMap = new Map();
  for (const camp of prevCampaigns) {
    if (camp?.id) offerMap.set(camp.id, camp);
  }
  for (const camp of nextCampaigns) {
    if (camp?.id) offerMap.set(camp.id, camp);
  }

  const memberMap = new Map();
  for (const mem of prevMembers) {
    if (mem?.id) memberMap.set(mem.id, mem);
  }
  for (const mem of nextMembers) {
    if (mem?.id) memberMap.set(mem.id, mem);
  }

  const orderedOffers = [
    ...nextCampaigns,
    ...prevCampaigns.filter((c) => c?.id && !nextCampaigns.some((nc) => nc.id === c.id)),
  ];
  const orderedMembers = [
    ...nextMembers,
    ...prevMembers.filter((m) => m?.id && !nextMembers.some((nm) => nm.id === m.id)),
  ];

  const seenPairs = new Set();
  const diffs = [];

  for (const mem of orderedMembers) {
    if (!mem?.id) continue;
    for (const camp of orderedOffers) {
      if (!camp?.id) continue;
      const pairKey = `${mem.id}::${camp.id}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      const prevCap = Math.max(0, Math.floor(Number(prevRecord.matrix?.[camp.id]?.[mem.id]) || 0));
      const nextCap = Math.max(0, Math.floor(Number(nextSnapshot.matrix?.[camp.id]?.[mem.id]) || 0));
      const delta = nextCap - prevCap;
      if (delta === 0) continue;

      const resolvedOffer = offerMap.get(camp.id) || camp;
      const resolvedMember = memberMap.get(mem.id) || mem;

      diffs.push({
        memberId: mem.id,
        memberName: resolvedMember.name || 'Thành viên',
        offerId: camp.id,
        offerCode: extractOfferNameCode(resolvedOffer),
        legacyCode: String(resolvedOffer.code || ''),
        offerName: String(resolvedOffer.name || ''),
        prevCap,
        nextCap,
        delta,
      });
    }
  }

  return diffs;
}

function closeUnclosedTelegramHtmlTags(slice) {
  let clean = String(slice || '').replace(/<[^>]*$/, '');
  const tagStack = [];
  const tagRegex = /<\/?(b|i|code|pre|a|u|s)(?:\s+[^>]*)?>/gi;
  let m;
  while ((m = tagRegex.exec(clean)) !== null) {
    const full = m[0];
    const tagName = m[1].toLowerCase();
    if (full.startsWith('</')) {
      const idx = tagStack.lastIndexOf(tagName);
      if (idx !== -1) tagStack.splice(idx, 1);
    } else {
      tagStack.push(tagName);
    }
  }
  for (let i = tagStack.length - 1; i >= 0; i--) {
    clean += `</${tagStack[i]}>`;
  }
  return clean;
}

function truncateTelegramHtml(text, footerHtml, maxLen = 3950) {
  if (text.length <= maxLen) return text;
  const suffix = `\n...\n${footerHtml || ''}`;
  const cutoff = Math.max(120, maxLen - suffix.length - 16);
  const sliced = text.slice(0, cutoff);
  const lastNewline = sliced.lastIndexOf('\n');
  const candidate = lastNewline > 100 ? sliced.slice(0, lastNewline) : sliced;
  return `${closeUnclosedTelegramHtmlTags(candidate)}${suffix}`;
}

function summarizeOfferDistribution(offerMatrixRow = {}, members = [], workingMembers = []) {
  const qtyById = new Map();
  const receivers = [];

  for (const mem of members) {
    if (!mem?.id) continue;
    const qty = Math.max(0, Math.floor(Number(offerMatrixRow?.[mem.id]) || 0));
    qtyById.set(mem.id, qty);
    if (qty > 0) {
      receivers.push({ member: mem, qty });
    }
  }

  if (receivers.length === 0) return '';

  const freqMap = new Map();
  for (const r of receivers) {
    if (!freqMap.has(r.qty)) freqMap.set(r.qty, []);
    freqMap.get(r.qty).push(r.member.name || 'Thành viên');
  }

  // Pick dominant quantity among receivers (highest member count; tie-break by smaller qty)
  let modeQty = receivers[0].qty;
  let modeNames = [];
  for (const [qty, names] of freqMap.entries()) {
    if (
      names.length > modeNames.length ||
      (names.length === modeNames.length && qty < modeQty)
    ) {
      modeQty = qty;
      modeNames = names;
    }
  }

  const workingCount = workingMembers.length > 0 ? workingMembers.length : receivers.length;
  const zeroWorkingNames = workingMembers
    .filter((m) => (qtyById.get(m.id) || 0) === 0)
    .map((m) => m.name || 'Thành viên');

  const otherReceiversGroups = [...freqMap.entries()]
    .filter(([qty]) => qty !== modeQty)
    .sort((a, b) => a[0] - b[0]);

  const exceptionCount =
    receivers.filter((r) => r.qty !== modeQty).length + zeroWorkingNames.length;

  const canUseSharedSummary =
    modeNames.length >= 3 &&
    modeNames.length >= workingCount / 2 &&
    (zeroWorkingNames.length <= 1 || otherReceiversGroups.length <= 2) &&
    exceptionCount <= Math.max(2, Math.floor(workingCount / 2));

  if (canUseSharedSummary) {
    const exceptionParts = [];
    for (const [qty, names] of otherReceiversGroups) {
      exceptionParts.push(`${names.map(escapeTelegramHtml).join(', ')} ${qty} cap`);
    }
    if (zeroWorkingNames.length > 0) {
      exceptionParts.push(`${zeroWorkingNames.map(escapeTelegramHtml).join(', ')} 0 cap`);
    }
    return exceptionParts.length > 0
      ? `Mỗi người ${modeQty} cap (${exceptionParts.join(', ')})`
      : `Mỗi người ${modeQty} cap`;
  }

  // Compact receiver-by-receiver grouping when only a subset of members take this offer
  if (freqMap.size === 1) {
    const [[onlyQty, onlyNames]] = [...freqMap.entries()];
    if (onlyNames.length === 1) {
      return `${escapeTelegramHtml(onlyNames[0])} ${onlyQty} cap`;
    }
    return `${onlyNames.map(escapeTelegramHtml).join(', ')} (mỗi người ${onlyQty} cap)`;
  }

  const sortedGroups = [...freqMap.entries()].sort((a, b) => a[0] - b[0]);
  return sortedGroups
    .map(([qty, names]) => `${names.map(escapeTelegramHtml).join(', ')} ${qty} cap`)
    .join(' · ');
}

export const TELEGRAM_TEMPLATE_KEYS = [
  'capPublish',
  'capUpdate',
  'shiftReminder',
  'testMessage',
];

/**
 * Only Group 1 ("group-1") uses the "Quản gia" persona; all other groups default to "Bot" / "AI".
 * @param {string} [groupId]
 * @returns {boolean}
 */
export function isButlerGroup(groupId = '') {
  return String(groupId || '').trim() === 'group-1';
}

/**
 * @param {string} [groupId]
 * @returns {'Quản gia' | 'Bot'}
 */
export function getDefaultBotLabel(groupId = '') {
  return isButlerGroup(groupId) ? 'Quản gia' : 'Bot';
}

/**
 * @param {string} [groupId]
 * @returns {'🎩' | '🤖'}
 */
export function getDefaultBotIcon(groupId = '') {
  return isButlerGroup(groupId) ? '🎩' : '🤖';
}

/**
 * Return default Telegram templates for a given group ("Quản gia" for group-1, "Bot" for all others).
 * @param {string} [groupId]
 */
export function getDefaultTelegramTemplates(groupId = '') {
  const label = getDefaultBotLabel(groupId);
  const icon = getDefaultBotIcon(groupId);
  return {
    capPublish: [
      `**${icon} ${label} xin thông báo – Bảng chia CAP Ngày {date} ({group})**`,
      'Nhóm trưởng đã hoàn tất chia **{totalCap} CAP** hôm nay. Mời cả nhà xem chi tiết ở ảnh trên ạ!',
    ].join('\n'),
    capUpdate: [
      `**${icon} ${label} xin cập nhật – Bảng chia CAP Ngày {date} ({group})**`,
      '{changes}',
    ].join('\n'),
    shiftReminder: [
      `**${icon} ${label} xin nhắc nhẹ – Đăng ký ca làm ({date})**`,
      'Kính gửi cả nhà **{group}**, đã đến 11:00 rồi ạ! Mọi người tranh thủ ghé **CAP Manager → Quản lý ca làm** để đăng ký / cập nhật lịch ca của mình (Ca 1, Ca 2, Ca 3) trước khi Nhóm trưởng chốt chia CAP nhé.',
      '',
      '{shiftSummary}',
    ].join('\n'),
    testMessage: [
      `**${icon} ${label} đã sẵn sàng phục vụ {group}!**`,
      `Kết nối Bot Telegram thành công. ${label} sẽ tự động gửi bảng chia CAP khi Nhóm trưởng chốt và báo phần điều chỉnh cho cả nhà ạ.`,
    ].join('\n'),
  };
}

export const DEFAULT_TELEGRAM_TEMPLATES = getDefaultTelegramTemplates('');

export const TELEGRAM_TEMPLATE_META = {
  capPublish: {
    key: 'capPublish',
    label: 'Chia CAP mới',
    description: 'Gửi kèm ảnh bảng chia CAP khi Nhóm trưởng bấm "Lưu bảng chia CAP" lần đầu trong ngày.',
    maxPreviewHint: 'Tối đa 1020 ký tự khi gửi kèm ảnh Telegram.',
    variables: [
      { token: '{group}', label: 'Tên nhóm' },
      { token: '{date}', label: 'Ngày (dd/mm)' },
      { token: '{totalCap}', label: 'Tổng CAP' },
      { token: '{totalPoints}', label: 'Tổng điểm' },
      { token: '{link}', label: 'Vị trí link xem bảng' },
    ],
  },
  capUpdate: {
    key: 'capUpdate',
    label: 'Cập nhật CAP',
    description: 'Gửi kèm ảnh bảng mới khi Nhóm trưởng chỉnh sửa và lưu đè bảng chia CAP trong ngày.',
    maxPreviewHint: 'Tối đa 1020 ký tự khi gửi kèm ảnh Telegram.',
    variables: [
      { token: '{group}', label: 'Tên nhóm' },
      { token: '{date}', label: 'Ngày (dd/mm)' },
      { token: '{totalCap}', label: 'Tổng CAP' },
      { token: '{changes}', label: 'Chi tiết ô thay đổi' },
      { token: '{link}', label: 'Vị trí link xem bảng' },
    ],
  },
  shiftReminder: {
    key: 'shiftReminder',
    label: 'Nhắc ca 11:00',
    description: 'Tự động gửi lúc 11:00 hằng ngày (hoặc khi bấm "Gửi nhắc đăng ký ca") để nhắc thành viên đăng ký ca.',
    maxPreviewHint: 'Tự động liệt kê trạng thái ca ngày mai tại vị trí {shiftSummary}.',
    variables: [
      { token: '{group}', label: 'Tên nhóm' },
      { token: '{date}', label: 'Ngày (dd/mm)' },
      { token: '{shiftSummary}', label: 'Danh sách ca ngày mai' },
      { token: '{pendingCount}', label: 'Số người chưa đăng ký' },
      { token: '{registeredCount}', label: 'Số người đã đăng ký' },
      { token: '{link}', label: 'Vị trí link đăng ký ca' },
    ],
  },
  testMessage: {
    key: 'testMessage',
    label: 'Tin nhắn thử',
    description: 'Nội dung bot gửi khi bấm nút "Gửi thử tin nhắn" để kiểm tra kết nối nhóm Telegram.',
    maxPreviewHint: 'Dùng để kiểm tra nhanh Bot Token và Group Chat ID.',
    variables: [
      { token: '{group}', label: 'Tên nhóm' },
      { token: '{date}', label: 'Ngày (dd/mm)' },
      { token: '{link}', label: 'Vị trí link mở app' },
    ],
  },
};

/**
 * Sanitize and bound per-group custom Telegram message templates for safe storage.
 * @param {Record<string, unknown> | null | undefined} raw
 * @returns {{ capPublish: string, capUpdate: string, shiftReminder: string, testMessage: string }}
 */
export function sanitizeTelegramTemplates(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {
    capPublish: '',
    capUpdate: '',
    shiftReminder: '',
    testMessage: '',
  };
  for (const key of TELEGRAM_TEMPLATE_KEYS) {
    const val = typeof src[key] === 'string' ? src[key].replace(/\r\n/g, '\n').trim() : '';
    out[key] = val.slice(0, 800);
  }
  return out;
}

/**
 * Safely render a user-customized message template to Telegram HTML.
 * Escapes raw user HTML first, supports **bold**, then substitutes safe system placeholders.
 * @param {string} template
 * @param {{
 *   plainVars?: Record<string, string | number>,
 *   htmlVars?: Record<string, string>,
 *   linkHtml?: string,
 *   doubleNewlineBeforeLink?: boolean,
 * }} [options]
 * @returns {string}
 */
export function renderCustomTelegramTemplate(
  template,
  { plainVars = {}, htmlVars = {}, linkHtml = '', doubleNewlineBeforeLink = false } = {}
) {
  const raw = String(template || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return '';

  let rendered = escapeTelegramHtml(raw);
  rendered = rendered.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');

  for (const [k, v] of Object.entries(plainVars)) {
    const token = `{${k}}`;
    if (rendered.includes(token)) {
      rendered = rendered.split(token).join(escapeTelegramHtml(String(v ?? '')));
    }
  }

  for (const [k, v] of Object.entries(htmlVars)) {
    const token = `{${k}}`;
    if (rendered.includes(token)) {
      rendered = rendered.split(token).join(String(v ?? ''));
    }
  }

  if (rendered.includes('{link}')) {
    rendered = rendered.split('{link}').join(linkHtml || '');
  } else if (linkHtml) {
    rendered = `${rendered}${doubleNewlineBeforeLink ? '\n\n' : '\n'}${linkHtml}`;
  }

  return rendered.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Format full CAP distribution notification in Butler ("Quản gia") style, grouped cleanly by offer.
 * @param {{
 *   groupId?: string,
 *   groupName?: string,
 *   dateStr?: string,
 *   members?: Array<any>,
 *   campaigns?: Array<any>,
 *   matrix?: Record<string, any>,
 *   stats?: Record<string, any>,
 *   appLink?: string,
 *   customTemplate?: string,
 * }} params
 */
export function formatTelegramDistributionMessage({
  groupId = '',
  groupName = 'Nhóm 1',
  dateStr = '',
  members = [],
  campaigns = [],
  matrix = {},
  stats = {},
  appLink = '',
  customTemplate = '',
}) {
  const shortDate = formatShortDateVi(dateStr);
  const safeGroup = escapeTelegramHtml(groupName);
  const botLabel = getDefaultBotLabel(groupId);
  const botIcon = getDefaultBotIcon(groupId);
  const totalCap = stats?.assignedTotalCap ?? 0;
  const totalPointsFormatted = Number(stats?.assignedTotalPoints || 0).toLocaleString('vi-VN');

  const validMembers = (Array.isArray(members) ? members : []).filter((m) => m && m.id);
  const workingMembers = [];
  const offMembers = [];

  for (const mem of validMembers) {
    let memCap = 0;
    for (const camp of campaigns) {
      if (!camp?.id) continue;
      memCap += Math.max(0, Math.floor(Number(matrix?.[camp.id]?.[mem.id]) || 0));
    }
    if (memCap > 0) {
      workingMembers.push(mem);
    } else if (mem.active !== false) {
      offMembers.push(mem);
    }
  }

  const offerLines = [];
  for (const camp of campaigns) {
    if (!camp?.id) continue;
    const offerRow = matrix?.[camp.id] || {};
    let offerAssigned = 0;
    for (const mem of validMembers) {
      offerAssigned += Math.max(0, Math.floor(Number(offerRow[mem.id]) || 0));
    }
    if (offerAssigned <= 0) continue;

    const offerTitle = escapeTelegramHtml(
      String(camp.name || extractOfferNameCode(camp) || 'Offer').trim()
    );
    const summary = summarizeOfferDistribution(offerRow, validMembers, workingMembers);
    offerLines.push(`• <b>${offerTitle}</b>: <b>${offerAssigned} CAP</b> — ${summary}`);
  }

  if (offMembers.length > 0) {
    offerLines.push(
      '',
      `⏸ Nghỉ / 0 CAP hôm nay: ${offMembers.map((m) => escapeTelegramHtml(m.name)).join(', ')}`
    );
  }

  const footer = appLink
    ? `🔗 <a href="${escapeTelegramHtml(appLink)}">Xem bảng chi tiết &amp; tích hoàn thành CAP</a>`
    : '';

  const trimmedCustom = String(customTemplate || '').trim();
  if (trimmedCustom) {
    const headerHtml = renderCustomTelegramTemplate(trimmedCustom, {
      plainVars: {
        group: groupName,
        date: shortDate,
        totalCap,
        totalPoints: totalPointsFormatted,
      },
      linkHtml: '',
    });
    const parts = [headerHtml];
    if (offerLines.length > 0) {
      parts.push('', ...offerLines);
    }
    if (footer && !trimmedCustom.includes('{link}')) {
      parts.push('', footer);
    } else if (footer && trimmedCustom.includes('{link}')) {
      parts[0] = parts[0].split('{link}').join(footer);
    }
    return truncateTelegramHtml(parts.join('\n'), footer);
  }

  const lines = [
    `${botIcon} <b>${botLabel} xin thông báo – Bảng chia CAP Ngày ${escapeTelegramHtml(shortDate)}</b>`,
    `Kính gửi cả nhà <b>${safeGroup}</b>, Nhóm trưởng đã hoàn tất chia CAP hôm nay (tổng <b>${totalCap} CAP</b>). ${botLabel} xin gửi bảng chi tiết gọn gàng để mọi người tiện theo dõi ạ:`,
    '',
    ...offerLines,
  ];

  if (footer) {
    lines.push('', footer);
  }

  return truncateTelegramHtml(lines.join('\n'), footer);
}

/**
 * Build concise HTML summary of CAP changes for caption/template {changes}.
 */
function buildChangesSummaryHtml(diffs = [], totalCap = 0) {
  if (Array.isArray(diffs) && diffs.length > 0 && diffs.length <= 3) {
    const tokens = diffs.map((d) => {
      const sign = d.delta > 0 ? `+${d.delta}` : `${d.delta}`;
      return `<b>${escapeTelegramHtml(d.memberName)}</b> ${sign} CAP (<code>${escapeTelegramHtml(d.offerCode)}</code>)`;
    });
    return `Điều chỉnh: ${tokens.join(', ')}.`;
  }
  return `Nhóm trưởng vừa cập nhật lại bảng chia mới (tổng <b>${totalCap} CAP</b>). Mời cả nhà xem bảng mới nhất ở ảnh trên ạ!`;
}

/**
 * Format concise Butler ("Quản gia") caption for Telegram sendPhoto (<= 1024 chars).
 * Keeps bulk updates clean without printing a long wall of diff lines.
 * @param {{
 *   groupId?: string,
 *   groupName?: string,
 *   dateStr?: string,
 *   stats?: Record<string, any>,
 *   diffs?: Array<any>,
 *   isUpdate?: boolean,
 *   appLink?: string,
 *   customTemplate?: string,
 * }} params
 */
export function formatTelegramPhotoCaption({
  groupId = '',
  groupName = 'Nhóm 1',
  dateStr = '',
  stats = {},
  diffs = [],
  isUpdate = false,
  appLink = '',
  customTemplate = '',
}) {
  const shortDate = formatShortDateVi(dateStr);
  const safeGroup = escapeTelegramHtml(groupName);
  const botLabel = getDefaultBotLabel(groupId);
  const botIcon = getDefaultBotIcon(groupId);
  const totalCap = stats?.assignedTotalCap ?? 0;
  const totalPointsFormatted = Number(stats?.assignedTotalPoints || 0).toLocaleString('vi-VN');
  const linkLabel = isUpdate
    ? 'Mở xem bảng chia CAP mới nhất'
    : 'Xem bảng chi tiết &amp; tích hoàn thành CAP';
  const linkHtml = appLink ? `🔗 <a href="${escapeTelegramHtml(appLink)}">${linkLabel}</a>` : '';

  const trimmedCustom = String(customTemplate || '').trim();
  if (trimmedCustom) {
    const rawCustom = renderCustomTelegramTemplate(trimmedCustom, {
      plainVars: {
        group: groupName,
        date: shortDate,
        totalCap,
        totalPoints: totalPointsFormatted,
      },
      htmlVars: {
        changes: buildChangesSummaryHtml(diffs, totalCap),
      },
      linkHtml,
    });
    if (rawCustom.length <= 1020) return rawCustom;
    const bodyWithoutLink = linkHtml ? rawCustom.split(linkHtml).join('').trim() : rawCustom;
    const budget = Math.max(120, 1010 - linkHtml.length - 20);
    const trimmedBody = closeUnclosedTelegramHtmlTags(bodyWithoutLink.slice(0, budget));
    return linkHtml ? `${trimmedBody}...\n${linkHtml}` : `${trimmedBody}...`;
  }

  const lines = [];
  if (isUpdate) {
    lines.push(
      `${botIcon} <b>${botLabel} xin cập nhật – Bảng chia CAP Ngày ${escapeTelegramHtml(shortDate)} (${safeGroup})</b>`
    );
    lines.push(buildChangesSummaryHtml(diffs, totalCap));
  } else {
    const pointsPart =
      Number(stats?.assignedTotalPoints) > 0 ? ` (<b>${totalPointsFormatted} point</b>)` : '';
    lines.push(
      `${botIcon} <b>${botLabel} xin thông báo – Bảng chia CAP Ngày ${escapeTelegramHtml(shortDate)} (${safeGroup})</b>`
    );
    lines.push(
      `Nhóm trưởng đã hoàn tất chia <b>${totalCap} CAP</b>${pointsPart} hôm nay. Mời cả nhà xem chi tiết ở ảnh trên ạ!`
    );
  }

  if (linkHtml) {
    lines.push(linkHtml);
  }

  const raw = lines.join('\n');
  if (raw.length <= 1020) return raw;
  const bodyWithoutLink = lines.slice(0, linkHtml ? -1 : undefined).join('\n');
  const budget = Math.max(120, 1010 - linkHtml.length - 20);
  const trimmedBody = closeUnclosedTelegramHtmlTags(bodyWithoutLink.slice(0, budget));
  return linkHtml ? `${trimmedBody}...\n${linkHtml}` : `${trimmedBody}...`;
}

/**
 * Format diff-only notification in Butler ("Quản gia") style (fallback when photo isn't used).
 * Caps verbose lists when many cells changed at once.
 * @param {{
 *   groupId?: string,
 *   groupName?: string,
 *   dateStr?: string,
 *   diffs?: Array<any>,
 *   stats?: Record<string, any>,
 *   appLink?: string,
 *   customTemplate?: string,
 * }} params
 */
export function formatTelegramDiffMessage({
  groupId = '',
  groupName = 'Nhóm 1',
  dateStr = '',
  diffs = [],
  stats = {},
  appLink = '',
  customTemplate = '',
}) {
  if (!Array.isArray(diffs) || diffs.length === 0) return '';
  const shortDate = formatShortDateVi(dateStr);
  const safeGroup = escapeTelegramHtml(groupName);
  const botLabel = getDefaultBotLabel(groupId);
  const botIcon = getDefaultBotIcon(groupId);
  const totalCap = stats?.assignedTotalCap ?? 0;
  const totalPointsFormatted = Number(stats?.assignedTotalPoints || 0).toLocaleString('vi-VN');
  const footer = appLink
    ? `🔗 <a href="${escapeTelegramHtml(appLink)}">Mở xem bảng chia CAP mới nhất</a>`
    : '';

  const trimmedCustom = String(customTemplate || '').trim();
  if (trimmedCustom) {
    const detailLines =
      diffs.length <= 5
        ? diffs.map((d) => {
            const sign = d.delta > 0 ? `+${d.delta}` : `${d.delta}`;
            return `• <b>${escapeTelegramHtml(d.memberName)}</b> ${sign} CAP (<code>${escapeTelegramHtml(d.offerCode)}</code>)`;
          })
        : [
            `Nhóm trưởng vừa chia lại bảng CAP mới (${diffs.length} thay đổi, tổng <b>${totalCap} CAP</b>).`,
          ];
    const rendered = renderCustomTelegramTemplate(trimmedCustom, {
      plainVars: {
        group: groupName,
        date: shortDate,
        totalCap,
        totalPoints: totalPointsFormatted,
      },
      htmlVars: {
        changes: detailLines.join('\n'),
      },
      linkHtml: footer,
      doubleNewlineBeforeLink: true,
    });
    return truncateTelegramHtml(rendered, footer);
  }

  const lines = [
    `${botIcon} <b>${botLabel} xin cập nhật – Điều chỉnh CAP Ngày ${escapeTelegramHtml(shortDate)} (${safeGroup})</b>`,
  ];

  if (diffs.length <= 5) {
    lines.push('Nhóm trưởng vừa điều chỉnh nhẹ bảng chia CAP như sau ạ:');
    for (const d of diffs) {
      const sign = d.delta > 0 ? `+${d.delta}` : `${d.delta}`;
      lines.push(
        `• <b>${escapeTelegramHtml(d.memberName)}</b> ${sign} CAP (<code>${escapeTelegramHtml(d.offerCode)}</code>)`
      );
    }
  } else {
    lines.push(
      `Nhóm trưởng vừa chia lại bảng CAP mới (${diffs.length} thay đổi, tổng <b>${stats?.assignedTotalCap ?? 0} CAP</b>). Cả nhà mở link bên dưới để xem chi tiết ạ!`
    );
  }

  if (stats && Number.isFinite(Number(stats.assignedTotalCap)) && diffs.length <= 5) {
    lines.push(`Tổng hiện tại: <b>${stats.assignedTotalCap} CAP</b>`);
  }

  if (footer) {
    lines.push('', footer);
  }

  return truncateTelegramHtml(lines.join('\n'), footer);
}

const SHIFT_SHORT_LABELS = {
  ca1: 'Ca 1',
  ca2: 'Ca 2',
  ca3: 'Ca 3',
};

function formatShiftCodes(shifts) {
  if (!Array.isArray(shifts) || shifts.length === 0) return 'Nghỉ';
  return shifts.map((s) => SHIFT_SHORT_LABELS[s] || s).join(', ');
}

/**
 * Format daily 11:00 AM shift-registration reminder in Butler ("Quản gia") style.
 * Reminds all members to register/update their own work shifts on CAP Manager.
 * @param {{
 *   groupId?: string,
 *   groupName?: string,
 *   dateStr?: string,
 *   members?: Array<any>,
 *   appLink?: string,
 *   customTemplate?: string,
 * }} params
 */
export function formatTelegramShiftReminderMessage({
  groupId = '',
  groupName = 'Nhóm 1',
  dateStr = '',
  members = [],
  appLink = '',
  customTemplate = '',
}) {
  const shortDate = formatShortDateVi(dateStr);
  const nextDateStr = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))
    ? addDaysToIso(dateStr, 1)
    : '';
  const shortNextDate = nextDateStr ? formatShortDateVi(nextDateStr) : '';
  const safeGroup = escapeTelegramHtml(groupName);
  const botLabel = getDefaultBotLabel(groupId);
  const botIcon = getDefaultBotIcon(groupId);

  const activeMembers = (Array.isArray(members) ? members : []).filter(
    (mem) => mem && mem.active !== false
  );

  const registeredNext = [];
  const pendingNext = [];

  if (nextDateStr) {
    for (const mem of activeMembers) {
      const hasExplicitNext = Boolean(
        mem.shiftSchedule &&
          Object.prototype.hasOwnProperty.call(mem.shiftSchedule, nextDateStr)
      );
      const label = escapeTelegramHtml(mem.name);
      if (hasExplicitNext) {
        const { todayShifts } = getMemberEffectiveShiftsForDay(mem, nextDateStr);
        registeredNext.push(`${label} (${escapeTelegramHtml(formatShiftCodes(todayShifts))})`);
      } else {
        pendingNext.push(label);
      }
    }
  }

  const summaryLines = [];
  if (shortNextDate && activeMembers.length > 0) {
    if (pendingNext.length > 0) {
      summaryLines.push(
        `• Chưa cập nhật ca ngày mai (${escapeTelegramHtml(shortNextDate)}): ${pendingNext.join(', ')}`
      );
    }
    if (registeredNext.length > 0) {
      summaryLines.push(
        `• Đã đăng ký ngày mai (${escapeTelegramHtml(shortNextDate)}): ${registeredNext.join(' · ')}`
      );
    }
  }
  const shiftSummaryHtml = summaryLines.join('\n');
  const linkHtml = appLink
    ? `🔗 <a href="${escapeTelegramHtml(appLink)}">Mở ngay để đăng ký &amp; cập nhật ca làm</a>`
    : '';

  const trimmedCustom = String(customTemplate || '').trim();
  if (trimmedCustom) {
    const rendered = renderCustomTelegramTemplate(trimmedCustom, {
      plainVars: {
        group: groupName,
        date: shortDate,
        pendingCount: pendingNext.length,
        registeredCount: registeredNext.length,
      },
      htmlVars: {
        shiftSummary: shiftSummaryHtml,
      },
      linkHtml,
      doubleNewlineBeforeLink: true,
    });
    return truncateTelegramHtml(rendered, linkHtml);
  }

  const lines = [
    `${botIcon} <b>${botLabel} xin nhắc nhẹ – Đăng ký ca làm (${escapeTelegramHtml(shortDate)})</b>`,
    `Kính gửi cả nhà <b>${safeGroup}</b>, đã đến 11:00 rồi ạ! Mọi người tranh thủ ghé <b>CAP Manager → Quản lý ca làm</b> để đăng ký / cập nhật lịch ca của mình (Ca 1, Ca 2, Ca 3) trước khi Nhóm trưởng chốt chia CAP nhé.`,
  ];

  if (shiftSummaryHtml) {
    lines.push('', shiftSummaryHtml);
  }

  const footer = appLink
    ? `\n🔗 <a href="${escapeTelegramHtml(appLink)}">Mở ngay để đăng ký &amp; cập nhật ca làm</a>`
    : '';
  if (footer) {
    lines.push(footer);
  }

  return truncateTelegramHtml(lines.join('\n'), footer);
}

/**
 * Format Telegram connection test message with optional group custom template.
 * @param {{
 *   groupId?: string,
 *   groupName?: string,
 *   dateStr?: string,
 *   appLink?: string,
 *   customTemplate?: string,
 * }} params
 */
export function formatTelegramTestMessage({
  groupId = '',
  groupName = 'Nhóm 1',
  dateStr = '',
  appLink = '',
  customTemplate = '',
}) {
  const shortDate = formatShortDateVi(dateStr);
  const safeGroup = escapeTelegramHtml(groupName);
  const botLabel = getDefaultBotLabel(groupId);
  const botIcon = getDefaultBotIcon(groupId);
  const linkHtml = appLink
    ? `🔗 <a href="${escapeTelegramHtml(appLink)}">Mở CAP Manager</a>`
    : '';

  const trimmedCustom = String(customTemplate || '').trim();
  if (trimmedCustom) {
    return renderCustomTelegramTemplate(trimmedCustom, {
      plainVars: {
        group: groupName,
        date: shortDate,
      },
      linkHtml,
    });
  }

  const lines = [
    `${botIcon} <b>${botLabel} đã sẵn sàng phục vụ ${safeGroup}!</b>`,
    `Kết nối Bot Telegram thành công. ${botLabel} sẽ tự động gửi bảng chia CAP khi Nhóm trưởng chốt và báo phần điều chỉnh cho cả nhà ạ.`,
  ];
  if (linkHtml) {
    lines.push(linkHtml);
  }
  return lines.join('\n');
}
