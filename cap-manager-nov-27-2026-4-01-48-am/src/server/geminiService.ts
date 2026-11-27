import crypto from 'node:crypto';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { computeDistributionStats, getMemberEffectiveShiftsForDay, isEveningOnlyOffer } from '../utils/capAlgorithm.js';

export const GEMINI_MODEL = 'gemini-4-hydrogen';
export const GEMINI_FALLBACK_MODEL = 'gemini-3.1-flash-lite';

function getGeminiApiKey(): string {
  const raw = String(process.env.GEMINI_API_KEY || '').trim();
  if (!raw || raw === 'MY_GEMINI_API_KEY') return '';
  return raw;
}

function getKeyFingerprint(apiKey: string): string {
  return crypto.createHash('sha1').update(apiKey).digest('hex').slice(0, 12);
}

export function isGeminiConfigured(): boolean {
  return Boolean(getGeminiApiKey());
}

function getAiClient(): GoogleGenAI | null {
  const apiKey = getGeminiApiKey();
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      timeout: 35_000,
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const MISSING_KEY_ERROR =
  'Chưa cấu hình GEMINI_API_KEY. Vui lòng thêm GEMINI_API_KEY trong phần Settings > Secrets của dự án rồi thử lại.';

export function isAuthGeminiError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err || '');
  return /API_KEY_INVALID|API key not valid|\b403\b|PERMISSION_DENIED|UNAUTHENTICATED/i.test(raw);
}

export function isQuotaGeminiError(err: unknown): boolean {
  if (isAuthGeminiError(err)) return false;
  const raw = err instanceof Error ? err.message : String(err || '');
  return /\b429\b|RESOURCE_EXHAUSTED|quota|rate limit/i.test(raw);
}

export function isTransientNetworkGeminiError(err: unknown): boolean {
  if (isAuthGeminiError(err) || isQuotaGeminiError(err)) return false;
  const raw = err instanceof Error ? err.message : String(err || '');
  if (/\b400\b|INVALID_ARGUMENT/i.test(raw)) return false;
  return /\b500\b|\b502\b|\b503\b|\b504\b|UNAVAILABLE|INTERNAL|DEADLINE_EXCEEDED|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR|socket|timeout|timed out|overloaded|fetch failed|network|EMPTY_RESPONSE/i.test(
    raw
  );
}

export function isTransientGeminiError(err: unknown): boolean {
  return isQuotaGeminiError(err) || isTransientNetworkGeminiError(err);
}

export function parseGeminiRetryDelayMs(err: unknown): number {
  const raw = err instanceof Error ? err.message : String(err || '');
  const jsonDelay = raw.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  if (jsonDelay) {
    return Math.max(0, Math.round(Number(jsonDelay[1]) * 1000));
  }
  const hmsMatch = raw.match(/retry in\s+(?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
  if (hmsMatch) {
    const h = Number(hmsMatch[1] || 0);
    const m = Number(hmsMatch[2] || 0);
    const s = Number(hmsMatch[3] || 0);
    return Math.max(0, Math.round((h * 3600 + m * 60 + s) * 1000));
  }
  return 0;
}

export function isDailyQuotaExceeded(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err || '');
  if (/PerDay|per day|GenerateRequestsPerDay/i.test(raw)) return true;
  return parseGeminiRetryDelayMs(err) >= 300_000;
}

export function parseGeminiJsonText<T>(rawText: string): T {
  let text = String(rawText || '').trim();
  if (!text) {
    throw new Error('EMPTY_RESPONSE: Phản hồi AI trống.');
  }
  const fencedMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fencedMatch && fencedMatch[1]) {
    text = fencedMatch[1].trim();
  }
  return JSON.parse(text) as T;
}

export function extractShortGeminiReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err || '');
  const codeMatch = raw.match(/\b(400|401|403|404|429|500|502|503|504)\b/);
  const statusMatch = raw.match(
    /\bEMPTY_RESPONSE(?:\([^)]+\))?|\b(UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE_EXCEEDED|INTERNAL|PERMISSION_DENIED|INVALID_ARGUMENT|NOT_FOUND)\b/i
  );
  if (codeMatch && statusMatch) return `${codeMatch[1]} ${statusMatch[0].toUpperCase()}`;
  if (statusMatch) return statusMatch[0];
  if (/timeout|timed out|ETIMEDOUT|AbortError/i.test(raw)) return 'timeout';
  if (/ECONNRESET|fetch failed|UND_ERR|network/i.test(raw)) return 'network/fetch failed';
  return raw.replace(/\s+/g, ' ').trim().slice(0, 80) || 'unknown';
}

