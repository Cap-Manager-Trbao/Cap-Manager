import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase.js';
import {
  DEFAULT_MEMBERS,
  DEFAULT_OFFERS,
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  createDefaultGroup1,
} from '../data/defaultData.js';
import {
  autoDistributeCaps,
  createEmptyMatrix,
  normalizeMatrix,
  sortOffersByPointsDesc,
} from './capAlgorithm.js';
import { hashPassword, verifyPassword } from './passwordCrypto.js';
import { getTodayDateString, loadFromStorage } from './storage.js';
import { sanitizeTelegramTemplates } from './telegramMessages.js';
import { normalizeTelegramUsername } from './telegramCommands.js';
import { applyCapTransferToState } from './aiHelpers.js';

function sanitizeId(raw, fallbackPrefix = 'id') {
  const clean = String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .slice(0, 128);
  return clean || `${fallbackPrefix}-${Date.now().toString(36)}`;
}

function sanitizeUsername(raw) {
  const clean = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '')
    .slice(0, 64);
  return clean.length >= 3 ? clean : `${clean}user`.slice(0, 64);
}

function sanitizeTimeHHMM(raw) {
  const clean = String(raw || '').trim().slice(0, 5);
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(clean) ? clean : '';
}

function sanitizeSettings(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  const rawChatId = String(merged.telegramChatId || '').trim().slice(0, 64);
  const validChatId =
    !rawChatId || /^-?\d{5,20}$/.test(rawChatId) || /^@[a-zA-Z0-9_]{5,32}$/.test(rawChatId)
      ? rawChatId
      : '';
  return {
    leaderPriority: ['normal', 'low', 'medium', 'high'].includes(merged.leaderPriority)
      ? merged.leaderPriority
      : 'medium',
    newMemberMode: ['less', 'normal'].includes(merged.newMemberMode)
      ? merged.newMemberMode
      : 'less',
    capBalanceLevel: ['high', 'medium'].includes(merged.capBalanceLevel)
      ? merged.capBalanceLevel
      : 'high',
    pointBalanceLevel: ['high', 'medium'].includes(merged.pointBalanceLevel)
      ? merged.pointBalanceLevel
      : 'high',
    useShiftMatching: merged.useShiftMatching !== false,
    useRolloverFairness: Boolean(merged.useRolloverFairness),
    optimizationTrials: Math.min(100, Math.max(1, Math.round(Number(merged.optimizationTrials) || 15))),
    autoSaveHistoryOnDistribute: Boolean(merged.autoSaveHistoryOnDistribute),
    telegramEnabled: Boolean(merged.telegramEnabled),
    telegramChatId: validChatId,
    telegramShiftReminderEnabled: merged.telegramShiftReminderEnabled !== false,
    telegramShiftReminderTime: sanitizeTimeHHMM(merged.telegramShiftReminderTime) || '11:00',
    telegramInteractiveEnabled: false,
    telegramDeadlineReminderTime: sanitizeTimeHHMM(merged.telegramDeadlineReminderTime),
    telegramDailySummaryTime: sanitizeTimeHHMM(merged.telegramDailySummaryTime),
    aiButlerEnabled: false,
    telegramTemplates: sanitizeTelegramTemplates(merged.telegramTemplates),
  };
}

function sanitizeMembers(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 100).map((m, idx) => {
    const clean = {
      id: sanitizeId(m?.id, `mem-${idx + 1}`),
      name: String(m?.name || `Thành viên ${idx + 1}`).trim().slice(0, 100),
      isLeader: Boolean(m?.isLeader),
      isNew: Boolean(m?.isNew),
      active: m?.active !== false,
      priority: ['low', 'normal', 'high'].includes(m?.priority) ? m.priority : 'normal',
      shifts: Array.isArray(m?.shifts) && m.shifts.length > 0 ? m.shifts.slice(0, 5) : ['ca1', 'ca2', 'ca3'],
      shiftSchedule: m?.shiftSchedule && typeof m.shiftSchedule === 'object' ? m.shiftSchedule : {},
    };
    const tgUsername = normalizeTelegramUsername(m?.telegramUsername);
    if (tgUsername) {
      clean.telegramUsername = tgUsername;
    }
    const tgUserId = String(m?.telegramUserId || '').trim().slice(0, 32);
    if (tgUserId) {
      clean.telegramUserId = tgUserId;
    }
    return clean;
  });
}

