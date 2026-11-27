export function loadFromStorage(key, fallback) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return fallback;
    }
    const raw = window.localStorage.getItem(key);
    if (raw === null) {
      return fallback;
    }
    const parsed = JSON.parse(raw);
    return parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

export function saveToStorage(key, value) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return false;
    }
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeFromStorage(key) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return;
    }
    window.localStorage.removeItem(key);
  } catch {
    // ignore storage errors
  }
}

export function getTodayDateString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDaysToIso(dateStr, offsetDays) {
  const [y, m, d] = (dateStr || getTodayDateString()).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + offsetDays);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

export function getDateRange(startDateStr, count = 7) {
  const list = [];
  for (let i = 0; i < count; i++) {
    list.push(addDaysToIso(startDateStr, i));
  }
  return list;
}

const WEEKDAY_VI = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

export function formatCalendarDateHeader(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const dd = String(d).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  const wd = WEEKDAY_VI[dt.getDay()];
  return {
    shortDate: `${dd}/${mm}`,
    weekday: wd,
  };
}

export function createId(prefix = 'id') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