export function formatGeminiError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err || 'Lỗi không xác định từ Gemini API.');
  if (isAuthGeminiError(err)) {
    return 'GEMINI_API_KEY không hợp lệ hoặc bị từ chối quyền. Vui lòng kiểm tra lại trong Settings > Secrets.';
  }
  if (isQuotaGeminiError(err)) {
    if (isDailyQuotaExceeded(err)) {
      return 'Hạn mức Gemini API miễn phí (Free Tier) theo ngày đã tạm hết. Vui lòng nâng cấp API Key có bật thanh toán trong Settings > Secrets hoặc đợi chu kỳ reset.';
    }
    return 'Hệ thống AI đang chạm giới hạn tốc độ (RPM). Vui lòng đợi khoảng 20–30 giây rồi thử lại.';
  }
  if (isTransientNetworkGeminiError(err)) {
    const reason = extractShortGeminiReason(err);
    return `Kết nối tới máy chủ AI tạm thời gián đoạn (${reason}). Vui lòng thử lại sau ít giây.`;
  }
  return `Lỗi xử lý AI: ${raw.slice(0, 220)}`;
}

export function buildGeminiAttemptConfig(
  baseConfig: Record<string, unknown>,
  model: string,
  attemptIndex: number
): Record<string, unknown> {
  const nextConfig: Record<string, unknown> = { ...baseConfig };
  if (model === GEMINI_FALLBACK_MODEL) {
    // Let gemini-3.1-flash-lite use its native default (MINIMAL) without incompatible thinkingLevel overrides
    delete nextConfig.thinkingConfig;
    return nextConfig;
  }
  if (attemptIndex > 0) {
    const tc = nextConfig.thinkingConfig as { thinkingLevel?: ThinkingLevel } | undefined;
    if (tc?.thinkingLevel === ThinkingLevel.MEDIUM || tc?.thinkingLevel === ThinkingLevel.HIGH) {
      nextConfig.thinkingConfig = { ...tc, thinkingLevel: ThinkingLevel.LOW };
    }
  }
  return nextConfig;
}

const modelCooldowns = new Map<string, { until: number; lastErr: unknown }>();
const aiResponseCache = new Map<string, { expiresAt: number; data: unknown }>();
const aiInFlight = new Map<string, Promise<unknown>>();

function getModelCooldown(keyFp: string, model: string): { active: boolean; lastErr: unknown } {
  const entry = modelCooldowns.get(`${keyFp}:${model}`);
  if (!entry) return { active: false, lastErr: null };
  if (Date.now() >= entry.until) {
    modelCooldowns.delete(`${keyFp}:${model}`);
    return { active: false, lastErr: null };
  }
  return { active: true, lastErr: entry.lastErr };
}

function recordModelQuotaCooldown(keyFp: string, model: string, err: unknown): void {
  if (!isQuotaGeminiError(err)) return;
  const delayMs = parseGeminiRetryDelayMs(err);
  const cooldownMs = isDailyQuotaExceeded(err)
    ? 15 * 60_000
    : Math.max(20_000, Math.min(90_000, (delayMs || 20_000) + 2_000));
  modelCooldowns.set(`${keyFp}:${model}`, {
    until: Date.now() + cooldownMs,
    lastErr: err,
  });
}

function hashCacheKey(prefix: string, payload: unknown): string {
  return `${prefix}:${crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex')}`;
}

export type GeminiCallResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; missingKey?: boolean; transient?: boolean; quotaExceeded?: boolean };

