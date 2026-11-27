// Client helper for authenticated backend proxy calls (/api/auth/* & /api/telegram/*).
// Holds any issued Bearer token strictly in JS memory (never in localStorage/sessionStorage).

let inMemorySessionToken = '';

export function setInMemorySessionToken(token) {
  inMemorySessionToken = typeof token === 'string' ? token : '';
}

export function clearInMemorySessionToken() {
  inMemorySessionToken = '';
}

export function getAuthRequestHeaders(extra = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    ...extra,
  };
  if (inMemorySessionToken) {
    headers.Authorization = `Bearer ${inMemorySessionToken}`;
  }
  return headers;
}

const buildHeaders = getAuthRequestHeaders;

async function fetchWithColdStartRetry(url, options = {}, maxRetries = 2) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (attempt < maxRetries && (res.status === 502 || res.status === 503 || res.status === 504)) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt >= maxRetries) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastError || new Error('Network error');
}

export async function loginLeaderOnServer(username, password) {
  try {
    const res = await fetchWithColdStartRetry('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: buildHeaders(),
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data?.ok && data?.token) {
      setInMemorySessionToken(data.token);
    }
    return {
      ok: Boolean(res.ok && data?.ok),
      status: res.status,
      session: data?.session || null,
      error: data?.error || '',
    };
  } catch {
    return { ok: false, status: 0, session: null, error: 'Không thể kết nối máy chủ.' };
  }
}

export async function logoutLeaderOnServer() {
  clearInMemorySessionToken();
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: buildHeaders(),
    });
  } catch {
    // ignore network errors on logout
  }
}

export async function checkServerAuthSession() {
  try {
    const res = await fetchWithColdStartRetry('/api/auth/session', {
      method: 'GET',
      credentials: 'same-origin',
      headers: buildHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    return {
      ok: Boolean(res.ok && data?.ok),
      authenticated: Boolean(data?.authenticated),
      groupId: data?.groupId || null,
      username: data?.username || null,
    };
  } catch {
    return { ok: false, authenticated: false, groupId: null, username: null };
  }
}

export async function fetchTelegramServerStatus(groupId = '') {
  try {
    const query = groupId ? `?groupId=${encodeURIComponent(groupId)}` : '';
    const res = await fetchWithColdStartRetry(`/api/telegram/status${query}`, {
      method: 'GET',
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    return {
      ok: Boolean(res.ok && data?.ok),
      configured: Boolean(data?.configured),
      defaultConfigured: Boolean(data?.defaultConfigured),
      encryptionEnvConfigured: Boolean(data?.encryptionEnvConfigured),
      aiConfigured: Boolean(data?.aiConfigured),
      byGroup: data?.byGroup && typeof data.byGroup === 'object' ? data.byGroup : {},
      serverDateVN: data?.serverDateVN || '',
      serverTimeVN: data?.serverTimeVN || '',
    };
  } catch {
    return {
      ok: false,
      configured: false,
      defaultConfigured: false,
      encryptionEnvConfigured: false,
      aiConfigured: false,
      byGroup: {},
      serverDateVN: '',
      serverTimeVN: '',
    };
  }
}

export async function saveGroupTelegramBotToken(groupId, botToken) {
  try {
    const res = await fetchWithColdStartRetry('/api/telegram/bot-token', {
      method: 'POST',
      credentials: 'same-origin',
      headers: buildHeaders(),
      body: JSON.stringify({ groupId, botToken }),
    });
    const data = await res.json().catch(() => ({}));
    return {
      ok: Boolean(res.ok && data?.ok),
      status: res.status,
      botUsername: data?.botUsername || '',
      tokenMasked: data?.tokenMasked || '',
      encryptedAtRest: Boolean(data?.encryptedAtRest),
      groupStatus: data?.groupStatus || null,
      error: data?.error || '',
    };
  } catch {
    return {
      ok: false,
      status: 0,
      botUsername: '',
      tokenMasked: '',
      encryptedAtRest: false,
      groupStatus: null,
      error: 'Không thể kết nối tới API Telegram của máy chủ.',
    };
  }
}

export async function deleteGroupTelegramBotToken(groupId) {
  try {
    const res = await fetchWithColdStartRetry('/api/telegram/bot-token', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: buildHeaders(),
      body: JSON.stringify({ groupId }),
    });
    const data = await res.json().catch(() => ({}));
    return {
      ok: Boolean(res.ok && data?.ok),
      status: res.status,
      groupStatus: data?.groupStatus || null,
      error: data?.error || '',
    };
  } catch {
    return {
      ok: false,
      status: 0,
      groupStatus: null,
      error: 'Không thể kết nối tới API Telegram của máy chủ.',
    };
  }
}

export async function sendTelegramTestMessage(groupId, chatId, botToken = '') {
  try {
    const payload = botToken ? { groupId, chatId, botToken } : { groupId, chatId };
    const res = await fetchWithColdStartRetry('/api/telegram/test', {
      method: 'POST',
      credentials: 'same-origin',
      headers: buildHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    return {
      ok: Boolean(res.ok && data?.ok),
      status: res.status,
      configured: Boolean(data?.configured),
      error: data?.error || '',
    };
  } catch {
    return {
      ok: false,
      status: 0,
      configured: false,
      error: 'Không thể kết nối tới API Telegram của máy chủ.',
    };
  }
}

export async function sendTelegramNotification(groupId, message, replyMarkup = null, meta = {}) {
  try {
    const payload = {
      groupId,
      message,
      ...(replyMarkup ? { replyMarkup } : {}),
      ...(meta?.distributionDate ? { distributionDate: meta.distributionDate } : {}),
      ...(meta?.matrixHash ? { matrixHash: meta.matrixHash } : {}),
    };
    const res = await fetchWithColdStartRetry('/api/telegram/send', {
      method: 'POST',
      credentials: 'same-origin',
      headers: buildHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    return {
      ok: Boolean(res.ok && data?.ok),
      status: res.status,
      configured: Boolean(data?.configured),
      error: data?.error || '',
    };
  } catch {
    return {
      ok: false,
      status: 0,
      configured: false,
      error: 'Không thể kết nối tới API Telegram của máy chủ.',
    };
  }
}

export async function sendTelegramPhoto(
  groupId,
  imageBase64,
  caption = '',
  replyMarkup = null,
  meta = {}
) {
  try {
    const payload = {
      groupId,
      imageBase64,
      caption,
      ...(replyMarkup ? { replyMarkup } : {}),
      ...(meta?.distributionDate ? { distributionDate: meta.distributionDate } : {}),
      ...(meta?.matrixHash ? { matrixHash: meta.matrixHash } : {}),
    };
    const res = await fetchWithColdStartRetry('/api/telegram/send-photo', {
      method: 'POST',
      credentials: 'same-origin',
      headers: buildHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    return {
      ok: Boolean(res.ok && data?.ok),
      status: res.status,
      configured: Boolean(data?.configured),
      error: data?.error || '',
    };
  } catch {
    return {
      ok: false,
      status: 0,
      configured: false,
      error: 'Không thể kết nối tới API Telegram của máy chủ.',
    };
  }
}

