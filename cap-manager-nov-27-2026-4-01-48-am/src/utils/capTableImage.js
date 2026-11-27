import { getMemberEffectiveShiftsForDay } from './capAlgorithm.js';
import { formatShortDateVi } from './telegramMessages.js';

const SHIFT_LABEL_MAP = {
  ca1: '1',
  ca2: '2',
  ca3: '3',
};

function formatCompactShiftTag(member, dateStr) {
  if (!member || member.active === false) return 'Nghỉ';
  const { todayShifts } = getMemberEffectiveShiftsForDay(member, dateStr);
  if (!todayShifts || todayShifts.length === 0) return 'Nghỉ';
  return `Ca ${todayShifts.map((s) => SHIFT_LABEL_MAP[s] || s).join(',')}`;
}

/**
 * Pure geometry & data builder for rendering a crisp CAP & Points distribution table PNG.
 * Exported separately so layout math and totals can be unit-tested in Node without DOM.
 */
export function computeCapTableImageLayout({
  groupName = 'Nhóm 1',
  dateStr = '',
  members = [],
  campaigns = [],
  matrix = {},
  stats = {},
}) {
  const validMembers = (Array.isArray(members) ? members : []).filter((m) => m && m.id);
  const activeCampaigns = (Array.isArray(campaigns) ? campaigns : []).filter(
    (c) => c && c.id && !c.hidden
  );

  const memberColWidth =
    validMembers.length <= 7 ? 96 : Math.max(82, Math.floor(680 / validMembers.length));
  const offerColWidth = 260;
  const hourColWidth = 98;
  const totalColWidth = 56;
  const pointsColWidth = 78;
  const padX = 24;
  const padTop = 22;
  const headerBlockHeight = 64;
  const tableHeaderHeight = 52;
  const rowHeight = 40;
  const summaryRowHeight = 40;
  const pointsSummaryRowHeight = 40;
  const footerHeight = 36;

  const tableWidth =
    offerColWidth +
    hourColWidth +
    totalColWidth +
    pointsColWidth +
    validMembers.length * memberColWidth;
  const canvasWidth = Math.max(720, tableWidth + padX * 2);

  const rows = activeCampaigns.map((camp) => {
    const pointsPerCap = Math.max(0, Math.round(Number(camp.pointsPerCap) || 0));
    let rowTotal = 0;
    const values = validMembers.map((mem) => {
      const qty = Math.max(0, Math.floor(Number(matrix?.[camp.id]?.[mem.id]) || 0));
      rowTotal += qty;
      return qty;
    });
    return {
      id: camp.id,
      name: String(camp.name || camp.code || 'Offer').trim(),
      capHour: String(camp.capHour || '-').trim(),
      pointsPerCap,
      rowTotal,
      rowTotalPoints: rowTotal * pointsPerCap,
      values,
    };
  });

  const memberTotals = validMembers.map((_, idx) =>
    rows.reduce((sum, row) => sum + (row.values[idx] || 0), 0)
  );

  const memberPointTotals = validMembers.map((_, idx) =>
    rows.reduce((sum, row) => sum + (row.values[idx] || 0) * row.pointsPerCap, 0)
  );

  const grandTotalCap = Number.isFinite(Number(stats?.assignedTotalCap))
    ? Number(stats.assignedTotalCap)
    : memberTotals.reduce((a, b) => a + b, 0);

  const grandTotalPoints = Number.isFinite(Number(stats?.assignedTotalPoints))
    ? Number(stats.assignedTotalPoints)
    : memberPointTotals.reduce((a, b) => a + b, 0);

  const canvasHeight =
    padTop +
    headerBlockHeight +
    tableHeaderHeight +
    Math.max(1, rows.length) * rowHeight +
    summaryRowHeight +
    pointsSummaryRowHeight +
    footerHeight;

  return {
    groupName: String(groupName || 'Nhóm 1'),
    shortDate: formatShortDateVi(dateStr),
    dateStr,
    grandTotalCap,
    grandTotalPoints,
    offerCount: rows.length,
    padX,
    padTop,
    headerBlockHeight,
    tableHeaderHeight,
    rowHeight,
    summaryRowHeight,
    pointsSummaryRowHeight,
    footerHeight,
    offerColWidth,
    hourColWidth,
    totalColWidth,
    pointsColWidth,
    memberColWidth,
    tableWidth,
    canvasWidth,
    canvasHeight,
    memberHeaders: validMembers.map((mem) => ({
      id: mem.id,
      name: String(mem.name || 'TV'),
      isNew: Boolean(mem.isNew),
      shiftTag: formatCompactShiftTag(mem, dateStr),
    })),
    rows,
    memberTotals,
    memberPointTotals,
  };
}