async function generateJsonWithRetry<T>(
  contents: unknown,
  config: Record<string, unknown>,
  options: {
    maxNetworkRetriesPerModel?: number;
    preferLite?: boolean;
    cacheKey?: string;
    cacheTtlMs?: number;
  } = {}
): Promise<GeminiCallResult<T>> {
  const apiKey = getGeminiApiKey();
  const ai = getAiClient();
  if (!ai || !apiKey) {
    return { ok: false, error: MISSING_KEY_ERROR, missingKey: true };
  }

  const { maxNetworkRetriesPerModel = 1, preferLite = false, cacheKey, cacheTtlMs = 90_000 } = options;

  if (cacheKey) {
    const cached = aiResponseCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { ok: true, data: cached.data as T };
    }
    const existingFlight = aiInFlight.get(cacheKey);
    if (existingFlight) {
      return (await existingFlight) as GeminiCallResult<T>;
    }
  }

  const run = async (): Promise<GeminiCallResult<T>> => {
    const keyFp = getKeyFingerprint(apiKey);
    const modelOrder = preferLite
      ? [GEMINI_FALLBACK_MODEL, GEMINI_MODEL]
      : [GEMINI_MODEL, GEMINI_FALLBACK_MODEL];

    let lastErr: unknown = null;
    let primaryQuotaErr: unknown = null;

    for (const model of modelOrder) {
      const cd = getModelCooldown(keyFp, model);
      if (cd.active) {
        if (!primaryQuotaErr) primaryQuotaErr = cd.lastErr;
        if (!lastErr) lastErr = cd.lastErr;
        continue;
      }

      const retriesForThisModel =
        model === GEMINI_FALLBACK_MODEL ? Math.max(2, maxNetworkRetriesPerModel) : maxNetworkRetriesPerModel;

      for (let attempt = 0; attempt <= retriesForThisModel; attempt++) {
        const attemptConfig = buildGeminiAttemptConfig(config, model, attempt);
        try {
          const response = await ai.models.generateContent({
            model,
            contents: contents as never,
            config: attemptConfig as never,
          });
          const rawText = String(response.text || '').trim();
          if (!rawText) {
            const finishReason = String(
              (response as { candidates?: Array<{ finishReason?: string }> })?.candidates?.[0]?.finishReason || 'UNKNOWN'
            );
            throw new Error(`EMPTY_RESPONSE(finishReason=${finishReason})`);
          }
          const parsed = parseGeminiJsonText<T>(rawText);
          if (cacheKey) {
            if (aiResponseCache.size >= 100) {
              const firstKey = aiResponseCache.keys().next().value;
              if (firstKey) aiResponseCache.delete(firstKey);
            }
            aiResponseCache.set(cacheKey, {
              expiresAt: Date.now() + cacheTtlMs,
              data: parsed,
            });
          }
          return { ok: true, data: parsed };
        } catch (err) {
          lastErr = err;
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[GeminiService] ${model} attempt ${attempt + 1}/${retriesForThisModel + 1} failed:`, msg);

          if (isAuthGeminiError(err)) {
            return { ok: false, error: formatGeminiError(err) };
          }

          if (isQuotaGeminiError(err)) {
            if (!primaryQuotaErr) primaryQuotaErr = err;
            recordModelQuotaCooldown(keyFp, model, err);
            // Never retry the same model on 429 — switch immediately to fallback model
            break;
          }

          if (!isTransientNetworkGeminiError(err)) {
            return { ok: false, error: formatGeminiError(err) };
          }

          if (attempt < retriesForThisModel) {
            const jitter = Math.floor(Math.random() * 250);
            await new Promise((resolve) => setTimeout(resolve, 900 * (attempt + 1) + jitter));
          }
        }
      }
    }

    const effectiveErr =
      primaryQuotaErr && (!lastErr || isQuotaGeminiError(lastErr)) ? primaryQuotaErr : lastErr;
    const quotaExceeded = isQuotaGeminiError(effectiveErr) || Boolean(primaryQuotaErr);

    if (primaryQuotaErr && lastErr && primaryQuotaErr !== lastErr && isTransientNetworkGeminiError(lastErr)) {
      const reason = extractShortGeminiReason(lastErr);
      console.error(`[GeminiService] Fallback failed after primary quota exhaustion: ${reason}`);
      return {
        ok: false,
        error: `Model AI chính đang vượt hạn mức Free Tier và máy chủ dự phòng tạm thời gián đoạn (${reason}). Vui lòng thử lại sau ít giây hoặc nâng cấp GEMINI_API_KEY trong Settings > Secrets.`,
        transient: true,
        quotaExceeded: true,
      };
    }

    return {
      ok: false,
      error: formatGeminiError(effectiveErr),
      transient: isTransientNetworkGeminiError(effectiveErr),
      quotaExceeded,
    };
  };

  if (!cacheKey) {
    return run();
  }

  const promise = run().finally(() => {
    aiInFlight.delete(cacheKey);
  });
  aiInFlight.set(cacheKey, promise);
  return promise;
}

export async function parseOffersWithGemini({
  text = '',
  imageBase64 = '',
  mimeType = 'image/png',
  existingOffers = [],
}: {
  text?: string;
  imageBase64?: string;
  mimeType?: string;
  existingOffers?: Array<{ code?: string; name?: string; capHour?: string; pointsPerCap?: number }>;
}) {
  const cleanText = String(text || '').trim();
  const cleanBase64 = String(imageBase64 || '')
    .replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '')
    .trim();

  if (!cleanText && !cleanBase64) {
    return { ok: false as const, error: 'Vui lòng dán nội dung tin nhắn hoặc chọn ảnh bảng Offer.' };
  }

  const allowedMimes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const safeMime = allowedMimes.has(mimeType) ? mimeType : 'image/png';

  const existingSummary = (existingOffers || [])
    .slice(0, 60)
    .map((o) => `${o.code || ''} | ${o.name || ''} | ${o.capHour || '10h'} | ${o.pointsPerCap || 25}p`)
    .join('\n');

  const promptText = [
    'Bạn là trợ lý trích xuất dữ liệu Offer CAP cho team affiliate/CPA tại Việt Nam.',
    'Hãy đọc kỹ văn bản giao kèo và/hoặc ảnh chụp bảng Offer dưới đây và trích xuất chính xác danh sách các Offer.',
    'Quy tắc bắt buộc:',
    '- code: Mã Offer ngắn (ví dụ 1769, 1551, 936 hoặc mã số đầu tiên của offer). Nếu chỉ có ID dài trong Name như "21997905 - ...", dùng mã số đó hoặc khớp với danh sách Offer hiện có nếu trùng.',
    '- name: Tên đầy đủ của offer.',
    '- capHour: Giờ mở/chốt CAP chung chuẩn hóa dạng "10h", "21h30", "23h" (mặc định "10h" nếu cả ngày hoặc không ghi).',
    '- totalCap: Tổng số CAP giao cho cả nhóm (số nguyên >= 0).',
    '- pointsPerCap: Điểm trên mỗi 1 CAP (số nguyên > 0; nếu không ghi và trùng offer cũ thì lấy điểm cũ, nếu mới thì ước lượng 25).',
    '- timeWindow: Mô tả khung giờ thực hiện (ví dụ "10h (Cả ngày)", "23h (19h–12h)").',
    '- eligibilityType: "exclude_new" nếu tin nhắn ghi rõ không cho thành viên mới / newbie / TV mới; ngược lại dùng "all".',
    '- note: Điều kiện phụ hoặc ghi chú ngắn gọn (chuỗi rỗng nếu không có).',
    existingSummary ? `\nDanh sách Offer hiện có của nhóm để đối chiếu mã:\n${existingSummary}` : '',
    cleanText ? `\nTin nhắn / văn bản cần trích xuất:\n${cleanText}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const parts: Array<Record<string, unknown>> = [{ text: promptText }];
  if (cleanBase64) {
    parts.push({
      inlineData: {
        mimeType: safeMime,
        data: cleanBase64,
      },
    });
  }

  return generateJsonWithRetry<{
    summary: string;
    offers: Array<{
      code: string;
      name: string;
      capHour: string;
      totalCap: number;
      pointsPerCap: number;
      timeWindow: string;
      eligibilityType: 'all' | 'exclude_new';
      note: string;
    }>;
  }>([{ role: 'user', parts }], {
    thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
    responseMimeType: 'application/json',
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        summary: { type: Type.STRING },
        offers: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              code: { type: Type.STRING },
              name: { type: Type.STRING },
              capHour: { type: Type.STRING },
              totalCap: { type: Type.INTEGER },
              pointsPerCap: { type: Type.INTEGER },
              timeWindow: { type: Type.STRING },
              eligibilityType: { type: Type.STRING, enum: ['all', 'exclude_new'] },
              note: { type: Type.STRING },
            },
            required: ['code', 'name', 'capHour', 'totalCap', 'pointsPerCap', 'timeWindow', 'eligibilityType', 'note'],
          },
        },
      },
      required: ['summary', 'offers'],
    },
  });
}

