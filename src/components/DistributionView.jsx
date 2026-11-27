import React, { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Input,
  InputNumber,
  Modal,
  Select,
  Switch,
  Table,
  Tooltip,
} from 'antd';
import {
  Sparkles,
  RefreshCw,
  RotateCcw,
  Save,
  FileSpreadsheet,
  AlertTriangle,
  CheckCircle2,
  Clock,
  KeyRound,
  Calendar,
  Lock,
  Unlock,
  Bot,
  ShieldCheck,
  Wand2,
  Send,
} from 'lucide-react';
import { SHIFTS } from '../data/defaultData.js';
import {
  detectDistributionShiftConflicts,
  getEligibleMembersForCampaign,
  getMemberEffectiveShiftsForDay,
  isEveningOnlyOffer,
  isMemberAvailableForCapCycle,
  isMemberCa3Worker,
  sortOffersByPointsDesc,
} from '../utils/capAlgorithm.js';
import {
  getSavedDistributionForDate,
  hasMatrixChangesSinceSaved,
} from '../utils/dashboardSchedule.js';
import { aiAuditDistribution, aiDistributionCommand } from '../utils/aiClient.js';
import { computeAnalyticsDataset } from '../utils/aiHelpers.js';
import { addDaysToIso, formatCalendarDateHeader, getTodayDateString } from '../utils/storage.js';

function formatShiftShort(shifts) {
  if (!Array.isArray(shifts) || shifts.length === 0) return 'Nghỉ';
  return shifts.map((id) => SHIFTS.find((s) => s.id === id)?.label || id).join(', ');
}

