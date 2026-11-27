import React, { useState } from 'react';
import {
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Switch,
  Table,
} from 'antd';
import {
  Plus,
  KeyRound,
  Pencil,
  Trash2,
  CheckCircle2,
  ArrowRightLeft,
  Send,
  Bell,
} from 'lucide-react';
import { isValidTelegramChatId } from '../utils/telegramMessages.js';
import { isValidTelegramBotToken } from '../utils/telegramBotConfig.js';

export default function GroupsView({
  groups,
  activeGroupId,
  authSession,
  serverAuthGroupId = null,
  telegramConfigured = false,
  telegramStatusByGroup = {},
  onSelectGroup,
  onCreateGroup,
  onUpdateGroup,
  onDeleteGroup,
  onTestTelegram,
  onDeleteTelegramBotToken,
  onOpenLoginForGroup,
  onReauthenticateTelegram,
  onNotify,
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testingTelegram, setTestingTelegram] = useState(false);
  const [deletingToken, setDeletingToken] = useState(false);
  const [form] = Form.useForm();

  const openCreateModal = () => {
    setEditingGroup(null);
    form.resetFields();
    const nextIdx = groups.length + 1;
    form.setFieldsValue({
      name: `Nhóm ${nextIdx}`,
      description: '',
      leaderDisplayName: `Leader Nhóm ${nextIdx}`,
      leaderUsername: `leader${nextIdx}`,
      leaderPassword: '',
      confirmLeaderPassword: '',
      copyDefaultCampaigns: true,
      telegramEnabled: false,
      telegramChatId: '',
      telegramBotToken: '',
      telegramShiftReminderEnabled: true,
    });
    setModalOpen(true);
  };

  const openEditModal = (group) => {
    setEditingGroup(group);
    form.resetFields();
    form.setFieldsValue({
      name: group.name,
      description: group.description || '',
      leaderDisplayName: group.leaderAccount?.displayName || '',
      leaderUsername: group.leaderAccount?.username || '',
      leaderPassword: '',
      confirmLeaderPassword: '',
      telegramEnabled: Boolean(group.settings?.telegramEnabled),
      telegramChatId: group.settings?.telegramChatId || '',
      telegramBotToken: '',
      telegramShiftReminderEnabled: group.settings?.telegramShiftReminderEnabled !== false,
    });
    setModalOpen(true);
  };

  const handleTestTelegramClick = async () => {
    if (!editingGroup || !onTestTelegram) return;
    const chatId = String(form.getFieldValue('telegramChatId') || '').trim();
    const draftBotToken = String(form.getFieldValue('telegramBotToken') || '').trim();
    if (!isValidTelegramChatId(chatId)) {
      onNotify('error', 'Vui lòng nhập Telegram Group Chat ID hợp lệ (ví dụ: -1001234567890).');
      return;
    }
    if (draftBotToken && !isValidTelegramBotToken(draftBotToken)) {
      onNotify('error', 'Bot Token vừa nhập chưa đúng định dạng @BotFather (vd: 123456789:AAH...).');
      return;
    }
    setTestingTelegram(true);
    try {
      await onTestTelegram(editingGroup.id, chatId, { botToken: draftBotToken });
    } finally {
      setTestingTelegram(false);
    }
  };

  const handleDeleteCustomBotClick = async () => {
    if (!editingGroup || !onDeleteTelegramBotToken) return;
    setDeletingToken(true);
    try {
      await onDeleteTelegramBotToken(editingGroup.id);
    } finally {
      setDeletingToken(false);
    }
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      const username = values.leaderUsername.trim().toLowerCase();
      const cleanChatId = String(values.telegramChatId || '').trim();
      const cleanBotToken = String(values.telegramBotToken || '').trim();

      const duplicate = groups.find(
        (g) =>
          g.id !== editingGroup?.id &&
          g.leaderAccount?.username?.toLowerCase() === username
      );
      if (duplicate) {
        onNotify('error', `Tài khoản "${username}" đã thuộc về ${duplicate.name}. Vui lòng chọn tên khác.`);
        return;
      }

      setSaving(true);
      if (editingGroup) {
        const ok = await onUpdateGroup(
          editingGroup.id,
          {
            name: values.name.trim(),
            description: values.description?.trim() || '',
            leaderAccount: {
              username,
              displayName: values.leaderDisplayName.trim(),
            },
            settings: {
              telegramEnabled: Boolean(values.telegramEnabled),
              telegramChatId: cleanChatId,
              telegramShiftReminderEnabled: values.telegramShiftReminderEnabled !== false,
            },
            telegramBotToken: cleanBotToken,
          },
          values.leaderPassword || ''
        );
        if (ok !== false) {
          onNotify('success', `Đã cập nhật thông tin ${values.name.trim()}`);
          setModalOpen(false);
        }
      } else {
        const ok = await onCreateGroup({
          name: values.name.trim(),
          description: values.description?.trim() || '',
          leaderDisplayName: values.leaderDisplayName.trim(),
          leaderUsername: username,
          leaderPassword: values.leaderPassword,
          copyDefaultCampaigns: Boolean(values.copyDefaultCampaigns),
          telegramEnabled: Boolean(values.telegramEnabled),
          telegramChatId: cleanChatId,
          telegramBotToken: cleanBotToken,
          telegramShiftReminderEnabled: values.telegramShiftReminderEnabled !== false,
        });
        if (ok !== false) {
          onNotify('success', `Đã tạo nhóm mới "${values.name.trim()}" và tài khoản Leader "${username}"`);
          setModalOpen(false);
        }
      }
    } catch {
      // inline form validation
    } finally {
      setSaving(false);
    }
  };

  const columns = [
    {
      title: 'Tên nhóm',
      dataIndex: 'name',
      key: 'name',
      minWidth: 180,
      render: (name, g) => {
        const isCurrent = g.id === activeGroupId;
        const hasTg = Boolean(g.settings?.telegramEnabled && g.settings?.telegramChatId);
        const botStatus = telegramStatusByGroup?.[g.id];
        const botTag =
          botStatus?.source === 'custom'
            ? botStatus.botUsername
              ? ` · Bot @${botStatus.botUsername}`
              : ' · Bot riêng'
            : botStatus?.source === 'env_group'
              ? ' · Bot riêng (Secrets)'
              : '';
        return (
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-slate-900">{name}</span>
              {isCurrent && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-[#2563EB]">
                  <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                  Đang mở
                </span>
              )}
            </div>
            {g.description && <div className="text-xs text-slate-500 mt-0.5">{g.description}</div>}
            <div className={`inline-flex items-center gap-1 text-[11px] mt-1 font-tabular ${hasTg ? 'text-emerald-700' : 'text-slate-400'}`}>
              <Bell className="w-3 h-3" aria-hidden="true" />
              {hasTg
                ? `Telegram nhóm: ${g.settings.telegramChatId}${botTag}`
                : `Chưa gắn Group Telegram${botTag}`}
            </div>
          </div>
        );
      },
    },
    {
      title: 'Tài khoản Leader',
      key: 'leaderAccount',
      minWidth: 200,
      render: (_, g) => {
        const isLoggedIn = authSession?.groupId === g.id;
        return (
          <div>
            <div className="text-sm font-medium text-slate-800">
              {g.leaderAccount?.displayName || 'Leader'}
            </div>
            <div className="text-xs text-slate-500 font-tabular">
              Tài khoản: <strong className="text-slate-700">{g.leaderAccount?.username}</strong>
              {isLoggedIn ? ' · Đang đăng nhập' : ''}
            </div>
          </div>
        );
      },
    },
    {
      title: 'Thành viên',
      key: 'memberCount',
      align: 'right',
      width: 110,
      render: (_, g) => <span className="font-tabular text-slate-700">{g.members?.length || 0}</span>,
    },
    {
      title: 'Offer',
      key: 'campaignCount',
      align: 'right',
      width: 110,
      render: (_, g) => <span className="font-tabular text-slate-700">{g.campaigns?.length || 0}</span>,
    },
    {
      title: 'Thao tác',
      key: 'actions',
      align: 'right',
      width: 310,
      render: (_, g) => {
        const isCurrent = g.id === activeGroupId;
        const isThisLeader = authSession?.groupId === g.id;

        return (
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {!isCurrent && (
              <Button
                size="small"
                icon={<ArrowRightLeft className="w-3.5 h-3.5" />}
                onClick={() => onSelectGroup(g.id)}
              >
                Mở nhóm
              </Button>
            )}
            {!isThisLeader && (
              <Button
                size="small"
                type="primary"
                ghost
                icon={<KeyRound className="w-3.5 h-3.5" />}
                onClick={() => onOpenLoginForGroup(g)}
              >
                Đăng nhập Leader
              </Button>
            )}
            {isThisLeader && (
              <Button
                size="small"
                aria-label={`Sửa nhóm ${g.name}`}
                icon={<Pencil className="w-3.5 h-3.5" />}
                onClick={() => openEditModal(g)}
              >
                Sửa
              </Button>
            )}
            {groups.length > 1 && isThisLeader && (
              <Popconfirm
                title={`Xóa ${g.name}?`}
                description="Toàn bộ thành viên, offer và lịch sử của nhóm này sẽ bị xóa."
                okText="Xóa"
                cancelText="Hủy"
                okButtonProps={{ danger: true }}
                onConfirm={() => onDeleteGroup(g.id)}
              >
                <Button
                  size="small"
                  danger
                  aria-label={`Xóa nhóm ${g.name}`}
                  icon={<Trash2 className="w-3.5 h-3.5" />}
                />
              </Popconfirm>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <section className="cap-card p-4 sm:p-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900 m-0">
            Quản lý Nhóm & Tài khoản Leader ({groups.length} nhóm)
          </h2>
          <p className="text-xs text-slate-500 mt-0.5 mb-0">
            Mỗi nhóm có danh sách thành viên, offer và tài khoản Leader riêng để phân quyền chỉnh sửa độc lập.
          </p>
        </div>
        <Button
          type="primary"
          icon={<Plus className="w-4 h-4" />}
          onClick={openCreateModal}
          className="font-medium"
        >
          Tạo nhóm mới
        </Button>
      </section>

      <section className="cap-card p-4">
        <Table
          dataSource={groups}
          columns={columns}
          rowKey="id"
          pagination={false}
          size="middle"
          scroll={{ x: 820 }}
        />
      </section>

      <Modal
        title={editingGroup ? `Chỉnh sửa ${editingGroup.name}` : 'Tạo nhóm mới & Tài khoản Leader'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSave}
        confirmLoading={saving}
        okText={editingGroup ? 'Lưu thay đổi' : 'Tạo nhóm'}
        cancelText="Hủy"
        width={580}
        centered
        styles={{ body: { maxHeight: '80vh', overflowY: 'auto', paddingRight: 4 } }}
      >
        <Form form={form} layout="vertical" className="mt-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 items-start">
            <Form.Item
              name="name"
              label="Tên nhóm"
              style={{ marginBottom: 12 }}
              rules={[{ required: true, message: 'Vui lòng nhập tên nhóm (vd: Nhóm 2)' }]}
            >
              <Input placeholder="Ví dụ: Nhóm 2" />
            </Form.Item>

            <Form.Item
              name="description"
              label="Mô tả nhóm (không bắt buộc)"
              style={{ marginBottom: 12 }}
            >
              <Input placeholder="Ví dụ: Team ca tối & cuối tuần" />
            </Form.Item>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 items-start">
            <Form.Item
              name="leaderDisplayName"
              label="Tên hiển thị Leader"
              style={{ marginBottom: 12 }}
              rules={[{ required: true, message: 'Vui lòng nhập tên Leader' }]}
            >
              <Input placeholder="Ví dụ: Minh Anh (Leader Nhóm 2)" />
            </Form.Item>

            <Form.Item
              name="leaderUsername"
              label="Tên đăng nhập Leader"
              style={{ marginBottom: 12 }}
              rules={[
                { required: true, message: 'Nhập tên đăng nhập' },
                { min: 3, message: 'Tối thiểu 3 ký tự' },
              ]}
            >
              <Input placeholder="Ví dụ: leader2" />
            </Form.Item>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 items-start">
            <Form.Item
              name="leaderPassword"
              label={editingGroup ? 'Mật khẩu mới' : 'Mật khẩu Leader'}
              style={{ marginBottom: 14 }}
              rules={
                editingGroup
                  ? [{ min: 6, message: 'Mật khẩu mới cần tối thiểu 6 ký tự' }]
                  : [
                      { required: true, message: 'Nhập mật khẩu' },
                      { min: 6, message: 'Mật khẩu cần tối thiểu 6 ký tự' },
                    ]
              }
            >
              <Input.Password
                placeholder={editingGroup ? 'Để trống nếu giữ mật khẩu cũ' : 'Tối thiểu 6 ký tự'}
                autoComplete="new-password"
              />
            </Form.Item>

            <Form.Item
              name="confirmLeaderPassword"
              label={editingGroup ? 'Xác nhận mật khẩu mới' : 'Xác nhận mật khẩu'}
              style={{ marginBottom: 14 }}
              dependencies={['leaderPassword']}
              rules={[
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    const pwd = getFieldValue('leaderPassword');
                    if (!pwd && !value) return Promise.resolve();
                    if (pwd && !value) {
                      return Promise.reject(new Error('Vui lòng xác nhận mật khẩu'));
                    }
                    if (pwd === value) return Promise.resolve();
                    return Promise.reject(new Error('Mật khẩu xác nhận không khớp'));
                  },
                }),
              ]}
            >
              <Input.Password
                placeholder={editingGroup ? 'Nhập lại nếu đổi mật khẩu mới' : 'Nhập lại mật khẩu'}
                autoComplete="new-password"
              />
            </Form.Item>
          </div>

          {/* Per-Group Telegram Configuration */}
          {(() => {
            const editingBotStatus = editingGroup ? telegramStatusByGroup?.[editingGroup.id] : null;
            const hasCustomBot = editingBotStatus?.source === 'custom';
            const isBotReady = Boolean(editingBotStatus?.configured || telegramConfigured);
            const botStatusText = hasCustomBot
              ? `Bot riêng${editingBotStatus.botUsername ? ` (@${editingBotStatus.botUsername})` : ''}`
              : editingBotStatus?.source === 'env_group'
                ? 'Bot riêng (Secrets)'
                : isBotReady
                  ? 'Bot mặc định máy chủ'
                  : 'Chưa gắn Bot Token';

            return (
              <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 flex flex-col gap-3 mb-2">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">
                      Thông báo Group Telegram
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      Mỗi nhóm dùng Bot riêng (từ @BotFather) và Group Chat ID riêng.
                    </div>
                  </div>
                  <span
                    className={`text-xs font-medium whitespace-nowrap shrink-0 pt-0.5 ${
                      isBotReady ? 'text-emerald-700' : 'text-amber-700'
                    }`}
                  >
                    {botStatusText}
                  </span>
                </div>

                <div className="border-t border-slate-200/80 pt-3 flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-xs font-medium text-slate-700">
                      Tự động gửi thông báo vào Group Telegram
                    </span>
                    <Form.Item
                      name="telegramEnabled"
                      valuePropName="checked"
                      style={{ marginBottom: 0 }}
                    >
                      <Switch size="small" aria-label="Bật thông báo Group Telegram" />
                    </Form.Item>
                  </div>

                  <div className="flex items-center justify-between gap-4">
                    <span className="text-xs font-medium text-slate-700">
                      Nhắc mọi người đăng ký ca làm lúc 11:00 hằng ngày
                    </span>
                    <Form.Item
                      name="telegramShiftReminderEnabled"
                      valuePropName="checked"
                      style={{ marginBottom: 0 }}
                    >
                      <Switch
                        size="small"
                        aria-label="Nhắc mọi người đăng ký ca làm lúc 11h hằng ngày"
                      />
                    </Form.Item>
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <label
                        htmlFor="groups-telegram-bot-token"
                        className="block text-xs font-medium text-slate-700"
                      >
                        Bot Token riêng của nhóm (tuỳ chọn)
                      </label>
                      {hasCustomBot && editingGroup && authSession?.groupId === editingGroup.id && (
                        <Popconfirm
                          title="Xóa Bot Token riêng của nhóm?"
                          okText="Xóa"
                          cancelText="Hủy"
                          okButtonProps={{ danger: true }}
                          onConfirm={handleDeleteCustomBotClick}
                        >
                          <Button
                            size="small"
                            type="text"
                            danger
                            loading={deletingToken}
                            style={{ paddingInline: 4, height: 'auto', fontSize: 11 }}
                          >
                            Xóa Bot riêng
                          </Button>
                        </Popconfirm>
                      )}
                    </div>
                    <Form.Item
                      name="telegramBotToken"
                      style={{ marginBottom: 0 }}
                      rules={[
                        {
                          validator: (_, val) => {
                            if (isValidTelegramBotToken(val, { allowEmpty: true })) {
                              return Promise.resolve();
                            }
                            return Promise.reject(
                              new Error('Bot Token không hợp lệ (vd: 123456789:AAH...)')
                            );
                          },
                        },
                      ]}
                    >
                      <Input.Password
                        id="groups-telegram-bot-token"
                        autoComplete="off"
                        placeholder={
                          hasCustomBot
                            ? `Đã lưu ${editingBotStatus?.tokenMasked || 'Bot riêng'} — nhập token mới để đổi`
                            : 'Để trống nếu dùng Bot mặc định, hoặc dán token từ @BotFather'
                        }
                        className="font-tabular"
                      />
                    </Form.Item>
                  </div>

                  <div>
                    <label
                      htmlFor="groups-telegram-chat-id"
                      className="block text-xs font-medium text-slate-700 mb-1.5"
                    >
                      Telegram Group Chat ID
                    </label>
                    <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-start">
                      <Form.Item
                        name="telegramChatId"
                        style={{ marginBottom: 0 }}
                        className="flex-1"
                        rules={[
                          {
                            validator: (_, val) => {
                              if (isValidTelegramChatId(val, { allowEmpty: true })) {
                                return Promise.resolve();
                              }
                              return Promise.reject(
                                new Error('Chat ID nhóm thường bắt đầu bằng dấu - (vd: -1001234567890)')
                              );
                            },
                          },
                        ]}
                      >
                        <Input
                          id="groups-telegram-chat-id"
                          placeholder="Ví dụ: -1001234567890"
                          className="font-tabular"
                        />
                      </Form.Item>

                      {editingGroup && authSession?.groupId === editingGroup.id && (
                        <Button
                          icon={<Send className="w-3.5 h-3.5" />}
                          loading={testingTelegram}
                          onClick={handleTestTelegramClick}
                          className="shrink-0 whitespace-nowrap"
                        >
                          Gửi thử tin nhắn
                        </Button>
                      )}
                    </div>
                  </div>
                </div>

                {editingGroup &&
                  authSession?.groupId === editingGroup.id &&
                  serverAuthGroupId !== editingGroup.id && (
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-slate-200/80 text-xs text-amber-800">
                      <span>Phiên gửi Telegram chưa kích hoạt sau khi tải lại trang.</span>
                      <Button
                        size="small"
                        icon={<KeyRound className="w-3.5 h-3.5" />}
                        onClick={() => {
                          setModalOpen(false);
                          onReauthenticateTelegram?.(editingGroup);
                        }}
                      >
                        Xác nhận lại Leader
                      </Button>
                    </div>
                  )}
              </div>
            );
          })()}

          {!editingGroup && (
            <div className="flex items-center justify-between gap-4 pt-2">
              <span className="text-xs font-medium text-slate-700">
                Khởi tạo kèm danh sách 8 offer mẫu
              </span>
              <Form.Item
                name="copyDefaultCampaigns"
                valuePropName="checked"
                style={{ marginBottom: 0 }}
              >
                <Switch size="small" aria-label="Khởi tạo kèm danh sách 8 offer mẫu" />
              </Form.Item>
            </div>
          )}
        </Form>
      </Modal>
    </div>
  );
}