export async function parseDistributionCommandWithGemini({
  prompt,
  members = [],
  campaigns = [],
  matrix = {},
  lockedCells = {},
  dateStr,
  settings = {},
}: {
  prompt: string;
  members: Array<any>;
  campaigns: Array<any>;
  matrix?: Record<string, any>;
  lockedCells?: Record<string, any>;
  dateStr: string;
  settings?: Record<string, unknown>;
}) {
  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt) {
    return { ok: false as const, error: 'Vui lòng nhập yêu cầu điều chỉnh bảng chia CAP bằng tiếng Việt.' };
  }

  const currentStats = (computeDistributionStats as (...args: any[]) => any)(
    matrix || {},
    campaigns,
    members,
    dateStr
  );

  const membersDesc = members.map((m) => {
    const eff = getMemberEffectiveShiftsForDay(m, dateStr);
    const mStat = currentStats?.memberTotalsMap?.[m.id];
    const offerBreakdown = campaigns
      .map((c) => {
        const qty = Math.max(0, Math.floor(Number(matrix?.[c.id]?.[m.id]) || 0));
        const isLocked = Boolean(lockedCells?.[c.id]?.[m.id]);
        if (qty === 0 && !isLocked) return null;
        return `${c.code}:${qty}${isLocked ? '[ghim]' : ''}`;
      })
      .filter(Boolean)
      .join(', ');
    return `- id="${m.id}" | tên="${m.name}" | leader=${Boolean(m.isLeader)} | mới=${Boolean(m.isNew)} | active=${m.active !== false} | ca_hôm_nay=[${eff.todayShifts.join(',')}] | ca_mai=[${eff.nextDayShifts.join(',')}] | hiện_có=${mStat?.totalCap ?? 0}CAP/${mStat?.totalPoints ?? 0}đ${offerBreakdown ? ` (${offerBreakdown})` : ''}`;
  });

  const offersDesc = campaigns.map(
    (c) => `- id="${c.id}" | code="${c.code}" | giờ="${c.capHour || '10h'}" | tổngCAP=${c.totalCap} | điểm=${c.pointsPerCap} | tên="${c.name}"`
  );

  const systemInstruction = [
    'Bạn là trợ lý điều chỉnh bảng chia CAP thông minh cho Nhóm trưởng.',
    'LUÔN sử dụng ĐÚNG các memberId và offerId có trong danh sách. KHÔNG tự bịa ID. Chú ý phân biệt kỹ tên gần giống (ví dụ "Trung Bảo" vs "Huy Bảo").',
    '',
    'Chọn `actionMode`:',
    '- "edit_only": khi Leader CHỈ muốn chuyển/hoán đổi/nhượng CAP trực tiếp giữa thành viên hoặc ghim ô cụ thể mà KHÔNG muốn xáo trộn bảng hiện tại của những người khác.',
    '- "reoptimize": khi Leader muốn chia lại bảng, thay đổi ưu tiên, bù điểm, khóa vài người rồi chia lại phần còn lại, thêm/bớt CAP mục tiêu, loại thành viên, hoặc đổi ca rồi chia lại.',
    '',
    'Quy tắc map các trường (mảng nào không dùng thì để []):',
    '1. `transfers`: Khi yêu cầu chuyển/nhượng/đổi N CAP từ người A sang người B (ví dụ "chuyển 1 CAP 1769 từ Trung Bảo sang Huy Bảo", "lấy 2 CAP của Hiếu đưa Hoài"). Để offerId="" nếu không chỉ định offer cụ thể.',
    '2. `lockMemberIds`: Khi yêu cầu giữ nguyên bảng của ai đó (ví dụ "giữ nguyên CAP của Hoài, chỉ chia lại người khác").',
    '3. `lockOfferIds`: Khi yêu cầu giữ nguyên một Offer nào đó.',
    '4. `excludeMemberIds`: Khi yêu cầu KHÔNG chia bất kỳ CAP nào hôm nay cho ai (nghỉ/0 CAP).',
    '5. `onlyIncludeMemberIds`: CHỈ điền nếu yêu cầu chỉ chia cho đúng nhóm người X (không cho người ngoài nhóm đó).',
    '6. `excludeMemberFromHourBuckets`: Khi không chia khung giờ cụ thể (bucket: "evening", "23h", "21h30", "10h", "morning", "afternoon", "all").',
    '7. `excludeCells` & `pinCells`: Khi cấm 1 người làm 1 offer cụ thể, hoặc ghim cứng đúng số CAP ở offer đó.',
    '8. `overrideMemberShifts`: Khi có điều chỉnh ca làm tạm thời để chạy lại bảng (day="today"|"tomorrow", shifts là mảng con của ["ca1","ca2","ca3"] hoặc [] nếu nghỉ).',
    '9. `memberTargetAdjustments`: Khi yêu cầu tăng/giảm/đặt tổng CAP cho thành viên:',
    '   - mode="exact_cap", value=N: đặt tổng CAP của thành viên gần nhất về N CAP (vd "chia cho Huy Bảo đúng 5 CAP").',
    '   - mode="delta_cap", value=N (dương hoặc âm): tăng thêm N CAP (vd +2) hoặc giảm bớt |N| CAP (vd -2) so với số CAP hiện có.',
    '   - mode="boost" / mode="reduce", value=1: ưu tiên nhiều hơn / chia ít hơn tương đối.',
    '   Cũng giữ `boostMemberIds` / `reduceMemberIds` đồng bộ nếu dùng boost/reduce.',
    '10. `settingsPatch`: chỉ đặt `applySettings: true` khi Leader yêu cầu đổi cài đặt (useShiftMatching, useRolloverFairness, leaderPriority, newMemberMode).',
  ].join('\n');

  const userPrompt = [
    `Ngày chia: ${dateStr}`,
    `Bảng nháp hiện tại: đã chia ${currentStats?.assignedTotalCap ?? 0}/${currentStats?.expectedTotalCap ?? 0} CAP · lệch CAP=${currentStats?.capSpread ?? 0} · lệch điểm=${currentStats?.pointSpread ?? 0}`,
    `Cài đặt hiện tại: leaderPriority=${String(settings.leaderPriority || 'medium')}, newMemberMode=${String(settings.newMemberMode || 'less')}, useShiftMatching=${String(settings.useShiftMatching !== false)}, useRolloverFairness=${String(Boolean(settings.useRolloverFairness))}`,
    '\nThành viên & CAP hiện tại:\n' + membersDesc.join('\n'),
    '\nDanh sách Offer:\n' + offersDesc.join('\n'),
    `\nYêu cầu của Leader:\n"${cleanPrompt}"`,
  ].join('\n');

  return generateJsonWithRetry<{
    summary: string;
    actionMode: 'edit_only' | 'reoptimize';
    transfers: Array<{ fromMemberId: string; toMemberId: string; offerId: string; qty: number }>;
    lockMemberIds: string[];
    lockOfferIds: string[];
    excludeMemberIds: string[];
    onlyIncludeMemberIds: string[];
    overrideMemberShifts: Array<{ memberId: string; day: 'today' | 'tomorrow'; shifts: string[] }>;
    memberTargetAdjustments: Array<{
      memberId: string;
      mode: 'exact_cap' | 'delta_cap' | 'boost' | 'reduce';
      value: number;
    }>;
    excludeMemberFromHourBuckets: Array<{ memberId: string; bucket: string }>;
    excludeCells: Array<{ memberId: string; offerId: string }>;
    pinCells: Array<{ memberId: string; offerId: string; qty: number }>;
    boostMemberIds: string[];
    reduceMemberIds: string[];
    settingsPatch: {
      applySettings: boolean;
      useShiftMatching?: boolean;
      useRolloverFairness?: boolean;
      leaderPriority?: string;
      newMemberMode?: string;
    };
  }>(userPrompt, {
    systemInstruction,
    thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
    responseMimeType: 'application/json',
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        summary: { type: Type.STRING },
        actionMode: { type: Type.STRING, enum: ['edit_only', 'reoptimize'] },
        transfers: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              fromMemberId: { type: Type.STRING },
              toMemberId: { type: Type.STRING },
              offerId: { type: Type.STRING },
              qty: { type: Type.INTEGER },
            },
            required: ['fromMemberId', 'toMemberId', 'offerId', 'qty'],
          },
        },
        lockMemberIds: { type: Type.ARRAY, items: { type: Type.STRING } },
        lockOfferIds: { type: Type.ARRAY, items: { type: Type.STRING } },
        excludeMemberIds: { type: Type.ARRAY, items: { type: Type.STRING } },
        onlyIncludeMemberIds: { type: Type.ARRAY, items: { type: Type.STRING } },
        overrideMemberShifts: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              memberId: { type: Type.STRING },
              day: { type: Type.STRING, enum: ['today', 'tomorrow'] },
              shifts: { type: Type.ARRAY, items: { type: Type.STRING } },
            },
            required: ['memberId', 'day', 'shifts'],
          },
        },
        memberTargetAdjustments: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              memberId: { type: Type.STRING },
              mode: { type: Type.STRING, enum: ['exact_cap', 'delta_cap', 'boost', 'reduce'] },
              value: { type: Type.INTEGER },
            },
            required: ['memberId', 'mode', 'value'],
          },
        },
        excludeMemberFromHourBuckets: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              memberId: { type: Type.STRING },
              bucket: { type: Type.STRING, enum: ['evening', 'morning', 'afternoon', 'all', '23h', '21h30', '10h'] },
            },
            required: ['memberId', 'bucket'],
          },
        },
        excludeCells: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              memberId: { type: Type.STRING },
              offerId: { type: Type.STRING },
            },
            required: ['memberId', 'offerId'],
          },
        },
        pinCells: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              memberId: { type: Type.STRING },
              offerId: { type: Type.STRING },
              qty: { type: Type.INTEGER },
            },
            required: ['memberId', 'offerId', 'qty'],
          },
        },
        boostMemberIds: { type: Type.ARRAY, items: { type: Type.STRING } },
        reduceMemberIds: { type: Type.ARRAY, items: { type: Type.STRING } },
        settingsPatch: {
          type: Type.OBJECT,
          properties: {
            applySettings: { type: Type.BOOLEAN },
            useShiftMatching: { type: Type.BOOLEAN },
            useRolloverFairness: { type: Type.BOOLEAN },
            leaderPriority: { type: Type.STRING, enum: ['normal', 'low', 'medium', 'high'] },
            newMemberMode: { type: Type.STRING, enum: ['less', 'normal'] },
          },
          required: ['applySettings'],
        },
      },
      required: [
        'summary',
        'actionMode',
        'transfers',
        'lockMemberIds',
        'lockOfferIds',
        'excludeMemberIds',
        'onlyIncludeMemberIds',
        'overrideMemberShifts',
        'memberTargetAdjustments',
        'excludeMemberFromHourBuckets',
        'excludeCells',
        'pinCells',
        'boostMemberIds',
        'reduceMemberIds',
        'settingsPatch',
      ],
    },
  });
}