function fitTextWithEllipsis(ctx, text, maxWidth) {
  const str = String(text || '');
  if (ctx.measureText(str).width <= maxWidth) return str;
  const ellipsis = '...';
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(str.slice(0, mid) + ellipsis).width <= maxWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return `${str.slice(0, Math.max(0, lo))}${ellipsis}`;
}

function drawRoundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * Render the CAP & Points distribution table onto a 2x Retina HTML5 Canvas and return a base64 PNG payload.
 * Returns null safely if Canvas 2D is unavailable.
 */
export function renderCapTablePngBase64(params) {
  if (typeof document === 'undefined') return null;

  const layout = computeCapTableImageLayout(params);
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = layout.canvasWidth * scale;
  canvas.height = layout.canvasHeight * scale;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.scale(scale, scale);
  const fontFamily =
    "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

  // Background
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, layout.canvasWidth, layout.canvasHeight);

  // Header area
  const { padX, padTop, tableWidth } = layout;
  ctx.fillStyle = '#0F172A';
  ctx.font = `700 18px ${fontFamily}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(`Bảng chia CAP Ngày ${layout.shortDate} – ${layout.groupName}`, padX, padTop);

  ctx.fillStyle = '#475569';
  ctx.font = `500 13px ${fontFamily}`;
  ctx.fillText(
    `Tổng phân bổ: ${layout.grandTotalCap} CAP · ${layout.grandTotalPoints.toLocaleString('vi-VN')} point · ${layout.offerCount} offer`,
    padX,
    padTop + 28
  );

  // Table outer container
  const tableTop = padTop + layout.headerBlockHeight;
  const rowsHeight = Math.max(1, layout.rows.length) * layout.rowHeight;
  const tableBodyHeight =
    layout.tableHeaderHeight +
    rowsHeight +
    layout.summaryRowHeight +
    layout.pointsSummaryRowHeight;

  ctx.save();
  drawRoundedRect(ctx, padX, tableTop, tableWidth, tableBodyHeight, 10);
  ctx.clip();

  // Table Header row
  ctx.fillStyle = '#F1F5F9';
  ctx.fillRect(padX, tableTop, tableWidth, layout.tableHeaderHeight);

  const colXs = [padX];
  colXs.push(colXs[0] + layout.offerColWidth);
  colXs.push(colXs[1] + layout.hourColWidth);
  colXs.push(colXs[2] + layout.totalColWidth);
  colXs.push(colXs[3] + layout.pointsColWidth);
  for (let i = 0; i < layout.memberHeaders.length; i++) {
    colXs.push(colXs[4] + (i + 1) * layout.memberColWidth);
  }

  ctx.fillStyle = '#0F172A';
  ctx.font = `700 12px ${fontFamily}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText('Offer', colXs[0] + 12, tableTop + layout.tableHeaderHeight / 2);

  ctx.textAlign = 'center';
  ctx.fillText('Giờ CAP chung', colXs[1] + layout.hourColWidth / 2, tableTop + layout.tableHeaderHeight / 2);
  ctx.fillText('CAP', colXs[2] + layout.totalColWidth / 2, tableTop + layout.tableHeaderHeight / 2);
  ctx.fillText('Điểm/CAP', colXs[3] + layout.pointsColWidth / 2, tableTop + layout.tableHeaderHeight / 2);

  layout.memberHeaders.forEach((mh, idx) => {
    const cx = colXs[4 + idx] + layout.memberColWidth / 2;
    ctx.fillStyle = '#0F172A';
    ctx.font = `700 12px ${fontFamily}`;
    const label = mh.isNew ? `${mh.name} (Mới)` : mh.name;
    ctx.fillText(
      fitTextWithEllipsis(ctx, label, layout.memberColWidth - 10),
      cx,
      tableTop + 17
    );

    ctx.fillStyle = mh.shiftTag === 'Nghỉ' ? '#94A3B8' : '#2563EB';
    ctx.font = `500 10.5px ${fontFamily}`;
    ctx.fillText(mh.shiftTag, cx, tableTop + 35);
  });

  // Offer rows
  layout.rows.forEach((row, rIdx) => {
    const rowY = tableTop + layout.tableHeaderHeight + rIdx * layout.rowHeight;
    ctx.fillStyle = rIdx % 2 === 1 ? '#F8FAFC' : '#FFFFFF';
    ctx.fillRect(padX, rowY, tableWidth, layout.rowHeight);

    // Subtle highlight on cells with CAP > 0
    row.values.forEach((qty, mIdx) => {
      if (qty > 0) {
        ctx.fillStyle = '#EFF6FF';
        ctx.fillRect(colXs[4 + mIdx] + 1, rowY + 1, layout.memberColWidth - 2, layout.rowHeight - 2);
      }
    });

    // Horizontal divider
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padX, rowY);
    ctx.lineTo(padX + tableWidth, rowY);
    ctx.stroke();

    // Offer Name
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#0F172A';
    ctx.font = `600 12px ${fontFamily}`;
    ctx.fillText(
      fitTextWithEllipsis(ctx, row.name, layout.offerColWidth - 20),
      colXs[0] + 12,
      rowY + layout.rowHeight / 2
    );

    // Hour
    ctx.textAlign = 'center';
    ctx.fillStyle = '#475569';
    ctx.font = `500 12px ${fontFamily}`;
    ctx.fillText(row.capHour, colXs[1] + layout.hourColWidth / 2, rowY + layout.rowHeight / 2);

    // Row Total CAP
    ctx.fillStyle = '#0F172A';
    ctx.font = `700 12.5px ${fontFamily}`;
    ctx.fillText(String(row.rowTotal), colXs[2] + layout.totalColWidth / 2, rowY + layout.rowHeight / 2);

    // Points per CAP
    ctx.fillStyle = '#334155';
    ctx.font = `600 11.5px ${fontFamily}`;
    ctx.fillText(
      `${row.pointsPerCap} point`,
      colXs[3] + layout.pointsColWidth / 2,
      rowY + layout.rowHeight / 2
    );

    // Member cells
    row.values.forEach((qty, mIdx) => {
      const cx = colXs[4 + mIdx] + layout.memberColWidth / 2;
      if (qty > 0) {
        ctx.fillStyle = '#1D4ED8';
        ctx.font = `700 14px ${fontFamily}`;
        ctx.fillText(String(qty), cx, rowY + layout.rowHeight / 2);
      } else {
        ctx.fillStyle = '#CBD5E1';
        ctx.font = `400 12px ${fontFamily}`;
        ctx.fillText('–', cx, rowY + layout.rowHeight / 2);
      }
    });
  });

  // Summary row 1 (TỔNG CAP)
  const summaryY = tableTop + layout.tableHeaderHeight + rowsHeight;
  ctx.fillStyle = '#EFF6FF';
  ctx.fillRect(padX, summaryY, tableWidth, layout.summaryRowHeight);

  ctx.strokeStyle = '#BFDBFE';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(padX, summaryY);
  ctx.lineTo(padX + tableWidth, summaryY);
  ctx.stroke();

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#1E3A8A';
  ctx.font = `700 12.5px ${fontFamily}`;
  ctx.fillText('TỔNG CAP', colXs[0] + 12, summaryY + layout.summaryRowHeight / 2);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#64748B';
  ctx.font = `500 12px ${fontFamily}`;
  ctx.fillText('–', colXs[1] + layout.hourColWidth / 2, summaryY + layout.summaryRowHeight / 2);
  ctx.fillStyle = '#1E3A8A';
  ctx.font = `800 13.5px ${fontFamily}`;
  ctx.fillText(
    String(layout.grandTotalCap),
    colXs[2] + layout.totalColWidth / 2,
    summaryY + layout.summaryRowHeight / 2
  );
  ctx.fillStyle = '#64748B';
  ctx.font = `500 12px ${fontFamily}`;
  ctx.fillText('–', colXs[3] + layout.pointsColWidth / 2, summaryY + layout.summaryRowHeight / 2);

  layout.memberTotals.forEach((tot, mIdx) => {
    const cx = colXs[4 + mIdx] + layout.memberColWidth / 2;
    ctx.fillStyle = tot > 0 ? '#1E3A8A' : '#94A3B8';
    ctx.font = `700 13.5px ${fontFamily}`;
    ctx.fillText(String(tot), cx, summaryY + layout.summaryRowHeight / 2);
  });

  // Summary row 2 (TỔNG ĐIỂM)
  const pointsSummaryY = summaryY + layout.summaryRowHeight;
  ctx.fillStyle = '#F8FAFC';
  ctx.fillRect(padX, pointsSummaryY, tableWidth, layout.pointsSummaryRowHeight);

  ctx.strokeStyle = '#CBD5E1';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padX, pointsSummaryY);
  ctx.lineTo(padX + tableWidth, pointsSummaryY);
  ctx.stroke();

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#334155';
  ctx.font = `700 12.5px ${fontFamily}`;
  ctx.fillText('TỔNG ĐIỂM', colXs[0] + 12, pointsSummaryY + layout.pointsSummaryRowHeight / 2);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#94A3B8';
  ctx.font = `500 12px ${fontFamily}`;
  ctx.fillText(
    '–',
    colXs[1] + layout.hourColWidth / 2,
    pointsSummaryY + layout.pointsSummaryRowHeight / 2
  );

  // Merge CAP + Điểm/CAP area visually on the TỔNG ĐIỂM row so grand total points never wrap/clip
  ctx.fillStyle = '#2563EB';
  ctx.font = `800 12.5px ${fontFamily}`;
  ctx.fillText(
    `${layout.grandTotalPoints.toLocaleString('vi-VN')} point`,
    colXs[2] + (layout.totalColWidth + layout.pointsColWidth) / 2,
    pointsSummaryY + layout.pointsSummaryRowHeight / 2
  );

  layout.memberPointTotals.forEach((ptTot, mIdx) => {
    const cx = colXs[4 + mIdx] + layout.memberColWidth / 2;
    ctx.fillStyle = ptTot > 0 ? '#2563EB' : '#94A3B8';
    ctx.font = `700 11.5px ${fontFamily}`;
    const label =
      layout.memberColWidth >= 86
        ? `${ptTot.toLocaleString('vi-VN')} point`
        : `${ptTot.toLocaleString('vi-VN')} pt`;
    ctx.fillText(
      fitTextWithEllipsis(ctx, label, layout.memberColWidth - 8),
      cx,
      pointsSummaryY + layout.pointsSummaryRowHeight / 2
    );
  });

  // Vertical column dividers (note: skip divider between CAP and Điểm/CAP on the TỔNG ĐIỂM row)
  ctx.strokeStyle = '#E2E8F0';
  ctx.lineWidth = 1;
  for (let i = 1; i < colXs.length - 1; i++) {
    const dividerBottom = i === 3 ? pointsSummaryY : tableTop + tableBodyHeight;
    ctx.beginPath();
    ctx.moveTo(colXs[i], tableTop);
    ctx.lineTo(colXs[i], dividerBottom);
    ctx.stroke();
  }

  ctx.restore();

  // Outer border
  ctx.strokeStyle = '#CBD5E1';
  ctx.lineWidth = 1;
  drawRoundedRect(ctx, padX, tableTop, tableWidth, tableBodyHeight, 10);
  ctx.stroke();

  // Subtle footer
  ctx.fillStyle = '#94A3B8';
  ctx.font = `500 11px ${fontFamily}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.fillText(
    'CAP Manager · Design by Trung Bảo',
    padX + tableWidth,
    tableTop + tableBodyHeight + layout.footerHeight / 2 + 2
  );

  const dataUrl = canvas.toDataURL('image/png');
  const commaIdx = dataUrl.indexOf(',');
  return commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : null;
}
