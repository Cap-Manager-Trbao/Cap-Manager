import XLSX from 'xlsx-js-style';
import { computeDistributionStats, sortOffersByPointsDesc } from './capAlgorithm.js';

const COLORS = {
  NAVY_DARK: '0F172A',
  BLUE_PRIMARY: '1D4ED8',
  BLUE_LIGHT: 'DBEAFE',
  BLUE_SOFT: 'EFF6FF',
  SLATE_BORDER: 'CBD5E1',
  SLATE_ROW_ALT: 'F8FAFC',
  TEXT_DARK: '0F172A',
  TEXT_MUTED: '475569',
  WHITE: 'FFFFFF',
};

const thinBorder = {
  top: { style: 'thin', color: { rgb: COLORS.SLATE_BORDER } },
  bottom: { style: 'thin', color: { rgb: COLORS.SLATE_BORDER } },
  left: { style: 'thin', color: { rgb: COLORS.SLATE_BORDER } },
  right: { style: 'thin', color: { rgb: COLORS.SLATE_BORDER } },
};

function makeCell(value, style = {}) {
  const type = typeof value === 'number' ? 'n' : 's';
  return { v: value ?? '', t: type, s: style };
}

function titleStyle() {
  return {
    font: { name: 'Calibri', sz: 14, bold: true, color: { rgb: COLORS.WHITE } },
    fill: { fgColor: { rgb: COLORS.NAVY_DARK } },
    alignment: { horizontal: 'left', vertical: 'center' },
  };
}

function subtitleStyle() {
  return {
    font: { name: 'Calibri', sz: 10, italic: true, color: { rgb: COLORS.TEXT_MUTED } },
    fill: { fgColor: { rgb: COLORS.BLUE_SOFT } },
    alignment: { horizontal: 'left', vertical: 'center' },
  };
}

function headerStyle(align = 'center') {
  return {
    font: { name: 'Calibri', sz: 11, bold: true, color: { rgb: COLORS.WHITE } },
    fill: { fgColor: { rgb: COLORS.BLUE_PRIMARY } },
    alignment: { horizontal: align, vertical: 'center', wrapText: true },
    border: thinBorder,
  };
}

function bodyStyle(align = 'left', isAlt = false, bold = false) {
  return {
    font: { name: 'Calibri', sz: 10.5, bold, color: { rgb: COLORS.TEXT_DARK } },
    fill: { fgColor: { rgb: isAlt ? COLORS.SLATE_ROW_ALT : COLORS.WHITE } },
    alignment: { horizontal: align, vertical: 'center' },
    border: thinBorder,
  };
}

function totalStyle(align = 'center') {
  return {
    font: { name: 'Calibri', sz: 11, bold: true, color: { rgb: COLORS.NAVY_DARK } },
    fill: { fgColor: { rgb: COLORS.BLUE_LIGHT } },
    alignment: { horizontal: align, vertical: 'center' },
    border: thinBorder,
  };
}

/**
 * Build workbook object (used by both browser export and unit tests).
 */