export async function auditDistributionWithGemini({
  members = [],
  campaigns = [],
  matrix = {},
  analyticsDataset = {},
  dateStr,
}: {
  members: Array<any>;
  campaigns: Array<any>;
  matrix: Record<string, any>;
  analyticsDataset?: Record<string, any>;
  dateStr: string;
}) {
  const stats = (computeDistributionStats as (...args: any[]) => any)(
    matrix,
    campaigns,
    members,
    dateStr
  );
  const memberBreakdown = stats.memberStats.map((ms: any) => {
    const mem = members.find((m) => m.id === ms.memberId);
    const eff = mem ? getMemberEffectiveShiftsForDay(mem, dateStr) : { todayShifts: [], nextDayShifts: [] };
    let eveningCap = 0;
    for (const camp of campaigns) {
      if (isEveningOnlyOffer(camp)) {
        eveningCap += Math.max(0, Math.floor(Number(matrix?.[camp.id]?.[ms.memberId]) || 0));
      }
    }
    return {
      memberId: ms.memberId,
      name: ms.name,
      isLeader: ms.isLeader,
      isNew: ms.isNew,
      todayShifts: eff.todayShifts,
      nextDayShifts: eff.nextDayShifts,
      totalCap: ms.totalCap,
      totalPoints: ms.totalPoints,
      eveningCap,
    };
  });

  const userPrompt = [
    `Kiểm tra tính công bằng & rủi ro cho bảng chia CAP ngày ${dateStr}:`,
    `Tổng quan bảng nháp: ${stats.assignedTotalCap}/${stats.expectedTotalCap} CAP, ${stats.assignedTotalPoints} điểm, lệch CAP=${stats.capSpread}, lệch điểm=${stats.pointSpread}.`,
    `Chi tiết từng thành viên hôm nay:\n${JSON.stringify(memberBreakdown)}`,
    `Dữ liệu lịch sử gần đây:\n${JSON.stringify(analyticsDataset)}`,
    'Hãy đánh giá kỹ: có ai bị dồn nhiều offer giờ muộn/23h liên tiếp không, ai thiếu điểm so với lịch sử 7 ngày không, có người không làm Ca 3 nhưng vẫn ôm nhiều offer tối không.',
    'Nếu cần điều chỉnh để cân bằng hơn, hãy điền `hasSuggestion=true` và cung cấp `suggestedDirectives` hợp lệ dùng đúng memberId ở trên (chẳng hạn boostMemberIds cho người đang hụt điểm, reduceMemberIds cho người đang vượt điểm, hoặc excludeMemberFromHourBuckets với bucket="evening" nếu người nghỉ Ca 3 bị dính giờ tối) để Leader có thể xem trước và bấm 1 nút áp dụng.',
  ].join('\n\n');

  return generateJsonWithRetry<{
    overallScore: number;
    headline: string;
    findings: Array<{
      severity: 'high' | 'medium' | 'low';
      title: string;
      detail: string;
      memberName: string;
    }>;
    recommendations: string[];
    hasSuggestion: boolean;
    suggestedDirectives: {
      summary: string;
      boostMemberIds: string[];
      reduceMemberIds: string[];
      excludeMemberFromHourBuckets: Array<{ memberId: string; bucket: string }>;
    };
  }>(userPrompt, {
    systemInstruction:
      'Bạn là chuyên gia kiểm toán bảng chia CAP đội nhóm. Phân tích ngắn gọn, chính xác theo số liệu, không bịa đặt số liệu.',
    thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
    responseMimeType: 'application/json',
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        overallScore: { type: Type.INTEGER },
        headline: { type: Type.STRING },
        findings: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              severity: { type: Type.STRING, enum: ['high', 'medium', 'low'] },
              title: { type: Type.STRING },
              detail: { type: Type.STRING },
              memberName: { type: Type.STRING },
            },
            required: ['severity', 'title', 'detail', 'memberName'],
          },
        },
        recommendations: { type: Type.ARRAY, items: { type: Type.STRING } },
        hasSuggestion: { type: Type.BOOLEAN },
        suggestedDirectives: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING },
            boostMemberIds: { type: Type.ARRAY, items: { type: Type.STRING } },
            reduceMemberIds: { type: Type.ARRAY, items: { type: Type.STRING } },
            excludeMemberFromHourBuckets: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  memberId: { type: Type.STRING },
                  bucket: { type: Type.STRING, enum: ['evening', '23h', '21h30', '10h'] },
                },
                required: ['memberId', 'bucket'],
              },
            },
          },
          required: ['summary', 'boostMemberIds', 'reduceMemberIds', 'excludeMemberFromHourBuckets'],
        },
      },
      required: ['overallScore', 'headline', 'findings', 'recommendations', 'hasSuggestion', 'suggestedDirectives'],
    },
  }, {
    cacheKey: hashCacheKey('audit', { dateStr, memberBreakdown, analyticsDataset }),
    cacheTtlMs: 90_000,
  });
}