function sanitizeCampaigns(list) {
  if (!Array.isArray(list)) return [];
  return sortOffersByPointsDesc(list)
    .slice(0, 200)
    .map((c, idx) => ({
      id: sanitizeId(c?.id, `offer-${idx + 1}`),
      code: String(c?.code || `OF-${idx + 1}`).trim().slice(0, 50),
      name: String(c?.name || `Offer ${idx + 1}`).trim().slice(0, 200),
      totalCap: Math.max(0, Math.round(Number(c?.totalCap) || 0)),
      pointsPerCap: Math.max(0, Math.round(Number(c?.pointsPerCap) || 0)),
      capHour: String(c?.capHour || '10h').trim().slice(0, 20),
      timeWindow: String(c?.timeWindow || 'Cả ngày').trim().slice(0, 80),
      note: String(c?.note || '').trim().slice(0, 300),
      condition: String(c?.condition || 'Tất cả thành viên').trim().slice(0, 150),
      eligibilityType: ['all', 'exclude_new', 'custom'].includes(c?.eligibilityType)
        ? c.eligibilityType
        : 'all',
      eligibleMemberIds: Array.isArray(c?.eligibleMemberIds)
        ? c.eligibleMemberIds.slice(0, 100).map((id) => String(id))
        : [],
      hidden: Boolean(c?.hidden),
    }));
}

function sanitizeMatrix(matrix, campaigns, members) {
  const normalized = normalizeMatrix(matrix, campaigns, members);
  const out = {};
  for (const camp of campaigns.slice(0, 200)) {
    out[camp.id] = {};
    for (const mem of members.slice(0, 100)) {
      out[camp.id][mem.id] = Math.max(0, Math.floor(Number(normalized?.[camp.id]?.[mem.id]) || 0));
    }
  }
  return out;
}

function sanitizeCompletions(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  const validDates = Object.keys(raw)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort((a, b) => b.localeCompare(a))
    .slice(0, 14);

  for (const dateStr of validDates) {
    const dateMap = raw[dateStr];
    if (!dateMap || typeof dateMap !== 'object') continue;
    const cleanDateMap = {};
    for (const offerId of Object.keys(dateMap).slice(0, 200)) {
      const memMap = dateMap[offerId];
      if (!memMap || typeof memMap !== 'object') continue;
      const cleanMemMap = {};
      for (const memId of Object.keys(memMap).slice(0, 100)) {
        if (memMap[memId] === true) {
          cleanMemMap[memId] = true;
        }
      }
      if (Object.keys(cleanMemMap).length > 0) {
        cleanDateMap[offerId] = cleanMemMap;
      }
    }
    if (Object.keys(cleanDateMap).length > 0) {
      out[dateStr] = cleanDateMap;
    }
  }
  return out;
}

function buildGroupFirestorePayload(groupObj, isCreate = false) {
  const id = sanitizeId(groupObj.id, 'group');
  const members = sanitizeMembers(groupObj.members);
  const campaigns = sanitizeCampaigns(groupObj.campaigns);
  const matrix = sanitizeMatrix(groupObj.matrix, campaigns, members);
  const autoBackup = groupObj.autoBackup
    ? sanitizeMatrix(groupObj.autoBackup, campaigns, members)
    : matrix;

  const payload = {
    id,
    name: String(groupObj.name || 'Nhóm mới').trim().slice(0, 100) || 'Nhóm mới',
    description: String(groupObj.description || '').trim().slice(0, 300),
    leaderUsername: sanitizeUsername(groupObj.leaderAccount?.username || groupObj.leaderUsername || 'leader1'),
    leaderDisplayName: String(
      groupObj.leaderAccount?.displayName || groupObj.leaderDisplayName || 'Leader'
    )
      .trim()
      .slice(0, 120) || 'Leader',
    members,
    campaigns,
    matrix,
    autoBackup,
    settings: sanitizeSettings(groupObj.settings),
    completions: sanitizeCompletions(groupObj.completions),
    visibility: 'shared',
    updatedAt: serverTimestamp(),
  };

  if (isCreate) {
    payload.createdAt = serverTimestamp();
  }
  return payload;
}