export function buildDistributionWorkbook({ matrix, campaigns, members, dateLabel = '' }) {
  const sortedOffers = sortOffersByPointsDesc(campaigns);
  const stats = computeDistributionStats(matrix, sortedOffers, members, dateLabel);

  if (!stats.isAllValid) {
    const mismatchList = stats.invalidCampaigns
      .map((c) => `${c.code} (đã chia ${c.assignedCap}/${c.targetCap})`)
      .join(', ');
    return {
      ok: false,
      error: `Không thể xuất Excel vì tổng CAP của offer chưa khớp: ${mismatchList}`,
      stats,
    };
  }

  if (stats.assignedTotalPoints !== stats.expectedTotalPoints) {
    return {
      ok: false,
      error: `Tổng điểm thành viên (${stats.assignedTotalPoints} point) không khớp tổng điểm offer (${stats.expectedTotalPoints} point).`,
      stats,
    };
  }

  const displayDate = dateLabel || new Date().toLocaleDateString('vi-VN');
  const wb = XLSX.utils.book_new();

  // ============================================================================
  // SHEET 1: CHIA CAP CHI TIẾT
  // ============================================================================
  const sheet1Headers = [
    'ID',
    'Name',
    'Giờ CAP chung',
    'CAP của nhóm',
    'Point/CAP',
    ...members.map((m) => m.name),
    'Thời gian',
    'Ghi chú',
  ];

  const s1ColCount = sheet1Headers.length;
  const s1Rows = [];

  const s1TitleRow = [makeCell(`BẢNG PHÂN CHIA CAP CHI TIẾT – ${displayDate}`, titleStyle())];
  for (let i = 1; i < s1ColCount; i++) s1TitleRow.push(makeCell('', titleStyle()));
  s1Rows.push(s1TitleRow);

  const s1SubRow = [
    makeCell(
      `Tổng offer: ${sortedOffers.length} | Tổng CAP: ${stats.assignedTotalCap} | Tổng điểm: ${stats.assignedTotalPoints.toLocaleString('vi-VN')} point`,
      subtitleStyle()
    ),
  ];
  for (let i = 1; i < s1ColCount; i++) s1SubRow.push(makeCell('', subtitleStyle()));
  s1Rows.push(s1SubRow);

  s1Rows.push(
    sheet1Headers.map((h, idx) =>
      makeCell(h, headerStyle(idx === 1 || idx >= s1ColCount - 2 ? 'left' : 'center'))
    )
  );

  sortedOffers.forEach((offer, rIdx) => {
    const isAlt = rIdx % 2 === 1;
    const row = [
      makeCell(offer.code || '', bodyStyle('center', isAlt, true)),
      makeCell(offer.name || '', bodyStyle('left', isAlt, false)),
      makeCell(offer.capHour || '-', bodyStyle('center', isAlt, true)),
      makeCell(Number(offer.totalCap) || 0, bodyStyle('center', isAlt, true)),
      makeCell(`${Number(offer.pointsPerCap) || 0} point`, bodyStyle('center', isAlt, false)),
      ...members.map((m) =>
        makeCell(stats.matrix[offer.id]?.[m.id] || 0, bodyStyle('center', isAlt, false))
      ),
      makeCell(offer.timeWindow || '', bodyStyle('left', isAlt, false)),
      makeCell(offer.note || offer.condition || '', bodyStyle('left', isAlt, false)),
    ];
    s1Rows.push(row);
  });

  s1Rows.push([
    makeCell('TỔNG CAP', totalStyle('center')),
    makeCell('Tổng hợp số lượng CAP', totalStyle('left')),
    makeCell('-', totalStyle('center')),
    makeCell(stats.assignedTotalCap, totalStyle('center')),
    makeCell('-', totalStyle('center')),
    ...members.map((m) => makeCell(stats.memberTotalsMap[m.id]?.totalCap || 0, totalStyle('center'))),
    makeCell('', totalStyle('left')),
    makeCell('', totalStyle('left')),
  ]);

  s1Rows.push([
    makeCell('TỔNG POINT', totalStyle('center')),
    makeCell('Tổng hợp điểm thưởng', totalStyle('left')),
    makeCell('-', totalStyle('center')),
    makeCell(`${stats.assignedTotalPoints.toLocaleString('vi-VN')} point`, totalStyle('center')),
    makeCell('-', totalStyle('center')),
    ...members.map((m) =>
      makeCell(`${(stats.memberTotalsMap[m.id]?.totalPoints || 0).toLocaleString('vi-VN')} point`, totalStyle('center'))
    ),
    makeCell('', totalStyle('left')),
    makeCell('', totalStyle('left')),
  ]);

  const ws1 = XLSX.utils.aoa_to_sheet(s1Rows);
  ws1['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: s1ColCount - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: s1ColCount - 1 } },
  ];
  ws1['!cols'] = [
    { wch: 12 },
    { wch: 46 },
    { wch: 14 },
    { wch: 14 },
    { wch: 13 },
    ...members.map(() => ({ wch: 14 })),
    { wch: 18 },
    { wch: 24 },
  ];
  ws1['!rows'] = [{ hpt: 28 }, { hpt: 20 }, { hpt: 26 }];
  XLSX.utils.book_append_sheet(wb, ws1, 'CHIA CAP CHI TIẾT');

  // ============================================================================
  // SHEET 2: TỔNG HỢP THÀNH VIÊN
  // ============================================================================
  const s2Headers = ['Tên thành viên', 'Vai trò', 'Tổng CAP', 'Tổng point', 'Số offer tham gia', 'Point TB/CAP'];
  const s2Rows = [];

  const s2Title = [makeCell(`TỔNG HỢP THÀNH VIÊN – ${displayDate}`, titleStyle())];
  for (let i = 1; i < s2Headers.length; i++) s2Title.push(makeCell('', titleStyle()));
  s2Rows.push(s2Title);

  s2Rows.push(s2Headers.map((h, idx) => makeCell(h, headerStyle(idx <= 1 ? 'left' : 'center'))));

  stats.memberStats.forEach((ms, rIdx) => {
    const isAlt = rIdx % 2 === 1;
    const roleLabel = ms.isLeader
      ? 'Nhóm trưởng'
      : ms.isNew
      ? 'Thành viên mới'
      : ms.active
      ? 'Thành viên'
      : 'Tạm nghỉ';

    s2Rows.push([
      makeCell(ms.name, bodyStyle('left', isAlt, true)),
      makeCell(roleLabel, bodyStyle('left', isAlt, false)),
      makeCell(ms.totalCap, bodyStyle('center', isAlt, true)),
      makeCell(`${ms.totalPoints.toLocaleString('vi-VN')} point`, bodyStyle('center', isAlt, true)),
      makeCell(ms.campaignCount, bodyStyle('center', isAlt, false)),
      makeCell(`${ms.avgPointsPerCap} point`, bodyStyle('center', isAlt, false)),
    ]);
  });

  s2Rows.push([
    makeCell('TỔNG CỘNG', totalStyle('left')),
    makeCell(`${members.length} thành viên`, totalStyle('left')),
    makeCell(stats.assignedTotalCap, totalStyle('center')),
    makeCell(`${stats.assignedTotalPoints.toLocaleString('vi-VN')} point`, totalStyle('center')),
    makeCell(sortedOffers.length, totalStyle('center')),
    makeCell(
      stats.assignedTotalCap > 0
        ? `${Number((stats.assignedTotalPoints / stats.assignedTotalCap).toFixed(2))} point`
        : '0 point',
      totalStyle('center')
    ),
  ]);

  const ws2 = XLSX.utils.aoa_to_sheet(s2Rows);
  ws2['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: s2Headers.length - 1 } }];
  ws2['!cols'] = [{ wch: 22 }, { wch: 18 }, { wch: 14 }, { wch: 18 }, { wch: 20 }, { wch: 16 }];
  ws2['!rows'] = [{ hpt: 28 }, { hpt: 26 }];
  XLSX.utils.book_append_sheet(wb, ws2, 'TỔNG HỢP THÀNH VIÊN');

  // ============================================================================
  // SHEET 3: THỐNG KÊ
  // ============================================================================
  const s3Rows = [];
  s3Rows.push([makeCell(`THỐNG KÊ PHÂN CHIA CAP – ${displayDate}`, titleStyle()), makeCell('', titleStyle())]);
  s3Rows.push([makeCell('Chỉ số thống kê', headerStyle('left')), makeCell('Giá trị', headerStyle('center'))]);

  const summaryItems = [
    ['Tổng số thành viên hoạt động', members.filter((m) => m.active !== false).length],
    ['Tổng số offer', sortedOffers.length],
    ['Tổng CAP toàn nhóm', stats.assignedTotalCap],
    ['Tổng điểm toàn nhóm', `${stats.assignedTotalPoints.toLocaleString('vi-VN')} point`],
    ['Chênh lệch CAP (Cao nhất - Thấp nhất)', stats.capSpread],
    ['Chênh lệch điểm (Cao nhất - Thấp nhất)', `${stats.pointSpread.toLocaleString('vi-VN')} point`],
    [
      'Người nhận nhiều CAP nhất',
      stats.maxCapMember ? `${stats.maxCapMember.name} (${stats.maxCapMember.totalCap} CAP)` : '-',
    ],
    [
      'Người có tổng point cao nhất',
      stats.maxPointsMember
        ? `${stats.maxPointsMember.name} (${stats.maxPointsMember.totalPoints.toLocaleString('vi-VN')} point)`
        : '-',
    ],
  ];

  summaryItems.forEach(([label, val], idx) => {
    const isAlt = idx % 2 === 1;
    s3Rows.push([
      makeCell(label, bodyStyle('left', isAlt, false)),
      makeCell(val, bodyStyle('center', isAlt, true)),
    ]);
  });

  const ws3 = XLSX.utils.aoa_to_sheet(s3Rows);
  ws3['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
  ws3['!cols'] = [{ wch: 42 }, { wch: 30 }];
  ws3['!rows'] = [{ hpt: 28 }, { hpt: 26 }];
  XLSX.utils.book_append_sheet(wb, ws3, 'THỐNG KÊ');

  return { ok: true, workbook: wb, stats };
}

export function exportDistributionToExcel({ matrix, campaigns, members, dateLabel = '', fileName = '' }) {
  const result = buildDistributionWorkbook({ matrix, campaigns, members, dateLabel });
  if (!result.ok) {
    return result;
  }

  const safeDate = (dateLabel || new Date().toISOString().slice(0, 10)).replace(/[^0-9a-zA-Z_-]/g, '_');
  const outName = fileName || `CAP_Manager_${safeDate}.xlsx`;
  XLSX.writeFile(result.workbook, outName);

  return { ok: true, fileName: outName, stats: result.stats };
}

export function downloadCampaignTemplateExcel() {
  const wb = XLSX.utils.book_new();
  const headers = ['ID', 'Name', 'Giờ CAP chung', 'Số CAP', 'Point/CAP', 'Thời gian', 'Điều kiện tham gia', 'Ghi chú'];
  const rows = [
    headers.map((h) => makeCell(h, headerStyle('center'))),
    [
      makeCell('1551', bodyStyle('center', false, true)),
      makeCell('21997905 - EverydayHealth - Diabetes Snacks', bodyStyle('left', false, false)),
      makeCell('10h', bodyStyle('center', false, true)),
      makeCell(12, bodyStyle('center', false, false)),
      makeCell(25, bodyStyle('center', false, false)),
      makeCell('10h (Cả ngày)', bodyStyle('left', false, false)),
      makeCell('Tất cả thành viên', bodyStyle('left', false, false)),
      makeCell('Mẫu nhập từ Excel', bodyStyle('left', false, false)),
    ],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [
    { wch: 12 },
    { wch: 46 },
    { wch: 15 },
    { wch: 12 },
    { wch: 12 },
    { wch: 18 },
    { wch: 24 },
    { wch: 24 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'DANH_SACH_OFFER');
  XLSX.writeFile(wb, 'Mau_Nhap_Offer_CAP_Manager.xlsx');
}

export function parseCampaignsFromExcelBuffer(arrayBuffer) {
  try {
    const wb = XLSX.read(arrayBuffer, { type: 'array' });
    const firstSheetName = wb.SheetNames[0];
    if (!firstSheetName) {
      return { ok: false, error: 'File Excel không có sheet dữ liệu nào.' };
    }

    const ws = wb.Sheets[firstSheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    if (!rows || rows.length === 0) {
      return { ok: false, error: 'Sheet đầu tiên không có dòng dữ liệu nào.' };
    }

    const parsed = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const code = String(
        r['ID'] ?? r['Mã offer'] ?? r['Mã chiến dịch'] ?? r['Ma chien dich'] ?? r['code'] ?? r['Code'] ?? ''
      ).trim();
      const name = String(
        r['Name'] ?? r['Tên offer'] ?? r['Tên chiến dịch'] ?? r['Ten chien dich'] ?? r['name'] ?? ''
      ).trim();
      const capHour = String(r['Giờ CAP chung'] ?? r['Gio CAP chung'] ?? r['Giờ CAP'] ?? r['capHour'] ?? '10h').trim();
      const rawCap = r['Số CAP'] ?? r['So CAP'] ?? r['CAP'] ?? r['CAP của nhóm'] ?? r['totalCap'];
      const rawPts = r['Point/CAP'] ?? r['Điểm/CAP'] ?? r['Diem/CAP'] ?? r['Điểm'] ?? r['pointsPerCap'];
      const timeWindow = String(r['Thời gian'] ?? r['Thoi gian'] ?? r['timeWindow'] ?? 'Cả ngày').trim() || 'Cả ngày';
      const condition = String(r['Điều kiện tham gia'] ?? r['Điều kiện'] ?? r['condition'] ?? 'Tất cả thành viên').trim();
      const note = String(r['Ghi chú'] ?? r['Ghi chu'] ?? r['note'] ?? '').trim();

      const totalCap = Number(rawCap);
      const pointsPerCap = Number(String(rawPts).replace(/point/gi, '').trim());

      if (!code && !name) continue;
      if (!Number.isFinite(totalCap) || totalCap < 0 || !Number.isFinite(pointsPerCap) || pointsPerCap < 0) {
        return {
          ok: false,
          error: `Dòng ${i + 2}: Số CAP hoặc Point/CAP không hợp lệ (${code || name}).`,
        };
      }

      const lowerCond = condition.toLowerCase();
      const eligibilityType =
        lowerCond.includes('không áp dụng cho thành viên mới') || lowerCond.includes('trừ thành viên mới')
          ? 'exclude_new'
          : 'all';

      parsed.push({
        id: `offer-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 5)}`,
        code: code || `OF-${i + 1}`,
        name: name || `Offer ${code || i + 1}`,
        capHour: capHour || '10h',
        totalCap: Math.round(totalCap),
        pointsPerCap: Math.round(pointsPerCap),
        timeWindow,
        condition: condition || 'Tất cả thành viên',
        eligibilityType,
        eligibleMemberIds: [],
        note,
      });
    }

    if (parsed.length === 0) {
      return { ok: false, error: 'Không tìm thấy offer hợp lệ trong file Excel.' };
    }

    return { ok: true, campaigns: parsed };
  } catch (err) {
    return { ok: false, error: `Không thể đọc file Excel: ${err.message}` };
  }
}
