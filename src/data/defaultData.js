export const STORAGE_KEYS = {
  GROUPS: 'cap_manager_groups_v3',
  ACTIVE_GROUP_ID: 'cap_manager_active_group_v3',
  AUTH_SESSION: 'cap_manager_auth_v4',
  LOCKED_CELLS: 'cap_manager_locked_cells_v1',
};

export const SHIFTS = [
  {
    id: 'ca1',
    label: 'Ca1',
    fullLabel: 'Ca 1',
    timeRange: '08:00 – 12:00',
    shortLabel: 'Ca 1 (8h–12h)',
  },
  {
    id: 'ca2',
    label: 'Ca2',
    fullLabel: 'Ca 2',
    timeRange: '14:45 – 18:45',
    shortLabel: 'Ca 2 (14h45–18h45)',
  },
  {
    id: 'ca3',
    label: 'Ca3',
    fullLabel: 'Ca 3',
    timeRange: '19:00 – 22:00',
    shortLabel: 'Ca 3 (19h–22h)',
  },
];

function buildInitialSchedule(baseShifts, baseDateStr) {
  const schedule = {};
  const [y, m, d] = baseDateStr.split('-').map(Number);
  const start = new Date(y, m - 1, d);
  for (let offset = -1; offset <= 10; offset++) {
    const dt = new Date(start);
    dt.setDate(start.getDate() + offset);
    const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    schedule[iso] = [...baseShifts];
  }
  return schedule;
}

function getTodayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

const TODAY_ISO = getTodayIso();

export const DEFAULT_MEMBERS = [
  {
    id: 'mem-trung-bao',
    memberCode: '84',
    name: 'Trung Bảo',
    isLeader: true,
    isNew: false,
    active: true,
    priority: 'normal',
    shifts: ['ca1', 'ca2', 'ca3'],
    shiftSchedule: buildInitialSchedule(['ca1', 'ca2', 'ca3'], TODAY_ISO),
  },
  {
    id: 'mem-hieu',
    memberCode: '73',
    name: 'Hiếu',
    isLeader: false,
    isNew: false,
    active: true,
    priority: 'normal',
    shifts: ['ca2', 'ca3'],
    shiftSchedule: buildInitialSchedule(['ca2', 'ca3'], TODAY_ISO),
  },
  {
    id: 'mem-huy-bao',
    memberCode: '83',
    name: 'Huy Bảo',
    isLeader: false,
    isNew: false,
    active: true,
    priority: 'normal',
    shifts: ['ca1', 'ca3'],
    shiftSchedule: buildInitialSchedule(['ca1', 'ca3'], TODAY_ISO),
  },
  {
    id: 'mem-uyen',
    memberCode: '66',
    name: 'Uyên',
    isLeader: false,
    isNew: false,
    active: true,
    priority: 'normal',
    shifts: ['ca1', 'ca2'],
    shiftSchedule: buildInitialSchedule(['ca1', 'ca2'], TODAY_ISO),
  },
  {
    id: 'mem-hoai',
    memberCode: '126',
    name: 'Hoài',
    isLeader: false,
    isNew: false,
    active: true,
    priority: 'normal',
    shifts: ['ca2', 'ca3'],
    shiftSchedule: buildInitialSchedule(['ca2', 'ca3'], TODAY_ISO),
  },
  {
    id: 'mem-chi-hon',
    memberCode: '140',
    name: 'Chi Hon',
    isLeader: false,
    isNew: true,
    active: true,
    priority: 'normal',
    shifts: ['ca1', 'ca2'],
    shiftSchedule: buildInitialSchedule(['ca1', 'ca2'], TODAY_ISO),
  },
];