function mapGroupDoc(docSnap) {
  const data = docSnap.data();
  const members = sanitizeMembers(data.members);
  const campaigns = sanitizeCampaigns(data.campaigns);
  const matrix = normalizeMatrix(data.matrix, campaigns, members);
  const autoBackup = data.autoBackup ? normalizeMatrix(data.autoBackup, campaigns, members) : matrix;

  return {
    id: data.id || docSnap.id,
    name: data.name || 'Nhóm 1',
    description: data.description || '',
    leaderAccount: {
      username: data.leaderUsername || '',
      displayName: data.leaderDisplayName || 'Leader',
    },
    members,
    campaigns,
    matrix,
    autoBackup,
    completions: sanitizeCompletions(data.completions),
    settings: sanitizeSettings(data.settings),
    createdAtMs: data.createdAt?.toMillis?.() || 0,
  };
}

/**
 * Seed default Group 1 (or migrate any pre-existing local groups) if Firestore `groups` is empty.
 */
export async function seedInitialGroupsIfEmpty() {
  try {
    const existingSnap = await getDocs(
      query(collection(db, 'groups'), where('visibility', '==', 'shared'))
    );
    if (!existingSnap.empty) {
      return;
    }

    const legacyGroups = loadFromStorage(STORAGE_KEYS.GROUPS, null);
    let groupsToSeed = [];

    if (Array.isArray(legacyGroups) && legacyGroups.length > 0) {
      groupsToSeed = legacyGroups;
    } else {
      const today = getTodayDateString();
      const initialRes = autoDistributeCaps(DEFAULT_MEMBERS, DEFAULT_OFFERS, DEFAULT_SETTINGS, 101, today);
      const initialMatrix = initialRes.ok
        ? initialRes.matrix
        : createEmptyMatrix(DEFAULT_OFFERS, DEFAULT_MEMBERS);
      groupsToSeed = [createDefaultGroup1(initialMatrix)];
    }

    for (const rawGroup of groupsToSeed) {
      const groupId = sanitizeId(rawGroup.id, 'group');
      const groupRef = doc(db, 'groups', groupId);
      const credRef = doc(db, 'groupCredentials', groupId);

      const groupPayload = buildGroupFirestorePayload({ ...rawGroup, id: groupId }, true);
      const rawPwd = rawGroup.leaderAccount?.password || '123456';
      const { salt, passwordHash } = await hashPassword(rawPwd);
      const credPayload = {
        groupId,
        username: groupPayload.leaderUsername,
        displayName: groupPayload.leaderDisplayName,
        salt,
        passwordHash,
        updatedAt: serverTimestamp(),
      };

      const batch = writeBatch(db);
      batch.set(groupRef, groupPayload);
      batch.set(credRef, credPayload);
      await batch.commit();

      if (Array.isArray(rawGroup.history) && rawGroup.history.length > 0) {
        for (const h of rawGroup.history.slice(0, 30)) {
          await addHistoryRecordInFirestore(groupId, h);
        }
      }
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'groups');
  }
}

export function subscribeGroups(onGroups, onError) {
  const path = 'groups';
  const q = query(collection(db, path), where('visibility', '==', 'shared'));
  return onSnapshot(
    q,
    (snapshot) => {
      const list = snapshot.docs.map(mapGroupDoc);
      list.sort((a, b) => {
        if (a.id === 'group-1') return -1;
        if (b.id === 'group-1') return 1;
        return (a.createdAtMs || 0) - (b.createdAtMs || 0);
      });
      onGroups(list);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        if (onError) onError(wrapped);
      }
    }
  );
}

export function subscribeGroupHistory(groupId, onHistory, onError) {
  if (!groupId) {
    onHistory([]);
    return () => {};
  }
  const path = `groups/${groupId}/history`;
  const q = query(collection(db, 'groups', groupId, 'history'), where('groupId', '==', groupId));
  return onSnapshot(
    q,
    (snapshot) => {
      const records = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          ...data,
          id: data.id || d.id,
        };
      });
      records.sort((a, b) => String(b.savedAt || b.date || '').localeCompare(String(a.savedAt || a.date || '')));
      onHistory(records);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        if (onError) onError(wrapped);
      }
    }
  );
}