export default function DistributionView({
  activeGroup,
  canEdit,
  onOpenLogin,
  members,
  campaigns,
  matrix,
  history = [],
  hasAutoBackup,
  stats,
  settings,
  distributionDate,
  onChangeDistributionDate,
  alternatives,
  onUpdateSettings,
  onAutoDistribute,
  onRedistributeVariant,
  onSelectAlternative,
  onCellChange,
  onRestoreAuto,
  onPublishDistribution,
  isPublishing = false,
  telegramConfigured = false,
  isTelegramDeliveredForCurrentMatrix = false,
  telegramSentAtForCurrentDate = '',
  onResendTelegram,
  onSaveHistory,
  onExportExcel,
  lockedCells = {},
  onToggleLockCell,
  onUnlockAllCells,
  rolloverInfo = null,
  onApplyAiDirectives,
  onRequestReauth,
  onNotify,
}) {
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveDate, setSaveDate] = useState(distributionDate || getTodayDateString());
  const [saveNote, setSaveNote] = useState('');
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiCommandLoading, setAiCommandLoading] = useState(false);
  const [aiCommandError, setAiCommandError] = useState('');
  const [aiCommandSummary, setAiCommandSummary] = useState('');
  const [aiMemberDiffs, setAiMemberDiffs] = useState([]);
  const [aiAuditLoading, setAiAuditLoading] = useState(false);
  const [aiAuditError, setAiAuditError] = useState('');
  const [aiAuditResult, setAiAuditResult] = useState(null);

  const existingSameDay = useMemo(
    () => history.find((h) => h.date === saveDate) || null,
    [history, saveDate]
  );

  const lockedCount = useMemo(() => {
    let count = 0;
    for (const camp of campaigns) {
      const row = lockedCells?.[camp.id];
      if (!row) continue;
      for (const mem of members) {
        if (row[mem.id]) count++;
      }
    }
    return count;
  }, [lockedCells, campaigns, members]);

  const sortedOffers = sortOffersByPointsDesc(campaigns);
  const targetDate = distributionDate || getTodayDateString();
  const nextDate = addDaysToIso(targetDate, 1);
  const todayLabel = formatCalendarDateHeader(targetDate).shortDate;
  const nextDayLabel = formatCalendarDateHeader(nextDate).shortDate;

  const shiftConflicts = useMemo(
    () =>
      detectDistributionShiftConflicts(
        matrix,
        campaigns,
        members,
        targetDate,
        settings.useShiftMatching !== false,
        lockedCells
      ),
    [matrix, campaigns, members, targetDate, settings.useShiftMatching, lockedCells]
  );

  const savedForTargetDate = useMemo(
    () => getSavedDistributionForDate(history, targetDate),
    [history, targetDate]
  );

  const hasUnsavedChanges = useMemo(
    () => hasMatrixChangesSinceSaved(savedForTargetDate, matrix, campaigns, members),
    [savedForTargetDate, matrix, campaigns, members]
  );

  const handleConfirmSave = (overwriteHistoryId = null) => {
    if (!saveDate) return;
    onSaveHistory(saveDate, saveNote, null, overwriteHistoryId);
    setSaveModalOpen(false);
    setSaveNote('');
  };

  const handleRunAiCommand = async (overridePrompt) => {
    if (aiCommandLoading) return;
    const promptText = String(overridePrompt ?? aiPrompt).trim();
    if (!promptText) {
      setAiCommandError('Vui lòng nhập yêu cầu điều chỉnh bảng chia CAP bằng tiếng Việt.');
      return;
    }
    if (!activeGroup?.id) return;

    setAiCommandLoading(true);
    setAiCommandError('');
    setAiCommandSummary('');
    setAiMemberDiffs([]);

    const res = await aiDistributionCommand({
      groupId: activeGroup.id,
      prompt: promptText,
      members,
      campaigns,
      matrix,
      lockedCells,
      dateStr: targetDate,
      settings,
    });
    setAiCommandLoading(false);

    if (!res.ok) {
      if (res.status === 401) {
        setAiCommandError('Phiên Leader trên máy chủ đã hết hạn. Vui lòng đăng nhập lại.');
        onRequestReauth?.();
        return;
      }
      setAiCommandError(res.error || 'Không thể phân tích yêu cầu AI.');
      return;
    }

    const directives = res.data?.directives;
    if (!directives) {
      setAiCommandError('AI chưa trả về chỉ thị điều chỉnh hợp lệ.');
      return;
    }

    const applied = await onApplyAiDirectives?.(directives);
    if (applied?.ok) {
      setAiCommandSummary(
        applied.appliedSummary || directives.summary || 'Đã áp dụng điều chỉnh theo yêu cầu AI.'
      );
      setAiMemberDiffs(Array.isArray(applied.memberDiffs) ? applied.memberDiffs : []);
      setAiAuditResult(null);
    } else if (applied?.error) {
      setAiCommandError(applied.error);
    }
  };

  const handleRunAiAudit = async () => {
    if (aiAuditLoading || !activeGroup?.id) return;
    setAiAuditLoading(true);
    setAiAuditError('');

    const analyticsDataset = computeAnalyticsDataset(
      history,
      activeGroup?.completions || {},
      members,
      campaigns
    );

    const res = await aiAuditDistribution({
      groupId: activeGroup.id,
      members,
      campaigns,
      matrix,
      analyticsDataset,
      dateStr: targetDate,
    });
    setAiAuditLoading(false);

    if (!res.ok) {
      if (res.status === 401) {
        setAiAuditError('Phiên Leader trên máy chủ đã hết hạn. Vui lòng đăng nhập lại.');
        onRequestReauth?.();
        return;
      }
      setAiAuditError(res.error || 'Không thể kiểm tra bảng chia bằng AI.');
      return;
    }

    setAiAuditResult(res.data?.audit || null);
  };

  const handleApplyAuditSuggestion = async () => {
    const suggested = aiAuditResult?.suggestedDirectives;
    if (!suggested) return;
    const applied = await onApplyAiDirectives?.(suggested);
    if (applied?.ok) {
      setAiCommandSummary(
        applied.appliedSummary || suggested.summary || 'Đã áp dụng đề xuất cân bằng từ AI.'
      );
      setAiMemberDiffs(Array.isArray(applied.memberDiffs) ? applied.memberDiffs : []);
      setAiAuditResult(null);
      onNotify?.('success', 'Đã áp dụng đề xuất cân bằng bảng chia CAP từ AI.');
    } else if (applied?.error) {
      setAiAuditError(applied.error);
    }
  };

  const hasSuggestedAction = useMemo(() => {
    const sd = aiAuditResult?.suggestedDirectives;
    if (!aiAuditResult?.hasSuggestion || !sd) return false;
    return Boolean(
      (sd.boostMemberIds && sd.boostMemberIds.length > 0) ||
        (sd.reduceMemberIds && sd.reduceMemberIds.length > 0) ||
        (sd.excludeMemberFromHourBuckets && sd.excludeMemberFromHourBuckets.length > 0) ||
        (sd.excludeCells && sd.excludeCells.length > 0) ||
        (sd.pinCells && sd.pinCells.length > 0) ||
        (sd.transfers && sd.transfers.length > 0) ||
        (sd.lockMemberIds && sd.lockMemberIds.length > 0) ||
        (sd.lockOfferIds && sd.lockOfferIds.length > 0) ||
        (sd.excludeMemberIds && sd.excludeMemberIds.length > 0) ||
        (sd.onlyIncludeMemberIds && sd.onlyIncludeMemberIds.length > 0) ||
        (sd.overrideMemberShifts && sd.overrideMemberShifts.length > 0) ||
        (sd.memberTargetAdjustments && sd.memberTargetAdjustments.length > 0)
    );
  }, [aiAuditResult]);

  const validationByCampId = {};
  for (const row of stats.campaignValidation) {
    validationByCampId[row.campaignId] = row;
  }

  const columns = [
    {
      title: 'ID',
      dataIndex: 'code',
      key: 'code',
      fixed: 'left',
      width: 64,
      render: (code) => <span className="font-tabular font-semibold text-slate-900 text-xs sm:text-sm">{code}</span>,
    },
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      fixed: 'left',
      width: 175,
      render: (name, offer) => (
        <div className="min-w-0">
          <div className="text-xs font-medium text-slate-900 truncate max-w-[158px]" title={name}>
            {name}
          </div>
          {offer.eligibilityType && offer.eligibilityType !== 'all' && (
            <div className="text-[11px] text-amber-700 mt-0.5">Có điều kiện riêng</div>
          )}
        </div>
      ),
    },
    {
      title: 'Giờ CAP chung',
      dataIndex: 'capHour',
      key: 'capHour',
      align: 'center',
      width: 108,
      render: (capHour) => (
        <span className="inline-flex items-center gap-1 font-tabular font-semibold text-slate-800 text-xs">
          <Clock className="w-3 h-3 text-[#2563EB]" aria-hidden="true" />
          {capHour || '-'}
        </span>
      ),
    },
    {
      title: 'Tổng CAP',
      dataIndex: 'totalCap',
      key: 'totalCap',
      align: 'right',
      width: 96,
      render: (targetCap, offer) => {
        const val = validationByCampId[offer.id];
        const isOk = val && val.status === 'valid';
        return (
          <div className="font-tabular text-right whitespace-nowrap text-xs">
            <span className={`font-semibold ${isOk ? 'text-slate-900' : 'text-red-600'}`}>
              {val ? val.assignedCap : 0}
            </span>
            <span className="text-slate-400"> / {targetCap}</span>
            {!isOk && val && (
              <div className="text-[11px] font-medium text-red-600">
                {val.diff > 0 ? `Vượt +${val.diff}` : `Thiếu ${val.diff}`}
              </div>
            )}
          </div>
        );
      },
    },
    {
      title: 'Điểm/CAP',
      dataIndex: 'pointsPerCap',
      key: 'pointsPerCap',
      align: 'right',
      width: 82,
      render: (pts) => (
        <span className="font-tabular font-medium text-slate-700 whitespace-nowrap text-xs">
          {pts} point
        </span>
      ),
    },
    ...members.map((mem) => {
      const eff = getMemberEffectiveShiftsForDay(mem, targetDate);
      const hasNextCa1 = eff.nextDayShifts.includes('ca1');
      const isAvailableForCycle = isMemberAvailableForCapCycle(mem, targetDate);
      return {
        title: (
          <div className="text-center leading-tight">
            <div className="font-semibold text-slate-900 whitespace-nowrap text-xs">
              {mem.name}
              {mem.isNew ? <span className="text-[10px] font-normal text-amber-600 ml-0.5">(Mới)</span> : null}
            </div>
            <div className="text-[10px] font-normal text-slate-500 whitespace-nowrap mt-0.5">
              {todayLabel}: {formatShiftShort(eff.todayShifts)}
            </div>
            <div className={`text-[10px] font-normal whitespace-nowrap ${hasNextCa1 ? 'text-blue-600' : 'text-slate-400'}`}>
              {nextDayLabel}: {hasNextCa1 ? 'Ca1' : formatShiftShort(eff.nextDayShifts)}
            </div>
            {!isAvailableForCycle && mem.active !== false && (
              <div className="text-[10px] font-semibold text-red-500 whitespace-nowrap">
                Không chia CAP
              </div>
            )}
          </div>
        ),
        key: mem.id,
        align: 'center',
        width: 108,
        render: (_, offer) => {
          const baseEligibleList = getEligibleMembersForCampaign(offer, members, targetDate, {
            useShiftMatching: false,
          });
          const isBaseEligible = mem.active !== false && baseEligibleList.some((m) => m.id === mem.id);
          const cellVal = matrix[offer.id]?.[mem.id] ?? 0;
          const isLocked = Boolean(lockedCells?.[offer.id]?.[mem.id]);
          const isShiftAutoExcluded =
            isBaseEligible &&
            settings.useShiftMatching !== false &&
            isEveningOnlyOffer(offer) &&
            !isMemberCa3Worker(mem, targetDate) &&
            baseEligibleList.some((m) => isMemberCa3Worker(m, targetDate));

          if (!isBaseEligible && cellVal === 0 && !isLocked) {
            const reason = !mem.active
              ? 'Thành viên tạm nghỉ'
              : !isAvailableForCycle
                ? 'Nghỉ Ca 2, 3 hôm nay & Ca 1 sáng mai (không chia CAP)'
                : 'Không thuộc điều kiện offer';
            return (
              <Tooltip title={reason}>
                <span className="text-xs text-slate-300 font-tabular select-none">—</span>
              </Tooltip>
            );
          }

          if (!canEdit) {
            return (
              <span className={`font-tabular ${cellVal > 0 ? 'font-semibold text-slate-900' : 'text-slate-300'}`}>
                {cellVal}
              </span>
            );
          }

          const cellEditor = (
            <div
              className={`inline-flex items-center justify-center gap-1 rounded-md px-1 py-0.5 transition-colors ${
                isLocked
                  ? 'bg-amber-50 border border-amber-300'
                  : isShiftAutoExcluded && cellVal === 0
                    ? 'bg-slate-50/70 border border-dashed border-slate-200'
                    : ''
              }`}
            >
              <InputNumber
                min={0}
                max={999}
                precision={0}
                value={cellVal}
                aria-label={`CAP của ${mem.name} cho offer ${offer.code}`}
                onChange={(nextVal) => onCellChange(offer.id, mem.id, nextVal ?? 0)}
                className="w-12 cap-matrix-cell-input"
                size="small"
              />
              <button
                type="button"
                onClick={() => onToggleLockCell && onToggleLockCell(offer.id, mem.id)}
                aria-pressed={isLocked}
                aria-label={`${isLocked ? 'Mở khóa' : 'Ghim'} CAP của ${mem.name} cho offer ${offer.code}`}
                title={
                  isLocked
                    ? 'Đang ghim ô này (giữ nguyên khi chia tự động / xác nhận tăng ca). Bấm để mở khóa.'
                    : 'Ghim cố định số CAP ô này trước khi tự động chia'
                }
                className={`p-1 rounded transition-colors cursor-pointer shrink-0 ${
                  isLocked
                    ? 'text-amber-700 hover:bg-amber-100'
                    : 'text-slate-400 hover:text-[#2563EB] hover:bg-slate-100'
                }`}
              >
                {isLocked ? (
                  <Lock className="w-3.5 h-3.5" aria-hidden="true" />
                ) : (
                  <Unlock className="w-3.5 h-3.5" aria-hidden="true" />
                )}
              </button>
            </div>
          );

          if (isShiftAutoExcluded && !isLocked && cellVal === 0) {
            return (
              <Tooltip title="Nghỉ Ca 3 hôm nay (máy tự chia 0 CAP tối; vẫn mở ô để Leader chỉnh tay nếu tăng ca)">
                {cellEditor}
              </Tooltip>
            );
          }

          return cellEditor;
        },
      };
    }),
  ];

  return (
    <div className="flex flex-col gap-5">
      {!canEdit && (
        <Alert
          type="info"
          showIcon
          title={`Bạn đang xem ${activeGroup?.name || 'nhóm này'} ở chế độ người xem`}
          description={
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs sm:text-sm">
              <span>
                Chỉ tài khoản Leader của {activeGroup?.name} mới có quyền chạy tự động chia CAP và chỉnh sửa số CAP trực tiếp.
              </span>
              <Button size="small" type="primary" icon={<KeyRound className="w-3.5 h-3.5" />} onClick={onOpenLogin}>
                Đăng nhập Leader
              </Button>
            </div>
          }
        />
      )}

      {/* Algorithm Configuration & Actions Bar */}
      <section className="cap-card p-4 sm:p-5">
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[repeat(5,minmax(0,1fr))_auto] gap-3 items-end">
            <div>
              <label htmlFor="cfg-dist-date" className="block text-xs font-medium text-slate-600 mb-1.5 whitespace-nowrap">
                Ngày chia CAP
              </label>
              <Input
                id="cfg-dist-date"
                type="date"
                value={targetDate}
                onChange={(e) => e.target.value && onChangeDistributionDate(e.target.value)}
                prefix={<Calendar className="w-3.5 h-3.5 text-slate-400" />}
              />
            </div>

            <div>
              <label htmlFor="cfg-leader-priority" className="block text-xs font-medium text-slate-600 mb-1.5 whitespace-nowrap">
                Ưu tiên nhóm trưởng
              </label>
              <Select
                id="cfg-leader-priority"
                disabled={!canEdit}
                value={settings.leaderPriority}
                onChange={(val) => onUpdateSettings({ ...settings, leaderPriority: val })}
                className="w-full"
                options={[
                  { value: 'normal', label: 'Bình thường' },
                  { value: 'low', label: 'Thấp' },
                  { value: 'medium', label: 'Vừa (Mặc định)' },
                  { value: 'high', label: 'Cao' },
                ]}
              />
            </div>

            <div>
              <label htmlFor="cfg-new-member" className="block text-xs font-medium text-slate-600 mb-1.5 whitespace-nowrap">
                Thành viên mới
              </label>
              <Select
                id="cfg-new-member"
                disabled={!canEdit}
                value={settings.newMemberMode}
                onChange={(val) => onUpdateSettings({ ...settings, newMemberMode: val })}
                className="w-full"
                options={[
                  { value: 'less', label: 'Ít hơn' },
                  { value: 'normal', label: 'Bình thường' },
                ]}
              />
            </div>

            <div>
              <label htmlFor="cfg-cap-balance" className="block text-xs font-medium text-slate-600 mb-1.5 whitespace-nowrap">
                Cân bằng CAP
              </label>
              <Select
                id="cfg-cap-balance"
                disabled={!canEdit}
                value={settings.capBalanceLevel}
                onChange={(val) => onUpdateSettings({ ...settings, capBalanceLevel: val })}
                className="w-full"
                options={[
                  { value: 'high', label: 'Cao' },
                  { value: 'medium', label: 'Trung bình' },
                ]}
              />
            </div>

            <div>
              <label htmlFor="cfg-point-balance" className="block text-xs font-medium text-slate-600 mb-1.5 whitespace-nowrap">
                Cân bằng điểm
              </label>
              <Select
                id="cfg-point-balance"
                disabled={!canEdit}
                value={settings.pointBalanceLevel}
                onChange={(val) => onUpdateSettings({ ...settings, pointBalanceLevel: val })}
                className="w-full"
                options={[
                  { value: 'high', label: 'Cao' },
                  { value: 'medium', label: 'Trung bình' },
                ]}
              />
            </div>

            <div className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg bg-slate-50 border border-slate-200 h-8">
              <span className="text-xs font-medium text-slate-700 whitespace-nowrap">
                Theo ca &amp; giờ CAP chung
              </span>
              <Switch
                size="small"
                disabled={!canEdit}
                checked={settings.useShiftMatching !== false}
                aria-label="Bật chia theo ca làm và giờ CAP chung"
                onChange={(checked) => onUpdateSettings({ ...settings, useShiftMatching: checked })}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="primary"
                size="large"
                disabled={!canEdit}
                icon={<Sparkles className="w-4 h-4" />}
                onClick={onAutoDistribute}
                className="font-semibold whitespace-nowrap"
              >
                TỰ ĐỘNG CHIA CAP
              </Button>
              <Button
                size="large"
                disabled={!canEdit}
                icon={<RefreshCw className="w-4 h-4" />}
                onClick={onRedistributeVariant}
                className="whitespace-nowrap"
              >
                Chia lại
              </Button>
              <Button
                size="large"
                icon={<RotateCcw className="w-4 h-4" />}
                onClick={onRestoreAuto}
                disabled={!canEdit || !hasAutoBackup}
                className="whitespace-nowrap"
              >
                Khôi phục tự động
              </Button>
              {canEdit && lockedCount > 0 && (
                <>
                  <Button
                    size="large"
                    icon={<Unlock className="w-4 h-4" />}
                    onClick={onUnlockAllCells}
                    className="whitespace-nowrap"
                  >
                    Mở khóa ({lockedCount} ô)
                  </Button>
                </>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2.5 text-xs text-slate-600">
              <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                <Switch
                  size="small"
                  disabled={!canEdit}
                  checked={Boolean(settings.useRolloverFairness)}
                  aria-label="Bù chênh lệch điểm từ lần chia gần nhất"
                  onChange={(checked) => onUpdateSettings({ ...settings, useRolloverFairness: checked })}
                />
                <span className="font-medium text-slate-700 whitespace-nowrap">
                  Bù lệch điểm ngày trước
                </span>
              </label>
              {settings.useRolloverFairness && (
                <span className="text-xs text-[#2563EB] font-tabular whitespace-nowrap">
                  {rolloverInfo?.sourceDate
                    ? `(Nguồn: ${rolloverInfo.sourceDate})`
                    : `(Chưa có lịch sử trước ${targetDate})`}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Alternative Candidate Switcher */}
        {canEdit && alternatives && alternatives.length > 1 && (
          <div className="mt-4 pt-3 border-t border-slate-100 flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-slate-500">Phương án gợi ý:</span>
            {alternatives.map((alt, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => onSelectAlternative(alt.matrix)}
                className="px-3 py-1.5 rounded-md text-xs font-medium border border-slate-200 bg-slate-50 hover:bg-blue-50 hover:border-blue-300 text-slate-700 transition-colors cursor-pointer font-tabular"
              >
                Phương án {idx + 1} · Lệch CAP: {alt.stats.capSpread} · Lệch điểm: {alt.stats.pointSpread} point
              </button>
            ))}
          </div>
        )}

        {/* AI Assistant Bar (Natural-Language Adjustment & 7-Day Fairness Audit) */}
        {canEdit && (
          <div className="mt-4 pt-4 border-t border-slate-100 flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-800">
                <Bot className="w-4 h-4 text-[#2563EB]" aria-hidden="true" />
                Trợ lý AI Chia CAP (Giữ nguyên các ô đã ghim)
              </div>
              <Button
                size="small"
                icon={<ShieldCheck className="w-3.5 h-3.5" />}
                loading={aiAuditLoading}
                onClick={handleRunAiAudit}
              >
                AI Kiểm tra bảng chia
              </Button>
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                onPressEnter={() => handleRunAiCommand()}
                placeholder='Nhập yêu cầu tiếng Việt, vd: "Không chia offer 23h cho Huy Bảo, ưu tiên bù thêm điểm cho Trọng"'
                aria-label="Yêu cầu AI điều chỉnh bảng chia CAP"
                disabled={aiCommandLoading}
              />
              <Button
                type="primary"
                icon={<Wand2 className="w-4 h-4" />}
                loading={aiCommandLoading}
                onClick={() => handleRunAiCommand()}
                className="shrink-0 whitespace-nowrap"
              >
                AI Áp dụng
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-slate-400 mr-1">Gợi ý nhanh:</span>
              {[
                'Chuyển 1 CAP từ người nhiều nhất sang người ít nhất',
                'Không chia 23h cho thành viên nghỉ Ca 3',
                'Bù thêm CAP cho thành viên ít điểm nhất rồi chia đều lại',
              ].map((sample) => (
                <button
                  key={sample}
                  type="button"
                  onClick={() => setAiPrompt(sample)}
                  className="px-2 py-0.5 rounded border border-slate-200 bg-slate-50 hover:bg-blue-50 hover:border-blue-300 text-[11px] text-slate-600 transition-colors cursor-pointer"
                >
                  {sample}
                </button>
              ))}
            </div>

            {aiCommandError && (
              <Alert
                type="error"
                showIcon
                closable
                onClose={() => setAiCommandError('')}
                title={aiCommandError}
              />
            )}

            {aiCommandSummary && (
              <Alert
                type="success"
                showIcon
                closable
                onClose={() => {
                  setAiCommandSummary('');
                  setAiMemberDiffs([]);
                }}
                title={`AI đã điều chỉnh: ${aiCommandSummary}`}
                description={
                  aiMemberDiffs.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {aiMemberDiffs.map((d) => (
                        <span
                          key={d.memberId}
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-tabular ${
                            d.deltaCap > 0
                              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                              : d.deltaCap < 0
                              ? 'bg-amber-50 border-amber-200 text-amber-800'
                              : 'bg-slate-50 border-slate-200 text-slate-700'
                          }`}
                        >
                          <strong>{d.name}:</strong>
                          <span>
                            {d.prevCap}→{d.nextCap} CAP ({d.deltaCap >= 0 ? `+${d.deltaCap}` : d.deltaCap})
                          </span>
                          {d.deltaPoints !== 0 && (
                            <span className="text-slate-500">
                              · {d.deltaPoints >= 0 ? `+${d.deltaPoints}` : d.deltaPoints}đ
                            </span>
                          )}
                        </span>
                      ))}
                    </div>
                  ) : undefined
                }
              />
            )}

            {aiAuditError && (
              <Alert
                type="error"
                showIcon
                closable
                onClose={() => setAiAuditError('')}
                title={aiAuditError}
              />
            )}

            {aiAuditResult && (
              <div className="rounded-xl border border-blue-200 bg-[#EFF6FF]/60 p-3.5 sm:p-4 flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-bold font-tabular bg-[#2563EB] text-white">
                      Điểm công bằng: {aiAuditResult.overallScore}/100
                    </span>
                    <span className="text-xs sm:text-sm font-semibold text-slate-900">
                      {aiAuditResult.headline}
                    </span>
                  </div>
                  <Button size="small" type="text" onClick={() => setAiAuditResult(null)}>
                    Đóng
                  </Button>
                </div>

                {Array.isArray(aiAuditResult.findings) && aiAuditResult.findings.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    {aiAuditResult.findings.map((f, idx) => {
                      const badgeCls =
                        f.severity === 'high'
                          ? 'bg-red-100 text-red-700 border-red-200'
                          : f.severity === 'medium'
                          ? 'bg-amber-100 text-amber-800 border-amber-200'
                          : 'bg-slate-100 text-slate-700 border-slate-200';
                      return (
                        <div
                          key={idx}
                          className="flex flex-wrap items-start gap-2 text-xs text-slate-700 bg-white rounded-lg border border-slate-200 px-3 py-2"
                        >
                          <span className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold uppercase shrink-0 ${badgeCls}`}>
                            {f.severity === 'high' ? 'Cao' : f.severity === 'medium' ? 'Lưu ý' : 'Nhẹ'}
                          </span>
                          {f.memberName && (
                            <strong className="text-slate-900 shrink-0">{f.memberName}:</strong>
                          )}
                          <span className="flex-1 min-w-[180px]">{f.detail}</span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {Array.isArray(aiAuditResult.recommendations) && aiAuditResult.recommendations.length > 0 && (
                  <ul className="m-0 pl-4 text-xs text-slate-600 flex flex-col gap-1">
                    {aiAuditResult.recommendations.map((rec, idx) => (
                      <li key={idx}>{rec}</li>
                    ))}
                  </ul>
                )}

                {hasSuggestedAction && (
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-blue-200">
                    <span className="text-xs text-slate-700">
                      <strong>Đề xuất áp dụng:</strong> {aiAuditResult.suggestedDirectives?.summary}
                    </span>
                    <Button
                      type="primary"
                      size="small"
                      icon={<Wand2 className="w-3.5 h-3.5" />}
                      onClick={handleApplyAuditSuggestion}
                    >
                      Áp dụng đề xuất AI (1 lần bấm)
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Validation Status Alert */}
      {!stats.isAllValid ? (
        <Alert
          type="error"
          showIcon
          icon={<AlertTriangle className="w-4 h-4" />}
          title="Cảnh báo sai lệch số lượng CAP offer"
          description={
            <div className="text-xs sm:text-sm">
              Các offer sau có tổng CAP phân bổ chưa khớp:{' '}
              {stats.invalidCampaigns
                .map(
                  (c) =>
                    `ID ${c.code} (đã chia ${c.assignedCap}/${c.targetCap}, ${
                      c.diff > 0 ? `vượt +${c.diff}` : `thiếu ${Math.abs(c.diff)}`
                    })`
                )
                .join('; ')}
              . Hãy điều chỉnh lại ô hoặc nhấn "Khôi phục tự động".
            </div>
          }
        />
      ) : (
        <Alert
          type="success"
          showIcon
          icon={<CheckCircle2 className="w-4 h-4" />}
          title={
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs sm:text-sm">
              <span>
                Đã phân chia khớp <strong className="font-tabular">{stats.assignedTotalCap}/{stats.expectedTotalCap} CAP</strong> và{' '}
                <strong className="font-tabular">{stats.assignedTotalPoints.toLocaleString('vi-VN')} point</strong>
                {' · '}Chênh lệch CAP: <strong className="font-tabular">{stats.capSpread}</strong>
                {' · '}Chênh lệch điểm: <strong className="font-tabular">{stats.pointSpread} point</strong>
              </span>
            </div>
          }
        />
      )}

      {canEdit && shiftConflicts.hasConflicts && (
        <Alert
          type="warning"
          showIcon
          title="Lịch ca làm vừa thay đổi so với bảng chia CAP hiện tại"
          description={
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs sm:text-sm">
              <span>
                {shiftConflicts.unavailableWithCap.length > 0 &&
                  `Có thành viên đang nghỉ chu kỳ nhưng vẫn giữ CAP (${shiftConflicts.unavailableWithCap.map((x) => `${x.name}: ${x.cap}`).join(', ')}). `}
                {shiftConflicts.nonCa3OnEvening.length > 0 &&
                  `Có thành viên nghỉ Ca 3 hôm nay nhưng đang giữ offer 20h+ (${shiftConflicts.nonCa3OnEvening.slice(0, 3).map((x) => `${x.name} - ${x.offerCode}`).join(', ')}). Nếu tự bù tăng ca, hãy bấm biểu tượng Ghim trên ô đó để giữ nguyên.`}
              </span>
              <Button size="small" type="primary" onClick={onAutoDistribute}>
                Chia lại cho khớp ca
              </Button>
            </div>
          }
        />
      )}

      {/* Distribution Matrix Table */}
      <section className="cap-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-slate-900 m-0">
              Bảng kết quả phân chia CAP ({todayLabel}) – {activeGroup?.name}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5 mb-0">
              10h, 21h30, 23h là giờ CAP chung. Thành viên làm nhiều ca trong chu kỳ (Ca 2, 3 hôm nay + Ca 1 {nextDayLabel}) được ưu tiên chia đều nhiều CAP & điểm; thành viên chỉ làm 1 ca trong chu kỳ được chia ít lại (ô tối vẫn mở sẵn để Leader chỉnh tay nếu tăng ca).
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              {!savedForTargetDate ? (
                <span className="inline-flex items-center gap-1.5 font-medium text-amber-700">
                  <Clock className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  Bản nháp ngày {todayLabel} chưa lưu — bấm &quot;Lưu bảng chia CAP&quot; để lưu vào lịch sử và hiển thị bên Dashboard.
                </span>
              ) : hasUnsavedChanges ? (
                <span className="inline-flex items-center gap-1.5 font-medium text-amber-700">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  Đang có thay đổi mới chưa lưu — bấm &quot;Lưu bảng chia CAP&quot; để cập nhật lịch sử và Dashboard.
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  Đã lưu vào lịch sử &amp; hiển thị bên Dashboard lúc{' '}
                  {new Date(savedForTargetDate.savedAt).toLocaleTimeString('vi-VN', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  .
                </span>
              )}

              {settings.telegramEnabled && (
                <span
                  className={`inline-flex items-center gap-1 font-medium ${
                    isTelegramDeliveredForCurrentMatrix ? 'text-emerald-700' : 'text-amber-700'
                  }`}
                >
                  <Send className="w-3 h-3 shrink-0" aria-hidden="true" />
                  {!telegramConfigured
                    ? 'Telegram chưa đủ Bot/Chat ID'
                    : isTelegramDeliveredForCurrentMatrix
                    ? `Đã gửi Telegram${
                        telegramSentAtForCurrentDate
                          ? ` lúc ${new Date(telegramSentAtForCurrentDate).toLocaleTimeString('vi-VN', {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}`
                          : ''
                      }`
                    : 'Chưa gửi Telegram cho bản này'}
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {canEdit && (
              <>
                <Button
                  type="primary"
                  icon={<Save className="w-4 h-4" />}
                  loading={isPublishing}
                  disabled={isPublishing}
                  onClick={() => onPublishDistribution && onPublishDistribution(targetDate)}
                  className="font-semibold whitespace-nowrap"
                >
                  Lưu bảng chia CAP
                </Button>
                {settings.telegramEnabled && onResendTelegram && (
                  <Button
                    icon={<Send className="w-3.5 h-3.5" />}
                    loading={isPublishing}
                    disabled={isPublishing}
                    onClick={onResendTelegram}
                    className="whitespace-nowrap"
                  >
                    {isTelegramDeliveredForCurrentMatrix ? 'Gửi lại Telegram' : 'Gửi lên Telegram'}
                  </Button>
                )}
                <Button
                  disabled={isPublishing}
                  onClick={() => {
                    setSaveDate(targetDate);
                    setSaveModalOpen(true);
                  }}
                  className="whitespace-nowrap"
                >
                  Lưu kèm ghi chú
                </Button>
              </>
            )}
            <Button
              type="primary"
              ghost
              icon={<FileSpreadsheet className="w-4 h-4" />}
              onClick={onExportExcel}
            >
              Xuất Excel
            </Button>
          </div>
        </div>

        <Table
          dataSource={sortedOffers}
          columns={columns}
          rowKey="id"
          pagination={false}
          size="small"
          bordered
          scroll={{ x: Math.max(990, 600 + members.length * 112) }}
          locale={{
            emptyText:
              'Hiện không có offer nào đang bật để chia CAP (các offer có thể đang được ẩn bên Quản lý offer).',
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
                  <span className={stats.assignedTotalCap === stats.expectedTotalCap ? 'text-[#0F172A]' : 'text-red-600'}>
                    {stats.assignedTotalCap}
                  </span>
                  <span className="text-slate-500 font-normal"> / {stats.expectedTotalCap}</span>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={4} align="right" className="font-tabular text-slate-500">
                  -
                </Table.Summary.Cell>
                {members.map((mem, idx) => {
                  const mStat = stats.memberTotalsMap[mem.id];
                  return (
                    <Table.Summary.Cell key={mem.id} index={5 + idx} align="center" className="font-tabular font-bold text-[#0F172A]">
                      {mStat ? mStat.totalCap : 0}
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
                  {stats.assignedTotalPoints.toLocaleString('vi-VN')} point
                </Table.Summary.Cell>
                <Table.Summary.Cell index={4} align="right" className="font-tabular text-slate-500">
                  -
                </Table.Summary.Cell>
                {members.map((mem, idx) => {
                  const mStat = stats.memberTotalsMap[mem.id];
                  return (
                    <Table.Summary.Cell key={mem.id} index={5 + idx} align="center" className="font-tabular font-semibold text-[#2563EB] whitespace-nowrap">
                      {(mStat ? mStat.totalPoints : 0).toLocaleString('vi-VN')} point
                    </Table.Summary.Cell>
                  );
                })}
              </Table.Summary.Row>
            </Table.Summary>
          )}
        />
      </section>

      {/* Save History Modal */}
      <Modal
        title="Lưu kết quả chia CAP vào lịch sử"
        open={saveModalOpen}
        onCancel={() => setSaveModalOpen(false)}
        footer={
          existingSameDay
            ? [
                <Button key="cancel" onClick={() => setSaveModalOpen(false)}>
                  Hủy
                </Button>,
                <Button key="new" onClick={() => handleConfirmSave(null)}>
                  Lưu thêm bản mới
                </Button>,
                <Button
                  key="overwrite"
                  type="primary"
                  onClick={() => handleConfirmSave(existingSameDay.id)}
                >
                  Ghi đè bản ngày này
                </Button>,
              ]
            : [
                <Button key="cancel" onClick={() => setSaveModalOpen(false)}>
                  Hủy
                </Button>,
                <Button key="save" type="primary" onClick={() => handleConfirmSave(null)}>
                  Lưu kết quả
                </Button>,
              ]
        }
      >
        <div className="flex flex-col gap-4 py-2">
          <div>
            <label htmlFor="history-save-date" className="block text-sm font-medium text-slate-700 mb-1">
              Ngày thực hiện
            </label>
            <Input
              id="history-save-date"
              type="date"
              value={saveDate}
              onChange={(e) => setSaveDate(e.target.value)}
            />
          </div>

          {existingSameDay && (
            <Alert
              type="warning"
              showIcon
              title={`Đã có bản lưu lịch sử cho ngày ${saveDate}`}
              description={
                <span className="text-xs">
                  Bản trước đó lưu lúc{' '}
                  <strong className="font-tabular">
                    {new Date(existingSameDay.savedAt).toLocaleTimeString('vi-VN', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </strong>{' '}
                  ({existingSameDay.stats?.assignedTotalCap ?? 0} CAP
                  {existingSameDay.note ? ` · "${existingSameDay.note}"` : ''}). Bạn có thể ghi đè bản cũ để tránh trùng hoặc lưu thêm bản mới.
                </span>
              }
            />
          )}

          <div>
            <label htmlFor="history-save-note" className="block text-sm font-medium text-slate-700 mb-1">
              Ghi chú (không bắt buộc)
            </label>
            <Input
              id="history-save-note"
              placeholder="Ví dụ: Chia ca tối ngày 20/11"
              value={saveNote}
              onChange={(e) => setSaveNote(e.target.value)}
            />
          </div>
          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-600 font-tabular">
            Tổng offer: {sortedOffers.length} · Tổng CAP: {stats.assignedTotalCap}/{stats.expectedTotalCap} · Tổng điểm: {stats.assignedTotalPoints.toLocaleString('vi-VN')} point
          </div>
        </div>
      </Modal>
    </div>
  );
}
