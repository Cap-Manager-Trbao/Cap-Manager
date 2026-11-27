import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Input, InputNumber, Modal, Select, Table } from 'antd';
import {
  Users,
  Briefcase,
  Target,
  Award,
  SlidersHorizontal,
  FileSpreadsheet,
  Clock,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Eye,
  X,
  Copy,
  Smartphone,
  Table2,
  Check,
  CheckCircle2,
  ArrowRightLeft,
  Bot,
  Send,
} from 'lucide-react';
import { SHIFTS } from '../data/defaultData.js';
import {
  computeDistributionStats,
  detectDistributionShiftConflicts,
  getMemberEffectiveShiftsForDay,
  isMemberAvailableForCapCycle,
  normalizeMatrix,
  parseCapHour,
  sortOffersByPointsDesc,
} from '../utils/capAlgorithm.js';
import { getSavedDistributionForDate } from '../utils/dashboardSchedule.js';
import { aiAnalyticsQa } from '../utils/aiClient.js';
import { computeAnalyticsDataset } from '../utils/aiHelpers.js';
import {
  addDaysToIso,
  formatCalendarDateHeader,
  getTodayDateString,
} from '../utils/storage.js';
import {
  formatGroupDistributionSummaryText,
  formatMemberCapScheduleText,
} from '../utils/shareText.js';
import { extractOfferNameCode } from '../utils/telegramMessages.js';

function formatCompactShifts(shiftIds) {
  if (!Array.isArray(shiftIds) || shiftIds.length === 0) return 'Nghỉ';
  return shiftIds
    .map((id) => SHIFTS.find((s) => s.id === id)?.label || id)
    .join(', ');
}

