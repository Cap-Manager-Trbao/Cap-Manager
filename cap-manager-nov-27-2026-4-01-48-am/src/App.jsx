import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ConfigProvider, Spin, message } from 'antd';
import viVN from 'antd/locale/vi_VN';
import {
  DEFAULT_OFFERS,
  DEFAULT_MEMBERS,
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
} from './data/defaultData.js';
import {
  createId,
  getTodayDateString,
  loadFromStorage,
  removeFromStorage,
  saveToStorage,
} from './utils/storage.js';
import {
  autoDistributeCaps,
  computeDistributionStats,
  computeRolloverPointOffsets,
  createEmptyMatrix,
  getActiveOffers,
  normalizeMatrix,
  sortOffersByPointsDesc,
} from './utils/capAlgorithm.js';
import { getSavedDistributionForDate } from './utils/dashboardSchedule.js';
import { exportDistributionToExcel } from './utils/excelService.js';
import {
  buildDashboardShareLink,
  computeDistributionDiff,
  computeDistributionMatrixHash,
  formatTelegramDiffMessage,
  formatTelegramDistributionMessage,
  formatTelegramPhotoCaption,
  getDefaultBotLabel,
  isValidTelegramChatId,
} from './utils/telegramMessages.js';
import { applyAiDistributionDirectives } from './utils/aiHelpers.js';
import { renderCapTablePngBase64 } from './utils/capTableImage.js';
import {
  checkServerAuthSession,
  deleteGroupTelegramBotToken,
  fetchTelegramServerStatus,
  loginLeaderOnServer,
  logoutLeaderOnServer,
  saveGroupTelegramBotToken,
  sendTelegramNotification,
  sendTelegramPhoto,
  sendTelegramShiftReminderNow,
  sendTelegramTestMessage,
} from './utils/telegramClient.js';
import { isValidTelegramBotToken } from './utils/telegramBotConfig.js';
import { testConnection } from './firebase.js';
import {
  addHistoryRecordInFirestore,
  batchUpdateGroupShiftScheduleInFirestore,
  changeLeaderPasswordInFirestore,
  createCapTransferInFirestore,
  createGroupInFirestore,
  deleteGroupInFirestore,
  deleteHistoryRecordInFirestore,
  isLeaderUsernameTaken,
  resolveCapTransferInFirestore,
  seedInitialGroupsIfEmpty,
  subscribeGroupHistory,
  subscribeGroupTransfers,
  subscribeGroups,
  toggleCapCompletionInFirestore,
  updateGroupInFirestore,
  updateMemberDateShiftsInFirestore,
  updateMemberMultiDateShiftsInFirestore,
  verifyLeaderLogin,
} from './utils/firestoreService.js';
import LayoutShell from './components/LayoutShell.jsx';
import DashboardView from './components/DashboardView.jsx';
import DistributionView from './components/DistributionView.jsx';
import CampaignsView from './components/CampaignsView.jsx';
import MembersView from './components/MembersView.jsx';
import GroupsView from './components/GroupsView.jsx';
import HistoryView from './components/HistoryView.jsx';
import SettingsView from './components/SettingsView.jsx';
import LoginModal from './components/LoginModal.jsx';
import ChangePasswordModal from './components/ChangePasswordModal.jsx';