export async function parseTelegramNaturalIntentWithGemini({
  text,
  senderName,
  members = [],
  campaigns = [],
  todayStr,
  tomorrowStr,
  groupId = '',
}: {
  text: string;
  senderName: string;
  members: Array<any>;
  campaigns: Array<any>;
  todayStr: string;
  tomorrowStr: string;
  groupId?: string;
}) {
  const membersList = members.map((m) => `id="${m.id}" | name="${m.name}"`).join('\n');
  const offersList = campaigns
    .slice(0, 40)
    .map((c) => `id="${c.id}" | code="${c.code}" | name="${c.name}"`)
    .join('\n');

  const userPrompt = [
    `Hôm nay: ${todayStr}. Ngày mai: ${tomorrowStr}.`,
    `Người nhắn trên Telegram: "${senderName}"`,
    `Danh sách thành viên:\n${membersList}`,
    `Danh sách Offer hiện có:\n${offersList}`,
    `Tin nhắn: "${text}"`,
  ].join('\n\n');

  const isButler = groupId === 'group-1';
  const roleLabel = isButler ? 'Quản gia trợ lý nhóm' : 'Trợ lý AI của nhóm';
  const styleHint = isButler ? 'lịch sự kiểu Quản gia' : 'lịch sự, ngắn gọn kiểu Trợ lý Bot';

  return generateJsonWithRetry<{
    intent: 'register_shift' | 'mark_cap_done' | 'request_transfer' | 'ask_progress' | 'help' | 'chat_reply';
    targetMemberId: string;
    dateStr: string;
    shifts: string[];
    isOff: boolean;
    offerId: string;
    toMemberId: string;
    qty: number;
    note: string;
    replyText: string;
  }>(userPrompt, {
    systemInstruction: [
      `Bạn là ${roleLabel} trên Telegram. Phân tích tin nhắn tiếng Việt tự nhiên thành intent chính xác.`,
      '- Nếu xin nghỉ / đổi ca / báo bận ca (ví dụ "mai xin nghỉ ca 3", "mai chỉ làm ca 1 ca 2", "hôm nay nghỉ hết"): intent="register_shift". Lưu ý mặc định ca bình thường là ["ca1","ca2","ca3"], nếu "nghỉ ca 3" thì shifts=["ca1","ca2"], isOff=false; nếu nghỉ cả ngày thì shifts=[], isOff=true.',
      '- Nếu báo đã làm xong CAP / offer (ví dụ "xong offer 1769 rồi", "em done hết CAP nay rồi"): intent="mark_cap_done" (nếu xong hết để offerId="").',
      '- Nếu muốn nhượng/chuyển/đổi CAP cho người khác (ví dụ "nhượng 1 con 1769 cho Uyên"): intent="request_transfer".',
      '- Nếu hỏi tiến độ nhóm/còn ai chưa xong: intent="ask_progress".',
      `- Nếu hỏi hướng dẫn hoặc chào hỏi chung: intent="help" hoặc "chat_reply" với replyText ${styleHint}.`,
      'Chỉ dùng memberId và offerId có trong danh sách; nếu không rõ để "".',
    ].join('\n'),
    thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
    responseMimeType: 'application/json',
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        intent: {
          type: Type.STRING,
          enum: ['register_shift', 'mark_cap_done', 'request_transfer', 'ask_progress', 'help', 'chat_reply'],
        },
        targetMemberId: { type: Type.STRING },
        dateStr: { type: Type.STRING },
        shifts: { type: Type.ARRAY, items: { type: Type.STRING } },
        isOff: { type: Type.BOOLEAN },
        offerId: { type: Type.STRING },
        toMemberId: { type: Type.STRING },
        qty: { type: Type.INTEGER },
        note: { type: Type.STRING },
        replyText: { type: Type.STRING },
      },
      required: ['intent', 'targetMemberId', 'dateStr', 'shifts', 'isOff', 'offerId', 'toMemberId', 'qty', 'note', 'replyText'],
    },
  }, { preferLite: true });
}

