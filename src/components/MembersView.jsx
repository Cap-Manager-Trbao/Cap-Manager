import React, { Suspense, lazy, useEffect, useState } from 'react';
import {
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Switch,
  Table,
} from 'antd';
import {
  UserPlus,
  Pencil,
  Trash2,
  Clock,
  KeyRound,
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Lock,
  Users,
  UserCheck,
  CopyCheck,
  History,
  FileSpreadsheet,
} from 'lucide-react';
import { SHIFTS } from '../data/defaultData.js';

const ShiftScheduleImportModal = lazy(() => import('./ShiftScheduleImportModal.jsx'));
import { getMemberShiftsOnDate } from '../utils/capAlgorithm.js';
import {
  addDaysToIso,
  createId,
  formatCalendarDateHeader,
  getDateRange,
  getTodayDateString,
  loadFromStorage,
  saveToStorage,
} from '../utils/storage.js';
import { normalizeTelegramUsername } from '../utils/telegramCommands.js';

export default function MembersView({
  activeGroup,
  canEdit,
  onOpenLogin,
  members,
  onAddMember,
  onUpdateMember,
  onUpdateMemberDateShifts,
  onUpdateMemberMultiDateShifts,
  onBatchImportShiftSchedule,
  onDeleteMember,
  onNotify,
}) {
  const todayStr = getTodayDateString();
  const [leaderSubView, setLeaderSubView] = useState('schedule');
  const [scheduleStartDate, setScheduleStartDate] = useState(todayStr);
  const [modalOpen, setModalOpen] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [editingMember, setEditingMember] = useState(null);
  const [bulkShifts, setBulkShifts] = useState(['ca1', 'ca2', 'ca3']);
  const [bulkLeaderTargetId, setBulkLeaderTargetId] = useState(() => members[0]?.id || null);
  const [form] = Form.useForm();

  const viewerStorageKey = `cap_manager_viewer_member_${activeGroup?.id || 'default'}`;
  const [selectedViewerMemberId, setSelectedViewerMemberId] = useState(() => {
    const saved = loadFromStorage(viewerStorageKey, null);
    if (saved && members.some((m) => m.id === saved)) return saved;
    const nonLeader = members.find((m) => !m.isLeader) || members[0];
    return nonLeader?.id || null;
  });

  useEffect(() => {
    const saved = loadFromStorage(viewerStorageKey, null);
    if (saved && members.some((m) => m.id === saved)) {
      setSelectedViewerMemberId(saved);
    } else if (!members.some((m) => m.id === selectedViewerMemberId)) {
      const nonLeader = members.find((m) => !m.isLeader) || members[0];
      setSelectedViewerMemberId(nonLeader?.id || null);
    }
    if (!members.some((m) => m.id === bulkLeaderTargetId)) {
      setBulkLeaderTargetId(members[0]?.id || null);
    }
  }, [activeGroup?.id, members]);

  const handleSelectViewerMember = (memId) => {
    setSelectedViewerMemberId(memId);
    saveToStorage(viewerStorageKey, memId);
  };

  const openAddModal = () => {
    setEditingMember(null);
    form.resetFields();
    form.setFieldsValue({
      name: '',
      telegramUsername: '',
      isLeader: false,
      isNew: false,
      active: true,
      priority: 'normal',
      shifts: ['ca1', 'ca2', 'ca3'],
    });
    setModalOpen(true);
  };

  const openEditModal = (member) => {
    setEditingMember(member);
    form.resetFields();
    form.setFieldsValue({
      name: member.name,
      telegramUsername: member.telegramUsername || '',
      isLeader: Boolean(member.isLeader),
      isNew: Boolean(member.isNew),
      active: member.active !== false,
      priority: member.priority || 'normal',
      shifts: Array.isArray(member.shifts) && member.shifts.length > 0 ? member.shifts : ['ca1', 'ca2', 'ca3'],
    });
    setModalOpen(true);
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      const defaultShifts = Array.isArray(values.shifts) && values.shifts.length > 0 ? values.shifts : ['ca1'];
      const cleanTgUsername = normalizeTelegramUsername(values.telegramUsername);
      const payload = {
        name: values.name.trim(),
        telegramUsername: cleanTgUsername,
        isLeader: Boolean(values.isLeader),
        isNew: Boolean(values.isNew),
        active: Boolean(values.active),
        priority: values.priority || 'normal',
        shifts: defaultShifts,
        ...(editingMember?.telegramUserId ? { telegramUserId: editingMember.telegramUserId } : {}),
      };

      if (editingMember) {
        onUpdateMember({ ...editingMember, ...payload });
        onNotify('success', `Đã cập nhật thành viên ${payload.name}`);
      } else {
        const schedule = {};
        for (let offset = 0; offset <= 10; offset++) {
          schedule[addDaysToIso(todayStr, offset)] = [...defaultShifts];
        }
        onAddMember({ id: createId('mem'), ...payload, shiftSchedule: schedule });
        onNotify('success', `Đã thêm thành viên ${payload.name} vào ${activeGroup?.name}`);
      }
      setModalOpen(false);
    } catch {
      // inline validation
    }
  };

  const handleToggleDateShift = (member, dateStr, shiftId) => {
    const isPast = dateStr < todayStr;
    if (!canEdit) {
      if (member.id !== selectedViewerMemberId) {
        onNotify('warning', 'Bạn chỉ có thể chỉnh sửa ca làm của chính mình.');
        return;
      }
      if (isPast) {
        onNotify('warning', 'Không thể chỉnh sửa ca làm của ngày đã qua.');
        return;
      }
    }

    const current = getMemberShiftsOnDate(member, dateStr);
    const exists = current.includes(shiftId);
    let next;
    if (exists) {
      next = current.filter((s) => s !== shiftId);
    } else {
      next = [...current, shiftId];
      next.sort((a, b) => a.localeCompare(b));
    }
    onUpdateMemberDateShifts(member.id, dateStr, next);
  };

  const visibleDates = getDateRange(scheduleStartDate, 6);
  const tomorrowStr = addDaysToIso(todayStr, 1);
  const selectedViewerMember = members.find((m) => m.id === selectedViewerMemberId) || null;
  const bulkTargetMember = canEdit
    ? members.find((m) => m.id === bulkLeaderTargetId) || members[0] || null
    : selectedViewerMember;

  const getBulkStartDate = () => {
    if (!canEdit && scheduleStartDate < todayStr) return todayStr;
    return scheduleStartDate;
  };

  const handleToggleBulkShift = (shiftId) => {
    setBulkShifts((prev) => {
      if (prev.includes(shiftId)) {
        return prev.filter((id) => id !== shiftId);
      }
      return [...prev, shiftId].sort((a, b) => a.localeCompare(b));
    });
  };

  const handleApplyBulk7Days = async (shiftsToApply) => {
    if (!bulkTargetMember) return;
    const startDate = getBulkStartDate();
    const dates = getDateRange(startDate, 7);
    const dateShiftsMap = {};
    for (const d of dates) {
      dateShiftsMap[d] = [...shiftsToApply];
    }
    if (onUpdateMemberMultiDateShifts) {
      await onUpdateMemberMultiDateShifts(bulkTargetMember.id, dateShiftsMap);
    } else {
      for (const d of dates) {
        await onUpdateMemberDateShifts(bulkTargetMember.id, d, [...shiftsToApply]);
      }
    }
    const label =
      shiftsToApply.length === 0
        ? 'Nghỉ cả 7 ngày'
        : shiftsToApply.map((id) => SHIFTS.find((s) => s.id === id)?.label || id).join(', ');
    const endDate = dates[dates.length - 1];
    onNotify(
      'success',
      `Đã áp dụng "${label}" cho 7 ngày (${formatCalendarDateHeader(dates[0]).shortDate} - ${formatCalendarDateHeader(endDate).shortDate}) của ${bulkTargetMember.name}.`
    );
  };

  const handleCopyPrevious7Days = async () => {
    if (!bulkTargetMember) return;
    const startDate = getBulkStartDate();
    const dates = getDateRange(startDate, 7);
    const dateShiftsMap = {};
    for (const d of dates) {
      const prevDate = addDaysToIso(d, -7);
      dateShiftsMap[d] = [...getMemberShiftsOnDate(bulkTargetMember, prevDate)];
    }
    if (onUpdateMemberMultiDateShifts) {
      await onUpdateMemberMultiDateShifts(bulkTargetMember.id, dateShiftsMap);
    } else {
      for (const [d, sh] of Object.entries(dateShiftsMap)) {
        await onUpdateMemberDateShifts(bulkTargetMember.id, d, sh);
      }
    }
    const endDate = dates[dates.length - 1];
    onNotify(
      'success',
      `Đã chép lịch 7 ngày trước sang ${formatCalendarDateHeader(dates[0]).shortDate} - ${formatCalendarDateHeader(endDate).shortDate} cho ${bulkTargetMember.name}.`
    );
  };

  const scheduleColumns = [
    {
      title: 'STT',
      key: 'stt',
      fixed: 'left',
      width: 52,
      align: 'center',
      render: (_, __, index) => (
        <span className="font-tabular text-xs font-semibold text-slate-600">{index + 1}</span>
      ),
    },
    {
      title: 'Họ và Tên',
      dataIndex: 'name',
      key: 'name',
      fixed: 'left',
      width: 175,
      render: (name, m) => {
        const isSelfViewer = !canEdit && m.id === selectedViewerMemberId;
        return (
          <div className="leading-snug py-0.5">
            <div className={`text-sm font-semibold ${isSelfViewer ? 'text-[#1D4ED8]' : 'text-slate-900'}`}>
              {name}
              {isSelfViewer && <span className="ml-1.5 text-xs font-bold text-[#2563EB]">(Tôi)</span>}
            </div>
            <div className="text-xs text-slate-500">
              {m.isLeader ? 'Nhóm trưởng' : m.isNew ? 'TV mới' : 'Thành viên'}
              {m.active === false ? ' · Nghỉ' : ''}
              {m.telegramUsername ? ` · @${m.telegramUsername}` : ''}
            </div>
          </div>
        );
      },
    },
    ...visibleDates.map((dateStr) => {
      const { shortDate, weekday } = formatCalendarDateHeader(dateStr);
      const isToday = dateStr === todayStr;
      const isTomorrow = dateStr === tomorrowStr;
      const isPast = dateStr < todayStr;
      return {
        title: (
          <div className={`text-center leading-tight py-0.5 rounded ${isToday ? 'text-[#1D4ED8]' : 'text-slate-900'}`}>
            <div className="text-xs font-bold font-tabular">
              {shortDate}
              {isToday && <span className="ml-1 text-[11px] font-bold text-[#2563EB]">(Nay)</span>}
              {isTomorrow && <span className="ml-1 text-[11px] font-semibold text-slate-600">(Mai)</span>}
            </div>
          </div>
        ),
        key: `col-group-${dateStr}`,
        children: [
          {
            title: (
              <div className={`text-center text-xs font-medium ${isToday ? 'text-[#1D4ED8]' : isPast ? 'text-slate-400' : 'text-slate-600'}`}>
                {weekday}
              </div>
            ),
            key: `col-${dateStr}`,
            align: 'center',
            width: 158,
            onCell: () => ({
              className: isToday ? 'bg-blue-50/35' : '',
            }),
            render: (_, mem) => {
              const selectedShifts = getMemberShiftsOnDate(mem, dateStr);
              const isRowEditable = canEdit || (mem.id === selectedViewerMemberId && !isPast);

              if (!isRowEditable) {
                return (
                  <div className="flex flex-wrap items-center justify-center gap-1.5 py-1">
                    {selectedShifts.length > 0 ? (
                      selectedShifts.map((shiftId) => {
                        const info = SHIFTS.find((s) => s.id === shiftId);
                        return (
                          <span
                            key={shiftId}
                            className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 text-xs font-medium font-tabular select-none"
                          >
                            {info?.label || shiftId}
                          </span>
                        );
                      })
                    ) : (
                      <span className="text-xs font-medium text-slate-400">Nghỉ</span>
                    )}
                  </div>
                );
              }

              return (
                <div className="flex items-center justify-center gap-1.5 py-0.5">
                  {SHIFTS.map((shift) => {
                    const active = selectedShifts.includes(shift.id);
                    return (
                      <button
                        key={shift.id}
                        type="button"
                        onClick={() => handleToggleDateShift(mem, dateStr, shift.id)}
                        title={`${mem.name} (${shortDate}): ${shift.shortLabel}`}
                        aria-pressed={active}
                        className={`px-2.5 py-1 rounded-md text-xs font-semibold border transition-colors cursor-pointer font-tabular whitespace-nowrap ${
                          active
                            ? 'bg-[#2563EB] text-white border-[#2563EB] shadow-xs hover:bg-[#1D4ED8]'
                            : 'bg-white text-slate-600 border-slate-300 hover:border-[#2563EB] hover:text-[#2563EB]'
                        }`}
                      >
                        {shift.label}
                      </button>
                    );
                  })}
                </div>
              );
            },
          },
        ],
      };
    }),
  ];

  const memberCrudColumns = [
    {
      title: 'STT',
      key: 'stt',
      width: 60,
      align: 'center',
      render: (_, __, idx) => <span className="font-tabular text-sm font-medium text-slate-600">{idx + 1}</span>,
    },
    {
      title: 'Họ và Tên',
      dataIndex: 'name',
      key: 'name',
      minWidth: 190,
      render: (name, m) => (
        <div className="py-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold text-slate-900">{name}</span>
            {m.telegramUserId && (
              <span className="px-1.5 py-0.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-700 text-[10px] font-semibold whitespace-nowrap">
                Đã liên kết Bot
              </span>
            )}
          </div>
          <div className="text-xs text-slate-500">
            {m.isLeader ? 'Nhóm trưởng' : m.isNew ? 'Thành viên mới' : 'Thành viên chính thức'}
            {m.telegramUsername ? ` · @${m.telegramUsername}` : ''}
          </div>
        </div>
      ),
    },
    {
      title: 'Nhóm trưởng',
      dataIndex: 'isLeader',
      key: 'isLeader',
      align: 'center',
      width: 120,
      render: (isLeader, m) => (
        <Switch
          disabled={!canEdit}
          checked={Boolean(isLeader)}
          aria-label={`Đánh dấu nhóm trưởng cho ${m.name}`}
          onChange={(checked) => onUpdateMember({ ...m, isLeader: checked })}
        />
      ),
    },
    {
      title: 'TV mới',
      dataIndex: 'isNew',
      key: 'isNew',
      align: 'center',
      width: 100,
      render: (isNew, m) => (
        <Switch
          disabled={!canEdit}
          checked={Boolean(isNew)}
          aria-label={`Đánh dấu thành viên mới cho ${m.name}`}
          onChange={(checked) => onUpdateMember({ ...m, isNew: checked })}
        />
      ),
    },
    {
      title: 'Hoạt động',
      dataIndex: 'active',
      key: 'active',
      align: 'center',
      width: 105,
      render: (active, m) => (
        <Switch
          disabled={!canEdit}
          checked={active !== false}
          aria-label={`Bật tắt hoạt động cho ${m.name}`}
          onChange={(checked) => onUpdateMember({ ...m, active: checked })}
        />
      ),
    },
    {
      title: 'Ưu tiên CAP',
      dataIndex: 'priority',
      key: 'priority',
      width: 165,
      render: (priority, m) => (
        <Select
          disabled={!canEdit}
          value={priority || 'normal'}
          size="middle"
          className="w-36"
          aria-label={`Mức ưu tiên CAP cho ${m.name}`}
          onChange={(val) => onUpdateMember({ ...m, priority: val })}
          options={[
            { value: 'low', label: 'Thấp (-8%)' },
            { value: 'normal', label: 'Bình thường' },
            { value: 'high', label: 'Ưu tiên (+8%)' },
          ]}
        />
      ),
    },
    {
      title: 'Thao tác',
      key: 'actions',
      align: 'right',
      width: 105,
      render: (_, m) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            type="text"
            size="small"
            aria-label={`Sửa thành viên ${m.name}`}
            icon={<Pencil className="w-4 h-4 text-slate-600" />}
            onClick={() => openEditModal(m)}
          />
          <Popconfirm
            title="Xóa thành viên này?"
            description={`Xác nhận xóa ${m.name} khỏi ${activeGroup?.name}?`}
            okText="Xóa"
            cancelText="Hủy"
            okButtonProps={{ danger: true }}
            onConfirm={() => onDeleteMember(m.id)}
          >
            <Button
              type="text"
              size="small"
              danger
              aria-label={`Xóa thành viên ${m.name}`}
              icon={<Trash2 className="w-4 h-4" />}
            />
          </Popconfirm>
        </div>
      ),
    },
  ];

  const activeCount = members.filter((m) => m.active !== false).length;

  const scheduleTableCard = (
    <section className="cap-card p-4 sm:p-5 flex flex-col gap-4">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pb-3 border-b border-slate-100">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs sm:text-sm text-slate-700 font-tabular">
            <span className="inline-flex items-center gap-1.5 text-slate-900 font-semibold">
              <Clock className="w-4 h-4 text-[#2563EB]" aria-hidden="true" />
              Khung giờ ca:
            </span>
            {SHIFTS.map((s) => (
              <span key={s.id}>
                <strong className="text-slate-900">{s.label}:</strong> {s.timeRange}
              </span>
            ))}
          </div>
          <p className="text-xs text-slate-500 m-0">
            {canEdit
              ? 'Bấm trực tiếp Ca1 / Ca2 / Ca3 tại từng ngày để cập nhật lịch làm việc cho thành viên.'
              : 'Bấm trực tiếp Ca1 / Ca2 / Ca3 trên dòng có chữ (Tôi) để đăng ký hoặc chỉnh sửa ca từ hôm nay.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
          <Input
            type="month"
            size="middle"
            aria-label="Chọn tháng cần xem lịch"
            value={scheduleStartDate.slice(0, 7)}
            onChange={(e) => {
              const ym = e.target.value;
              if (/^\d{4}-\d{2}$/.test(ym)) {
                setScheduleStartDate(ym === todayStr.slice(0, 7) ? todayStr : `${ym}-01`);
              }
            }}
            className="w-36 font-tabular"
          />
          <Button
            size="middle"
            icon={<ChevronLeft className="w-4 h-4" />}
            onClick={() => setScheduleStartDate(addDaysToIso(scheduleStartDate, -6))}
          >
            6 ngày trước
          </Button>
          <Button
            size="middle"
            icon={<CalendarDays className="w-4 h-4" />}
            onClick={() => setScheduleStartDate(todayStr)}
          >
            Từ hôm nay
          </Button>
          <Button
            size="middle"
            onClick={() => setScheduleStartDate(addDaysToIso(scheduleStartDate, 6))}
          >
            6 ngày sau
            <ChevronRight className="w-4 h-4 inline ml-0.5" />
          </Button>
        </div>
      </div>

      {/* Bulk 7-Day Quick Shift Registration */}
      {bulkTargetMember && (
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-100 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-slate-700 whitespace-nowrap">
              Đăng ký nhanh 7 ngày:
            </span>
            {canEdit ? (
              <Select
                size="small"
                value={bulkTargetMember.id}
                onChange={setBulkLeaderTargetId}
                className="w-40"
                aria-label="Chọn thành viên để áp dụng ca hàng loạt"
                options={members.map((m) => ({ value: m.id, label: m.name }))}
              />
            ) : (
              <span className="font-semibold text-[#1D4ED8] whitespace-nowrap">
                {bulkTargetMember.name}
              </span>
            )}
            <div className="inline-flex items-center gap-1">
              {SHIFTS.map((shift) => {
                const active = bulkShifts.includes(shift.id);
                return (
                  <button
                    key={shift.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => handleToggleBulkShift(shift.id)}
                    className={`px-2 py-1 rounded border text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap font-tabular ${
                      active
                        ? 'bg-[#2563EB] text-white border-[#2563EB]'
                        : 'bg-white text-slate-600 border-slate-300 hover:border-[#2563EB]'
                    }`}
                  >
                    {shift.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="small"
              type="primary"
              icon={<CopyCheck className="w-3.5 h-3.5" />}
              onClick={() => handleApplyBulk7Days(bulkShifts)}
              className="whitespace-nowrap shrink-0"
            >
              Áp dụng 7 ngày
            </Button>
            <Button
              size="small"
              onClick={() => handleApplyBulk7Days([])}
              className="whitespace-nowrap shrink-0"
            >
              Nghỉ 7 ngày
            </Button>
            <Button
              size="small"
              icon={<History className="w-3.5 h-3.5" />}
              onClick={handleCopyPrevious7Days}
              className="whitespace-nowrap shrink-0"
            >
              Chép 7 ngày trước
            </Button>
          </div>
        </div>
      )}

      <Table
        dataSource={members}
        columns={scheduleColumns}
        rowKey="id"
        pagination={false}
        size="middle"
        bordered
        rowClassName={(mem) =>
          !canEdit && mem.id === selectedViewerMemberId ? 'bg-blue-50/75' : ''
        }
        scroll={{ x: Math.max(960, 227 + visibleDates.length * 158) }}
        locale={{ emptyText: 'Chưa có thành viên nào trong nhóm.' }}
      />

      {!canEdit && (
        <div className="flex items-center gap-2 text-xs text-slate-500 pt-1">
          <Lock className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
          <span>Các ngày đã qua và dòng của thành viên khác được khóa chỉ xem.</span>
        </div>
      )}
    </section>
  );

  // Viewer mode: Clear, high-contrast "Tôi là" member selector + editable shift table
  if (!canEdit) {
    return (
      <div className="flex flex-col gap-5">
        <section className="cap-card p-4 sm:p-5 flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-base sm:text-lg font-semibold text-slate-900 m-0">
                Quản lý ca làm – {activeGroup?.name}
              </h2>
              <p className="text-xs sm:text-sm text-slate-600 mt-1 mb-0">
                Chọn đúng tên của bạn ở bên dưới để tự bật/tắt ca làm từ hôm nay cho các ngày sắp tới.
              </p>
            </div>
            <Button
              type="default"
              icon={<KeyRound className="w-4 h-4" />}
              onClick={onOpenLogin}
              className="whitespace-nowrap shrink-0"
            >
              Đăng nhập Leader
            </Button>
          </div>

          <div className="pt-3 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 sm:gap-3">
              <label
                htmlFor="viewer-member-select"
                className="inline-flex items-center gap-2 text-sm font-semibold text-slate-900 whitespace-nowrap"
              >
                <UserCheck className="w-4 h-4 text-[#2563EB]" aria-hidden="true" />
                Tôi là:
              </label>
              <Select
                id="viewer-member-select"
                size="large"
                showSearch
                optionFilterProp="label"
                value={selectedViewerMemberId}
                onChange={handleSelectViewerMember}
                className="w-full sm:w-72"
                aria-label="Chọn tên của bạn để chỉnh sửa ca làm"
                options={members.map((m) => ({
                  value: m.id,
                  label: `${m.name} (${m.isLeader ? 'Nhóm trưởng' : m.isNew ? 'TV mới' : 'Thành viên'})`,
                }))}
              />
            </div>

            {selectedViewerMember && (
              <div className="text-xs sm:text-sm text-slate-600">
                Đang chỉnh sửa dòng của:{' '}
                <strong className="text-[#1D4ED8] font-semibold">
                  {selectedViewerMember.name}
                </strong>
              </div>
            )}
          </div>
        </section>

        {scheduleTableCard}
      </div>
    );
  }

  // Leader mode: High-contrast segmented view switcher (Schedule vs Member List) without nested cards
  return (
    <div className="flex flex-col gap-5">
      <section className="cap-card p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h2 className="text-base sm:text-lg font-semibold text-slate-900 m-0">
            Thành viên & Ca làm – {activeGroup?.name}
          </h2>
          <p className="text-xs sm:text-sm text-slate-500 mt-0.5 mb-0 font-tabular">
            {activeCount}/{members.length} thành viên đang hoạt động
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div
            role="tablist"
            aria-label="Chế độ xem thành viên và ca làm"
            className="inline-flex items-center p-1 bg-slate-100 rounded-lg border border-slate-200"
          >
            <button
              type="button"
              role="tab"
              aria-selected={leaderSubView === 'schedule'}
              onClick={() => setLeaderSubView('schedule')}
              className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-md text-xs sm:text-sm font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                leaderSubView === 'schedule'
                  ? 'bg-[#2563EB] text-white shadow-xs'
                  : 'text-slate-700 hover:text-slate-900 hover:bg-white/70'
              }`}
            >
              <CalendarDays className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>Lịch phân ca theo ngày</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={leaderSubView === 'members'}
              onClick={() => setLeaderSubView('members')}
              className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-md text-xs sm:text-sm font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                leaderSubView === 'members'
                  ? 'bg-[#2563EB] text-white shadow-xs'
                  : 'text-slate-700 hover:text-slate-900 hover:bg-white/70'
              }`}
            >
              <Users className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>Danh sách thành viên ({members.length})</span>
            </button>
          </div>

          <Button
            type="default"
            size="large"
            icon={<FileSpreadsheet className="w-4 h-4 text-[#2563EB]" />}
            onClick={() => setImportModalOpen(true)}
            className="font-semibold whitespace-nowrap shrink-0"
          >
            Nhập lịch tháng (Sheets / Excel)
          </Button>

          <Button
            type="primary"
            size="large"
            icon={<UserPlus className="w-4 h-4" />}
            onClick={openAddModal}
            className="font-semibold whitespace-nowrap shrink-0"
          >
            Thêm thành viên
          </Button>
        </div>
      </section>

      {leaderSubView === 'schedule' ? (
        scheduleTableCard
      ) : (
        <section className="cap-card p-4 sm:p-5">
          <div className="mb-3">
            <h3 className="text-sm sm:text-base font-semibold text-slate-900 m-0">
              Danh sách thành viên ({members.length})
            </h3>
            <p className="text-xs text-slate-500 mt-0.5 mb-0">
              Quản lý vai trò Nhóm trưởng, Thành viên mới, trạng thái hoạt động và mức ưu tiên chia CAP.
            </p>
          </div>
          <Table
            dataSource={members}
            columns={memberCrudColumns}
            rowKey="id"
            pagination={false}
            size="middle"
            bordered
            scroll={{ x: 900 }}
            locale={{ emptyText: 'Chưa có thành viên nào trong nhóm.' }}
          />
        </section>
      )}

      <Modal
        title={editingMember ? `Chỉnh sửa thành viên: ${editingMember.name}` : `Thêm thành viên mới vào ${activeGroup?.name}`}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSave}
        okText={editingMember ? 'Lưu thay đổi' : 'Thêm thành viên'}
        cancelText="Hủy"
      >
        <Form form={form} layout="vertical" className="mt-3">
          <Form.Item
            name="name"
            label="Họ và Tên"
            rules={[{ required: true, message: 'Vui lòng nhập họ và tên' }]}
          >
            <Input placeholder="Ví dụ: Minh Anh" />
          </Form.Item>

          <Form.Item
            name="telegramUsername"
            label="Telegram @username (tuỳ chọn)"
            extra="Dùng để Bot tag nhắc khi chưa xong CAP trên Group Telegram."
          >
            <Input prefix="@" placeholder="Ví dụ: minhanh_99" />
          </Form.Item>

          <Form.Item
            name="shifts"
            label="Ca làm mặc định"
            rules={[{ required: true, type: 'array', min: 1, message: 'Chọn ít nhất 1 ca làm' }]}
          >
            <Checkbox.Group
              options={SHIFTS.map((s) => ({
                value: s.id,
                label: s.shortLabel,
              }))}
            />
          </Form.Item>

          <Form.Item name="priority" label="Mức ưu tiên phân chia CAP">
            <Select
              options={[
                { value: 'low', label: 'Thấp (-8%)' },
                { value: 'normal', label: 'Bình thường' },
                { value: 'high', label: 'Ưu tiên (+8%)' },
              ]}
            />
          </Form.Item>

          <div className="grid grid-cols-3 gap-3 pt-1">
            <Form.Item name="isLeader" label="Nhóm trưởng" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="isNew" label="Thành viên mới" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="active" label="Hoạt động" valuePropName="checked">
              <Switch />
            </Form.Item>
          </div>
        </Form>
      </Modal>

      {importModalOpen && (
        <Suspense fallback={null}>
          <ShiftScheduleImportModal
            open={importModalOpen}
            onClose={() => setImportModalOpen(false)}
            activeGroup={activeGroup}
            members={members}
            onBatchImportShiftSchedule={onBatchImportShiftSchedule}
            onImportedJumpToDate={(isoDate) => {
              if (isoDate) setScheduleStartDate(isoDate);
            }}
            onNotify={onNotify}
          />
        </Suspense>
      )}
    </div>
  );
}