const ANTD_THEME = {
  token: {
    colorPrimary: '#2563EB',
    colorInfo: '#2563EB',
    colorTextBase: '#0F172A',
    colorBgContainer: '#FFFFFF',
    borderRadius: 8,
    fontFamily: "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
};

function loadSavedAuthSession() {
  const saved = loadFromStorage(STORAGE_KEYS.AUTH_SESSION, null);
  if (!saved || typeof saved !== 'object' || !saved.groupId || !saved.username) {
    return null;
  }
  return saved;
}

const VIEWER_ALLOWED_TABS = new Set(['dashboard', 'members']);

function getInitialDeepLinkParams() {
  try {
    if (typeof window === 'undefined') return { groupId: null, date: null, tab: null };
    const params = new URLSearchParams(window.location.search);
    const rawGroupId = String(params.get('groupId') || '').trim();
    const rawDate = String(params.get('date') || '').trim();
    const rawTab = String(params.get('tab') || '').trim();
    return {
      groupId: /^[a-zA-Z0-9_-]{1,128}$/.test(rawGroupId) ? rawGroupId : null,
      date: /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null,
      tab: VIEWER_ALLOWED_TABS.has(rawTab) ? rawTab : null,
    };
  } catch {
    return { groupId: null, date: null, tab: null };
  }
}

export default function App() {
  const [messageApi, contextHolder] = message.useMessage();
  const [initialDeepLink] = useState(() => getInitialDeepLinkParams());
  const [activeTab, setActiveTab] = useState(() => initialDeepLink.tab || 'dashboard');
  const [distributionDate, setDistributionDate] = useState(
    () => initialDeepLink.date || getTodayDateString()
  );
  const [dashboardDate, setDashboardDate] = useState(
    () => initialDeepLink.date || getTodayDateString()
  );

  const [groups, setGroups] = useState([]);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [syncError, setSyncError] = useState(null);
  const [history, setHistory] = useState([]);
  const [transfers, setTransfers] = useState([]);
  const [telegramStatus, setTelegramStatus] = useState({
    checked: false,
    configured: false,
    defaultConfigured: false,
    encryptionEnvConfigured: false,
    aiConfigured: false,
    byGroup: {},
    serverDateVN: '',
    serverTimeVN: '',
  });

  const [activeGroupId, setActiveGroupId] = useState(() => {
    if (initialDeepLink.groupId) return initialDeepLink.groupId;
    const savedId = loadFromStorage(STORAGE_KEYS.ACTIVE_GROUP_ID, null);
    return savedId || 'group-1';
  });
  const [authSession, setAuthSession] = useState(() => loadSavedAuthSession());
  const [serverAuthGroupId, setServerAuthGroupId] = useState(null);
  const pendingTelegramActionRef = useRef(null);
  const publishingRef = useRef(false);
  const [isPublishingDistribution, setIsPublishingDistribution] = useState(false);
  const [deliveredMatrixHashes, setDeliveredMatrixHashes] = useState({});

  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [loginPreselectGroup, setLoginPreselectGroup] = useState(null);
  const [changePwdModalOpen, setChangePwdModalOpen] = useState(false);
  const [alternativesByGroup, setAlternativesByGroup] = useState({});
  const [lockedCellsByGroup, setLockedCellsByGroup] = useState(() => {
    const saved = loadFromStorage(STORAGE_KEYS.LOCKED_CELLS, {});
    return saved && typeof saved === 'object' ? saved : {};
  });
  const [seedCounter, setSeedCounter] = useState(1);

  // Throw Firestore fatal errors to ErrorBoundary
  if (syncError) {
    throw syncError;
  }

  // Initial Firestore bootstrap + real-time subscription for all shared groups
  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};

    async function initFirestore() {
      try {
        await testConnection();
        await seedInitialGroupsIfEmpty();
        if (!active) return;

        unsubscribe = subscribeGroups(
          (syncedGroups) => {
            if (!active) return;
            setGroups(syncedGroups);
            setGroupsLoaded(true);
          },
          (err) => {
            if (!active) return;
            setSyncError(err);
          }
        );
      } catch (err) {
        if (!active) return;
        setSyncError(err);
      }
    }

    initFirestore();
    fetchTelegramServerStatus().then((status) => {
      if (!active) return;
      setTelegramStatus({
        checked: true,
        configured: status.configured,
        defaultConfigured: status.defaultConfigured,
        encryptionEnvConfigured: status.encryptionEnvConfigured,
        aiConfigured: Boolean(status.aiConfigured),
        byGroup: status.byGroup || {},
        serverDateVN: status.serverDateVN || '',
        serverTimeVN: status.serverTimeVN,
      });
    });
    checkServerAuthSession().then((res) => {
      if (!active) return;
      if (res.authenticated && res.groupId) {
        setServerAuthGroupId(res.groupId);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const activeGroup = useMemo(() => {
    if (groups.length === 0) return null;
    return groups.find((g) => g.id === activeGroupId) || groups[0];
  }, [groups, activeGroupId]);

  // Keep activeGroupId valid when groups sync from Firestore
  useEffect(() => {
    if (groupsLoaded && groups.length > 0 && !groups.some((g) => g.id === activeGroupId)) {
      setActiveGroupId(groups[0].id);
    }
  }, [groupsLoaded, groups, activeGroupId]);

  // Validate persisted Leader session against synced Firestore groups
  useEffect(() => {
    if (!groupsLoaded || !authSession) return;
    const matched = groups.find(
      (g) =>
        g.id === authSession.groupId &&
        g.leaderAccount?.username?.toLowerCase() === String(authSession.username).toLowerCase()
    );
    if (!matched) {
      setAuthSession(null);
    }
  }, [groupsLoaded, groups, authSession]);

  // Subscribe to history & transfers subcollections of activeGroup
  useEffect(() => {
    if (!activeGroup?.id) {
      setHistory([]);
      setTransfers([]);
      return () => {};
    }
    const unsubHistory = subscribeGroupHistory(
      activeGroup.id,
      (records) => setHistory(records),
      (err) => setSyncError(err)
    );
    const unsubTransfers = subscribeGroupTransfers(
      activeGroup.id,
      (items) => setTransfers(items),
      (err) => setSyncError(err)
    );
    return () => {
      unsubHistory();
      unsubTransfers();
    };
  }, [activeGroup?.id]);

  const canEditActiveGroup = Boolean(
    authSession && activeGroup && authSession.groupId === activeGroup.id
  );
  const telegramSessionActive = Boolean(
    activeGroup?.id && serverAuthGroupId === activeGroup.id
  );

  // Enforce Viewer tab restrictions when not logged in as Leader of the active group
  useEffect(() => {
    if (!canEditActiveGroup && !VIEWER_ALLOWED_TABS.has(activeTab)) {
      setActiveTab('dashboard');
    }
  }, [canEditActiveGroup, activeTab]);

  useEffect(() => {
    if (activeGroup?.id) {
      saveToStorage(STORAGE_KEYS.ACTIVE_GROUP_ID, activeGroup.id);
    }
  }, [activeGroup?.id]);

  useEffect(() => {
    if (authSession) {
      saveToStorage(STORAGE_KEYS.AUTH_SESSION, authSession);
    } else {
      removeFromStorage(STORAGE_KEYS.AUTH_SESSION);
    }
  }, [authSession]);

  useEffect(() => {
    saveToStorage(STORAGE_KEYS.LOCKED_CELLS, lockedCellsByGroup);
  }, [lockedCellsByGroup]);

  useEffect(() => {
    if (!groupsLoaded || !activeGroup?.id) return;
    const validCampIds = new Set(
      getActiveOffers(activeGroup.campaigns || []).map((c) => c.id)
    );
    const validMemIds = new Set((activeGroup.members || []).map((m) => m.id));
    setLockedCellsByGroup((prev) => {
      const currentGroupLocks = prev[activeGroup.id];
      if (!currentGroupLocks || typeof currentGroupLocks !== 'object') return prev;
      let changed = false;
      const cleaned = {};
      for (const [campId, memMap] of Object.entries(currentGroupLocks)) {
        if (!validCampIds.has(campId) || !memMap || typeof memMap !== 'object') {
          changed = true;
          continue;
        }
        const nextMemMap = {};
        for (const [memId, locked] of Object.entries(memMap)) {
          if (validMemIds.has(memId) && locked) {
            nextMemMap[memId] = true;
          } else {
            changed = true;
          }
        }
        if (Object.keys(nextMemMap).length > 0) {
          cleaned[campId] = nextMemMap;
        } else {
          changed = true;
        }
      }
      if (!changed) return prev;
      return { ...prev, [activeGroup.id]: cleaned };
    });
  }, [groupsLoaded, activeGroup?.id, activeGroup?.campaigns, activeGroup?.members]);

  const members = activeGroup?.members || [];
  const allCampaigns = useMemo(
    () => sortOffersByPointsDesc(activeGroup?.campaigns || []),
    [activeGroup?.campaigns]
  );
  const campaigns = useMemo(() => getActiveOffers(allCampaigns), [allCampaigns]);
  const settings = activeGroup?.settings || DEFAULT_SETTINGS;
  const matrix = useMemo(
    () => normalizeMatrix(activeGroup?.matrix, campaigns, members),
    [activeGroup?.matrix, campaigns, members]
  );

  const stats = useMemo(
    () => computeDistributionStats(matrix, campaigns, members, distributionDate),
    [matrix, campaigns, members, distributionDate]
  );

  const rolloverInfo = useMemo(
    () => computeRolloverPointOffsets(history, members, distributionDate),
    [history, members, distributionDate]
  );

  const activeGroupTelegramStatus = useMemo(() => {
    const entry = activeGroup?.id ? telegramStatus.byGroup?.[activeGroup.id] : null;
    if (entry) return entry;
    return {
      configured: Boolean(telegramStatus.defaultConfigured),
      source: telegramStatus.defaultConfigured ? 'env_default' : 'none',
      botUsername: '',
      tokenMasked: '',
      encryptedAtRest: Boolean(telegramStatus.defaultConfigured),
      decryptError: false,
      schedulerState: null,
    };
  }, [activeGroup?.id, telegramStatus]);

  const currentDistributionDate = distributionDate || getTodayDateString();
  const currentDistributionMatrixHash = useMemo(
    () => computeDistributionMatrixHash(campaigns, members, matrix),
    [campaigns, members, matrix]
  );

  const deliveredEntryForCurrentDate = useMemo(() => {
    if (!activeGroup?.id) return null;
    const memKey = `${activeGroup.id}:${currentDistributionDate}`;
    const localEntry = deliveredMatrixHashes[memKey];
    const sched = activeGroupTelegramStatus?.schedulerState;
    if (
      sched?.lastDistributionSentDate === currentDistributionDate &&
      sched?.lastDistributionMatrixHash
    ) {
      if (localEntry?.matrixHash === currentDistributionMatrixHash) return localEntry;
      return {
        matrixHash: sched.lastDistributionMatrixHash,
        sentAt: sched.lastDistributionSentAt || '',
      };
    }
    return localEntry || null;
  }, [
    activeGroup?.id,
    currentDistributionDate,
    currentDistributionMatrixHash,
    deliveredMatrixHashes,
    activeGroupTelegramStatus?.schedulerState,
  ]);

  const isTelegramDeliveredForCurrentMatrix = Boolean(
    deliveredEntryForCurrentDate &&
      deliveredEntryForCurrentDate.matrixHash === currentDistributionMatrixHash
  );
  const telegramSentAtForCurrentDate = deliveredEntryForCurrentDate?.sentAt || '';

  const refreshTelegramStatus = async (targetGroupId = activeGroup?.id || '') => {
    const status = await fetchTelegramServerStatus(targetGroupId);
    if (!status.ok) return;
    setTelegramStatus({
      checked: true,
      configured: status.configured,
      defaultConfigured: status.defaultConfigured,
      encryptionEnvConfigured: status.encryptionEnvConfigured,
      aiConfigured: Boolean(status.aiConfigured),
      byGroup: status.byGroup || {},
      serverDateVN: status.serverDateVN || '',
      serverTimeVN: status.serverTimeVN,
    });
  };

  const updateActiveGroup = async (updater, newPassword = '', options = {}) => {
    if (!activeGroup) return false;
    const targetId = activeGroup.id;
    const prevGroup = activeGroup;
    const nextGroup = updater(activeGroup);

    setGroups((prev) => prev.map((g) => (g.id === targetId ? nextGroup : g)));
    try {
      await updateGroupInFirestore(targetId, nextGroup, newPassword, options);
      return true;
    } catch {
      setGroups((prev) => prev.map((g) => (g.id === targetId ? prevGroup : g)));
      messageApi.error('Không thể đồng bộ thay đổi lên máy chủ. Vui lòng thử lại.');
      return false;
    }
  };

  const notify = (type, text) => {
    if (type === 'error') messageApi.error(text);
    else if (type === 'warning') messageApi.warning(text);
    else messageApi.success(text);
  };

  const requireLeaderPermission = () => {
    if (canEditActiveGroup) return true;
    messageApi.warning(`Vui lòng đăng nhập tài khoản Leader của ${activeGroup?.name} để chỉnh sửa.`);
    setLoginPreselectGroup(activeGroup);
    setLoginModalOpen(true);
    return false;
  };

  const requestTelegramReauth = (pendingAction, targetGroup = activeGroup) => {
    pendingTelegramActionRef.current = pendingAction || null;
    setServerAuthGroupId(null);
    setLoginPreselectGroup(targetGroup || activeGroup);
    setLoginModalOpen(true);
    messageApi.info('Vui lòng xác nhận mật khẩu Leader để kích hoạt phiên gửi Telegram.');
  };

  // Auth Handlers (verified against server + Firestore groupCredentials)
  const handleLogin = async (username, password) => {
    try {
      const serverRes = await loginLeaderOnServer(username, password);
      let result = serverRes;
      if (!serverRes.ok && serverRes.status === 0) {
        result = await verifyLeaderLogin(username, password);
      }

      if (!result.ok || !result.session) {
        messageApi.error(result.error || 'Sai tên đăng nhập hoặc mật khẩu Leader.');
        return false;
      }

      const matchedGroup = groups.find((g) => g.id === result.session.groupId);
      setAuthSession(result.session);
      setActiveGroupId(result.session.groupId);
      if (serverRes.ok) {
        setServerAuthGroupId(result.session.groupId);
      } else {
        setServerAuthGroupId(null);
      }
      messageApi.success(`Đã đăng nhập quyền Nhóm trưởng: ${matchedGroup?.name || result.session.displayName}`);

      const pending = pendingTelegramActionRef.current;
      if (pending && serverRes.ok && pending.groupId === result.session.groupId) {
        pendingTelegramActionRef.current = null;
        void (async () => {
          if (pending.type === 'test') {
            await handleTestTelegram(pending.groupId, pending.chatId, {
              botToken: pending.botToken || '',
              allowReauthPrompt: false,
            });
          } else if (pending.type === 'reminder') {
            await handleSendShiftReminderNow(pending.groupId, { allowReauthPrompt: false });
          } else if (pending.type === 'saveToken') {
            await handleSaveGroupTelegramBotToken(pending.groupId, pending.botToken, {
              allowReauthPrompt: false,
            });
          } else if (pending.type === 'deleteToken') {
            await handleDeleteGroupTelegramBotToken(pending.groupId, {
              allowReauthPrompt: false,
            });
          } else if (pending.type === 'photo') {
            const meta = {
              distributionDate: pending.distributionDate,
              matrixHash: pending.matrixHash,
            };
            let tgRes = await sendTelegramPhoto(
              pending.groupId,
              pending.imageBase64,
              pending.caption,
              pending.replyMarkup || null,
              meta
            );
            if (!tgRes.ok && pending.fallbackMessage) {
              tgRes = await sendTelegramNotification(
                pending.groupId,
                pending.fallbackMessage,
                pending.replyMarkup || null,
                meta
              );
            }
            if (tgRes.ok) {
              if (pending.distributionDate && pending.matrixHash) {
                setDeliveredMatrixHashes((prev) => ({
                  ...prev,
                  [`${pending.groupId}:${pending.distributionDate}`]: {
                    matrixHash: pending.matrixHash,
                    sentAt: new Date().toISOString(),
                  },
                }));
                void refreshTelegramStatus(pending.groupId);
              }
              messageApi.success(
                pending.successMessage ||
                  `${getDefaultBotLabel(pending.groupId)} đã gửi bảng chia CAP vào Group Telegram.`
              );
            } else {
              messageApi.warning(`Chưa gửi được Telegram: ${tgRes.error}`);
            }
          } else if (pending.type === 'notify') {
            const meta = {
              distributionDate: pending.distributionDate,
              matrixHash: pending.matrixHash,
            };
            const tgRes = await sendTelegramNotification(
              pending.groupId,
              pending.message,
              pending.replyMarkup || null,
              meta
            );
            if (tgRes.ok) {
              if (pending.distributionDate && pending.matrixHash) {
                setDeliveredMatrixHashes((prev) => ({
                  ...prev,
                  [`${pending.groupId}:${pending.distributionDate}`]: {
                    matrixHash: pending.matrixHash,
                    sentAt: new Date().toISOString(),
                  },
                }));
                void refreshTelegramStatus(pending.groupId);
              }
              messageApi.success(
                pending.successMessage || 'Đã gửi thông báo bảng chia CAP vào Group Telegram.'
              );
            } else {
              messageApi.warning(`Chưa gửi được Telegram: ${tgRes.error}`);
            }
          }
        })();
      } else if (pending) {
        pendingTelegramActionRef.current = null;
      }

      return true;
    } catch {
      messageApi.error('Lỗi xác thực tài khoản Leader. Vui lòng thử lại.');
      return false;
    }
  };

  const handleLogout = () => {
    void logoutLeaderOnServer();
    setAuthSession(null);
    setServerAuthGroupId(null);
    pendingTelegramActionRef.current = null;
    if (!VIEWER_ALLOWED_TABS.has(activeTab)) {
      setActiveTab('dashboard');
    }
    messageApi.info('Đã chuyển sang chế độ người xem (Xem chia CAP & Quản lý ca làm).');
  };

  const handleChangeLeaderPassword = async (currentPassword, newPassword) => {
    if (!activeGroup || !canEditActiveGroup) {
      return { ok: false, error: 'Bạn cần đăng nhập quyền Leader của nhóm này.' };
    }
    try {
      const res = await changeLeaderPasswordInFirestore(
        activeGroup.id,
        currentPassword,
        newPassword
      );
      if (res?.ok) {
        messageApi.success(`Đã đổi mật khẩu Leader cho ${activeGroup.name}.`);
        return { ok: true };
      }
      return { ok: false, error: res?.error || 'Không thể đổi mật khẩu.' };
    } catch {
      return { ok: false, error: 'Lỗi hệ thống khi cập nhật mật khẩu.' };
    }
  };

  // Group CRUD (persisted to Firestore across all devices)
  const handleCreateGroup = async ({
    name,
    description,
    leaderDisplayName,
    leaderUsername,
    leaderPassword,
    copyDefaultCampaigns,
    telegramEnabled,
    telegramChatId,
    telegramShiftReminderEnabled,
    telegramBotToken,
  }) => {
    try {
      const taken = await isLeaderUsernameTaken(leaderUsername);
      if (taken) {
        messageApi.error(`Tài khoản "${leaderUsername}" đã tồn tại. Vui lòng chọn tên đăng nhập khác.`);
        return false;
      }

      const newId = createId('group');
      const newCampaigns = copyDefaultCampaigns ? structuredClone(DEFAULT_OFFERS) : [];
      const newMembers = [
        {
          id: createId('mem'),
          name: leaderDisplayName.replace(/\s*\(.*?\)\s*/g, '').trim() || 'Leader',
          isLeader: true,
          isNew: false,
          active: true,
          priority: 'normal',
          shifts: ['ca1', 'ca2', 'ca3'],
          shiftSchedule: { [getTodayDateString()]: ['ca1', 'ca2', 'ca3'] },
        },
      ];
      const newMatrix = createEmptyMatrix(newCampaigns, newMembers);

      const newGroup = {
        id: newId,
        name,
        description,
        leaderAccount: {
          username: leaderUsername,
          displayName: leaderDisplayName,
        },
        members: newMembers,
        campaigns: newCampaigns,
        matrix: newMatrix,
        autoBackup: newMatrix,
        settings: {
          ...DEFAULT_SETTINGS,
          telegramEnabled: Boolean(telegramEnabled),
          telegramChatId: String(telegramChatId || '').trim(),
          telegramShiftReminderEnabled: telegramShiftReminderEnabled !== false,
        },
      };

      const created = await createGroupInFirestore(newGroup, leaderPassword);
      const serverLogin = await loginLeaderOnServer(created.leaderAccount.username, leaderPassword);
      setActiveGroupId(newId);
      setAuthSession({
        username: created.leaderAccount.username,
        displayName: created.leaderAccount.displayName,
        groupId: newId,
      });
      if (serverLogin.ok) {
        setServerAuthGroupId(newId);
        const cleanBotToken = String(telegramBotToken || '').trim();
        if (cleanBotToken) {
          const botRes = await saveGroupTelegramBotToken(newId, cleanBotToken);
          if (!botRes.ok) {
            messageApi.warning(
              `Đã tạo nhóm, nhưng chưa lưu được Bot Token riêng: ${botRes.error}`
            );
          }
        }
      }
      void refreshTelegramStatus(newId);
      return true;
    } catch {
      messageApi.error('Không thể tạo nhóm mới trên cơ sở dữ liệu.');
      return false;
    }
  };

  const handleUpdateGroup = async (groupId, updates, newPassword = '') => {
    try {
      const existingGroup = groups.find((g) => g.id === groupId);
      if (!existingGroup) return false;

      if (updates.leaderAccount?.username) {
        const taken = await isLeaderUsernameTaken(updates.leaderAccount.username, groupId);
        if (taken) {
          messageApi.error(`Tài khoản "${updates.leaderAccount.username}" đã thuộc về nhóm khác.`);
          return false;
        }
      }

      const nextGroup = {
        ...existingGroup,
        ...updates,
        settings: updates.settings
          ? { ...(existingGroup.settings || DEFAULT_SETTINGS), ...updates.settings }
          : existingGroup.settings,
      };
      setGroups((prev) => prev.map((g) => (g.id === groupId ? nextGroup : g)));
      await updateGroupInFirestore(groupId, nextGroup, newPassword);

      if (authSession?.groupId === groupId && updates.leaderAccount) {
        setAuthSession({
          username: updates.leaderAccount.username,
          displayName: updates.leaderAccount.displayName,
          groupId,
        });
      }
      if (authSession?.groupId === groupId && newPassword) {
        const nextUser = updates.leaderAccount?.username || existingGroup.leaderAccount?.username;
        if (nextUser) {
          const serverLogin = await loginLeaderOnServer(nextUser, newPassword);
          if (serverLogin.ok) {
            setServerAuthGroupId(groupId);
          }
        }
      }

      const cleanBotToken = String(updates.telegramBotToken || '').trim();
      if (cleanBotToken) {
        const botRes = await handleSaveGroupTelegramBotToken(groupId, cleanBotToken, {
          allowReauthPrompt: true,
        });
        if (!botRes?.ok) {
          return false;
        }
      } else {
        void refreshTelegramStatus(groupId);
      }
      return true;
    } catch {
      messageApi.error('Không thể cập nhật thông tin nhóm.');
      return false;
    }
  };

  const handleDeleteGroup = async (groupId) => {
    if (groups.length <= 1 || groupId === 'group-1') {
      messageApi.warning('Không thể xóa nhóm mặc định.');
      return;
    }
    try {
      await deleteGroupInFirestore(groupId);
      const remaining = groups.filter((g) => g.id !== groupId);
      if (activeGroupId === groupId && remaining[0]) {
        setActiveGroupId(remaining[0].id);
      }
      if (authSession?.groupId === groupId) {
        setAuthSession(null);
      }
      messageApi.success('Đã xóa nhóm.');
    } catch {
      messageApi.error('Không thể xóa nhóm trên cơ sở dữ liệu.');
    }
  };

  // History & Publishing to Dashboard
  const handleSaveHistory = async (
    dateStr,
    noteStr = '',
    overrideMatrix = null,
    overwriteHistoryId = null,
    customSuccessMessage = null
  ) => {
    if (!requireLeaderPermission()) return false;
    const targetMatrix = overrideMatrix || matrix;
    const targetDate = dateStr || distributionDate || getTodayDateString();
    const snapStats = computeDistributionStats(targetMatrix, campaigns, members, targetDate);

    if (!snapStats.isAllValid) {
      messageApi.warning('Lưu ý: Bản lưu hiện có offer chưa khớp tổng CAP.');
    }

    const record = {
      id: createId('hist'),
      date: targetDate,
      note: noteStr,
      savedAt: new Date().toISOString(),
      members: structuredClone(members),
      campaigns: structuredClone(campaigns),
      matrix: structuredClone(snapStats.matrix),
      stats: {
        assignedTotalCap: snapStats.assignedTotalCap,
        expectedTotalCap: snapStats.expectedTotalCap,
        assignedTotalPoints: snapStats.assignedTotalPoints,
        capSpread: snapStats.capSpread,
        pointSpread: snapStats.pointSpread,
      },
    };

    try {
      await addHistoryRecordInFirestore(activeGroup.id, record, overwriteHistoryId);
      messageApi.success(
        customSuccessMessage ||
          (overwriteHistoryId
            ? `Đã lưu cập nhật bảng chia CAP ngày ${record.date} vào lịch sử và Dashboard ${activeGroup.name}.`
            : `Đã lưu bảng chia CAP ngày ${record.date} vào lịch sử và hiển thị lên Dashboard ${activeGroup.name}.`)
      );
      return true;
    } catch {
      messageApi.error('Không thể lưu lịch sử lên máy chủ.');
      return false;
    }
  };

  const markDistributionDelivered = (groupId, targetDate, matrixHash) => {
    if (!groupId || !targetDate || !matrixHash) return;
    setDeliveredMatrixHashes((prev) => ({
      ...prev,
      [`${groupId}:${targetDate}`]: {
        matrixHash,
        sentAt: new Date().toISOString(),
      },
    }));
    void refreshTelegramStatus(groupId);
  };

  const dispatchDistributionTelegram = async ({
    targetGroup,
    targetDate,
    nextStats,
    existingForDate,
    isForceResend = false,
  }) => {
    const groupSettings = targetGroup?.settings || {};
    const chatId = String(groupSettings.telegramChatId || '').trim();
    if (!groupSettings.telegramEnabled) {
      if (isForceResend) {
        messageApi.warning('Nhóm đang tắt gửi thông báo Telegram trong Cài đặt.');
      }
      return false;
    }
    if (!isValidTelegramChatId(chatId)) {
      messageApi.warning(
        'Đã lưu bảng CAP, nhưng nhóm chưa cấu hình Telegram Group Chat ID hợp lệ trong Cài đặt.'
      );
      return false;
    }

    const matrixHash = computeDistributionMatrixHash(campaigns, members, nextStats.matrix);
    const sched = telegramStatus.byGroup?.[targetGroup.id]?.schedulerState;
    const localDelivered = deliveredMatrixHashes[`${targetGroup.id}:${targetDate}`];
    const alreadyDeliveredThisHash =
      localDelivered?.matrixHash === matrixHash ||
      (sched?.lastDistributionSentDate === targetDate &&
        sched?.lastDistributionMatrixHash === matrixHash);

    let diffs = [];
    if (existingForDate) {
      diffs = computeDistributionDiff(
        existingForDate,
        {
          members,
          campaigns,
          matrix: nextStats.matrix,
        },
        campaigns,
        members
      );
    }

    if (!isForceResend && alreadyDeliveredThisHash && diffs.length === 0) {
      messageApi.info(
        'Bảng chia CAP này đã được lưu và gửi lên Telegram trước đó. Bấm "Gửi lại Telegram" nếu bạn muốn gửi lại.'
      );
      return true;
    }

    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const appLink = buildDashboardShareLink(origin, targetGroup.id, targetDate);
    const isUpdate = Boolean(existingForDate) && diffs.length > 0;
    const customTemplates = groupSettings?.telegramTemplates || {};
    const activeTemplate = isUpdate
      ? customTemplates.capUpdate || ''
      : customTemplates.capPublish || '';

    const replyMarkup = null;

    const botLabel = getDefaultBotLabel(targetGroup.id);

    const fallbackTextMessage =
      isUpdate && diffs.length > 0
        ? formatTelegramDiffMessage({
            groupId: targetGroup.id,
            groupName: targetGroup.name,
            dateStr: targetDate,
            diffs,
            stats: nextStats,
            appLink,
            customTemplate: activeTemplate,
          })
        : formatTelegramDistributionMessage({
            groupId: targetGroup.id,
            groupName: targetGroup.name,
            dateStr: targetDate,
            members,
            campaigns,
            matrix: nextStats.matrix,
            stats: nextStats,
            appLink,
            customTemplate: activeTemplate,
          });

    const imageBase64 = renderCapTablePngBase64({
      groupName: targetGroup.name,
      dateStr: targetDate,
      members,
      campaigns,
      matrix: nextStats.matrix,
      stats: nextStats,
    });

    const meta = { distributionDate: targetDate, matrixHash };

    if (imageBase64) {
      const caption = formatTelegramPhotoCaption({
        groupId: targetGroup.id,
        groupName: targetGroup.name,
        dateStr: targetDate,
        stats: nextStats,
        diffs,
        isUpdate,
        appLink,
        customTemplate: activeTemplate,
      });
      const successMsg = isUpdate
        ? `${botLabel} đã gửi ảnh bảng chia CAP cập nhật vào Group Telegram ${targetGroup.name}.`
        : `${botLabel} đã gửi ảnh bảng chia CAP ngày ${targetDate} vào Group Telegram ${targetGroup.name}.`;

      const tgRes = await sendTelegramPhoto(
        targetGroup.id,
        imageBase64,
        caption,
        replyMarkup,
        meta
      );
      if (tgRes.ok) {
        setServerAuthGroupId(targetGroup.id);
        markDistributionDelivered(targetGroup.id, targetDate, matrixHash);
        messageApi.success(successMsg);
        return true;
      }
      if (tgRes.status === 401) {
        requestTelegramReauth({
          type: 'photo',
          groupId: targetGroup.id,
          imageBase64,
          caption,
          fallbackMessage: fallbackTextMessage,
          replyMarkup,
          distributionDate: targetDate,
          matrixHash,
          successMessage: successMsg,
        });
        return false;
      }

      const fallbackRes = await sendTelegramNotification(
        targetGroup.id,
        fallbackTextMessage,
        replyMarkup,
        meta
      );
      if (fallbackRes.ok) {
        setServerAuthGroupId(targetGroup.id);
        markDistributionDelivered(targetGroup.id, targetDate, matrixHash);
        messageApi.success(
          `${botLabel} đã gửi bảng chia CAP (tin nhắn văn bản dự phòng) vào Group Telegram ${targetGroup.name}.`
        );
        return true;
      }
      messageApi.warning(
        `Đã lưu bảng CAP, nhưng chưa gửi được Telegram: ${fallbackRes.error || tgRes.error}`
      );
      return false;
    }

    const successMsg = isUpdate
      ? `${botLabel} đã gửi cập nhật bảng chia CAP vào Group Telegram ${targetGroup.name}.`
      : `${botLabel} đã gửi bảng chia CAP ngày ${targetDate} vào Group Telegram ${targetGroup.name}.`;

    const tgRes = await sendTelegramNotification(
      targetGroup.id,
      fallbackTextMessage,
      replyMarkup,
      meta
    );
    if (tgRes.ok) {
      setServerAuthGroupId(targetGroup.id);
      markDistributionDelivered(targetGroup.id, targetDate, matrixHash);
      messageApi.success(successMsg);
      return true;
    }
    if (tgRes.status === 401) {
      requestTelegramReauth({
        type: 'notify',
        groupId: targetGroup.id,
        message: fallbackTextMessage,
        replyMarkup,
        distributionDate: targetDate,
        matrixHash,
        successMessage: successMsg,
      });
      return false;
    }
    messageApi.warning(`Đã lưu bảng CAP, nhưng chưa gửi được Telegram: ${tgRes.error}`);
    return false;
  };

  const handlePublishDistribution = async (dateStr) => {
    if (!requireLeaderPermission()) return false;
    if (publishingRef.current) return false;

    publishingRef.current = true;
    setIsPublishingDistribution(true);
    try {
      const targetDate = dateStr || distributionDate || getTodayDateString();
      const existingForDate = getSavedDistributionForDate(history, targetDate);
      const nextStats = computeDistributionStats(matrix, campaigns, members, targetDate);

      const saved = await handleSaveHistory(
        targetDate,
        existingForDate?.note || 'Bảng chia CAP chính thức',
        null,
        existingForDate?.id || null,
        `Đã lưu bảng chia CAP ngày ${targetDate} vào lịch sử và hiển thị bên Dashboard.`
      );
      if (!saved) return false;

      setDashboardDate(targetDate);

      await dispatchDistributionTelegram({
        targetGroup: activeGroup,
        targetDate,
        nextStats,
        existingForDate,
        isForceResend: false,
      });

      return true;
    } finally {
      publishingRef.current = false;
      setIsPublishingDistribution(false);
    }
  };

  const handleResendDistributionTelegram = async (dateStr) => {
    if (!requireLeaderPermission()) return false;
    if (!activeGroup || publishingRef.current) return false;

    publishingRef.current = true;
    setIsPublishingDistribution(true);
    try {
      const targetDate = dateStr || distributionDate || getTodayDateString();
      const existingForDate = getSavedDistributionForDate(history, targetDate);
      const nextStats = computeDistributionStats(matrix, campaigns, members, targetDate);
      return await dispatchDistributionTelegram({
        targetGroup: activeGroup,
        targetDate,
        nextStats,
        existingForDate,
        isForceResend: true,
      });
    } finally {
      publishingRef.current = false;
      setIsPublishingDistribution(false);
    }
  };

  const handleSaveGroupTelegramBotToken = async (
    groupId,
    botToken,
    { allowReauthPrompt = true } = {}
  ) => {
    const cleanToken = String(botToken || '').trim();
    if (!isValidTelegramBotToken(cleanToken)) {
      messageApi.error(
        'Bot Token không hợp lệ. Token từ @BotFather thường có dạng 123456789:AAH...'
      );
      return { ok: false, error: 'Định dạng Bot Token không hợp lệ.' };
    }
    const res = await saveGroupTelegramBotToken(groupId, cleanToken);
    if (res.ok) {
      setServerAuthGroupId(groupId);
      if (res.groupStatus) {
        setTelegramStatus((prev) => ({
          ...prev,
          configured: groupId === activeGroup?.id ? res.groupStatus.configured : prev.configured,
          byGroup: {
            ...(prev.byGroup || {}),
            [groupId]: res.groupStatus,
          },
        }));
      } else {
        void refreshTelegramStatus(groupId);
      }
      const botLabel = res.botUsername ? `@${res.botUsername}` : 'Bot riêng';
      messageApi.success(`Đã xác minh và lưu ${botLabel} cho nhóm!`);
    } else if (res.status === 401) {
      if (allowReauthPrompt) {
        const targetGroup = groups.find((g) => g.id === groupId) || activeGroup;
        requestTelegramReauth({ type: 'saveToken', groupId, botToken: cleanToken }, targetGroup);
      } else {
        messageApi.warning(res.error || 'Vui lòng đăng nhập lại Leader để lưu Bot Token.');
      }
    } else {
      messageApi.error(res.error || 'Không thể lưu Bot Token riêng cho nhóm.');
    }
    return res;
  };

  const handleDeleteGroupTelegramBotToken = async (
    groupId,
    { allowReauthPrompt = true } = {}
  ) => {
    const res = await deleteGroupTelegramBotToken(groupId);
    if (res.ok) {
      setServerAuthGroupId(groupId);
      if (res.groupStatus) {
        setTelegramStatus((prev) => ({
          ...prev,
          configured: groupId === activeGroup?.id ? res.groupStatus.configured : prev.configured,
          byGroup: {
            ...(prev.byGroup || {}),
            [groupId]: res.groupStatus,
          },
        }));
      } else {
        void refreshTelegramStatus(groupId);
      }
      messageApi.success('Đã xóa Bot Token riêng của nhóm.');
    } else if (res.status === 401) {
      if (allowReauthPrompt) {
        const targetGroup = groups.find((g) => g.id === groupId) || activeGroup;
        requestTelegramReauth({ type: 'deleteToken', groupId }, targetGroup);
      } else {
        messageApi.warning(res.error || 'Vui lòng đăng nhập lại Leader để xóa Bot Token.');
      }
    } else {
      messageApi.error(res.error || 'Không thể xóa Bot Token riêng của nhóm.');
    }
    return res;
  };

  const handleTestTelegram = async (
    groupId,
    chatId,
    { allowReauthPrompt = true, botToken = '' } = {}
  ) => {
    const cleanChatId = String(chatId || '').trim();
    const cleanBotToken = String(botToken || '').trim();
    if (!isValidTelegramChatId(cleanChatId)) {
      messageApi.error('Telegram Group Chat ID không hợp lệ (ví dụ: -1001234567890).');
      return { ok: false, error: 'Telegram Group Chat ID không hợp lệ.' };
    }
    if (cleanBotToken && !isValidTelegramBotToken(cleanBotToken)) {
      messageApi.error('Bot Token vừa nhập chưa đúng định dạng @BotFather (vd: 123456789:AAH...).');
      return { ok: false, error: 'Bot Token không đúng định dạng.' };
    }
    const res = await sendTelegramTestMessage(groupId, cleanChatId, cleanBotToken);
    if (res.ok) {
      setServerAuthGroupId(groupId);
      messageApi.success('Đã gửi tin nhắn thử thành công tới Group Telegram!');
    } else if (res.status === 401) {
      if (allowReauthPrompt) {
        const targetGroup = groups.find((g) => g.id === groupId) || activeGroup;
        requestTelegramReauth(
          { type: 'test', groupId, chatId: cleanChatId, botToken: cleanBotToken },
          targetGroup
        );
      } else {
        messageApi.warning(res.error || 'Vui lòng đăng nhập lại Leader để kiểm tra kết nối Telegram.');
      }
    } else {
      messageApi.warning(res.error || 'Chưa gửi được tin nhắn thử Telegram.');
    }
    return res;
  };

  const handleSendShiftReminderNow = async (groupId, { allowReauthPrompt = true } = {}) => {
    const res = await sendTelegramShiftReminderNow(groupId);
    if (res.ok) {
      setServerAuthGroupId(groupId);
      messageApi.success('Đã gửi tin nhắn nhắc mọi người đăng ký ca làm vào Group Telegram!');
    } else if (res.status === 401) {
      if (allowReauthPrompt) {
        const targetGroup = groups.find((g) => g.id === groupId) || activeGroup;
        requestTelegramReauth({ type: 'reminder', groupId }, targetGroup);
      } else {
        messageApi.warning(res.error || 'Vui lòng đăng nhập lại Leader để gửi nhắc ca Telegram.');
      }
    } else {
      messageApi.warning(res.error || 'Chưa gửi được tin nhắn nhắc ca Telegram.');
    }
    return res;
  };

  // Real-time CAP Completion Toggle (allowed for both Viewer & Leader)
  const handleToggleCompletion = async (offerId, memberId, nextDone, dateOverride = null) => {
    if (!activeGroup?.id) return;
    const targetId = activeGroup.id;
    const targetDate = dateOverride || dashboardDate || getTodayDateString();
    const prevCompletions = activeGroup.completions || {};

    setGroups((prev) =>
      prev.map((g) => {
        if (g.id !== targetId) return g;
        const nextComp = { ...(g.completions || {}) };
        const nextDateMap = { ...(nextComp[targetDate] || {}) };
        const nextOfferMap = { ...(nextDateMap[offerId] || {}) };
        if (nextDone) {
          nextOfferMap[memberId] = true;
        } else {
          delete nextOfferMap[memberId];
        }
        if (Object.keys(nextOfferMap).length > 0) {
          nextDateMap[offerId] = nextOfferMap;
        } else {
          delete nextDateMap[offerId];
        }
        if (Object.keys(nextDateMap).length > 0) {
          nextComp[targetDate] = nextDateMap;
        } else {
          delete nextComp[targetDate];
        }
        return { ...g, completions: nextComp };
      })
    );

    try {
      await toggleCapCompletionInFirestore(targetId, targetDate, offerId, memberId, nextDone);
    } catch {
      setGroups((prev) =>
        prev.map((g) => (g.id === targetId ? { ...g, completions: prevCompletions } : g))
      );
      messageApi.error('Không thể đồng bộ trạng thái hoàn thành lên máy chủ.');
    }
  };

  // Distribution
  const runDistribution = async (customSeed, switchToDistribute = true) => {
    if (!requireLeaderPermission()) return;
    const targetDate = distributionDate || getTodayDateString();
    const groupLocked = lockedCellsByGroup[activeGroup.id] || {};
    const res = autoDistributeCaps(members, campaigns, settings, customSeed, targetDate, {
      lockedCells: groupLocked,
      baseMatrix: matrix,
      rolloverOffsets: rolloverInfo.offsetsByMemberId,
    });
    if (!res.ok) {
      messageApi.error(res.error);
      return;
    }

    const synced = await updateActiveGroup(
      (g) => ({
        ...g,
        matrix: res.matrix,
        autoBackup: res.matrix,
      }),
      '',
      { preserveLatestMembers: true }
    );
    if (!synced) return;
    setAlternativesByGroup((prev) => ({
      ...prev,
      [activeGroup.id]: res.alternatives || [],
    }));

    if (switchToDistribute) {
      setActiveTab('distribute');
    }

    messageApi.success(
      `Đã chia nháp ${res.stats.assignedTotalCap} CAP (${res.stats.assignedTotalPoints.toLocaleString('vi-VN')} point). Bấm "Lưu bảng chia CAP" để lưu lịch sử và hiển thị bên Dashboard.`
    );
  };

  const handleAutoDistribute = () => {
    const nextSeed = seedCounter + 101;
    setSeedCounter(nextSeed);
    runDistribution(nextSeed, true);
  };

  const handleRedistributeVariant = () => {
    const nextSeed = seedCounter + 997;
    setSeedCounter(nextSeed);
    runDistribution(nextSeed, false);
  };

  const handleSelectAlternative = async (altMatrix) => {
    if (!requireLeaderPermission()) return;
    const normalized = normalizeMatrix(altMatrix, campaigns, members);
    const synced = await updateActiveGroup(
      (g) => ({
        ...g,
        matrix: normalized,
        autoBackup: normalized,
      }),
      '',
      { preserveLatestMembers: true }
    );
    if (!synced) return;
    messageApi.success('Đã chuyển sang phương án phân chia được chọn.');
  };

  const handleCellChange = async (campaignId, memberId, value) => {
    if (!requireLeaderPermission()) return;
    const cleanVal = Math.max(0, Math.floor(Number(value) || 0));
    await updateActiveGroup(
      (g) => ({
        ...g,
        matrix: {
          ...(g.matrix || {}),
          [campaignId]: {
            ...((g.matrix && g.matrix[campaignId]) || {}),
            [memberId]: cleanVal,
          },
        },
      }),
      '',
      { preserveLatestMembers: true }
    );
  };

  const handleToggleLockCell = (campaignId, memberId) => {
    if (!activeGroup?.id) return;
    setLockedCellsByGroup((prev) => {
      const groupMap = { ...(prev[activeGroup.id] || {}) };
      const campMap = { ...(groupMap[campaignId] || {}) };
      if (campMap[memberId]) {
        delete campMap[memberId];
      } else {
        campMap[memberId] = true;
      }
      groupMap[campaignId] = campMap;
      return { ...prev, [activeGroup.id]: groupMap };
    });
  };

  const handleUnlockAllCells = () => {
    if (!activeGroup?.id) return;
    setLockedCellsByGroup((prev) => ({
      ...prev,
      [activeGroup.id]: {},
    }));
    messageApi.info('Đã mở khóa tất cả ô CAP đã ghim.');
  };

  const handleRestoreAuto = async () => {
    if (!requireLeaderPermission()) return;
    if (!activeGroup?.autoBackup) {
      messageApi.info('Chưa có bản tự động trước đó để khôi phục.');
      return;
    }
    const synced = await updateActiveGroup(
      (g) => ({
        ...g,
        matrix: normalizeMatrix(g.autoBackup, getActiveOffers(g.campaigns), g.members),
      }),
      '',
      { preserveLatestMembers: true }
    );
    if (!synced) return;
    messageApi.success('Đã khôi phục kết quả chia CAP tự động.');
  };

  const handleApplyAiDirectives = async (directives) => {
    if (!requireLeaderPermission()) {
      return { ok: false, error: 'Cần đăng nhập Leader để điều chỉnh bảng chia CAP.' };
    }
    const targetDate = distributionDate || getTodayDateString();
    const groupLocked = lockedCellsByGroup[activeGroup.id] || {};
    const nextSeed = seedCounter + 313;
    setSeedCounter(nextSeed);

    const res = applyAiDistributionDirectives(directives, {
      members,
      campaigns,
      baseMatrix: matrix,
      lockedCells: groupLocked,
      settings,
      dateStr: targetDate,
      rolloverOffsets: rolloverInfo.offsetsByMemberId,
      seed: nextSeed,
    });

    if (!res.ok) {
      messageApi.error(res.error || 'Không thể áp dụng điều chỉnh AI.');
      return { ok: false, error: res.error };
    }

    setLockedCellsByGroup((prev) => ({
      ...prev,
      [activeGroup.id]: res.lockedCells || groupLocked,
    }));

    const synced = await updateActiveGroup(
      (g) => ({
        ...g,
        matrix: res.matrix,
        autoBackup: res.matrix,
      }),
      '',
      { preserveLatestMembers: true }
    );
    if (!synced) {
      return { ok: false, error: 'Không thể đồng bộ bảng chia CAP sau khi AI điều chỉnh.' };
    }

    setAlternativesByGroup((prev) => ({
      ...prev,
      [activeGroup.id]: res.alternatives || [],
    }));

    messageApi.success(`AI đã điều chỉnh: ${res.appliedSummary}`);
    return {
      ok: true,
      appliedSummary: res.appliedSummary,
      memberDiffs: res.memberDiffs || [],
      stats: res.stats,
    };
  };

  const handleCreateTransfer = async (transferInput) => {
    if (!activeGroup?.id) return false;
    try {
      await createCapTransferInFirestore(activeGroup.id, transferInput);
      messageApi.success(
        `Đã gửi yêu cầu nhượng ${transferInput.qty} CAP (${transferInput.offerCode}) chờ Leader duyệt.`
      );
      return true;
    } catch {
      messageApi.error('Không thể tạo yêu cầu nhượng CAP.');
      return false;
    }
  };

  const handleResolveTransfer = async (transfer, action) => {
    if (!requireLeaderPermission()) return false;
    if (!activeGroup?.id || !transfer?.id) return false;
    const savedForTransferDate = getSavedDistributionForDate(history, transfer.date);
    try {
      const res = await resolveCapTransferInFirestore({
        groupId: activeGroup.id,
        transfer,
        action,
        resolvedBy: authSession?.displayName || authSession?.username || 'Leader',
        savedRecord: savedForTransferDate,
      });
      if (!res?.ok) {
        messageApi.error(res?.error || 'Không thể xử lý yêu cầu nhượng CAP.');
        return false;
      }
      if (action === 'approved') {
        messageApi.success(
          `Đã duyệt nhượng ${transfer.qty} CAP ${transfer.offerCode} từ ${transfer.fromMemberName} ➔ ${transfer.toMemberName}.`
        );
      } else {
        messageApi.info(`Đã từ chối yêu cầu nhượng ${transfer.qty} CAP ${transfer.offerCode}.`);
      }
      return true;
    } catch {
      messageApi.error('Lỗi máy chủ khi xử lý yêu cầu nhượng CAP.');
      return false;
    }
  };

  const handleExportRecordToExcel = (record) => {
    if (!record) {
      messageApi.warning('Chưa có bảng chia CAP được lưu cho ngày này để xuất Excel.');
      return;
    }
    const targetDate = record.date || dashboardDate || getTodayDateString();
    const res = exportDistributionToExcel({
      matrix: record.matrix || {},
      campaigns: sortOffersByPointsDesc(record.campaigns || []),
      members: record.members || [],
      dateLabel: targetDate,
      fileName: `CAP_Manager_${activeGroup?.name?.replace(/\s+/g, '_')}_${targetDate}.xlsx`,
    });
    if (!res.ok) {
      messageApi.error(res.error);
      return;
    }
    messageApi.success(`Đã xuất file Excel: ${res.fileName}`);
  };

  const handleExportExcel = () => {
    if (safeTab === 'dashboard') {
      const savedForDashboard = getSavedDistributionForDate(history, dashboardDate);
      handleExportRecordToExcel(savedForDashboard);
      return;
    }
    const targetDate = distributionDate || getTodayDateString();
    const res = exportDistributionToExcel({
      matrix,
      campaigns,
      members,
      dateLabel: targetDate,
      fileName: `CAP_Manager_${activeGroup?.name?.replace(/\s+/g, '_')}_${targetDate}.xlsx`,
    });
    if (!res.ok) {
      messageApi.error(res.error);
      return;
    }
    messageApi.success(`Đã xuất file Excel: ${res.fileName}`);
  };

  // Member CRUD + Atomic Multi-Day Shift Management
  const handleAddMember = async (member) => {
    if (!requireLeaderPermission()) return;
    await updateActiveGroup((g) => {
      const nextMembers = [...g.members, member];
      return {
        ...g,
        members: nextMembers,
        matrix: normalizeMatrix(g.matrix, g.campaigns, nextMembers),
      };
    });
  };

  const handleUpdateMember = async (updated) => {
    if (!requireLeaderPermission()) return;
    await updateActiveGroup((g) => ({
      ...g,
      members: g.members.map((m) => (m.id === updated.id ? updated : m)),
    }));
  };

  const handleUpdateMemberMultiDateShifts = async (memberId, dateShiftsMap) => {
    const todayStr = getTodayDateString();
    const filteredMap = {};
    let blockedPast = false;

    for (const [dateStr, nextShifts] of Object.entries(dateShiftsMap || {})) {
      if (!canEditActiveGroup && dateStr < todayStr) {
        blockedPast = true;
        continue;
      }
      filteredMap[dateStr] = Array.isArray(nextShifts) ? nextShifts : [];
    }

    const entries = Object.entries(filteredMap);
    if (entries.length === 0) {
      if (blockedPast) {
        messageApi.warning('Chế độ người xem chỉ được chỉnh sửa ca làm từ hôm nay trở về sau.');
      }
      return;
    }

    // Optimistic local state update
    setGroups((prev) =>
      prev.map((g) => {
        if (g.id !== activeGroup?.id) return g;
        return {
          ...g,
          members: g.members.map((m) => {
            if (m.id !== memberId) return m;
            const nextSchedule = { ...(m.shiftSchedule || {}) };
            let nextDefaultShifts = m.shifts;
            for (const [dateStr, shifts] of entries) {
              nextSchedule[dateStr] = shifts;
              if (dateStr === todayStr && shifts.length > 0) {
                nextDefaultShifts = shifts;
              }
            }
            return {
              ...m,
              shiftSchedule: nextSchedule,
              shifts: nextDefaultShifts,
            };
          }),
        };
      })
    );

    try {
      if (entries.length === 1) {
        await updateMemberDateShiftsInFirestore(activeGroup.id, memberId, entries[0][0], entries[0][1]);
      } else {
        await updateMemberMultiDateShiftsInFirestore(activeGroup.id, memberId, filteredMap);
      }
    } catch {
      messageApi.error('Không thể lưu thay đổi ca làm lên máy chủ.');
    }
  };

  const handleUpdateMemberDateShifts = async (memberId, dateStr, nextShifts) => {
    return handleUpdateMemberMultiDateShifts(memberId, { [dateStr]: nextShifts });
  };

  const handleBatchImportShiftSchedule = async (memberDateShiftsMap) => {
    if (!requireLeaderPermission()) return false;
    const todayStr = getTodayDateString();
    const entries = Object.entries(memberDateShiftsMap || {}).filter(
      ([, dateMap]) => dateMap && Object.keys(dateMap).length > 0
    );
    if (entries.length === 0) return false;

    setGroups((prev) =>
      prev.map((g) => {
        if (g.id !== activeGroup?.id) return g;
        return {
          ...g,
          members: g.members.map((m) => {
            const dateMap = memberDateShiftsMap[m.id];
            if (!dateMap || typeof dateMap !== 'object') return m;
            const nextSchedule = { ...(m.shiftSchedule || {}) };
            let nextDefaultShifts = m.shifts;
            for (const [dateStr, shifts] of Object.entries(dateMap)) {
              if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;
              const cleanShifts = Array.isArray(shifts) ? shifts.slice(0, 5) : [];
              nextSchedule[dateStr] = cleanShifts;
              if (dateStr === todayStr && cleanShifts.length > 0) {
                nextDefaultShifts = cleanShifts;
              }
            }
            return {
              ...m,
              shiftSchedule: nextSchedule,
              shifts: nextDefaultShifts,
            };
          }),
        };
      })
    );

    try {
      await batchUpdateGroupShiftScheduleInFirestore(activeGroup.id, memberDateShiftsMap);
      return true;
    } catch {
      messageApi.error('Không thể đồng bộ lịch tháng lên máy chủ.');
      return false;
    }
  };

  const handleDeleteMember = async (memberId) => {
    if (!requireLeaderPermission()) return;
    if (members.length <= 1) {
      messageApi.warning('Nhóm cần giữ lại ít nhất 1 thành viên.');
      return;
    }
    const synced = await updateActiveGroup((g) => {
      const nextMembers = g.members.filter((m) => m.id !== memberId);
      return {
        ...g,
        members: nextMembers,
        matrix: normalizeMatrix(g.matrix, g.campaigns, nextMembers),
      };
    });
    if (synced) messageApi.success('Đã xóa thành viên.');
  };

  // Offer CRUD (preserveLatestMembers avoids overwriting concurrent viewer shift updates)
  const handleAddCampaign = async (offer) => {
    if (!requireLeaderPermission()) return;
    await updateActiveGroup(
      (g) => {
        const nextOffers = sortOffersByPointsDesc([...g.campaigns, offer]);
        return {
          ...g,
          campaigns: nextOffers,
          matrix: normalizeMatrix(g.matrix, getActiveOffers(nextOffers), g.members),
        };
      },
      '',
      { preserveLatestMembers: true }
    );
  };

  const handleUpdateCampaign = async (updated) => {
    if (!requireLeaderPermission()) return;
    await updateActiveGroup(
      (g) => {
        const nextOffers = sortOffersByPointsDesc(
          g.campaigns.map((c) => (c.id === updated.id ? updated : c))
        );
        return {
          ...g,
          campaigns: nextOffers,
          matrix: normalizeMatrix(g.matrix, getActiveOffers(nextOffers), g.members),
        };
      },
      '',
      { preserveLatestMembers: true }
    );
  };

  const handleDeleteCampaign = async (offerId) => {
    if (!requireLeaderPermission()) return;
    const synced = await updateActiveGroup(
      (g) => {
        const nextOffers = g.campaigns.filter((c) => c.id !== offerId);
        return {
          ...g,
          campaigns: nextOffers,
          matrix: normalizeMatrix(g.matrix, getActiveOffers(nextOffers), g.members),
        };
      },
      '',
      { preserveLatestMembers: true }
    );
    if (synced) messageApi.success('Đã xóa offer.');
  };

  const handleReplaceCampaigns = async (nextOffers) => {
    if (!requireLeaderPermission()) return;
    const sorted = sortOffersByPointsDesc(nextOffers);
    await updateActiveGroup(
      (g) => ({
        ...g,
        campaigns: sorted,
        matrix: normalizeMatrix(g.matrix, getActiveOffers(sorted), g.members),
      }),
      '',
      { preserveLatestMembers: true }
    );
  };

  // History actions
  const handleReopenHistory = async (record) => {
    if (!requireLeaderPermission()) return;
    const synced = await updateActiveGroup((g) => {
      const nextMembers =
        Array.isArray(record.members) && record.members.length > 0 ? record.members : g.members;
      const nextOffers = sortOffersByPointsDesc(
        Array.isArray(record.campaigns) ? record.campaigns : g.campaigns
      );
      const restoredMatrix = normalizeMatrix(record.matrix, getActiveOffers(nextOffers), nextMembers);
      return {
        ...g,
        members: nextMembers,
        campaigns: nextOffers,
        matrix: restoredMatrix,
        autoBackup: restoredMatrix,
      };
    });
    if (!synced) return;
    if (record.date) setDistributionDate(record.date);
    setActiveTab('distribute');
    messageApi.success(`Đã mở lại bảng chia CAP ngày ${record.date}.`);
  };

  const handleCopyCampaignsFromHistory = async (record) => {
    if (!requireLeaderPermission()) return;
    const cloned = sortOffersByPointsDesc(
      (record.campaigns || []).map((c) => ({
        ...c,
        id: createId('offer'),
        hidden: false,
      }))
    );
    const synced = await updateActiveGroup((g) => ({
      ...g,
      campaigns: cloned,
      matrix: createEmptyMatrix(cloned, g.members),
    }));
    if (!synced) return;
    setActiveTab('campaigns');
    messageApi.success(`Đã sao chép ${cloned.length} offer từ ngày ${record.date}.`);
  };

  const handleDeleteHistory = async (historyId) => {
    if (!requireLeaderPermission()) return;
    try {
      await deleteHistoryRecordInFirestore(activeGroup.id, historyId);
      messageApi.success('Đã xóa bản lưu lịch sử.');
    } catch {
      messageApi.error('Không thể xóa bản lưu lịch sử.');
    }
  };

  // Settings & Data management
  const handleUpdateSettings = async (nextSettings) => {
    if (!requireLeaderPermission()) return;
    await updateActiveGroup(
      (g) => ({ ...g, settings: nextSettings }),
      '',
      { preserveLatestMembers: true }
    );
  };

  const handleResetDefaults = async () => {
    if (!requireLeaderPermission()) return;
    const targetDate = distributionDate || getTodayDateString();
    const res = autoDistributeCaps(DEFAULT_MEMBERS, DEFAULT_OFFERS, DEFAULT_SETTINGS, 101, targetDate);
    const nextMatrix = res.ok ? res.matrix : createEmptyMatrix(DEFAULT_OFFERS, DEFAULT_MEMBERS);
    const synced = await updateActiveGroup((g) => ({
      ...g,
      members: structuredClone(DEFAULT_MEMBERS),
      campaigns: structuredClone(DEFAULT_OFFERS),
      settings: { ...DEFAULT_SETTINGS },
      matrix: nextMatrix,
      autoBackup: nextMatrix,
    }));
    if (!synced) return;
    setAlternativesByGroup((prev) => ({
      ...prev,
      [activeGroup.id]: res.alternatives || [],
    }));
    messageApi.success(`Đã khôi phục dữ liệu mẫu mặc định cho ${activeGroup.name}.`);
  };

  const handleExportBackupJson = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      activeGroup,
      groups,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `CAP_Manager_Backup_${getTodayDateString()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    messageApi.success('Đã tải file sao lưu JSON.');
  };

  if (!groupsLoaded) {
    return (
      <ConfigProvider locale={viVN} theme={ANTD_THEME}>
        {contextHolder}
        <div className="min-h-screen flex flex-col items-center justify-center bg-[#F8FAFC] gap-3">
          <Spin size="large" />
          <div className="text-sm font-medium text-slate-600">
            Đang đồng bộ dữ liệu CAP Manager...
          </div>
        </div>
      </ConfigProvider>
    );
  }

  const safeTab = !canEditActiveGroup && !VIEWER_ALLOWED_TABS.has(activeTab) ? 'dashboard' : activeTab;

  return (
    <ConfigProvider locale={viVN} theme={ANTD_THEME}>
      {contextHolder}
      <LayoutShell
        activeTab={safeTab}
        onTabChange={setActiveTab}
        groups={groups}
        activeGroup={activeGroup}
        onSelectGroup={setActiveGroupId}
        authSession={authSession}
        canEditActiveGroup={canEditActiveGroup}
        onOpenLogin={() => {
          setLoginPreselectGroup(activeGroup);
          setLoginModalOpen(true);
        }}
        onOpenChangePassword={() => setChangePwdModalOpen(true)}
        onLogout={handleLogout}
        onAutoDistribute={handleAutoDistribute}
        onExportExcel={handleExportExcel}
      >
        {safeTab === 'dashboard' && (
          <DashboardView
            activeGroup={activeGroup}
            canEdit={canEditActiveGroup}
            members={members}
            history={history}
            settings={settings}
            dashboardDate={dashboardDate}
            onChangeDashboardDate={setDashboardDate}
            completions={activeGroup?.completions || {}}
            onToggleCompletion={(offerId, memberId, nextDone) =>
              handleToggleCompletion(offerId, memberId, nextDone, dashboardDate)
            }
            onOpenDistributeForDate={(dateStr) => {
              if (dateStr) setDistributionDate(dateStr);
              setActiveTab('distribute');
            }}
            onNavigate={setActiveTab}
            onExportRecord={handleExportRecordToExcel}
            onNotify={notify}
            transfers={transfers}
            onCreateTransfer={handleCreateTransfer}
            onResolveTransfer={handleResolveTransfer}
            onRequestReauth={() => requestTelegramReauth(null)}
          />
        )}

        {safeTab === 'distribute' && canEditActiveGroup && (
          <DistributionView
            activeGroup={activeGroup}
            canEdit={canEditActiveGroup}
            onOpenLogin={() => {
              setLoginPreselectGroup(activeGroup);
              setLoginModalOpen(true);
            }}
            members={members}
            campaigns={campaigns}
            matrix={matrix}
            history={history}
            hasAutoBackup={Boolean(activeGroup?.autoBackup)}
            stats={stats}
            settings={settings}
            distributionDate={distributionDate}
            onChangeDistributionDate={setDistributionDate}
            alternatives={alternativesByGroup[activeGroup?.id] || []}
            onUpdateSettings={handleUpdateSettings}
            onAutoDistribute={handleAutoDistribute}
            onRedistributeVariant={handleRedistributeVariant}
            onSelectAlternative={handleSelectAlternative}
            onCellChange={handleCellChange}
            onRestoreAuto={handleRestoreAuto}
            onPublishDistribution={handlePublishDistribution}
            isPublishing={isPublishingDistribution}
            telegramConfigured={Boolean(activeGroupTelegramStatus?.configured)}
            isTelegramDeliveredForCurrentMatrix={isTelegramDeliveredForCurrentMatrix}
            telegramSentAtForCurrentDate={telegramSentAtForCurrentDate}
            onResendTelegram={() => handleResendDistributionTelegram(distributionDate)}
            onSaveHistory={handleSaveHistory}
            onExportExcel={handleExportExcel}
            lockedCells={lockedCellsByGroup[activeGroup?.id] || {}}
            onToggleLockCell={handleToggleLockCell}
            onUnlockAllCells={handleUnlockAllCells}
            rolloverInfo={rolloverInfo}
            onApplyAiDirectives={handleApplyAiDirectives}
            onRequestReauth={() => requestTelegramReauth(null)}
            onNotify={notify}
          />
        )}

        {safeTab === 'campaigns' && canEditActiveGroup && (
          <CampaignsView
            activeGroup={activeGroup}
            canEdit={canEditActiveGroup}
            onOpenLogin={() => {
              setLoginPreselectGroup(activeGroup);
              setLoginModalOpen(true);
            }}
            campaigns={allCampaigns}
            members={members}
            history={history}
            onAddCampaign={handleAddCampaign}
            onUpdateCampaign={handleUpdateCampaign}
            onDeleteCampaign={handleDeleteCampaign}
            onReplaceCampaigns={handleReplaceCampaigns}
            onNotify={notify}
            onRequestReauth={() => requestTelegramReauth(null)}
          />
        )}

        {safeTab === 'members' && (
          <MembersView
            activeGroup={activeGroup}
            canEdit={canEditActiveGroup}
            onOpenLogin={() => {
              setLoginPreselectGroup(activeGroup);
              setLoginModalOpen(true);
            }}
            members={members}
            stats={stats}
            onAddMember={handleAddMember}
            onUpdateMember={handleUpdateMember}
            onUpdateMemberDateShifts={handleUpdateMemberDateShifts}
            onUpdateMemberMultiDateShifts={handleUpdateMemberMultiDateShifts}
            onBatchImportShiftSchedule={handleBatchImportShiftSchedule}
            onDeleteMember={handleDeleteMember}
            onNotify={notify}
          />
        )}

        {safeTab === 'groups' && canEditActiveGroup && (
          <GroupsView
            groups={groups}
            activeGroupId={activeGroup?.id}
            authSession={authSession}
            serverAuthGroupId={serverAuthGroupId}
            telegramConfigured={telegramStatus.defaultConfigured}
            telegramStatusByGroup={telegramStatus.byGroup}
            onSelectGroup={setActiveGroupId}
            onCreateGroup={handleCreateGroup}
            onUpdateGroup={handleUpdateGroup}
            onDeleteGroup={handleDeleteGroup}
            onTestTelegram={handleTestTelegram}
            onDeleteTelegramBotToken={handleDeleteGroupTelegramBotToken}
            onOpenLoginForGroup={(g) => {
              setLoginPreselectGroup(g);
              setLoginModalOpen(true);
            }}
            onReauthenticateTelegram={(g) => {
              setLoginPreselectGroup(g || activeGroup);
              setLoginModalOpen(true);
            }}
            onNotify={notify}
          />
        )}

        {safeTab === 'history' && canEditActiveGroup && (
          <HistoryView
            groupName={activeGroup?.name || 'Nhóm'}
            history={history}
            onReopenHistory={handleReopenHistory}
            onCopyCampaignsFromHistory={handleCopyCampaignsFromHistory}
            onDeleteHistory={handleDeleteHistory}
            onNotify={notify}
          />
        )}

        {safeTab === 'settings' && canEditActiveGroup && (
          <SettingsView
            activeGroup={activeGroup}
            canEdit={canEditActiveGroup}
            telegramSessionActive={telegramSessionActive}
            onOpenLogin={() => {
              setLoginPreselectGroup(activeGroup);
              setLoginModalOpen(true);
            }}
            onReauthenticateTelegram={() => {
              setLoginPreselectGroup(activeGroup);
              setLoginModalOpen(true);
            }}
            settings={settings}
            telegramStatus={{
              ...telegramStatus,
              ...activeGroupTelegramStatus,
            }}
            onUpdateSettings={handleUpdateSettings}
            onSaveTelegramBotToken={handleSaveGroupTelegramBotToken}
            onDeleteTelegramBotToken={handleDeleteGroupTelegramBotToken}
            onTestTelegram={handleTestTelegram}
            onSendShiftReminderNow={handleSendShiftReminderNow}
            onResetDefaults={handleResetDefaults}
            onExportBackupJson={handleExportBackupJson}
            onNotify={notify}
          />
        )}
      </LayoutShell>

      <LoginModal
        open={loginModalOpen}
        groups={groups}
        preselectedGroup={loginPreselectGroup}
        onClose={() => {
          pendingTelegramActionRef.current = null;
          setLoginModalOpen(false);
        }}
        onLogin={handleLogin}
      />

      <ChangePasswordModal
        open={changePwdModalOpen}
        groupName={activeGroup?.name || ''}
        username={authSession?.username || ''}
        onClose={() => setChangePwdModalOpen(false)}
        onSubmit={handleChangeLeaderPassword}
      />
    </ConfigProvider>
  );
}