export async function verifyLeaderLogin(username, password) {
  const cleanUser = String(username || '').trim().toLowerCase();
  if (!cleanUser || !password) return { ok: false };

  const path = 'groupCredentials';
  try {
    const q = query(collection(db, path), where('username', '==', cleanUser), limit(5));
    const snap = await getDocs(q);
    if (snap.empty) {
      return { ok: false };
    }

    for (const docSnap of snap.docs) {
      const cred = docSnap.data();
      const matched = await verifyPassword(password, cred.salt, cred.passwordHash);
      if (matched) {
        return {
          ok: true,
          session: {
            username: cred.username,
            displayName: cred.displayName,
            groupId: cred.groupId,
          },
        };
      }
    }
    return { ok: false };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export async function isLeaderUsernameTaken(username, excludeGroupId = null) {
  const cleanUser = sanitizeUsername(username);
  const path = 'groupCredentials';
  try {
    const q = query(collection(db, path), where('username', '==', cleanUser), limit(5));
    const snap = await getDocs(q);
    return snap.docs.some((d) => d.id !== excludeGroupId);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export async function createGroupInFirestore(groupObj, plainPassword) {
  const groupId = sanitizeId(groupObj.id, 'group');
  const path = `groups/${groupId}`;
  try {
    const groupPayload = buildGroupFirestorePayload({ ...groupObj, id: groupId }, true);
    const { salt, passwordHash } = await hashPassword(plainPassword);
    const credPayload = {
      groupId,
      username: groupPayload.leaderUsername,
      displayName: groupPayload.leaderDisplayName,
      salt,
      passwordHash,
      updatedAt: serverTimestamp(),
    };

    const batch = writeBatch(db);
    batch.set(doc(db, 'groups', groupId), groupPayload);
    batch.set(doc(db, 'groupCredentials', groupId), credPayload);
    await batch.commit();

    return {
      groupId,
      leaderAccount: {
        username: groupPayload.leaderUsername,
        displayName: groupPayload.leaderDisplayName,
      },
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateGroupInFirestore(
  groupId,
  nextGroupObj,
  newPlainPassword = '',
  options = {}
) {
  const cleanId = sanitizeId(groupId, 'group');
  const path = `groups/${cleanId}`;
  const preserveLatestMembers = Boolean(options?.preserveLatestMembers);
  try {
    const payload = buildGroupFirestorePayload({ ...nextGroupObj, id: cleanId }, false);

    if (newPlainPassword || nextGroupObj.leaderAccount) {
      const credRef = doc(db, 'groupCredentials', cleanId);
      const existingCredSnap = await getDoc(credRef);
      const existingCred = existingCredSnap.exists() ? existingCredSnap.data() : null;

      let salt = existingCred?.salt;
      let passwordHash = existingCred?.passwordHash;
      if (newPlainPassword) {
        const hashed = await hashPassword(newPlainPassword);
        salt = hashed.salt;
        passwordHash = hashed.passwordHash;
      }

      if (salt && passwordHash) {
        const groupRef = doc(db, 'groups', cleanId);
        await runTransaction(db, async (tx) => {
          const latestSnap = await tx.get(groupRef);
          const mergedPayload =
            preserveLatestMembers && latestSnap.exists()
              ? {
                  ...payload,
                  members: sanitizeMembers(latestSnap.data().members),
                }
              : payload;
          tx.update(groupRef, mergedPayload);
          tx.set(credRef, {
            groupId: cleanId,
            username: mergedPayload.leaderUsername,
            displayName: mergedPayload.leaderDisplayName,
            salt,
            passwordHash,
            updatedAt: serverTimestamp(),
          });
        });
        return;
      }
    }

    const groupRef = doc(db, 'groups', cleanId);
    if (preserveLatestMembers) {
      await runTransaction(db, async (tx) => {
        const latestSnap = await tx.get(groupRef);
        if (!latestSnap.exists()) return;
        const latestData = latestSnap.data();
        const latestMembers = sanitizeMembers(latestData.members);
        tx.update(groupRef, {
          ...payload,
          members: latestMembers,
          completions: sanitizeCompletions(latestData.completions),
          matrix: sanitizeMatrix(nextGroupObj.matrix, nextGroupObj.campaigns || [], latestMembers),
          autoBackup: sanitizeMatrix(
            nextGroupObj.autoBackup || nextGroupObj.matrix,
            nextGroupObj.campaigns || [],
            latestMembers
          ),
        });
      });
      return;
    }

    await updateDoc(groupRef, payload);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function toggleCapCompletionInFirestore(
  groupId,
  dateStr,
  offerId,
  memberId,
  isCompleted
) {
  const cleanId = sanitizeId(groupId, 'group');
  const path = `groups/${cleanId}`;
  const cleanDate = String(dateStr || getTodayDateString()).slice(0, 10);
  try {
    await runTransaction(db, async (tx) => {
      const groupRef = doc(db, 'groups', cleanId);
      const snap = await tx.get(groupRef);
      if (!snap.exists()) return;
      const current = sanitizeCompletions(snap.data().completions);
      const nextDateMap = { ...(current[cleanDate] || {}) };
      const nextOfferMap = { ...(nextDateMap[offerId] || {}) };

      if (isCompleted) {
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
        current[cleanDate] = nextDateMap;
      } else {
        delete current[cleanDate];
      }

      tx.update(groupRef, {
        completions: sanitizeCompletions(current),
        updatedAt: serverTimestamp(),
      });
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function changeLeaderPasswordInFirestore(
  groupId,
  currentPassword,
  newPassword
) {
  const cleanId = sanitizeId(groupId, 'group');
  const path = `groupCredentials/${cleanId}`;
  if (!currentPassword || !newPassword || String(newPassword).length < 6) {
    return { ok: false, error: 'Mật khẩu mới cần tối thiểu 6 ký tự.' };
  }

  try {
    const credRef = doc(db, 'groupCredentials', cleanId);
    const credSnap = await getDoc(credRef);
    if (!credSnap.exists()) {
      return { ok: false, error: 'Không tìm thấy thông tin tài khoản Leader.' };
    }

    const cred = credSnap.data();
    const matched = await verifyPassword(currentPassword, cred.salt, cred.passwordHash);
    if (!matched) {
      return { ok: false, error: 'Mật khẩu hiện tại không chính xác.' };
    }

    const { salt, passwordHash } = await hashPassword(newPassword);
    await runTransaction(db, async (tx) => {
      tx.update(credRef, {
        salt,
        passwordHash,
        updatedAt: serverTimestamp(),
      });
    });

    return { ok: true };
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function updateMemberDateShiftsInFirestore(groupId, memberId, dateStr, nextShifts) {
  return updateMemberMultiDateShiftsInFirestore(groupId, memberId, { [dateStr]: nextShifts });
}

export async function updateMemberMultiDateShiftsInFirestore(groupId, memberId, dateShiftsMap) {
  const cleanId = sanitizeId(groupId, 'group');
  const path = `groups/${cleanId}`;
  const todayStr = getTodayDateString();
  const entries = Object.entries(dateShiftsMap || {});
  if (entries.length === 0) return;

  try {
    await runTransaction(db, async (tx) => {
      const groupRef = doc(db, 'groups', cleanId);
      const snap = await tx.get(groupRef);
      if (!snap.exists()) return;
      const data = snap.data();
      const updatedMembers = sanitizeMembers(data.members).map((m) => {
        if (m.id !== memberId) return m;
        const nextSchedule = { ...(m.shiftSchedule || {}) };
        let nextDefaultShifts = m.shifts;

        for (const [dateStr, shifts] of entries) {
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
      });

      tx.update(groupRef, {
        members: updatedMembers,
        updatedAt: serverTimestamp(),
      });
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function batchUpdateGroupShiftScheduleInFirestore(groupId, memberDateShiftsMap) {
  const cleanId = sanitizeId(groupId, 'group');
  const path = `groups/${cleanId}`;
  const todayStr = getTodayDateString();
  const memberEntries = Object.entries(memberDateShiftsMap || {});
  if (memberEntries.length === 0) return;

  try {
    await runTransaction(db, async (tx) => {
      const groupRef = doc(db, 'groups', cleanId);
      const snap = await tx.get(groupRef);
      if (!snap.exists()) return;
      const data = snap.data();
      const updatedMembers = sanitizeMembers(data.members).map((m) => {
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
      });

      tx.update(groupRef, {
        members: updatedMembers,
        updatedAt: serverTimestamp(),
      });
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteGroupInFirestore(groupId) {
  if (!groupId || groupId === 'group-1') return;
  const cleanId = sanitizeId(groupId, 'group');
  const path = `groups/${cleanId}`;
  try {
    const historySnap = await getDocs(
      query(collection(db, 'groups', cleanId, 'history'), where('groupId', '==', cleanId))
    );
    const batch = writeBatch(db);
    for (const hDoc of historySnap.docs) {
      batch.delete(hDoc.ref);
    }
    batch.delete(doc(db, 'groups', cleanId));
    batch.delete(doc(db, 'groupCredentials', cleanId));
    batch.delete(doc(db, 'groupTelegramBots', cleanId));
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function addHistoryRecordInFirestore(groupId, record, overwriteHistoryId = null) {
  const cleanGroupId = sanitizeId(groupId, 'group');
  const cleanHistId = sanitizeId(record.id, 'hist');
  const path = `groups/${cleanGroupId}/history/${cleanHistId}`;
  try {
    const members = sanitizeMembers(record.members);
    const campaigns = sanitizeCampaigns(record.campaigns);
    const matrix = sanitizeMatrix(record.matrix, campaigns, members);

    const payload = {
      id: cleanHistId,
      groupId: cleanGroupId,
      date: String(record.date || getTodayDateString()).slice(0, 10),
      note: String(record.note || '').trim().slice(0, 300),
      savedAt: String(record.savedAt || new Date().toISOString()).slice(0, 40),
      members,
      campaigns,
      matrix,
      stats: {
        assignedTotalCap: Math.max(0, Number(record.stats?.assignedTotalCap) || 0),
        expectedTotalCap: Math.max(0, Number(record.stats?.expectedTotalCap) || 0),
        assignedTotalPoints: Math.max(0, Number(record.stats?.assignedTotalPoints) || 0),
        capSpread: Math.max(0, Number(record.stats?.capSpread) || 0),
        pointSpread: Math.max(0, Number(record.stats?.pointSpread) || 0),
      },
      createdAt: serverTimestamp(),
    };

    const batch = writeBatch(db);
    if (overwriteHistoryId && overwriteHistoryId !== cleanHistId) {
      const oldHistId = sanitizeId(overwriteHistoryId, 'hist');
      batch.delete(doc(db, 'groups', cleanGroupId, 'history', oldHistId));
    }
    batch.set(doc(db, 'groups', cleanGroupId, 'history', cleanHistId), payload);
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function deleteHistoryRecordInFirestore(groupId, historyId) {
  const cleanGroupId = sanitizeId(groupId, 'group');
  const cleanHistId = sanitizeId(historyId, 'hist');
  const path = `groups/${cleanGroupId}/history/${cleanHistId}`;
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, 'groups', cleanGroupId, 'history', cleanHistId));
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export function subscribeGroupTransfers(groupId, onTransfers, onError) {
  if (!groupId) {
    onTransfers([]);
    return () => {};
  }
  const path = `groups/${groupId}/transfers`;
  const q = query(collection(db, 'groups', groupId, 'transfers'), where('groupId', '==', groupId));
  return onSnapshot(
    q,
    (snapshot) => {
      const items = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          ...data,
          id: data.id || d.id,
          createdAtMs: data.createdAt?.toMillis?.() || 0,
        };
      });
      items.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
      onTransfers(items);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        if (onError) onError(wrapped);
      }
    }
  );
}

export async function createCapTransferInFirestore(groupId, transferObj) {
  const cleanGroupId = sanitizeId(groupId, 'group');
  const cleanId = sanitizeId(
    transferObj?.id || `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    'tr'
  );
  const path = `groups/${cleanGroupId}/transfers/${cleanId}`;
  try {
    const qty = Math.max(1, Math.min(100, Math.floor(Number(transferObj?.qty) || 1)));
    const payload = {
      id: cleanId,
      groupId: cleanGroupId,
      date: String(transferObj?.date || getTodayDateString()).slice(0, 10),
      offerId: String(transferObj?.offerId || '').trim().slice(0, 128),
      offerCode: String(transferObj?.offerCode || 'OFFER').trim().slice(0, 50) || 'OFFER',
      offerName: String(transferObj?.offerName || '').trim().slice(0, 200),
      fromMemberId: String(transferObj?.fromMemberId || '').trim().slice(0, 128),
      fromMemberName: String(transferObj?.fromMemberName || 'Thành viên').trim().slice(0, 100),
      toMemberId: String(transferObj?.toMemberId || '').trim().slice(0, 128),
      toMemberName: String(transferObj?.toMemberName || 'Thành viên').trim().slice(0, 100),
      qty,
      note: String(transferObj?.note || '').trim().slice(0, 200),
      source: transferObj?.source === 'telegram' ? 'telegram' : 'app',
      status: 'pending',
      resolvedBy: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    const batch = writeBatch(db);
    batch.set(doc(db, 'groups', cleanGroupId, 'transfers', cleanId), payload);
    await batch.commit();
    return { ...payload, id: cleanId };
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function resolveCapTransferInFirestore({
  groupId,
  transfer,
  action,
  resolvedBy = 'Leader',
  savedRecord = null,
}) {
  const cleanGroupId = sanitizeId(groupId, 'group');
  const cleanTransferId = sanitizeId(transfer?.id, 'tr');
  const cleanResolver = String(resolvedBy || 'Leader').trim().slice(0, 100) || 'Leader';
  const transferRef = doc(db, 'groups', cleanGroupId, 'transfers', cleanTransferId);

  if (!transfer || transfer.status !== 'pending') {
    return { ok: false, error: 'Yêu cầu nhượng CAP này đã được xử lý trước đó.' };
  }

  try {
    if (action === 'rejected') {
      await updateDoc(transferRef, {
        status: 'rejected',
        resolvedBy: cleanResolver,
        updatedAt: serverTimestamp(),
      });
      return { ok: true, status: 'rejected' };
    }

    const groupRef = doc(db, 'groups', cleanGroupId);
    const groupSnap = await getDoc(groupRef);
    if (!groupSnap.exists()) {
      return { ok: false, error: 'Không tìm thấy dữ liệu nhóm.' };
    }
    const groupData = groupSnap.data();
    const members = sanitizeMembers(groupData.members);
    const campaigns = sanitizeCampaigns(groupData.campaigns);

    const applied = applyCapTransferToState({
      matrix: groupData.matrix || null,
      record: savedRecord || null,
      completions: sanitizeCompletions(groupData.completions),
      dateStr: transfer.date,
      offerId: transfer.offerId,
      fromMemberId: transfer.fromMemberId,
      toMemberId: transfer.toMemberId,
      qty: transfer.qty,
      members,
      campaigns,
    });

    if (!applied.ok) {
      return { ok: false, error: applied.error };
    }

    const batch = writeBatch(db);

    if (savedRecord && applied.nextRecord) {
      const recMembers = sanitizeMembers(applied.nextRecord.members || members);
      const recOffers = sanitizeCampaigns(applied.nextRecord.campaigns || campaigns);
      const recMatrix = sanitizeMatrix(applied.nextRecord.matrix, recOffers, recMembers);
      const oldHistId = sanitizeId(savedRecord.id, 'hist');
      const updatedHistId = sanitizeId(
        `hist-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        'hist'
      );

      batch.delete(doc(db, 'groups', cleanGroupId, 'history', oldHistId));
      batch.set(doc(db, 'groups', cleanGroupId, 'history', updatedHistId), {
        id: updatedHistId,
        groupId: cleanGroupId,
        date: String(savedRecord.date || transfer.date).slice(0, 10),
        note: String(
          savedRecord.note || `Nhượng ${transfer.qty} CAP (${transfer.offerCode})`
        )
          .trim()
          .slice(0, 300),
        savedAt: new Date().toISOString().slice(0, 40),
        members: recMembers,
        campaigns: recOffers,
        matrix: recMatrix,
        stats: {
          assignedTotalCap: Math.max(0, Number(applied.nextRecord.stats?.assignedTotalCap) || 0),
          expectedTotalCap: Math.max(0, Number(applied.nextRecord.stats?.expectedTotalCap) || 0),
          assignedTotalPoints: Math.max(0, Number(applied.nextRecord.stats?.assignedTotalPoints) || 0),
          capSpread: Math.max(0, Number(applied.nextRecord.stats?.capSpread) || 0),
          pointSpread: Math.max(0, Number(applied.nextRecord.stats?.pointSpread) || 0),
        },
        createdAt: serverTimestamp(),
      });
    }

    const groupUpdates = {
      completions: sanitizeCompletions(applied.nextCompletions),
      updatedAt: serverTimestamp(),
    };
    if (applied.nextGroupMatrix) {
      groupUpdates.matrix = sanitizeMatrix(applied.nextGroupMatrix, campaigns, members);
    }
    batch.update(groupRef, groupUpdates);
    batch.update(transferRef, {
      status: 'approved',
      resolvedBy: cleanResolver,
      updatedAt: serverTimestamp(),
    });

    await batch.commit();
    return { ok: true, status: 'approved' };
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `groups/${cleanGroupId}/transfers/${cleanTransferId}`);
  }
}