// Sorted by pointsPerCap DESC (highest point first)
export const DEFAULT_OFFERS = [
  {
    id: 'offer-1769',
    code: '1769',
    name: '22038737 - Everydayhealth - Diabetes Cocktail Guide',
    totalCap: 6,
    pointsPerCap: 35,
    capHour: '10h',
    timeWindow: '10h (Cả ngày)',
    note: 'Điểm cao ưu tiên chia ca sáng hôm sau',
    condition: 'Tất cả thành viên',
    eligibilityType: 'all',
    eligibleMemberIds: [],
  },
  {
    id: 'offer-1706',
    code: '1706',
    name: '2288 - Everyday Health - Diabetes Snacks',
    totalCap: 5,
    pointsPerCap: 30,
    capHour: '10h',
    timeWindow: '10h (19h–11h)',
    note: '',
    condition: 'Tất cả thành viên',
    eligibilityType: 'all',
    eligibleMemberIds: [],
  },
  {
    id: 'offer-1551',
    code: '1551',
    name: '21997905 - EverydayHealth - Diabetes Snacks',
    totalCap: 12,
    pointsPerCap: 25,
    capHour: '10h',
    timeWindow: '10h (Cả ngày)',
    note: '',
    condition: 'Tất cả thành viên',
    eligibilityType: 'all',
    eligibleMemberIds: [],
  },
  {
    id: 'offer-936',
    code: '936',
    name: '21872327 - Everydayhealth - Diabetes Snacks',
    totalCap: 8,
    pointsPerCap: 25,
    capHour: '23h',
    timeWindow: '23h (19h–12h)',
    note: '',
    condition: 'Tất cả thành viên',
    eligibilityType: 'all',
    eligibleMemberIds: [],
  },
  {
    id: 'offer-1134',
    code: '1134',
    name: "999 - Everyday Health - Men's Treatments Path",
    totalCap: 5,
    pointsPerCap: 25,
    capHour: '21h30',
    timeWindow: '21h30 (18h–11h hôm sau)',
    note: '',
    condition: 'Tất cả thành viên',
    eligibilityType: 'all',
    eligibleMemberIds: [],
  },
  {
    id: 'offer-1132',
    code: '1132',
    name: '997 - Everyday Health - Diabetes Snacks',
    totalCap: 5,
    pointsPerCap: 25,
    capHour: '23h',
    timeWindow: '23h (18h–12h)',
    note: '',
    condition: 'Tất cả thành viên',
    eligibilityType: 'all',
    eligibleMemberIds: [],
  },
  {
    id: 'offer-1260',
    code: '1260',
    name: '21928418 - EverydayHealth - Diabetes Cocktail Guide',
    totalCap: 3,
    pointsPerCap: 25,
    capHour: '23h',
    timeWindow: '23h (Từ 20h)',
    note: '',
    condition: 'Tất cả thành viên',
    eligibilityType: 'all',
    eligibleMemberIds: [],
  },
  {
    id: 'offer-1257',
    code: '1257',
    name: '21927987 - Everydayhealth - Diabetes Cocktail Guide',
    totalCap: 5,
    pointsPerCap: 20,
    capHour: '23h',
    timeWindow: '23h (Từ 20h)',
    note: '',
    condition: 'Tất cả thành viên',
    eligibilityType: 'all',
    eligibleMemberIds: [],
  },
];

// Keep alias for compatibility
export const DEFAULT_CAMPAIGNS = DEFAULT_OFFERS;

export const DEFAULT_SETTINGS = {
  leaderPriority: 'medium', // 'normal' | 'low' | 'medium' | 'high'
  newMemberMode: 'less', // 'less' | 'normal'
  capBalanceLevel: 'high', // 'high' | 'medium'
  pointBalanceLevel: 'high', // 'high' | 'medium'
  useShiftMatching: true, // Ca 2,3 hôm nay + Ca 1 ngày mai
  useRolloverFairness: false, // Bù chênh lệch điểm từ lần lưu gần nhất
  optimizationTrials: 15,
  autoSaveHistoryOnDistribute: false,
  telegramEnabled: false,
  telegramChatId: '',
  telegramShiftReminderEnabled: false,
  telegramShiftReminderTime: '',
  telegramInteractiveEnabled: false,
  telegramDeadlineReminderTime: '',
  telegramDailySummaryTime: '',
  aiButlerEnabled: false,
  telegramTemplates: {
    capPublish: '',
    capUpdate: '',
    shiftReminder: '',
    testMessage: '',
  },
};

export function createDefaultGroup1(initialMatrix = null) {
  return {
    id: 'group-1',
    name: 'Nhóm 1',
    description: 'Nhóm chính mặc định',
    leaderAccount: {
      username: 'leader1',
      password: '123456',
      displayName: 'Trung Bảo (Nhóm trưởng Nhóm 1)',
    },
    members: structuredClone(DEFAULT_MEMBERS),
    campaigns: [],
    matrix: initialMatrix,
    autoBackup: initialMatrix,
    completions: {},
    history: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}
