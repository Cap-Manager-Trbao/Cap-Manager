/**
 * Pure parser & matcher for importing monthly shift schedules from
 * Google Sheets, Excel (.xlsx/.xls/.csv), or direct spreadsheet copy-paste.
 */

const MONTH_NAME_MAP = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

export function normalizeVietnameseText(raw) {
  return String(raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractSpreadsheetIdAndGid(input) {
  const raw = String(input || '').trim();
  if (!raw) return { spreadsheetId: '', gid: null };

  let spreadsheetId = '';
  const urlMatch = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/i);
  if (urlMatch) {
    spreadsheetId = urlMatch[1];
  } else if (/^[a-zA-Z0-9-_]{20,}$/.test(raw)) {
    spreadsheetId = raw;
  }

  let gid = null;
  const gidMatch = raw.match(/[?&#]gid=(\d+)/i);
  if (gidMatch) {
    gid = Number(gidMatch[1]);
  }

  return { spreadsheetId, gid };
}

export function inferYearMonthFromTitle(title, fallbackYear = null, fallbackMonth = null) {
  const text = String(title || '').trim();
  const now = new Date();
  const defYear = Number.isFinite(fallbackYear) ? fallbackYear : now.getFullYear();
  const defMonth = Number.isFinite(fallbackMonth) ? fallbackMonth : now.getMonth() + 1;

  if (!text) return { year: defYear, month: defMonth };

  // Matches "Tháng 11/2026", "T11-2026", "11/2026", "11.2026", "2026-11"
  let m = text.match(/(?:th[aá]ng|t)?\s*(\d{1,2})\s*[/\-._]\s*(20\d{2})/i);
  if (m) {
    const month = Number(m[1]);
    const year = Number(m[2]);
    if (month >= 1 && month <= 12) return { year, month };
  }

  m = text.match(/(20\d{2})\s*[/\-._]\s*(\d{1,2})/);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month >= 1 && month <= 12) return { year, month };
  }

  // Matches "Nov 2026", "November-2026"
  const norm = normalizeVietnameseText(text);
  for (const [k, monthNum] of Object.entries(MONTH_NAME_MAP)) {
    const rx = new RegExp(`\\b${k}\\b\\s*(20\\d{2})?`, 'i');
    const hit = norm.match(rx);
    if (hit) {
      const year = hit[1] ? Number(hit[1]) : defYear;
      return { year, month: monthNum };
    }
  }

  // Matches "Tháng 11" without year
  m = norm.match(/\b(?:thang|t)\s*(\d{1,2})\b/);
  if (m) {
    const month = Number(m[1]);
    if (month >= 1 && month <= 12) return { year: defYear, month };
  }

  return { year: defYear, month: defMonth };
}

function toIsoDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(year, month - 1, day);
  if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) {
    return null;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function excelSerialToIsoDate(serial) {
  const num = Number(serial);
  if (!Number.isFinite(num) || num < 36526 || num > 73050) return null; // roughly 2000..2099
  const utcDays = Math.floor(num - 25569);
  const dt = new Date(utcDays * 86400 * 1000);
  return toIsoDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/**
 * Parse a date header cell from Google Sheets / Excel into YYYY-MM-DD.
 * Supports: "1-Nov", "01-Nov-2026", "1/11", "01/11/2026", "2026-11-01",
 * day number ("1".."31"), or Excel serial date.
 */
export function parseHeaderDateCell(rawVal, defaultYear, defaultMonth) {
  if (rawVal === null || rawVal === undefined || rawVal === '') return null;

  if (typeof rawVal === 'number') {
    if (rawVal >= 1 && rawVal <= 31 && Number.isInteger(rawVal) && defaultYear && defaultMonth) {
      return toIsoDate(defaultYear, defaultMonth, rawVal);
    }
    return excelSerialToIsoDate(rawVal);
  }

  const text = String(rawVal).trim();
  if (!text) return null;

  // Numeric string: either day-of-month (1..31) or Excel serial
  if (/^\d{1,5}$/.test(text)) {
    const num = Number(text);
    if (num >= 1 && num <= 31 && defaultYear && defaultMonth) {
      return toIsoDate(defaultYear, defaultMonth, num);
    }
    return excelSerialToIsoDate(num);
  }

  // ISO YYYY-MM-DD or YYYY/MM/DD
  let m = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) {
    return toIsoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  }

  // DD/MM/YYYY or DD-MM-YYYY
  m = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    return toIsoDate(y, mo, d);
  }

  // DD/MM or DD-MM
  m = text.match(/^(\d{1,2})[-/](\d{1,2})$/);
  if (m && defaultYear) {
    return toIsoDate(defaultYear, Number(m[2]), Number(m[1]));
  }

  // "1-Nov", "01-Nov-2026", "1 Nov", "15-Dec"
  m = text.match(/^(\d{1,2})[-\s/]+([a-zA-Z]+)(?:[-\s/]+(\d{2,4}))?$/);
  if (m) {
    const day = Number(m[1]);
    const monKey = m[2].toLowerCase();
    const mon = MONTH_NAME_MAP[monKey];
    if (mon) {
      let yr = m[3] ? Number(m[3]) : defaultYear;
      if (yr && yr < 100) yr += 2000;
      if (yr) return toIsoDate(yr, mon, day);
    }
  }

  // "Nov 1", "Nov-01"
  m = text.match(/^([a-zA-Z]+)[-\s/]+(\d{1,2})(?:[-\s/,]+(\d{2,4}))?$/);
  if (m) {
    const mon = MONTH_NAME_MAP[m[1].toLowerCase()];
    const day = Number(m[2]);
    if (mon) {
      let yr = m[3] ? Number(m[3]) : defaultYear;
      if (yr && yr < 100) yr += 2000;
      if (yr) return toIsoDate(yr, mon, day);
    }
  }

  return null;
}