export async function answerAnalyticsWithGemini({
  question,
  analyticsDataset = {},
  groupName = 'Nhóm',
}: {
  question: string;
  analyticsDataset: Record<string, unknown>;
  groupName?: string;
}) {
  const cleanQ = String(question || '').trim();
  if (!cleanQ) {
    return { ok: false as const, error: 'Vui lòng nhập câu hỏi thống kê.' };
  }

  const userPrompt = [
    `Nhóm: ${groupName}`,
    `Số liệu thực tế trích từ Firestore:\n${JSON.stringify(analyticsDataset)}`,
    `Câu hỏi của Leader: "${cleanQ}"`,
  ].join('\n\n');

  return generateJsonWithRetry<{
    answer: string;
    highlights: string[];
  }>(userPrompt, {
    systemInstruction:
      'Bạn là Trợ lý AI phân tích số liệu cho Leader bằng tiếng Việt. Trả lời trực tiếp, súc tích, trích dẫn chính xác số CAP, điểm, tỷ lệ % từ dữ liệu được cung cấp. Tuyệt đối không bịa số liệu không có trong JSON.',
    thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
    responseMimeType: 'application/json',
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        answer: { type: Type.STRING },
        highlights: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: ['answer', 'highlights'],
    },
  }, {
    cacheKey: hashCacheKey('qa', { groupName, cleanQ, analyticsDataset }),
    cacheTtlMs: 90_000,
  });
}

