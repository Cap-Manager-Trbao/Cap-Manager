import React, { useEffect, useState } from 'react';
import { Alert, Button, Input, InputNumber, Popconfirm, Select, Switch } from 'antd';
import { RotateCcw, Download, KeyRound, Send, Bell, Save, Clock, Bot, Trash2 } from 'lucide-react';
import { getDefaultBotLabel, isValidTelegramChatId } from '../utils/telegramMessages.js';
import { isValidTelegramBotToken, normalizeGroupEnvKey } from '../utils/telegramBotConfig.js';
import TelegramMessageCustomizer from './TelegramMessageCustomizer.jsx';

export default function SettingsView({
  activeGroup,
  canEdit,
  telegramSessionActive = false,
  onOpenLogin,
  onReauthenticateTelegram,
  settings,
  telegramStatus = {
    checked: false,
    configured: false,
    source: 'none',
    botUsername: '',
    tokenMasked: '',
    decryptError: false,
    serverDateVN: '',
    serverTimeVN: '',
    schedulerState: null,
  },
  onUpdateSettings,
  onSaveTelegramBotToken,
  onDeleteTelegramBotToken,
  onTestTelegram,
  onSendShiftReminderNow,
  onResetDefaults,
  onExportBackupJson,
  onNotify,
}) {
  const [chatIdDraft, setChatIdDraft] = useState(settings.telegramChatId || '');
  const [botTokenDraft, setBotTokenDraft] = useState('');
  const [savingBotToken, setSavingBotToken] = useState(false);
  const [deletingBotToken, setDeletingBotToken] = useState(false);
  const [testingTelegram, setTestingTelegram] = useState(false);
  const [sendingReminder, setSendingReminder] = useState(false);

  useEffect(() => {
    setChatIdDraft(settings.telegramChatId || '');
    setBotTokenDraft('');
  }, [activeGroup?.id, settings.telegramChatId]);

  const botLabel = getDefaultBotLabel(activeGroup?.id);
  const trimmedChatId = String(chatIdDraft || '').trim();
  const isChatIdValid = isValidTelegramChatId(trimmedChatId, { allowEmpty: true });
  const isChatIdDirty = trimmedChatId !== String(settings.telegramChatId || '').trim();

  const trimmedBotToken = String(botTokenDraft || '').trim();
  const isBotTokenValid = isValidTelegramBotToken(trimmedBotToken, { allowEmpty: true });

  const handleSaveChatId = async () => {
    if (!canEdit) return;
    if (!isValidTelegramChatId(trimmedChatId, { allowEmpty: true })) {
      onNotify?.('error', 'Telegram Group Chat ID không hợp lệ (ví dụ: -1001234567890).');
      return;
    }
    await onUpdateSettings({ ...settings, telegramChatId: trimmedChatId });
    onNotify?.('success', `Đã lưu Telegram Group Chat ID cho ${activeGroup?.name || 'nhóm'}.`);
  };

  const handleSaveBotToken = async () => {
    if (!canEdit || !activeGroup?.id || !onSaveTelegramBotToken) return;
    if (!isValidTelegramBotToken(trimmedBotToken)) {
      onNotify?.('error', 'Bot Token không hợp lệ. Token từ @BotFather có dạng 123456789:AAH...');
      return;
    }
    setSavingBotToken(true);
    try {
      const res = await onSaveTelegramBotToken(activeGroup.id, trimmedBotToken);
      if (res?.ok) {
        setBotTokenDraft('');
      }
    } finally {
      setSavingBotToken(false);
    }
  };

  const handleDeleteBotToken = async () => {
    if (!canEdit || !activeGroup?.id || !onDeleteTelegramBotToken) return;
    setDeletingBotToken(true);
    try {
      await onDeleteTelegramBotToken(activeGroup.id);
    } finally {
      setDeletingBotToken(false);
    }
  };

  const handleTestClick = async () => {
    if (!activeGroup?.id || !onTestTelegram) return;
    if (!isValidTelegramChatId(trimmedChatId)) {
      onNotify?.('error', 'Vui lòng nhập Telegram Group Chat ID hợp lệ (ví dụ: -1001234567890).');
      return;
    }
    if (trimmedBotToken && !isValidTelegramBotToken(trimmedBotToken)) {
      onNotify?.('error', 'Bot Token vừa nhập chưa đúng định dạng @BotFather (vd: 123456789:AAH...).');
      return;
    }
    setTestingTelegram(true);
    try {
      await onTestTelegram(activeGroup.id, trimmedChatId, { botToken: trimmedBotToken });
    } finally {
      setTestingTelegram(false);
    }
  };

  const handleReminderNowClick = async () => {
    if (!activeGroup?.id || !onSendShiftReminderNow) return;
    if (isChatIdDirty && isValidTelegramChatId(trimmedChatId)) {
      await onUpdateSettings({ ...settings, telegramChatId: trimmedChatId });
    }
    setSendingReminder(true);
    try {
      await onSendShiftReminderNow(activeGroup.id);
    } finally {
      setSendingReminder(false);
    }
  };

  const renderBotStatusLabel = () => {
    if (telegramStatus.source === 'custom') {
      const handle = telegramStatus.botUsername ? `@${telegramStatus.botUsername}` : 'Bot riêng';
      return (
        <span className="text-emerald-700">
          Bot riêng nhóm: {handle} {telegramStatus.tokenMasked ? `(${telegramStatus.tokenMasked})` : ''}
        </span>
      );
    }
    if (telegramStatus.source === 'env_group') {
      return (
        <span className="text-emerald-700">
          Bot riêng từ Secrets máy chủ {telegramStatus.tokenMasked ? `(${telegramStatus.tokenMasked})` : ''}
        </span>
      );
    }
    if (telegramStatus.source === 'env_default' || telegramStatus.configured) {
      return <span className="text-emerald-700">Đang dùng Bot mặc định máy chủ</span>;
    }
    return <span className="text-amber-700">Chưa gắn Bot Token cho nhóm này</span>;
  };

  const envVarHint = activeGroup?.id
    ? `TELEGRAM_BOT_TOKEN_${normalizeGroupEnvKey(activeGroup.id)}`
    : 'TELEGRAM_BOT_TOKEN_GROUP_1';

  const reminderTime = settings.telegramShiftReminderTime || '11:00';
  const sched = telegramStatus?.schedulerState || null;
  const serverDateVN = telegramStatus?.serverDateVN || '';
  const isTodaySched = Boolean(serverDateVN && sched?.lastShiftReminderDate === serverDateVN);
  const sentAtLabel = sched?.lastShiftReminderSentAt
    ? new Date(sched.lastShiftReminderSentAt).toLocaleTimeString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';

  return (
    <div className="flex flex-col gap-5">
      {!canEdit && (
        <Alert
          type="info"
          showIcon
          title={`Chỉ xem cài đặt – ${activeGroup?.name}`}
          description={
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs sm:text-sm">
              <span>Đăng nhập tài khoản Leader của {activeGroup?.name} để thay đổi cấu hình thuật toán, thông báo Telegram hoặc khôi phục dữ liệu nhóm.</span>
              <Button size="small" type="primary" icon={<KeyRound className="w-3.5 h-3.5" />} onClick={onOpenLogin}>
                Đăng nhập Leader
              </Button>
            </div>
          }
        />
      )}

      {/* Telegram Group Notification Settings Card */}
      <section className="cap-card p-5 flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900 m-0 flex items-center gap-2">
              <Bell className="w-4 h-4 text-[#2563EB]" aria-hidden="true" />
              Thông báo Telegram nhóm ({activeGroup?.name})
            </h2>
            <p className="text-xs text-slate-500 mt-1 mb-0">
              Mỗi nhóm có thể gắn Bot Telegram riêng (từ @BotFather) và Group Chat ID riêng. {botLabel} gửi thẳng vào nhóm chat chung, không cần kết nối từng thành viên.
            </p>
          </div>
          <div className="text-xs font-medium">{renderBotStatusLabel()}</div>
        </div>

        {canEdit && telegramStatus.decryptError && (
          <Alert
            type="warning"
            showIcon
            title="Cần nhập lại Bot Token riêng của nhóm"
            description="Khóa mã hóa trên máy chủ đã thay đổi nên hệ thống không giải mã được token đã lưu trước đó. Vui lòng dán lại Bot Token từ @BotFather và bấm Lưu Bot Token."
          />
        )}

        {canEdit && settings.telegramEnabled && (!trimmedChatId || !telegramStatus.configured) && (
          <Alert
            type="warning"
            showIcon
            title="Chưa thể gửi thông báo Telegram cho nhóm này"
            description={
              !telegramStatus.configured
                ? 'Nhóm đang bật Telegram nhưng chưa gắn Bot Token hợp lệ (Bot riêng nhóm hoặc Bot mặc định máy chủ).'
                : 'Nhóm đang bật Telegram nhưng chưa nhập Telegram Group Chat ID. Vui lòng nhập Chat ID bên dưới và bấm "Lưu Chat ID".'
            }
          />
        )}

        {canEdit && !telegramSessionActive && (
          <Alert
            type="warning"
            showIcon
            title="Phiên xác thực gửi Telegram trên máy chủ chưa kích hoạt"
            description={
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span>
                  Sau khi tải lại trang hoặc khởi động lại máy chủ, hãy xác nhận lại mật khẩu Leader (hoặc bấm &quot;Gửi thử tin nhắn&quot;) để kích hoạt phiên gửi Telegram.
                </span>
                <Button
                  size="small"
                  type="primary"
                  icon={<KeyRound className="w-3.5 h-3.5" />}
                  onClick={() => onReauthenticateTelegram?.()}
                >
                  Xác nhận mật khẩu Leader
                </Button>
              </div>
            }
          />
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pt-1">
          <div className="flex flex-col gap-3.5 p-4 rounded-lg bg-slate-50 border border-slate-200">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-medium text-slate-800">
                  Bật gửi thông báo về Group Telegram
                </div>
                <div className="text-xs text-slate-500">
                  Tự động chụp gửi ảnh bảng chia CAP khi bấm &quot;Lưu bảng chia CAP&quot;
                </div>
              </div>
              <Switch
                disabled={!canEdit}
                checked={Boolean(settings.telegramEnabled)}
                aria-label="Bật gửi thông báo về Group Telegram"
                onChange={(checked) =>
                  onUpdateSettings({ ...settings, telegramEnabled: checked })
                }
              />
            </div>

            <div className="flex flex-col gap-1.5 border-t border-slate-200/80 pt-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label
                  htmlFor="settings-telegram-bot-token"
                  className="text-xs font-medium text-slate-700 flex items-center gap-1.5"
                >
                  <Bot className="w-3.5 h-3.5 text-[#2563EB]" aria-hidden="true" />
                  Bot Token riêng của {activeGroup?.name} (từ @BotFather)
                </label>
                {telegramStatus.source === 'custom' && canEdit && (
                  <Popconfirm
                    title="Xóa Bot Token riêng của nhóm này?"
                    description="Nhóm sẽ chuyển về dùng Bot mặc định của máy chủ (nếu có)."
                    okText="Xóa"
                    cancelText="Hủy"
                    okButtonProps={{ danger: true }}
                    onConfirm={handleDeleteBotToken}
                  >
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<Trash2 className="w-3.5 h-3.5" />}
                      loading={deletingBotToken}
                    >
                      Xóa Bot riêng
                    </Button>
                  </Popconfirm>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Input.Password
                  id="settings-telegram-bot-token"
                  disabled={!canEdit}
                  value={botTokenDraft}
                  onChange={(e) => setBotTokenDraft(e.target.value)}
                  autoComplete="off"
                  placeholder={
                    telegramStatus.source === 'custom'
                      ? `Đã lưu ${telegramStatus.tokenMasked || 'token riêng'} — nhập token mới nếu muốn đổi`
                      : 'Dán token từ @BotFather (vd: 123456789:AAH...)'
                  }
                  status={!isBotTokenValid ? 'error' : ''}
                  className="flex-1 min-w-[200px] font-tabular"
                />
                {canEdit && (
                  <Button
                    icon={<Save className="w-3.5 h-3.5" />}
                    loading={savingBotToken}
                    disabled={!trimmedBotToken || !isBotTokenValid}
                    onClick={handleSaveBotToken}
                  >
                    Lưu Bot Token
                  </Button>
                )}
              </div>

              {!isBotTokenValid ? (
                <span className="text-xs text-red-600">
                  Bot Token chưa đúng định dạng @BotFather (gồm mã số bot, dấu hai chấm và chuỗi ký tự, vd: 123456789:AAH...).
                </span>
              ) : (
                <span className="text-[11px] text-slate-500">
                  Token chỉ được gửi lên máy chủ để xác minh &amp; lưu trữ riêng cho nhóm này, không hiển thị lại ra trình duyệt. Hoặc đặt biến <code className="font-mono text-slate-700">{envVarHint}</code> trong Secrets máy chủ.
                </span>
              )}
            </div>

            <div className="flex flex-col gap-1.5 border-t border-slate-200/80 pt-3">
              <label htmlFor="settings-telegram-chat-id" className="text-xs font-medium text-slate-700">
                Telegram Group Chat ID của {activeGroup?.name}
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="settings-telegram-chat-id"
                  disabled={!canEdit}
                  value={chatIdDraft}
                  onChange={(e) => setChatIdDraft(e.target.value)}
                  placeholder="Ví dụ: -1001234567890"
                  status={!isChatIdValid ? 'error' : ''}
                  className="flex-1 min-w-[200px] font-tabular"
                />
                {canEdit && (
                  <>
                    <Button
                      icon={<Save className="w-3.5 h-3.5" />}
                      disabled={!isChatIdValid || !isChatIdDirty}
                      onClick={handleSaveChatId}
                    >
                      Lưu Chat ID
                    </Button>
                    <Button
                      type="primary"
                      ghost
                      icon={<Send className="w-3.5 h-3.5" />}
                      loading={testingTelegram}
                      disabled={!trimmedChatId || !isChatIdValid || !isBotTokenValid}
                      onClick={handleTestClick}
                    >
                      Gửi thử tin nhắn
                    </Button>
                  </>
                )}
              </div>
              {!isChatIdValid ? (
                <span className="text-xs text-red-600">
                  Chat ID nhóm Telegram cần là dãy số (vd: -1001234567890) hoặc @username nhóm công khai.
                </span>
              ) : (
                <span className="text-[11px] text-slate-500">
                  Mẹo lấy Chat ID: Thêm Bot riêng của nhóm vào Group Telegram cùng @userinfobot hoặc @RawDataBot để xem ID nhóm (thường có dấu trừ phía trước).
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-col justify-between gap-3 p-4 rounded-lg bg-slate-50 border border-slate-200">
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-slate-800 flex items-center gap-1.5">
                    <Clock className="w-4 h-4 text-[#2563EB]" aria-hidden="true" />
                    Nhắc đăng ký ca làm lúc {reminderTime} hằng ngày
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    Tự động nhắn nhắc đăng ký ca vào Group Telegram từ {reminderTime} (giờ Việt Nam, tự động bù gửi trong vòng 3 tiếng nếu máy chủ vừa khởi động lại).
                  </div>
                </div>
                <Switch
                  disabled={!canEdit}
                  checked={settings.telegramShiftReminderEnabled !== false}
                  aria-label="Nhắc mọi người đăng ký ca làm hằng ngày"
                  onChange={(checked) =>
                    onUpdateSettings({ ...settings, telegramShiftReminderEnabled: checked })
                  }
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200/80 pt-2.5">
                <label
                  htmlFor="settings-tg-shift-reminder-time"
                  className="text-xs font-medium text-slate-700"
                >
                  Giờ nhắc tự động (VN):
                </label>
                <div className="flex items-center gap-2">
                  <Input
                    id="settings-tg-shift-reminder-time"
                    type="time"
                    size="small"
                    disabled={!canEdit}
                    value={reminderTime}
                    onChange={(e) =>
                      onUpdateSettings({
                        ...settings,
                        telegramShiftReminderTime: e.target.value || '11:00',
                      })
                    }
                    className="w-28 font-tabular"
                  />
                  {canEdit && reminderTime !== '11:00' && (
                    <Button
                      size="small"
                      onClick={() =>
                        onUpdateSettings({ ...settings, telegramShiftReminderTime: '11:00' })
                      }
                    >
                      Mặc định 11:00
                    </Button>
                  )}
                </div>
              </div>

              <div className="text-xs rounded-md bg-white border border-slate-200/90 px-3 py-2">
                {!settings.telegramEnabled ? (
                  <span className="text-slate-500">Đang tắt gửi thông báo Telegram chung.</span>
                ) : settings.telegramShiftReminderEnabled === false ? (
                  <span className="text-slate-500">Đang tắt nhắc đăng ký ca hằng ngày.</span>
                ) : !trimmedChatId ? (
                  <span className="text-amber-700 font-medium">
                    Chưa có Group Chat ID nên chưa thể gửi nhắc ca tự động.
                  </span>
                ) : !telegramStatus.configured ? (
                  <span className="text-amber-700 font-medium">
                    Chưa gắn Bot Token hợp lệ cho nhóm này.
                  </span>
                ) : isTodaySched && sched?.lastShiftReminderStatus === 'error' ? (
                  <span className="text-red-600 font-medium">
                    Lỗi gửi nhắc ca hôm nay: {sched.lastShiftReminderError || 'Không rõ lỗi Telegram'}
                  </span>
                ) : isTodaySched && sched?.lastShiftReminderStatus === 'sent' ? (
                  <span className="text-emerald-700 font-medium">
                    Đã gửi nhắc ca hôm nay ({serverDateVN})
                    {sentAtLabel ? ` lúc ${sentAtLabel} (giờ VN)` : ''}.
                  </span>
                ) : (
                  <span className="text-slate-700">
                    Hôm nay ({serverDateVN || 'giờ VN'}) chưa gửi nhắc ca — sẽ tự gửi từ{' '}
                    <strong>{reminderTime}</strong>.
                  </span>
                )}
              </div>
            </div>

            <div className="text-xs text-slate-600 space-y-1 border-t border-slate-200/80 pt-2.5">
              <div>• <strong>Khi bấm &quot;Lưu bảng chia CAP&quot;:</strong> {botLabel} chụp gửi ảnh bảng chia CAP (tự chuyển văn bản nếu gửi ảnh lỗi).</div>
              <div>• <strong>Khi chỉnh sửa &amp; lưu lại:</strong> Gửi ảnh bảng mới nhất và tự ghi chú đúng ô thay đổi.</div>
            </div>

            {canEdit && (
              <div className="flex items-center justify-end">
                <Button
                  size="small"
                  icon={<Send className="w-3.5 h-3.5" />}
                  loading={sendingReminder}
                  disabled={!settings.telegramEnabled || !trimmedChatId || !isChatIdValid}
                  onClick={handleReminderNowClick}
                >
                  Gửi nhắc đăng ký ca
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Scheduled CAP Nudge & Daily Summary (Outbound-only) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 rounded-lg bg-slate-50 border border-slate-200">
          <div>
            <label
              htmlFor="settings-tg-deadline-nudge"
              className="block text-xs font-medium text-slate-700 mb-1"
            >
              Nhắc CAP chưa xong lúc (VN)
            </label>
            <div className="flex items-center gap-1.5">
              <Input
                id="settings-tg-deadline-nudge"
                type="time"
                size="small"
                disabled={!canEdit}
                value={settings.telegramDeadlineReminderTime || ''}
                onChange={(e) =>
                  onUpdateSettings({
                    ...settings,
                    telegramDeadlineReminderTime: e.target.value || '',
                  })
                }
                className="font-tabular"
              />
              {canEdit && settings.telegramDeadlineReminderTime && (
                <Button
                  size="small"
                  onClick={() =>
                    onUpdateSettings({ ...settings, telegramDeadlineReminderTime: '' })
                  }
                >
                  Tắt
                </Button>
              )}
            </div>
            <span className="text-[11px] text-slate-500">
              Để trống nếu không tự động nhắc trước giờ chốt.
            </span>
          </div>

          <div>
            <label
              htmlFor="settings-tg-daily-summary"
              className="block text-xs font-medium text-slate-700 mb-1"
            >
              Tổng kết cuối ngày lúc (VN)
            </label>
            <div className="flex items-center gap-1.5">
              <Input
                id="settings-tg-daily-summary"
                type="time"
                size="small"
                disabled={!canEdit}
                value={settings.telegramDailySummaryTime || ''}
                onChange={(e) =>
                  onUpdateSettings({
                    ...settings,
                    telegramDailySummaryTime: e.target.value || '',
                  })
                }
                className="font-tabular"
              />
              {canEdit && settings.telegramDailySummaryTime && (
                <Button
                  size="small"
                  onClick={() =>
                    onUpdateSettings({ ...settings, telegramDailySummaryTime: '' })
                  }
                >
                  Tắt
                </Button>
              )}
            </div>
            <span className="text-[11px] text-slate-500">
              Tự gửi tỷ lệ hoàn thành &amp; lịch ca ngày mai.
            </span>
          </div>
        </div>

        <TelegramMessageCustomizer
          activeGroup={activeGroup}
          canEdit={canEdit}
          settings={settings}
          botUsername={telegramStatus.botUsername}
          onUpdateSettings={onUpdateSettings}
          onNotify={onNotify}
        />
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Algorithm Settings Card */}
        <section className="cap-card p-5 flex flex-col gap-5">
          <div>
            <h2 className="text-base font-semibold text-slate-900 m-0">
              Cấu hình thuật toán chia CAP ({activeGroup?.name})
            </h2>
            <p className="text-xs text-slate-500 mt-1 mb-0">
              Tùy chỉnh trọng số ưu tiên, khớp ca làm và số vòng lặp tối ưu khi chạy &quot;TỰ ĐỘNG CHIA CAP&quot;.
            </p>
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-medium text-slate-800">Chia theo ca làm &amp; giờ CAP chung</div>
                <div className="text-xs text-slate-500">Ưu tiên offer không mở 23h (10h) cho Ca 1 hôm sau; Ca 2, 3 &amp; Ca 1 hôm sau chia bình thường và giữ đều điểm</div>
              </div>
              <Switch
                disabled={!canEdit}
                checked={settings.useShiftMatching !== false}
                onChange={(checked) =>
                  onUpdateSettings({ ...settings, useShiftMatching: checked })
                }
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-medium text-slate-800">Ưu tiên nhóm trưởng</div>
                <div className="text-xs text-slate-500">Chọn &quot;Bình thường&quot; để chia đều như thành viên, hoặc ưu tiên thêm CAP/điểm</div>
              </div>
              <Select
                disabled={!canEdit}
                value={settings.leaderPriority}
                onChange={(val) => onUpdateSettings({ ...settings, leaderPriority: val })}
                className="w-44"
                options={[
                  { value: 'normal', label: 'Bình thường' },
                  { value: 'low', label: 'Thấp' },
                  { value: 'medium', label: 'Vừa (Mặc định)' },
                  { value: 'high', label: 'Cao' },
                ]}
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-medium text-slate-800">Chế độ thành viên mới</div>
                <div className="text-xs text-slate-500">Điều chỉnh tỷ lệ nhận CAP cho thành viên mới</div>
              </div>
              <Select
                disabled={!canEdit}
                value={settings.newMemberMode}
                onChange={(val) => onUpdateSettings({ ...settings, newMemberMode: val })}
                className="w-44"
                options={[
                  { value: 'less', label: 'Ít hơn' },
                  { value: 'normal', label: 'Bình thường' },
                ]}
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-medium text-slate-800">Cân bằng số lượng CAP</div>
                <div className="text-xs text-slate-500">Ưu tiên đồng đều số CAP giữa các thành viên</div>
              </div>
              <Select
                disabled={!canEdit}
                value={settings.capBalanceLevel}
                onChange={(val) => onUpdateSettings({ ...settings, capBalanceLevel: val })}
                className="w-44"
                options={[
                  { value: 'high', label: 'Cao' },
                  { value: 'medium', label: 'Trung bình' },
                ]}
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-medium text-slate-800">Cân bằng tổng điểm</div>
                <div className="text-xs text-slate-500">Ưu tiên giảm chênh lệch điểm thưởng</div>
              </div>
              <Select
                disabled={!canEdit}
                value={settings.pointBalanceLevel}
                onChange={(val) => onUpdateSettings({ ...settings, pointBalanceLevel: val })}
                className="w-44"
                options={[
                  { value: 'high', label: 'Cao' },
                  { value: 'medium', label: 'Trung bình' },
                ]}
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-medium text-slate-800">Số phương án tìm kiếm mỗi lần chia</div>
                <div className="text-xs text-slate-500">Chạy nhiều phương án và chọn phương án tối ưu nhất</div>
              </div>
              <InputNumber
                disabled={!canEdit}
                min={1}
                max={40}
                precision={0}
                value={settings.optimizationTrials || 15}
                onChange={(val) =>
                  onUpdateSettings({ ...settings, optimizationTrials: val || 15 })
                }
                className="w-44"
              />
            </div>

            <div className="flex items-center justify-between gap-4 pt-2 border-t border-slate-100">
              <div>
                <div className="text-sm font-medium text-slate-800">Bù chênh lệch điểm từ lần lưu gần nhất</div>
                <div className="text-xs text-slate-500">Ưu tiên bù nhẹ cho thành viên bị hụt điểm ở lần lưu lịch sử trước đó</div>
              </div>
              <Switch
                disabled={!canEdit}
                checked={Boolean(settings.useRolloverFairness)}
                onChange={(checked) =>
                  onUpdateSettings({ ...settings, useRolloverFairness: checked })
                }
              />
            </div>

            <div className="flex items-center justify-between gap-4 pt-2 border-t border-slate-100">
              <div>
                <div className="text-sm font-medium text-slate-800">Lưu &amp; hiển thị lên Dashboard</div>
                <div className="text-xs text-slate-500">
                  Bảng chia chỉ được lưu vào Lịch sử và hiển thị bên Dashboard khi bạn bấm nút &quot;Lưu bảng chia CAP&quot;
                </div>
              </div>
              <span className="text-xs font-semibold text-[#2563EB] whitespace-nowrap">
                Chỉ lưu khi bấm
              </span>
            </div>
          </div>
        </section>

        {/* Data Management Card */}
        <section className="cap-card p-5 flex flex-col justify-between gap-5">
          <div>
            <h2 className="text-base font-semibold text-slate-900 m-0">
              Quản lý dữ liệu &amp; Sao lưu
            </h2>
            <p className="text-xs text-slate-500 mt-1 mb-0">
              Dữ liệu tất cả các nhóm, ca làm, offer, lịch sử và tài khoản Leader được lưu trữ trên cơ sở dữ liệu đám mây (Firebase Firestore) và đồng bộ trực tiếp giữa các thiết bị.
            </p>

            <div className="mt-5 flex flex-col gap-3">
              <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-slate-900">Tải bản sao lưu JSON</div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    Xuất toàn bộ dữ liệu nhóm hiện tại và cấu hình ra file JSON.
                  </div>
                </div>
                <Button icon={<Download className="w-4 h-4" />} onClick={onExportBackupJson}>
                  Tải JSON
                </Button>
              </div>

              {canEdit && (
                <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium text-slate-900">Khôi phục dữ liệu mẫu mặc định</div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      Đưa thành viên (6 người) và danh sách 8 offer mẫu của nhóm về mặc định.
                    </div>
                  </div>
                  <Popconfirm
                    title="Khôi phục dữ liệu mặc định cho nhóm này?"
                    description="Danh sách thành viên, offer và bảng chia của nhóm sẽ trở về dữ liệu mẫu ban đầu."
                    okText="Khôi phục"
                    cancelText="Hủy"
                    okButtonProps={{ danger: true }}
                    onConfirm={onResetDefaults}
                  >
                    <Button danger icon={<RotateCcw className="w-4 h-4" />}>
                      Khôi phục mẫu
                    </Button>
                  </Popconfirm>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