/**
 * Parse a cell containing shift chips / labels into canonical sorted shift IDs.
 * Supports: "Ca1, Ca2", "Ca3, Ca2", "Ca2, Ca1", "Ca1 Ca2 Ca3", "1,2,3",
 * "Full", "Cả ngày", "Nghỉ", "Off", "", etc.
 */
export function parseShiftCellTokens(rawVal) {
  const raw = String(rawVal ?? '').trim();
  if (!raw) {
    return { shifts: [], isOff: true, unknownTokens: [] };
  }

  const norm = normalizeVietnameseText(raw);
  if (
    !norm ||
    norm === 'nghi' ||
    norm === 'off' ||
    norm === 'o' ||
    norm === '0' ||
    norm === 'x' ||
    norm === 'none' ||
    norm === 'phep'
  ) {
    return { shifts: [], isOff: true, unknownTokens: [] };
  }

  if (norm === 'full' || norm === 'ca ngay' || norm === 'full ca' || norm === 'all') {
    return { shifts: ['ca1', 'ca2', 'ca3'], isOff: false, unknownTokens: [] };
  }

  const found = new Set();
  const unknownTokens = [];
  const parts = raw
    .split(/[,;/+&|\n]+|\s+/)
    .map((p) => p.trim())
    .filter(Boolean);

  for (let i = 0; i < parts.length; i++) {
    const pNorm = normalizeVietnameseText(parts[i]);
    if (!pNorm) continue;

    // Handle split "Ca" + "1"
    if (pNorm === 'ca' && i + 1 < parts.length) {
      const nextNorm = normalizeVietnameseText(parts[i + 1]);
      if (['1', '2', '3'].includes(nextNorm)) {
        found.add(`ca${nextNorm}`);
        i += 1;
        continue;
      }
    }

    const caMatches = [...pNorm.matchAll(/(?:ca|c)?\s*([123])\b/g)];
    if (/^(?:ca|c)?[123]+$/.test(pNorm.replace(/\s+/g, ''))) {
      for (const ch of pNorm.replace(/[^123]/g, '')) {
        found.add(`ca${ch}`);
      }
      continue;
    }

    if (caMatches.length > 0 && /^(?:ca|c)?\s*[123](?:\s*(?:ca|c)?\s*[123])*$/.test(pNorm)) {
      for (const m of caMatches) {
        found.add(`ca${m[1]}`);
      }
      continue;
    }

    if (pNorm === 'sang' || pNorm === 's') {
      found.add('ca1');
    } else if (pNorm === 'chieu' || pNorm === 'c') {
      found.add('ca2');
    } else if (pNorm === 'toi' || pNorm === 't') {
      found.add('ca3');
    } else if (pNorm === 'nghi' || pNorm === 'off') {
      // ignore if mixed
    } else {
      unknownTokens.push(parts[i]);
    }
  }

  const shifts = ['ca1', 'ca2', 'ca3'].filter((id) => found.has(id));
  return {
    shifts,
    isOff: shifts.length === 0 && unknownTokens.length === 0,
    unknownTokens,
  };
}

