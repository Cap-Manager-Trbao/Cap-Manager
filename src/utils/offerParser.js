import { createId } from './storage.js';

function normalizeHourToken(raw) {
  const txt = String(raw || '').trim();
  if (!txt) return '';
  const match = txt.match(/^(\d{1,2})\s*(?:h|:)\s*(\d{1,2})?$/i);
  if (!match) return '';
  const h = Number(match[1]);
  const m = match[2] ? Number(match[2]) : 0;
  if (!Number.isFinite(h) || h < 0 || h > 23 || !Number.isFinite(m) || m < 0 || m >= 60) {
    return '';
  }
  return m > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

function parseNumericToken(raw) {
  const cleaned = String(raw || '')
    .trim()
    .replace(/\b(point|pts|diem|điểm|cap)\b/gi, '')
    .replace(/,/g, '')
    .trim();
  if (!cleaned || !/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? Math.round(num) : null;
}

function splitPastedLine(line) {
  if (line.includes('\t')) {
    return line.split('\t').map((c) => c.trim());
  }
  if (line.includes('|')) {
    return line.split('|').map((c) => c.trim());
  }
  if (line.includes(';')) {
    return line.split(';').map((c) => c.trim());
  }
  if (/\s{2,}/.test(line)) {
    return line.split(/\s{2,}/).map((c) => c.trim());
  }
  const firstSpace = line.trim().match(/^(\S+)\s+(.+)$/);
  if (firstSpace) {
    return [firstSpace[1].trim(), firstSpace[2].trim()];
  }
  return [line.trim()];
}

function isHeaderRow(cells) {
  const joined = cells.join(' ').toLowerCase();
  const hasId = /\bid\b|\bmã\b/.test(joined);
  const hasName = /\bname\b|\btên\b|\boffer\b|\bchiến dịch\b/.test(joined);
  return hasId && hasName;
}

/**
 * Parse lines pasted from Excel or Google Sheets into structured offers.
 * Supports:
 * - 2 cols: ID | Name
 * - 3 cols: ID | Name | (capHour or totalCap or pointsPerCap)
 * - 4 cols: ID | Name | Giờ CAP chung | Tổng CAP (or Tổng CAP | Điểm)
 * - 5+ cols: ID | Name | Giờ CAP chung | Tổng CAP | Điểm/CAP | [Ghi chú]
 */
export function parseQuickPastedOffers(rawText, existingOffers = []) {
  const text = String(rawText || '').trim();
  if (!text) {
    return { ok: false, offers: [], matchedCount: 0, newCount: 0, skippedCount: 0, error: 'Chưa có dữ liệu để phân tích.' };
  }

  const existingByCode = new Map();
  for (const off of existingOffers || []) {
    if (off?.code) {
      existingByCode.set(String(off.code).trim().toLowerCase(), off);
    }
  }

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const parsedOffers = [];
  let matchedCount = 0;
  let newCount = 0;
  let skippedCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const cells = splitPastedLine(lines[i]).filter((c, idx) => idx < 2 || c !== '');
    if (i === 0 && isHeaderRow(cells)) {
      continue;
    }

    const code = String(cells[0] || '').trim();
    const name = String(cells[1] || '').trim();
    if (!code || !name) {
      skippedCount++;
      continue;
    }

    const existing = existingByCode.get(code.toLowerCase()) || null;
    if (existing) matchedCount++;
    else newCount++;

    let capHour = existing?.capHour || '10h';
    let totalCap = Number(existing?.totalCap ?? 5);
    let pointsPerCap = Number(existing?.pointsPerCap ?? 25);
    let note = existing?.note || '';

    const extras = cells.slice(2);
    if (extras.length >= 3) {
      const maybeHour = normalizeHourToken(extras[0]);
      const maybeCap = parseNumericToken(extras[1]);
      const maybePts = parseNumericToken(extras[2]);
      if (maybeHour) capHour = maybeHour;
      if (maybeCap !== null) totalCap = maybeCap;
      if (maybePts !== null) pointsPerCap = maybePts;
      if (extras[3]) note = extras[3];
    } else if (extras.length === 2) {
      const h0 = normalizeHourToken(extras[0]);
      const n0 = parseNumericToken(extras[0]);
      const n1 = parseNumericToken(extras[1]);
      const h1 = normalizeHourToken(extras[1]);
      if (h0 && n1 !== null) {
        capHour = h0;
        totalCap = n1;
      } else if (n0 !== null && h1) {
        totalCap = n0;
        capHour = h1;
      } else if (n0 !== null && n1 !== null) {
        totalCap = n0;
        pointsPerCap = n1;
      }
    } else if (extras.length === 1) {
      const h0 = normalizeHourToken(extras[0]);
      const n0 = parseNumericToken(extras[0]);
      if (h0) capHour = h0;
      else if (n0 !== null) totalCap = n0;
    }

    parsedOffers.push({
      id: existing?.id || createId('offer'),
      code,
      name,
      capHour,
      totalCap: Math.max(0, totalCap),
      pointsPerCap: Math.max(0, pointsPerCap),
      timeWindow: existing?.timeWindow || `${capHour} (Cả ngày)`,
      note,
      condition: existing?.condition || 'Tất cả thành viên',
      eligibilityType: existing?.eligibilityType || 'all',
      eligibleMemberIds: Array.isArray(existing?.eligibleMemberIds) ? existing.eligibleMemberIds : [],
      hidden: Boolean(existing?.hidden),
      isExistingMatch: Boolean(existing),
    });
  }

  if (parsedOffers.length === 0) {
    return {
      ok: false,
      offers: [],
      matchedCount: 0,
      newCount: 0,
      skippedCount,
      error: 'Không đọc được dòng offer hợp lệ. Mỗi dòng cần ít nhất Mã ID và Tên offer (cách nhau bằng Tab khi copy từ Sheet/Excel).',
    };
  }

  return {
    ok: true,
    offers: parsedOffers,
    matchedCount,
    newCount,
    skippedCount,
  };
}

/**
 * Merge incoming offers into existing offers by normalized `code` (case-insensitive).
 * Matching codes update existing offers in-place (preserving `existing.id`),
 * and duplicate codes within `incomingOffers` collapse to the latest entry.
 */
export function mergeOffersByCode(existingOffers = [], incomingOffers = []) {
  const incomingByCode = new Map();
  let duplicateInImportCount = 0;

  for (const item of incomingOffers || []) {
    const codeKey = String(item?.code || '').trim().toLowerCase();
    if (!codeKey) continue;
    if (incomingByCode.has(codeKey)) {
      duplicateInImportCount++;
    }
    incomingByCode.set(codeKey, item);
  }

  const merged = [];
  const handledCodes = new Set();
  let updatedCount = 0;
  let addedCount = 0;

  for (const existing of existingOffers || []) {
    const codeKey = String(existing?.code || '').trim().toLowerCase();
    if (codeKey && incomingByCode.has(codeKey) && !handledCodes.has(codeKey)) {
      const next = incomingByCode.get(codeKey);
      merged.push({
        ...existing,
        ...next,
        id: existing.id,
      });
      handledCodes.add(codeKey);
      updatedCount++;
    } else if (!codeKey || !handledCodes.has(codeKey)) {
      merged.push(existing);
      if (codeKey) handledCodes.add(codeKey);
    }
  }

  for (const [codeKey, item] of incomingByCode.entries()) {
    if (!handledCodes.has(codeKey)) {
      merged.push(item);
      handledCodes.add(codeKey);
      addedCount++;
    }
  }

  return {
    merged,
    updatedCount,
    addedCount,
    duplicateInImportCount,
  };
}

/**
 * Return list of duplicate offer codes present in an offer array.
 */
export function findDuplicateOfferCodes(offers = []) {
  const counts = new Map();
  for (const offer of offers || []) {
    const rawCode = String(offer?.code || '').trim();
    if (!rawCode) continue;
    const key = rawCode.toLowerCase();
    const prev = counts.get(key) || { code: rawCode, count: 0 };
    counts.set(key, { code: prev.code, count: prev.count + 1 });
  }
  return [...counts.values()].filter((entry) => entry.count > 1);
}