async function copyTextSafe(text) {
  if (!text) return false;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fallback below
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export default function DashboardView({
  activeGroup,
  canEdit,
  members = [],
  history = [],
  settings = {},
  dashboardDate,
  onChangeDashboardDate,
  completions = {},
  onToggleCompletion,
  onOpenDistributeForDate,
  onNavigate,
  onExportRecord,
  onNotify,
  transfers = [],
  onCreateTransfer,
  onResolveTransfer,
  onRequestReauth,
}) {
  const [focusedMemberId, setFocusedMemberId] = useState(null);
  const [onlyAssignedOffers, setOnlyAssignedOffers] = useState(false);
  const [mobileLayout, setMobileLayout] = useState('cards'); // 'cards' | 'table'
  const tableContainerRef = useRef(null);

  const [transferModalOpen, setTransferModalOpen] = useState(false);
  const [transferOfferId, setTransferOfferId] = useState('');
  const [transferFromId, setTransferFromId] = useState('');
  const [transferToId, setTransferToId] = useState('');
  const [transferQty, setTransferQty] = useState(1);
  const [transferNote, setTransferNote] = useState('');
  const [transferSubmitting, setTransferSubmitting] = useState(false);
  const [resolvingTransferId, setResolvingTransferId] = useState('');

  const [aiQaModalOpen, setAiQaModalOpen] = useState(false);
  const [aiQaQuestion, setAiQaQuestion] = useState('');
  const [aiQaLoading, setAiQaLoading] = useState(false);
  const [aiQaError, setAiQaError] = useState('');
  const [aiQaResult, setAiQaResult] = useState(null);

  const todayStr = getTodayDateString();
  const tomorrowStr = addDaysToIso(todayStr, 1);
  const selectedDate = dashboardDate || todayStr;
  const dateHeaderInfo = formatCalendarDateHeader(selectedDate);

  const savedRecord = useMemo(
    () => getSavedDistributionForDate(history, selectedDate),
    [history, selectedDate]
  );

  const liveMemberById = useMemo(
    () => new Map(members.map((m) => [m.id, m])),
    [members]
  );

  const recordMembers = useMemo(() => {
    if (!savedRecord) return members;
    const snapMembers = Array.isArray(savedRecord.members) && savedRecord.members.length > 0
      ? savedRecord.members
      : members;
    return snapMembers.map((m) => liveMemberById.get(m.id) || m);
  }, [savedRecord, members, liveMemberById]);

  const sortedOffers = useMemo(
    () => (savedRecord ? sortOffersByPointsDesc(savedRecord.campaigns || []) : []),
    [savedRecord]
  );

  const recordMatrix = useMemo(
    () =>
      savedRecord
        ? normalizeMatrix(savedRecord.matrix || {}, sortedOffers, recordMembers)
        : {},
    [savedRecord, sortedOffers, recordMembers]
  );

  const recordStats = useMemo(
    () => computeDistributionStats(recordMatrix, sortedOffers, recordMembers, selectedDate),
    [recordMatrix, sortedOffers, recordMembers, selectedDate]
  );

  // Clear stale focus when switching groups or dates
  useEffect(() => {
    if (focusedMemberId && !recordMembers.some((m) => m.id === focusedMemberId)) {
      setFocusedMemberId(null);
      setOnlyAssignedOffers(false);
    }
  }, [activeGroup?.id, selectedDate, recordMembers, focusedMemberId]);

  // Smoothly scroll focused member column into view if it is horizontally off-screen
  useEffect(() => {
    if (!focusedMemberId || !tableContainerRef.current) return;
    const headerBtn = tableContainerRef.current.querySelector(
      `button[data-member-col="${focusedMemberId}"]`
    );
    if (headerBtn && typeof headerBtn.scrollIntoView === 'function') {
      headerBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }, [focusedMemberId]);

  const focusedMember = useMemo(
    () => recordMembers.find((m) => m.id === focusedMemberId) || null,
    [recordMembers, focusedMemberId]
  );

  const toggleFocusMember = (memberId) => {
    setFocusedMemberId((prev) => {
      const next = prev === memberId ? null : memberId;
      if (!next) setOnlyAssignedOffers(false);
      return next;
    });
  };

  const clearFocus = () => {
    setFocusedMemberId(null);
    setOnlyAssignedOffers(false);
  };

  const activeCount = members.filter((m) => m.active !== false).length;
  const participatingCount = members.filter((m) =>
    isMemberAvailableForCapCycle(m, selectedDate)
  ).length;
  const shiftConflicts = useMemo(
    () =>
      savedRecord
        ? detectDistributionShiftConflicts(
            recordMatrix,
            sortedOffers,
            recordMembers,
            selectedDate,
            settings?.useShiftMatching !== false
          )
        : { hasConflicts: false, unavailableWithCap: [], nonCa3OnEvening: [] },
    [savedRecord, recordMatrix, sortedOffers, recordMembers, selectedDate, settings?.useShiftMatching]
  );
  const dateCompletions = useMemo(
    () => completions?.[selectedDate] || {},
    [completions, selectedDate]
  );

  const completionStats = useMemo(() => {
    let totalCap = 0;
    let completedCap = 0;
    let totalSlots = 0;
    let doneSlots = 0;
    if (!savedRecord) return { totalCap, completedCap, totalSlots, doneSlots };
    for (const camp of sortedOffers) {
      for (const mem of recordMembers) {
        const qty = Number(recordMatrix[camp.id]?.[mem.id] ?? 0);
        if (qty > 0) {
          totalCap += qty;
          totalSlots += 1;
          if (dateCompletions?.[camp.id]?.[mem.id]) {
            completedCap += qty;
            doneSlots += 1;
          }
        }
      }
    }
    return { totalCap, completedCap, totalSlots, doneSlots };
  }, [savedRecord, sortedOffers, recordMembers, recordMatrix, dateCompletions]);

  const focusedSummary = useMemo(() => {
    if (!focusedMember || !savedRecord) return null;
    const mStat = recordStats.memberTotalsMap[focusedMember.id];
    const assignedOffers = sortedOffers.filter(
      (camp) => (recordMatrix[camp.id]?.[focusedMember.id] ?? 0) > 0
    );
    let completedCap = 0;
    for (const camp of assignedOffers) {
      if (dateCompletions?.[camp.id]?.[focusedMember.id]) {
        completedCap += Number(recordMatrix[camp.id]?.[focusedMember.id] ?? 0);
      }
    }
    return {
      totalCap: mStat ? mStat.totalCap : 0,
      totalPoints: mStat ? mStat.totalPoints : 0,
      offerCount: assignedOffers.length,
      completedCap,
    };
  }, [focusedMember, savedRecord, recordStats.memberTotalsMap, sortedOffers, recordMatrix, dateCompletions]);

  const displayedOffers = useMemo(() => {
    if (!savedRecord) return [];
    if (!focusedMember || !onlyAssignedOffers) return sortedOffers;
    return sortedOffers.filter(
      (camp) => (recordMatrix[camp.id]?.[focusedMember.id] ?? 0) > 0
    );
  }, [savedRecord, focusedMember, onlyAssignedOffers, sortedOffers, recordMatrix]);

  const mobileGroupedByHour = useMemo(() => {
    if (!savedRecord) return [];
    const source = focusedMember
      ? sortedOffers.filter((camp) => (recordMatrix[camp.id]?.[focusedMember.id] ?? 0) > 0)
      : sortedOffers;
    const groupsMap = new Map();
    for (const offer of source) {
      const hour = offer.capHour || 'Khác';
      if (!groupsMap.has(hour)) groupsMap.set(hour, []);
      groupsMap.get(hour).push(offer);
    }
    return [...groupsMap.entries()].sort(([ha], [hb]) => {
      const pa = parseCapHour(ha);
      const pb = parseCapHour(hb);
      if (pa === null && pb === null) return ha.localeCompare(hb);
      if (pa === null) return 1;
      if (pb === null) return -1;
      return pa - pb;
    });
  }, [savedRecord, focusedMember, sortedOffers, recordMatrix]);

  const handleCopyMemberSchedule = async () => {
    if (!focusedMember || !savedRecord) return;
    const text = formatMemberCapScheduleText({
      member: focusedMember,
      campaigns: sortedOffers,
      matrix: recordMatrix,
      stats: recordStats,
      distributionDate: selectedDate,
      groupName: activeGroup?.name || 'Nhóm 1',
    });
    const ok = await copyTextSafe(text);
    if (onNotify) {
      onNotify(
        ok ? 'success' : 'error',
        ok
          ? `Đã sao chép lịch CAP của ${focusedMember.name} để gửi Zalo/Telegram.`
          : 'Trình duyệt chặn tự động sao chép. Vui lòng thử lại.'
      );
    }
  };

  const handleCopyGroupSummary = async () => {
    if (!savedRecord) return;
    const text = formatGroupDistributionSummaryText({
      groupName: activeGroup?.name || 'Nhóm 1',
      distributionDate: selectedDate,
      members: recordMembers,
      campaigns: sortedOffers,
      matrix: recordMatrix,
      stats: recordStats,
    });
    const ok = await copyTextSafe(text);
    if (onNotify) {
      onNotify(
        ok ? 'success' : 'error',
        ok
          ? `Đã sao chép tóm tắt chia CAP ${activeGroup?.name || 'nhóm'}.`
          : 'Trình duyệt chặn tự động sao chép. Vui lòng thử lại.'
      );
    }
  };

  const transferableOffers = useMemo(() => {
    if (!savedRecord) return [];
    return sortedOffers.filter((offer) =>
      recordMembers.some((m) => (recordMatrix[offer.id]?.[m.id] ?? 0) > 0)
    );
  }, [savedRecord, sortedOffers, recordMembers, recordMatrix]);

  const holdersForSelectedOffer = useMemo(() => {
    if (!transferOfferId) return [];
    return recordMembers.filter((m) => (recordMatrix[transferOfferId]?.[m.id] ?? 0) > 0);
  }, [transferOfferId, recordMembers, recordMatrix]);

  const maxTransferQty = useMemo(() => {
    if (!transferOfferId || !transferFromId) return 1;
    return Math.max(1, Number(recordMatrix[transferOfferId]?.[transferFromId] ?? 0));
  }, [transferOfferId, transferFromId, recordMatrix]);

  const pendingTransfers = useMemo(
    () => (Array.isArray(transfers) ? transfers.filter((t) => t.status === 'pending') : []),
    [transfers]
  );

  const resolvedTransfersForDate = useMemo(
    () =>
      (Array.isArray(transfers)
        ? transfers.filter((t) => t.date === selectedDate && t.status !== 'pending')
        : []
      ).slice(0, 5),
    [transfers, selectedDate]
  );

  const openTransferModal = () => {
    if (!savedRecord || transferableOffers.length === 0) {
      onNotify?.('warning', 'Chưa có CAP nào được chia trong ngày để nhượng.');
      return;
    }
    let defaultOffer = transferableOffers[0];
    if (focusedMember) {
      const focusedOffer = transferableOffers.find(
        (o) => (recordMatrix[o.id]?.[focusedMember.id] ?? 0) > 0
      );
      if (focusedOffer) defaultOffer = focusedOffer;
    }
    const holders = recordMembers.filter(
      (m) => (recordMatrix[defaultOffer.id]?.[m.id] ?? 0) > 0
    );
    const defaultFrom =
      focusedMember && holders.some((h) => h.id === focusedMember.id)
        ? focusedMember.id
        : holders[0]?.id || '';
    const defaultTo = recordMembers.find((m) => m.id !== defaultFrom)?.id || '';

    setTransferOfferId(defaultOffer.id);
    setTransferFromId(defaultFrom);
    setTransferToId(defaultTo);
    setTransferQty(1);
    setTransferNote('');
    setTransferModalOpen(true);
  };

  const handleTransferOfferChange = (nextOfferId) => {
    setTransferOfferId(nextOfferId);
    const holders = recordMembers.filter((m) => (recordMatrix[nextOfferId]?.[m.id] ?? 0) > 0);
    const nextFrom = holders.some((h) => h.id === transferFromId)
      ? transferFromId
      : holders[0]?.id || '';
    setTransferFromId(nextFrom);
    if (transferToId === nextFrom) {
      setTransferToId(recordMembers.find((m) => m.id !== nextFrom)?.id || '');
    }
    setTransferQty(1);
  };

  const handleSubmitTransfer = async () => {
    if (!onCreateTransfer || !savedRecord) return;
    const offer = sortedOffers.find((o) => o.id === transferOfferId);
    const fromMem = recordMembers.find((m) => m.id === transferFromId);
    const toMem = recordMembers.find((m) => m.id === transferToId);
    if (!offer || !fromMem || !toMem || fromMem.id === toMem.id) {
      onNotify?.('warning', 'Vui lòng chọn đầy đủ Offer, người nhượng và người nhận khác nhau.');
      return;
    }
    const holding = Number(recordMatrix[offer.id]?.[fromMem.id] ?? 0);
    const cleanQty = Math.max(1, Math.min(holding, Math.floor(Number(transferQty) || 1)));
    if (holding <= 0) {
      onNotify?.('warning', `${fromMem.name} không còn CAP ở offer này.`);
      return;
    }
    setTransferSubmitting(true);
    const ok = await onCreateTransfer({
      date: selectedDate,
      offerId: offer.id,
      offerCode: extractOfferNameCode(offer) || offer.code,
      offerName: offer.name,
      fromMemberId: fromMem.id,
      fromMemberName: fromMem.name,
      toMemberId: toMem.id,
      toMemberName: toMem.name,
      qty: cleanQty,
      note: transferNote,
      source: 'app',
    });
    setTransferSubmitting(false);
    if (ok) {
      setTransferModalOpen(false);
    }
  };

  const handleResolveTransferClick = async (tr, action) => {
    if (!onResolveTransfer || !tr?.id) return;
    setResolvingTransferId(tr.id);
    await onResolveTransfer(tr, action);
    setResolvingTransferId('');
  };

  const handleRunAiQa = async (overrideQuestion) => {
    if (aiQaLoading) return;
    const qText = String(overrideQuestion ?? aiQaQuestion).trim();
    if (!qText) {
      setAiQaError('Vui lòng nhập câu hỏi thống kê.');
      return;
    }
    if (!activeGroup?.id) return;

    setAiQaLoading(true);
    setAiQaError('');

    const dataset = computeAnalyticsDataset(history, completions, members, sortedOffers);
    const res = await aiAnalyticsQa({
      groupId: activeGroup.id,
      question: qText,
      analyticsDataset: dataset,
      groupName: activeGroup?.name || '',
    });
    setAiQaLoading(false);

    if (!res.ok) {
      if (res.status === 401) {
        setAiQaError('Phiên Leader trên máy chủ đã hết hạn. Vui lòng đăng nhập lại.');
        onRequestReauth?.();
        return;
      }
      setAiQaError(res.error || 'Không thể phân tích dữ liệu bằng AI.');
      return;
    }

    setAiQaResult({
      question: qText,
      answer: res.data?.answer || '',
      highlights: Array.isArray(res.data?.highlights) ? res.data.highlights : [],
    });
  };

  const kpis = [
    {
      label: activeGroup?.name || 'Nhóm hiện tại',
      value: `${activeCount}/${members.length}`,
      sub:
        participatingCount < activeCount
          ? `${participatingCount} TV có ca chia CAP`
          : 'Thành viên hoạt động',
      icon: Users,
    },
    {
      label: `Offer ngày ${dateHeaderInfo.shortDate}`,
      value: savedRecord ? sortedOffers.length : 0,
      sub: savedRecord
        ? `Tổng ${recordStats.expectedTotalCap} CAP`
        : 'Nhóm trưởng chưa chia CAP',
      icon: Briefcase,
    },
    {
      label: 'Tổng điểm nhóm',
      value: savedRecord
        ? `${recordStats.expectedTotalPoints.toLocaleString('vi-VN')} point`
        : '0 point',
      sub: savedRecord
        ? `Độ lệch: ${recordStats.pointSpread} point`
        : 'Chưa lưu bảng chia CAP',
      icon: Award,
    },
    {
      label: 'Nhiều CAP nhất',
      value: savedRecord && recordStats.maxCapMember ? recordStats.maxCapMember.name : '—',
      sub:
        savedRecord && recordStats.maxCapMember
          ? `${recordStats.maxCapMember.totalCap} CAP · ${recordStats.maxCapMember.totalPoints.toLocaleString('vi-VN')} point`
          : 'Nhóm trưởng chưa chia CAP',
      icon: Target,
    },
  ];

  const columns = [
    {
      title: 'ID',
      dataIndex: 'code',
      key: 'code',
      fixed: 'left',
      width: 60,
      render: (code, camp) => {
        const isAssigned = focusedMember
          ? (recordMatrix[camp.id]?.[focusedMember.id] ?? 0) > 0
          : false;
        return (
          <span
            className={`font-tabular text-xs sm:text-sm ${
              isAssigned ? 'font-bold text-[#1D4ED8]' : 'font-semibold text-slate-900'
            }`}
          >
            {code}
          </span>
        );
      },
    },
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      fixed: 'left',
      width: 172,
      render: (name, camp) => {
        const isAssigned = focusedMember
          ? (recordMatrix[camp.id]?.[focusedMember.id] ?? 0) > 0
          : false;
        return (
          <div
            className={`text-xs truncate max-w-[154px] ${
              isAssigned ? 'font-semibold text-slate-950' : 'font-medium text-slate-800'
            }`}
            title={name}
          >
            {name}
          </div>
        );
      },
    },
    {
      title: 'Giờ CAP chung',
      dataIndex: 'capHour',
      key: 'capHour',
      fixed: 'left',
      align: 'center',
      width: 108,
      render: (capHour, camp) => {
        const isAssigned = focusedMember
          ? (recordMatrix[camp.id]?.[focusedMember.id] ?? 0) > 0
          : false;
        return (
          <span
            className={`inline-flex items-center gap-1 font-tabular text-xs whitespace-nowrap ${
              isAssigned ? 'font-bold text-[#1D4ED8]' : 'font-semibold text-slate-800'
            }`}
          >
            <Clock className="w-3 h-3 text-[#2563EB]" aria-hidden="true" />
            {capHour || '-'}
          </span>
        );
      },
    },
    {
      title: 'Tổng CAP',
      dataIndex: 'totalCap',
      key: 'totalCap',
      align: 'right',
      width: 112,
      render: (val) => (
        <span className="font-tabular font-semibold text-slate-900">{val}</span>
      ),
    },
    {
      title: 'Điểm/CAP',
      dataIndex: 'pointsPerCap',
      key: 'pointsPerCap',
      align: 'right',
      width: 88,
      render: (val) => (
        <span className="font-tabular font-medium text-slate-700 whitespace-nowrap text-xs">
          {val} point
        </span>
      ),
    },
    ...recordMembers.map((mem) => {
      const eff = getMemberEffectiveShiftsForDay(mem, selectedDate);
      const hasNextCa1 = eff.nextDayShifts.includes('ca1');
      const isAvailable = isMemberAvailableForCapCycle(mem, selectedDate);
      const isFocused = focusedMember?.id === mem.id;
      const isDimmed = Boolean(focusedMember) && !isFocused;

      return {
        title: (
          <button
            type="button"
            data-member-col={mem.id}
            onClick={() => toggleFocusMember(mem.id)}
            aria-pressed={isFocused}
            aria-label={`Xem CAP của ${mem.name}`}
            title={
              isFocused
                ? `Đang làm nổi bật CAP của ${mem.name}. Bấm lại để xem tất cả.`
                : `Bấm để xem nhanh các CAP của ${mem.name}`
            }
            className={`w-full px-1 py-1 rounded-md text-center leading-tight cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-[#2563EB] ${
              isFocused
                ? 'bg-[#2563EB]/10 text-[#1D4ED8]'
                : 'hover:bg-blue-50/70'
            }`}
          >
            <div
              className={`font-semibold whitespace-nowrap text-xs ${
                isFocused ? 'text-[#1D4ED8]' : 'text-slate-900'
              }`}
            >
              {mem.name}
            </div>
            <div className="text-[10px] font-normal text-slate-500 whitespace-nowrap mt-0.5">
              Nay: {formatCompactShifts(eff.todayShifts)}
            </div>
            <div
              className={`text-[10px] font-normal whitespace-nowrap ${
                hasNextCa1 ? 'text-blue-600' : 'text-slate-400'
              }`}
            >
              Mai: {hasNextCa1 ? 'Ca1' : formatCompactShifts(eff.nextDayShifts)}
            </div>
            {!isAvailable && mem.active !== false && (
              <div className="text-[10px] font-semibold text-red-500 whitespace-nowrap">
                Không chia CAP
              </div>
            )}
          </button>
        ),
        key: mem.id,
        align: 'center',
        width: 108,
        onHeaderCell: () => ({
          className: `cap-col-interactive ${
            isFocused ? 'cap-col-focused' : isDimmed ? 'cap-col-dimmed' : ''
          }`,
        }),
        onCell: () => ({
          className: isFocused
            ? 'cap-col-focused'
            : isDimmed
            ? 'cap-col-dimmed'
            : '',
        }),
        render: (_, camp) => {
          const val = recordMatrix[camp.id]?.[mem.id] ?? 0;
          if (val <= 0) {
            return <span className="font-tabular text-slate-300 font-normal">0</span>;
          }

          const isDone = Boolean(dateCompletions?.[camp.id]?.[mem.id]);
          return (
            <button
              type="button"
              onClick={() => onToggleCompletion && onToggleCompletion(camp.id, mem.id, !isDone)}
              aria-pressed={isDone}
              aria-label={`${isDone ? 'Bỏ đánh dấu xong' : 'Đánh dấu đã xong'} ${val} CAP của ${mem.name} ở offer ${camp.code}`}
              title={
                isDone
                  ? 'Đã làm xong CAP này (đồng bộ theo thời gian thực). Bấm để bỏ đánh dấu.'
                  : 'Bấm để tích dấu đã làm xong CAP này'
              }
              className={`inline-flex items-center justify-center gap-1 px-2 py-0.5 rounded-md border text-xs font-tabular transition-colors cursor-pointer ${
                isDone
                  ? 'bg-emerald-50 border-emerald-300 text-emerald-700 font-bold hover:bg-emerald-100'
                  : isFocused
                  ? 'bg-white border-blue-200 text-[#1D4ED8] font-bold hover:border-[#2563EB] hover:bg-blue-50'
                  : 'bg-white border-slate-200 text-slate-900 font-semibold hover:border-emerald-300 hover:bg-emerald-50/50'
              }`}
            >
              <span>{val}</span>
              {isDone ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" aria-hidden="true" />
              ) : (
                <Check className="w-3 h-3 text-slate-300 shrink-0" aria-hidden="true" />
              )}
            </button>
          );
        },
      };
    }),
  ];

  return (
    <div className="flex flex-col gap-5">
      {/* Date Filter Bar for Dashboard */}
      <section className="cap-card p-3.5 sm:px-5 sm:py-3.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <label
            htmlFor="dashboard-date-picker"
            className="inline-flex items-center gap-1.5 text-xs sm:text-sm font-semibold text-slate-700 whitespace-nowrap"
          >
            <CalendarDays className="w-4 h-4 text-[#2563EB]" aria-hidden="true" />
            Xem CAP theo ngày:
          </label>
          <div className="inline-flex items-center gap-1">
            <Button
              size="small"
              aria-label="Xem ngày trước"
              icon={<ChevronLeft className="w-3.5 h-3.5" />}
              onClick={() =>
                onChangeDashboardDate && onChangeDashboardDate(addDaysToIso(selectedDate, -1))
              }
            />
            <Input
              id="dashboard-date-picker"
              type="date"
              size="small"
              value={selectedDate}
              onChange={(e) =>
                e.target.value && onChangeDashboardDate && onChangeDashboardDate(e.target.value)
              }
              className="w-36 font-tabular"
            />
            <Button
              size="small"
              aria-label="Xem ngày tiếp theo"
              icon={<ChevronRight className="w-3.5 h-3.5" />}
              onClick={() =>
                onChangeDashboardDate && onChangeDashboardDate(addDaysToIso(selectedDate, 1))
              }
            />
          </div>
          <div className="inline-flex items-center gap-1">
            <Button
              size="small"
              type={selectedDate === todayStr ? 'primary' : 'default'}
              ghost={selectedDate === todayStr}
              onClick={() => onChangeDashboardDate && onChangeDashboardDate(todayStr)}
            >
              Hôm nay
            </Button>
            <Button
              size="small"
              type={selectedDate === tomorrowStr ? 'primary' : 'default'}
              ghost={selectedDate === tomorrowStr}
              onClick={() => onChangeDashboardDate && onChangeDashboardDate(tomorrowStr)}
            >
              Ngày mai
            </Button>
          </div>
        </div>

        <div className="text-xs font-medium">
          {savedRecord ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-700">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              Đã lưu lúc{' '}
              <span className="font-tabular">
                {new Date(savedRecord.savedAt).toLocaleTimeString('vi-VN', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-amber-700">
              <Clock className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              Nhóm trưởng chưa chia CAP
            </span>
          )}
        </div>
      </section>

      {/* Compact 4-KPI Row */}
      <section aria-label="Thống kê nhanh" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {kpis.map((kpi) => {
          const Icon = kpi.icon;
          return (
            <div key={kpi.label} className="cap-card p-4 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-medium text-slate-500 truncate">{kpi.label}</div>
                <div className="text-xl font-bold text-slate-900 font-tabular mt-1 truncate">
                  {kpi.value}
                </div>
                <div className="text-xs text-slate-500 mt-0.5 font-tabular truncate">{kpi.sub}</div>
              </div>
              <div className="w-10 h-10 rounded-lg bg-[#EFF6FF] text-[#2563EB] flex items-center justify-center shrink-0">
                <Icon className="w-5 h-5" aria-hidden="true" />
              </div>
            </div>
          );
        })}
      </section>

      {/* Pending & Recent CAP Transfer Requests */}
      {(pendingTransfers.length > 0 || resolvedTransfersForDate.length > 0) && (
        <section
          aria-label="Yêu cầu nhượng CAP"
          className="cap-card p-4 sm:p-5 border-l-4 border-l-[#2563EB]"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div className="inline-flex items-center gap-2 text-sm font-semibold text-slate-900">
              <ArrowRightLeft className="w-4 h-4 text-[#2563EB]" aria-hidden="true" />
              Yêu cầu nhượng CAP
              {pendingTransfers.length > 0 && (
                <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800 text-xs font-semibold font-tabular">
                  {pendingTransfers.length} chờ Leader duyệt
                </span>
              )}
            </div>
          </div>

          {pendingTransfers.length > 0 && (
            <div className="flex flex-col gap-2">
              {pendingTransfers.map((tr) => (
                <div
                  key={tr.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50/60 px-3.5 py-2.5"
                >
                  <div className="min-w-0 flex-1 text-xs sm:text-sm text-slate-800">
                    <div className="flex flex-wrap items-center gap-1.5 font-semibold">
                      <span className="font-tabular text-[#1D4ED8]">{tr.offerCode}</span>
                      <span>·</span>
                      <span>{tr.fromMemberName}</span>
                      <span className="text-slate-400">➔</span>
                      <span>{tr.toMemberName}</span>
                      <span className="font-tabular text-slate-900">({tr.qty} CAP)</span>
                      <span className="text-[11px] font-normal text-slate-500 font-tabular">
                        · Ngày {tr.date} · {tr.source === 'telegram' ? 'Telegram' : 'Web'}
                      </span>
                    </div>
                    {tr.note && (
                      <div className="text-xs text-slate-600 mt-0.5">Ghi chú: {tr.note}</div>
                    )}
                  </div>
                  {canEdit ? (
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        type="primary"
                        size="small"
                        loading={resolvingTransferId === tr.id}
                        onClick={() => handleResolveTransferClick(tr, 'approved')}
                      >
                        Duyệt
                      </Button>
                      <Button
                        danger
                        size="small"
                        loading={resolvingTransferId === tr.id}
                        onClick={() => handleResolveTransferClick(tr, 'rejected')}
                      >
                        Từ chối
                      </Button>
                    </div>
                  ) : (
                    <span className="text-xs text-amber-700 font-medium shrink-0">
                      Đang chờ Leader duyệt
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {resolvedTransfersForDate.length > 0 && (
            <div className="mt-2.5 flex flex-col gap-1">
              {resolvedTransfersForDate.map((tr) => (
                <div
                  key={tr.id}
                  className="text-xs text-slate-500 flex flex-wrap items-center gap-1.5"
                >
                  <span
                    className={`font-semibold ${
                      tr.status === 'approved' ? 'text-emerald-700' : 'text-red-600'
                    }`}
                  >
                    {tr.status === 'approved' ? 'Đã duyệt' : 'Đã từ chối'}
                  </span>
                  <span>·</span>
                  <span className="font-tabular">
                    {tr.qty} CAP {tr.offerCode}: {tr.fromMemberName} ➔ {tr.toMemberName}
                  </span>
                  {tr.resolvedBy && <span>(bởi {tr.resolvedBy})</span>}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Shift Conflict Alert when member shifts changed since saved distribution */}
      {canEdit && savedRecord && shiftConflicts.hasConflicts && (
        <Alert
          type="warning"
          showIcon
          title="Lịch ca làm vừa thay đổi so với bảng chia CAP đã lưu"
          description={
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs sm:text-sm">
              <span>
                {shiftConflicts.unavailableWithCap.length > 0 &&
                  `Có thành viên đang nghỉ chu kỳ vẫn giữ CAP (${shiftConflicts.unavailableWithCap.map((x) => `${x.name}: ${x.cap}`).join(', ')}). `}
                {shiftConflicts.nonCa3OnEvening.length > 0 &&
                  `Có thành viên nghỉ Ca 3 hôm nay đang giữ offer 20h+ (${shiftConflicts.nonCa3OnEvening.slice(0, 3).map((x) => `${x.name} - ${x.offerCode}`).join(', ')}).`}
              </span>
              {onOpenDistributeForDate && (
                <Button size="small" type="primary" onClick={() => onOpenDistributeForDate(selectedDate)}>
                  Mở Chia CAP ngày {dateHeaderInfo.shortDate}
                </Button>
              )}
            </div>
          }
        />
      )}

      {/* Main Daily CAP Distribution Table OR Empty State */}
      {!savedRecord ? (
        <section className="cap-card px-5 py-12 text-center flex flex-col items-center justify-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-amber-50 border border-amber-200 text-amber-600 flex items-center justify-center">
            <Clock className="w-6 h-6" aria-hidden="true" />
          </div>
          <div className="max-w-md">
            <h2 className="text-base sm:text-lg font-semibold text-slate-900 m-0">
              Nhóm trưởng chưa chia CAP
            </h2>
            <p className="text-xs sm:text-sm text-slate-500 mt-1.5 mb-0">
              {canEdit
                ? `Ngày ${dateHeaderInfo.shortDate} (${selectedDate}) chưa có bảng chia CAP nào được lưu lên Dashboard. Hãy vào mục Chia CAP, điều chỉnh và bấm nút "Lưu bảng chia CAP" để hiển thị tại đây.`
                : `Ngày ${dateHeaderInfo.shortDate} (${selectedDate}) chưa được Nhóm trưởng chia và lưu bảng CAP. Vui lòng quay lại sau hoặc chọn ngày khác để xem lại.`}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2 mt-2">
            {canEdit ? (
              <Button
                type="primary"
                icon={<SlidersHorizontal className="w-4 h-4" />}
                onClick={() =>
                  onOpenDistributeForDate
                    ? onOpenDistributeForDate(selectedDate)
                    : onNavigate('distribute')
                }
              >
                Chia CAP ngày {dateHeaderInfo.shortDate}
              </Button>
            ) : (
              <Button
                type="primary"
                icon={<CalendarDays className="w-4 h-4" />}
                onClick={() => onNavigate('members')}
              >
                Đăng ký ca làm
              </Button>
            )}
            {selectedDate !== todayStr && (
              <Button onClick={() => onChangeDashboardDate && onChangeDashboardDate(todayStr)}>
                Về ngày hôm nay
              </Button>
            )}
          </div>
        </section>
      ) : (
      <section className="cap-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900 m-0">
              Bảng chia CAP ngày {dateHeaderInfo.shortDate} ({selectedDate}) – {activeGroup?.name || 'Nhóm 1'}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5 mb-0">
              {recordStats.isAllValid
                ? `Khớp ${recordStats.assignedTotalCap}/${recordStats.expectedTotalCap} CAP · Tiến độ: ${completionStats.completedCap}/${completionStats.totalCap} CAP xong · Tổng ${recordStats.assignedTotalPoints.toLocaleString('vi-VN')} point · Lệch CAP: ${recordStats.capSpread}`
                : `Cảnh báo: Có ${recordStats.invalidCampaigns.length} offer chưa khớp tổng CAP`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canEdit ? (
              <Button
                icon={<SlidersHorizontal className="w-4 h-4" />}
                onClick={() =>
                  onOpenDistributeForDate
                    ? onOpenDistributeForDate(selectedDate)
                    : onNavigate('distribute')
                }
              >
                Điều chỉnh chia CAP
              </Button>
            ) : (
              <Button
                icon={<CalendarDays className="w-4 h-4" />}
                onClick={() => onNavigate('members')}
              >
                Đăng ký ca làm
              </Button>
            )}
            <Button
              icon={<ArrowRightLeft className="w-4 h-4" />}
              onClick={openTransferModal}
              disabled={transferableOffers.length === 0}
            >
              Nhượng CAP
            </Button>
            {canEdit && (
              <Button
                icon={<Bot className="w-4 h-4 text-[#2563EB]" />}
                onClick={() => {
                  setAiQaError('');
                  setAiQaModalOpen(true);
                }}
              >
                AI Thống kê &amp; Hỏi đáp
              </Button>
            )}
            <Button
              icon={<Copy className="w-4 h-4" />}
              onClick={handleCopyGroupSummary}
            >
              Copy tóm tắt
            </Button>
            <Button
              type="primary"
              ghost
              icon={<FileSpreadsheet className="w-4 h-4" />}
              onClick={() => onExportRecord && onExportRecord(savedRecord)}
            >
              Xuất Excel
            </Button>
          </div>
        </div>

        {/* Quick Personal CAP Focus Bar */}
        {recordMembers.length > 0 && (
          <div className="flex flex-col gap-2 mb-3.5 pb-3 border-b border-slate-100">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 mr-1 whitespace-nowrap shrink-0">
                  <Eye className="w-3.5 h-3.5 text-[#2563EB]" aria-hidden="true" />
                  Xem nhanh CAP của:
                </span>
                <div
                  role="group"
                  aria-label="Chọn thành viên để làm nổi bật CAP"
                  className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg"
                >
                  <button
                    type="button"
                    onClick={clearFocus}
                    aria-pressed={!focusedMember}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      !focusedMember
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Tất cả
                  </button>
                  {recordMembers.map((mem) => {
                    const isActive = focusedMember?.id === mem.id;
                    return (
                      <button
                        key={mem.id}
                        type="button"
                        onClick={() => toggleFocusMember(mem.id)}
                        aria-pressed={isActive}
                        className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          isActive
                            ? 'bg-[#2563EB] text-white shadow-sm'
                            : 'text-slate-600 hover:text-slate-900 hover:bg-white/70'
                        }`}
                      >
                        {mem.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              {focusedMember && (
                <div className="flex flex-wrap items-center gap-2 min-w-0 max-w-full">
                  <button
                    type="button"
                    onClick={handleCopyMemberSchedule}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-md border border-[#2563EB] bg-[#2563EB] text-white hover:bg-[#1D4ED8] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                    Copy lịch {focusedMember.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => setOnlyAssignedOffers((prev) => !prev)}
                    aria-pressed={onlyAssignedOffers}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      onlyAssignedOffers
                        ? 'bg-[#EFF6FF] border-[#2563EB] text-[#1D4ED8]'
                        : 'bg-white border-slate-200 text-slate-600 hover:text-slate-900 hover:border-slate-300'
                    }`}
                  >
                    {onlyAssignedOffers ? 'Đang lọc offer cần làm' : 'Chỉ hiện offer cần làm'}
                  </button>
                  <button
                    type="button"
                    onClick={clearFocus}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md border border-slate-200 bg-white text-slate-600 hover:text-slate-900 hover:border-slate-300 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                    Xem tất cả
                  </button>
                </div>
              )}
            </div>

            {focusedMember && focusedSummary ? (
              <div
                aria-live="polite"
                className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600"
              >
                <span>
                  Đang xem CAP của{' '}
                  <strong className="font-semibold text-[#1D4ED8]">{focusedMember.name}</strong>
                </span>
                <span aria-hidden="true" className="text-slate-300">·</span>
                <span className="font-tabular font-semibold text-slate-900">
                  {focusedSummary.totalCap} CAP
                </span>
                <span aria-hidden="true" className="text-slate-300">·</span>
                <span className="font-tabular font-semibold text-emerald-700">
                  Đã xong {focusedSummary.completedCap}/{focusedSummary.totalCap} CAP
                </span>
                <span aria-hidden="true" className="text-slate-300">·</span>
                <span className="font-tabular font-semibold text-[#2563EB]">
                  {focusedSummary.totalPoints.toLocaleString('vi-VN')} point
                </span>
                <span aria-hidden="true" className="text-slate-300">·</span>
                <span className="font-tabular text-slate-700">
                  {focusedSummary.offerCount} offer cần làm
                </span>
              </div>
            ) : (
              <div className="text-xs text-slate-400">
                Mẹo: Bấm vào tên để lọc CAP cá nhân; bấm trực tiếp vào ô số CAP (✓) để đánh dấu đã làm xong theo thời gian thực.
              </div>
            )}
          </div>
        )}

        {/* Mobile View Switcher (< md only) */}
        <div className="flex md:hidden items-center justify-between gap-2 mb-3">
          <span className="text-xs font-medium text-slate-500">Hiển thị trên điện thoại:</span>
          <div className="inline-flex items-center p-0.5 bg-slate-100 rounded-lg border border-slate-200">
            <button
              type="button"
              onClick={() => setMobileLayout('cards')}
              aria-pressed={mobileLayout === 'cards'}
              className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-md whitespace-nowrap cursor-pointer ${
                mobileLayout === 'cards' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
              }`}
            >
              <Smartphone className="w-3.5 h-3.5" aria-hidden="true" />
              Thẻ gọn
            </button>
            <button
              type="button"
              onClick={() => setMobileLayout('table')}
              aria-pressed={mobileLayout === 'table'}
              className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-md whitespace-nowrap cursor-pointer ${
                mobileLayout === 'table' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
              }`}
            >
              <Table2 className="w-3.5 h-3.5" aria-hidden="true" />
              Bảng đầy đủ
            </button>
          </div>
        </div>

        {/* Mobile Compact Cards Grouped by Giờ CAP chung */}
        {mobileLayout === 'cards' && (
          <div className="flex flex-col gap-3 md:hidden">
            {mobileGroupedByHour.length === 0 ? (
              <div className="py-6 text-center text-sm text-slate-500">
                {focusedMember
                  ? `${focusedMember.name} chưa được chia CAP nào hôm nay.`
                  : 'Chưa có offer nào cho nhóm này.'}
              </div>
            ) : (
              mobileGroupedByHour.map(([hour, hourOffers]) => (
                <div key={hour} className="flex flex-col gap-2">
                  <div className="flex items-center justify-between text-xs font-semibold text-slate-600 px-1 pt-1">
                    <span className="inline-flex items-center gap-1.5 text-[#1D4ED8] font-tabular">
                      <Clock className="w-3.5 h-3.5" aria-hidden="true" />
                      Giờ CAP chung: {hour}
                    </span>
                    <span className="font-tabular text-slate-400">{hourOffers.length} offer</span>
                  </div>
                  <div className="flex flex-col divide-y divide-slate-100 border border-slate-200 rounded-lg bg-white overflow-hidden">
                    {hourOffers.map((offer) => {
                      const focusedQty = focusedMember
                        ? Number(recordMatrix[offer.id]?.[focusedMember.id] ?? 0)
                        : null;
                      const focusedDone = focusedMember
                        ? Boolean(dateCompletions?.[offer.id]?.[focusedMember.id])
                        : false;
                      const assignedMembers = !focusedMember
                        ? recordMembers
                            .map((m) => ({
                              id: m.id,
                              name: m.name,
                              qty: Number(recordMatrix[offer.id]?.[m.id] ?? 0),
                              done: Boolean(dateCompletions?.[offer.id]?.[m.id]),
                            }))
                            .filter((x) => x.qty > 0)
                        : [];

                      return (
                        <div key={offer.id} className="px-3 py-2.5 flex items-start justify-between gap-2.5 min-w-0">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 text-xs">
                              <span className="font-tabular font-bold text-[#1D4ED8]">{offer.code}</span>
                              <span className="font-tabular text-slate-500">· {offer.pointsPerCap} point</span>
                            </div>
                            <div className="text-xs font-medium text-slate-900 mt-0.5 break-words">
                              {offer.name}
                            </div>
                            {!focusedMember && assignedMembers.length > 0 && (
                              <div className="flex flex-wrap items-center gap-1 mt-1.5 min-w-0 max-w-full">
                                {assignedMembers.map((x) => (
                                  <button
                                    key={x.id}
                                    type="button"
                                    onClick={() =>
                                      onToggleCompletion && onToggleCompletion(offer.id, x.id, !x.done)
                                    }
                                    aria-pressed={x.done}
                                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px] font-tabular cursor-pointer transition-colors ${
                                      x.done
                                        ? 'bg-emerald-50 border-emerald-300 text-emerald-700 font-semibold'
                                        : 'bg-slate-50 border-slate-200 text-slate-700 hover:border-emerald-300'
                                    }`}
                                  >
                                    <span>{x.name} ({x.qty})</span>
                                    {x.done && (
                                      <CheckCircle2 className="w-3 h-3 text-emerald-600 shrink-0" aria-hidden="true" />
                                    )}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="shrink-0 flex flex-col items-end gap-1">
                            <div className="text-right">
                              <div className="font-tabular text-base font-bold text-[#1D4ED8] leading-tight">
                                {focusedMember ? focusedQty : offer.totalCap}
                              </div>
                              <div className="text-[10px] text-slate-400 font-tabular">CAP</div>
                            </div>
                            {focusedMember && focusedQty > 0 && (
                              <button
                                type="button"
                                onClick={() =>
                                  onToggleCompletion &&
                                  onToggleCompletion(offer.id, focusedMember.id, !focusedDone)
                                }
                                aria-pressed={focusedDone}
                                className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] font-semibold whitespace-nowrap cursor-pointer transition-colors ${
                                  focusedDone
                                    ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                                    : 'bg-white border-slate-300 text-slate-700 hover:border-emerald-400 hover:text-emerald-700'
                                }`}
                              >
                                {focusedDone ? (
                                  <>
                                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" aria-hidden="true" />
                                    <span>Đã xong</span>
                                  </>
                                ) : (
                                  <>
                                    <Check className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
                                    <span>Xong</span>
                                  </>
                                )}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* Full Matrix Table (Always visible on md+, or when toggled to table on mobile) */}
        <div
          ref={tableContainerRef}
          className={mobileLayout === 'cards' ? 'hidden md:block' : 'block'}
        >
          <Table
            dataSource={displayedOffers}
            columns={columns}
            rowKey="id"
            pagination={false}
            size="small"
            bordered
            scroll={{ x: Math.max(940, 561 + recordMembers.length * 108) }}
            rowClassName={(camp) => {
              if (!focusedMember) return '';
              const myCap = recordMatrix[camp.id]?.[focusedMember.id] ?? 0;
              return myCap > 0 ? 'cap-row-active' : 'cap-row-dimmed';
            }}
            locale={{
              emptyText:
                focusedMember && onlyAssignedOffers
                  ? `${focusedMember.name} chưa được chia CAP nào ngày ${dateHeaderInfo.shortDate}.`
                  : 'Chưa có offer nào trong bảng chia này.',
            }}
            summary={() => (
              <Table.Summary>
                <Table.Summary.Row className="bg-[#EFF6FF] font-semibold">
                  <Table.Summary.Cell index={0} colSpan={2} className="font-semibold text-[#0F172A]">
                    TỔNG CAP
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={2} align="center" className="text-slate-400">
                    -
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={3} align="right" className="font-tabular font-bold text-[#0F172A]">
                    {recordStats.assignedTotalCap}
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={4} align="right" className="text-slate-400">
                    -
                  </Table.Summary.Cell>
                  {recordMembers.map((mem, idx) => {
                    const mStat = recordStats.memberTotalsMap[mem.id];
                    const isFocused = focusedMember?.id === mem.id;
                    const isDimmed = Boolean(focusedMember) && !isFocused;
                    return (
                      <Table.Summary.Cell
                        key={mem.id}
                        index={5 + idx}
                        align="center"
                        className={`font-tabular font-bold ${
                          isFocused
                            ? 'cap-col-focused text-[#1D4ED8]'
                            : isDimmed
                            ? 'cap-col-dimmed text-[#0F172A]'
                            : 'text-[#0F172A]'
                        }`}
                      >
                        <span>{mStat ? mStat.totalCap : 0}</span>
                      </Table.Summary.Cell>
                    );
                  })}
                </Table.Summary.Row>
                <Table.Summary.Row className="bg-slate-50 font-semibold">
                  <Table.Summary.Cell index={0} colSpan={2} className="font-semibold text-slate-700">
                    TỔNG ĐIỂM
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={2} align="center" className="text-slate-400">
                    -
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={3} align="right" className="font-tabular font-bold text-[#2563EB] whitespace-nowrap">
                    {recordStats.assignedTotalPoints.toLocaleString('vi-VN')} point
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={4} align="right" className="text-slate-400">
                    -
                  </Table.Summary.Cell>
                  {recordMembers.map((mem, idx) => {
                    const mStat = recordStats.memberTotalsMap[mem.id];
                    const isFocused = focusedMember?.id === mem.id;
                    const isDimmed = Boolean(focusedMember) && !isFocused;
                    return (
                      <Table.Summary.Cell
                        key={mem.id}
                        index={5 + idx}
                        align="center"
                        className={`font-tabular font-semibold whitespace-nowrap ${
                          isFocused
                            ? 'cap-col-focused text-[#1D4ED8]'
                            : isDimmed
                            ? 'cap-col-dimmed text-[#2563EB]'
                            : 'text-[#2563EB]'
                        }`}
                      >
                        <span>{(mStat ? mStat.totalPoints : 0).toLocaleString('vi-VN')} point</span>
                      </Table.Summary.Cell>
                    );
                  })}
                </Table.Summary.Row>
              </Table.Summary>
            )}
          />
        </div>
      </section>
      )}

      {/* CAP Transfer Request Modal */}
      <Modal
        title={`Đề xuất nhượng CAP ngày ${dateHeaderInfo.shortDate}`}
        open={transferModalOpen}
        onCancel={() => setTransferModalOpen(false)}
        footer={[
          <Button key="cancel" onClick={() => setTransferModalOpen(false)}>
            Hủy
          </Button>,
          <Button
            key="submit"
            type="primary"
            icon={<ArrowRightLeft className="w-4 h-4" />}
            loading={transferSubmitting}
            onClick={handleSubmitTransfer}
          >
            {canEdit ? 'Gửi yêu cầu nhượng (Chờ duyệt)' : 'Gửi Leader phê duyệt'}
          </Button>,
        ]}
      >
        <div className="flex flex-col gap-3.5 py-2">
          <div>
            <label htmlFor="tr-offer" className="block text-xs font-medium text-slate-600 mb-1">
              Chọn Offer cần nhượng
            </label>
            <Select
              id="tr-offer"
              className="w-full"
              value={transferOfferId || undefined}
              onChange={handleTransferOfferChange}
              options={transferableOffers.map((o) => ({
                value: o.id,
                label: `${extractOfferNameCode(o) || o.code} · ${o.name} (${o.capHour || '-'})`,
              }))}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="tr-from" className="block text-xs font-medium text-slate-600 mb-1">
                Người nhượng CAP
              </label>
              <Select
                id="tr-from"
                className="w-full"
                value={transferFromId || undefined}
                onChange={(val) => {
                  setTransferFromId(val);
                  if (transferToId === val) {
                    setTransferToId(recordMembers.find((m) => m.id !== val)?.id || '');
                  }
                  setTransferQty(1);
                }}
                options={holdersForSelectedOffer.map((m) => ({
                  value: m.id,
                  label: `${m.name} (đang giữ ${recordMatrix[transferOfferId]?.[m.id] ?? 0} CAP)`,
                }))}
              />
            </div>

            <div>
              <label htmlFor="tr-to" className="block text-xs font-medium text-slate-600 mb-1">
                Người nhận CAP
              </label>
              <Select
                id="tr-to"
                className="w-full"
                value={transferToId || undefined}
                onChange={setTransferToId}
                options={recordMembers
                  .filter((m) => m.id !== transferFromId)
                  .map((m) => ({
                    value: m.id,
                    label: m.name,
                  }))}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="tr-qty" className="block text-xs font-medium text-slate-600 mb-1">
                Số lượng CAP nhượng (tối đa {maxTransferQty})
              </label>
              <InputNumber
                id="tr-qty"
                min={1}
                max={maxTransferQty}
                precision={0}
                value={transferQty}
                onChange={(val) => setTransferQty(val ?? 1)}
                className="w-full"
              />
            </div>
            <div>
              <label htmlFor="tr-note" className="block text-xs font-medium text-slate-600 mb-1">
                Lý do / Ghi chú (tuỳ chọn)
              </label>
              <Input
                id="tr-note"
                value={transferNote}
                onChange={(e) => setTransferNote(e.target.value)}
                placeholder="Ví dụ: Bận đột xuất ca tối"
                maxLength={160}
              />
            </div>
          </div>
        </div>
      </Modal>

      {/* AI Analytics Q&A Modal (Leader only) */}
      <Modal
        title="AI Thống kê & Hỏi đáp dữ liệu nhóm"
        open={aiQaModalOpen}
        onCancel={() => setAiQaModalOpen(false)}
        width={680}
        footer={[
          <Button key="close" onClick={() => setAiQaModalOpen(false)}>
            Đóng
          </Button>,
        ]}
      >
        <div className="flex flex-col gap-3.5 py-2">
          <div className="flex flex-wrap gap-1.5">
            {[
              'Ai hoàn thành CAP tốt nhất trong lịch sử gần đây?',
              'Có thành viên nào bị dồn nhiều CAP giờ muộn hoặc chênh điểm không?',
              'Viết đoạn tổng kết nhanh tình hình nhóm để gửi thông báo',
            ].map((sample) => (
              <button
                key={sample}
                type="button"
                disabled={aiQaLoading}
                onClick={() => {
                  setAiQaQuestion(sample);
                  handleRunAiQa(sample);
                }}
                className="px-2.5 py-1 rounded-md border border-slate-200 bg-slate-50 hover:bg-blue-50 hover:border-blue-300 disabled:opacity-50 disabled:cursor-not-allowed text-xs text-slate-700 transition-colors cursor-pointer text-left"
              >
                {sample}
              </button>
            ))}
          </div>

          <div className="flex gap-2">
            <Input
              value={aiQaQuestion}
              onChange={(e) => setAiQaQuestion(e.target.value)}
              onPressEnter={() => handleRunAiQa()}
              placeholder="Hỏi về điểm số, CAP, tỷ lệ hoàn thành hoặc yêu cầu AI soạn thông báo..."
              aria-label="Câu hỏi thống kê AI"
              disabled={aiQaLoading}
            />
            <Button
              type="primary"
              icon={<Send className="w-4 h-4" />}
              loading={aiQaLoading}
              onClick={() => handleRunAiQa()}
            >
              Hỏi AI
            </Button>
          </div>

          {aiQaError && <Alert type="error" showIcon title={aiQaError} />}

          {aiQaResult && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 flex flex-col gap-2.5">
              <div className="text-xs font-semibold text-[#1D4ED8]">{aiQaResult.question}</div>
              <div className="text-sm text-slate-800 whitespace-pre-line leading-relaxed">
                {aiQaResult.answer}
              </div>
              {aiQaResult.highlights.length > 0 && (
                <ul className="m-0 pl-4 text-xs text-slate-600 flex flex-col gap-1 border-t border-slate-200 pt-2">
                  {aiQaResult.highlights.map((item, idx) => (
                    <li key={idx}>{item}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