export function parsePasteTextToRows(rawText) {
  const text = String(rawText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!text.trim()) return [];
  const lines = text.split('\n').filter((line) => line.length > 0);
  const hasTabs = lines.some((l) => l.includes('\t'));
  if (hasTabs) {
    return lines.map((line) => line.split('\t').map((cell) => cell.trim()));
  }
  return lines.map((line) => line.split(',').map((cell) => cell.trim()));
}

/**
 * Match a spreadsheet person row to a CAP Manager group member.
 * Distinguishes multi-word names like "Trung Bảo" vs "Huy Bảo", and matches given names
 * like "Uyên" -> "Dương Thị Uyên" when unambiguous.
 */
export function matchMemberRowToGroup(
  sheetName,
  sheetExternalId,
  groupMembers,
  savedMappings = {}
) {
  const cleanSheetName = String(sheetName || '').trim();
  const normSheetName = normalizeVietnameseText(cleanSheetName);
  const cleanExtId = String(sheetExternalId || '').trim();

  if (!normSheetName || !Array.isArray(groupMembers) || groupMembers.length === 0) {
    return { memberId: null, confidence: 'unmatched' };
  }

  // 1. Saved explicit mapping by external ID or exact normalized sheet name
  if (savedMappings && typeof savedMappings === 'object') {
    const byName = savedMappings[`name:${normSheetName}`] || savedMappings[normSheetName];
    if (byName && groupMembers.some((m) => m.id === byName)) {
      return { memberId: byName, confidence: 'saved' };
    }
    if (cleanExtId) {
      const byId = savedMappings[`id:${cleanExtId}`];
      if (byId && groupMembers.some((m) => m.id === byId)) {
        return { memberId: byId, confidence: 'saved' };
      }
    }
  }

  const memberNorms = groupMembers.map((m) => ({
    member: m,
    norm: normalizeVietnameseText(m.name),
    tokens: normalizeVietnameseText(m.name).split(' ').filter(Boolean),
  }));

  // 2. Exact full name match
  const exactHit = memberNorms.find((entry) => entry.norm === normSheetName);
  if (exactHit) {
    return { memberId: exactHit.member.id, confidence: 'exact' };
  }

  // 3. Suffix match ("Nguyễn Ngọc Trung Bảo" ends with "trung bao", "Dương Thị Uyên" ends with "uyen")
  const sheetTokens = normSheetName.split(' ').filter(Boolean);
  const suffixHits = memberNorms.filter((entry) => {
    if (entry.tokens.length === 0 || entry.tokens.length > sheetTokens.length) return false;
    const tail = sheetTokens.slice(sheetTokens.length - entry.tokens.length);
    return entry.tokens.every((t, idx) => tail[idx] === t);
  });

  if (suffixHits.length === 1) {
    return { memberId: suffixHits[0].member.id, confidence: 'suffix' };
  }

  // If multiple suffix hits (e.g. shorter vs longer), prefer longest token match
  if (suffixHits.length > 1) {
    suffixHits.sort((a, b) => b.tokens.length - a.tokens.length);
    if (suffixHits[0].tokens.length > suffixHits[1].tokens.length) {
      return { memberId: suffixHits[0].member.id, confidence: 'suffix' };
    }
  }

  return { memberId: null, confidence: 'unmatched' };
}