export async function polishButlerMessageWithGemini({
  kind,
  statsSummary,
  groupName,
  dateStr,
  groupId = '',
}: {
  kind: 'shiftReminder' | 'dailySummary';
  statsSummary: string;
  groupName: string;
  dateStr: string;
  groupId?: string;
}): Promise<string | null> {
  const apiKey = getGeminiApiKey();
  const ai = getAiClient();
  if (!ai || !apiKey) return null;
  const keyFp = getKeyFingerprint(apiKey);
  const model = !getModelCooldown(keyFp, GEMINI_FALLBACK_MODEL).active
    ? GEMINI_FALLBACK_MODEL
    : GEMINI_MODEL;
  if (getModelCooldown(keyFp, model).active) return null;

  try {
    const styleLabel = groupId === 'group-1' ? 'kiểu Quản gia' : 'thân thiện, gọn gàng';
    const res = await ai.models.generateContent({
      model,
      contents: [
        `Nhóm: ${groupName} | Ngày: ${dateStr} | Loại tin: ${kind}`,
        `Số liệu thực tế:\n${statsSummary}`,
        kind === 'shiftReminder'
          ? `Viết 1 câu chào mở đầu ${styleLabel} (tối đa 180 ký tự, thuần văn bản tiếng Việt, không dùng HTML/Markdown) nhắc cả nhà đăng ký ca làm cho ngày mai.`
          : 'Viết 1-2 câu tổng kết cuối ngày ấm áp, thực tế dựa trên tỷ lệ hoàn thành CAP trên (tối đa 220 ký tự, thuần văn bản tiếng Việt, không dùng HTML/Markdown).',
      ].join('\n\n'),
      ...(model === GEMINI_MODEL ? { config: { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } } : {}),
    });
    const text = String(res.text || '').trim().replace(/[<>&*`]/g, '');
    return text ? text.slice(0, 260) : null;
  } catch (err) {
    if (isQuotaGeminiError(err)) {
      recordModelQuotaCooldown(keyFp, model, err);
    }
    return null;
  }
}
