// Client helper for authenticated AI Assistant backend proxy routes (/api/ai/*).
import { getAuthRequestHeaders } from './telegramClient.js';

async function postAiJson(endpoint, payload, maxClientRetries = 1) {
  let lastResult = {
    ok: false,
    status: 0,
    data: null,
    error: 'Không thể kết nối tới dịch vụ AI trên máy chủ.',
  };

  for (let attempt = 0; attempt <= maxClientRetries; attempt++) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 75_000) : null;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: getAuthRequestHeaders(),
        body: JSON.stringify(payload || {}),
        signal: controller?.signal,
      });
      if (timer) clearTimeout(timer);
      const data = await res.json().catch(() => ({}));
      const result = {
        ok: Boolean(res.ok && data?.ok),
        status: res.status,
        data,
        error: data?.error || (!res.ok ? `Lỗi máy chủ AI (HTTP ${res.status}).` : ''),
      };
      if (result.ok) {
        return result;
      }
      lastResult = result;
      // Only retry proxy-level 502/504 drops; never retry 429/503 (backend already ran retries + model fallback)
      const shouldRetry =
        attempt < maxClientRetries &&
        (res.status === 502 || res.status === 504);
      if (!shouldRetry) {
        return result;
      }
    } catch (err) {
      if (timer) clearTimeout(timer);
      const isAbort = err instanceof Error && err.name === 'AbortError';
      lastResult = {
        ok: false,
        status: 0,
        data: null,
        error: isAbort
          ? 'Yêu cầu AI xử lý quá thời gian chờ. Vui lòng thử lại sau ít giây.'
          : 'Không thể kết nối tới dịch vụ AI trên máy chủ.',
      };
      if (attempt >= maxClientRetries || isAbort) {
        return lastResult;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 900));
  }

  return lastResult;
}

export function aiParseOffers({ groupId, text = '', imageBase64 = '', mimeType = 'image/png', existingOffers = [] }) {
  return postAiJson('/api/ai/parse-offers', {
    groupId,
    text,
    imageBase64,
    mimeType,
    existingOffers,
  });
}

export function aiDistributionCommand({
  groupId,
  prompt,
  members = [],
  campaigns = [],
  matrix = {},
  lockedCells = {},
  dateStr,
  settings = {},
}) {
  return postAiJson('/api/ai/distribution-command', {
    groupId,
    prompt,
    members,
    campaigns,
    matrix,
    lockedCells,
    dateStr,
    settings,
  });
}

export function aiAuditDistribution({ groupId, members = [], campaigns = [], matrix = {}, analyticsDataset = {}, dateStr }) {
  return postAiJson('/api/ai/audit-distribution', {
    groupId,
    members,
    campaigns,
    matrix,
    analyticsDataset,
    dateStr,
  });
}

export function aiAnalyticsQa({ groupId, question, analyticsDataset = {}, groupName = '' }) {
  return postAiJson('/api/ai/analytics-qa', {
    groupId,
    question,
    analyticsDataset,
    groupName,
  });
}