function findBestDateHeaderRow(rows, defaultYear, defaultMonth) {
  let best = null;
  const maxScan = Math.min(rows.length, 10);

  for (let r = 0; r < maxScan; r++) {
    const row = Array.isArray(rows[r]) ? rows[r] : [];
    const dateCols = [];
    for (let c = 0; c < row.length; c++) {
      const iso = parseHeaderDateCell(row[c], defaultYear, defaultMonth);
      if (iso) {
        dateCols.push({ colIndex: c, date: iso, rawHeader: String(row[c] ?? '').trim() });
      }
    }
    if (dateCols.length >= 3 && (!best || dateCols.length > best.dateCols.length)) {
      best = { rowIndex: r, dateCols };
    }
  }
  return best;
}

function detectNameAndIdColumns(rows, dateHeaderRowIndex, firstDateColIndex) {
  let nameColIndex = -1;
  let idColIndex = -1;
  let dataStartRow = dateHeaderRowIndex + 1;

  const scanRows = [dateHeaderRowIndex, dateHeaderRowIndex + 1].filter(
    (idx) => idx >= 0 && idx < rows.length
  );

  for (const r of scanRows) {
    const row = Array.isArray(rows[r]) ? rows[r] : [];
    const limit = firstDateColIndex > 0 ? Math.min(row.length, firstDateColIndex) : row.length;
    for (let c = 0; c < limit; c++) {
      const norm = normalizeVietnameseText(row[c]);
      if (!norm) continue;
      if (
        nameColIndex === -1 &&
        (norm === 'ho va ten' ||
          norm === 'ho ten' ||
          norm === 'ten' ||
          norm === 'thanh vien' ||
          norm === 'nhan vien' ||
          norm === 'name' ||
          norm.includes('ho va ten'))
      ) {
        nameColIndex = c;
        dataStartRow = Math.max(dataStartRow, r + 1);
      } else if (idColIndex === -1 && (norm === 'id' || norm === 'ma nv' || norm === 'ma')) {
        idColIndex = c;
      }
    }
  }

  // Fallback: inspect data rows below date header for first text-heavy name column before dates
  if (nameColIndex === -1) {
    const limit = firstDateColIndex > 0 ? firstDateColIndex : 5;
    let bestScore = -1;
    for (let c = 0; c < limit; c++) {
      let score = 0;
      for (let r = dataStartRow; r < Math.min(rows.length, dataStartRow + 15); r++) {
        const val = String(rows[r]?.[c] ?? '').trim();
        if (!val) continue;
        // Names usually contain letters & spaces and aren't "Onsite" / "Remote" / "Loan-Submit"
        const n = normalizeVietnameseText(val);
        if (
          /[a-z]/.test(n) &&
          n.includes(' ') &&
          !['onsite', 'remote', 'loan submit'].includes(n) &&
          !/^\d+$/.test(val)
        ) {
          score += 1;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        nameColIndex = c;
      }
    }
  }

  // Check if row right after dateHeaderRow is a weekday label row ("CN", "T2", "T3"...)
  if (dataStartRow < rows.length) {
    const maybeSubHeader = rows[dataStartRow] || [];
    const weekdayHits = maybeSubHeader.filter((cell) => {
      const n = normalizeVietnameseText(cell);
      return ['cn', 't2', 't3', 't4', 't5', 't6', 't7', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].includes(
        n
      );
    }).length;
    if (weekdayHits >= 3) {
      dataStartRow += 1;
    }
  }

  return { nameColIndex, idColIndex, dataStartRow };
}

/**
 * Parse a 2D spreadsheet grid into structured monthly shift data matched against groupMembers.
 */
export function parseShiftScheduleGrid(
  rows,
  {
    groupMembers = [],
    sheetTitle = '',
    fallbackYear = null,
    fallbackMonth = null,
    savedMappings = {},
  } = {}
) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      ok: false,
      error: 'Bảng dữ liệu trống, không có dòng nào để đọc.',
      dates: [],
      matchedRows: [],
      ignoredOtherRows: [],
      unmatchedGroupMembers: groupMembers,
      memberDateShiftsMap: {},
      unknownCells: [],
    };
  }

  const inferred = inferYearMonthFromTitle(sheetTitle, fallbackYear, fallbackMonth);
  const headerHit = findBestDateHeaderRow(rows, inferred.year, inferred.month);

  if (!headerHit) {
    return {
      ok: false,
      error:
        'Không tìm thấy hàng tiêu đề ngày (ví dụ: 1-Nov, 2-Nov, 01/11 hoặc 1..30). Hãy chọn đúng tab tháng.',
      dates: [],
      matchedRows: [],
      ignoredOtherRows: [],
      unmatchedGroupMembers: groupMembers,
      memberDateShiftsMap: {},
      unknownCells: [],
    };
  }

  const firstDateCol = headerHit.dateCols[0]?.colIndex ?? 1;
  const { nameColIndex, idColIndex, dataStartRow } = detectNameAndIdColumns(
    rows,
    headerHit.rowIndex,
    firstDateCol
  );

  if (nameColIndex === -1) {
    return {
      ok: false,
      error: 'Không tìm thấy cột "Họ và Tên" trong bảng lịch ca.',
      dates: [],
      matchedRows: [],
      ignoredOtherRows: [],
      unmatchedGroupMembers: groupMembers,
      memberDateShiftsMap: {},
      unknownCells: [],
    };
  }

  const dates = headerHit.dateCols.map((d) => d.date);
  const matchedMemberIds = new Set();
  const matchedRows = [];
  const ignoredOtherRows = [];
  const unknownCells = [];
  const memberDateShiftsMap = {};

  for (let r = dataStartRow; r < rows.length; r++) {
    const row = Array.isArray(rows[r]) ? rows[r] : [];
    const sheetName = String(row[nameColIndex] ?? '').trim();
    if (!sheetName) continue;

    const normName = normalizeVietnameseText(sheetName);
    if (['ho va ten', 'ho ten', 'tong', 'total', 'stt'].includes(normName)) continue;

    const sheetExternalId = idColIndex >= 0 ? String(row[idColIndex] ?? '').trim() : '';
    const matchRes = matchMemberRowToGroup(
      sheetName,
      sheetExternalId,
      groupMembers,
      savedMappings
    );

    const shiftsByDate = {};
    for (const dCol of headerHit.dateCols) {
      const rawCell = row[dCol.colIndex];
      const parsedCell = parseShiftCellTokens(rawCell);
      shiftsByDate[dCol.date] = parsedCell.shifts;
      if (parsedCell.unknownTokens.length > 0 && matchRes.memberId) {
        unknownCells.push({
          memberId: matchRes.memberId,
          sheetName,
          date: dCol.date,
          raw: String(rawCell ?? ''),
          tokens: parsedCell.unknownTokens,
        });
      }
    }

    if (matchRes.memberId && !matchedMemberIds.has(matchRes.memberId)) {
      matchedMemberIds.add(matchRes.memberId);
      const memberObj = groupMembers.find((m) => m.id === matchRes.memberId);
      matchedRows.push({
        memberId: matchRes.memberId,
        memberName: memberObj?.name || sheetName,
        sheetName,
        sheetExternalId,
        confidence: matchRes.confidence,
        shiftsByDate,
      });
      memberDateShiftsMap[matchRes.memberId] = shiftsByDate;
    } else {
      ignoredOtherRows.push({
        rowIndex: r + 1,
        sheetName,
        sheetExternalId,
        shiftsByDate,
      });
    }
  }

  const unmatchedGroupMembers = groupMembers.filter((m) => !matchedMemberIds.has(m.id));
  const firstIso = dates[0] || '';
  const [yr, mo] = firstIso ? firstIso.split('-').map(Number) : [inferred.year, inferred.month];

  return {
    ok: true,
    inferredYear: yr,
    inferredMonth: mo,
    dates,
    minDate: dates[0] || '',
    maxDate: dates[dates.length - 1] || '',
    matchedRows,
    ignoredOtherRows,
    unmatchedGroupMembers,
    memberDateShiftsMap,
    unknownCells,
  };
}
