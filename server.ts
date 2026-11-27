import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Request, Response } from 'express';
import { initializeApp } from 'firebase/app';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { verifyPassword } from './src/utils/passwordCrypto.js';
import {
  isValidTelegramBotToken,
  maskTelegramBotToken,
  pickEffectiveGroupBotToken,
  resolveEnvBotTokenForGroup,
} from './src/utils/telegramBotConfig.js';
import {
  buildDashboardShareLink,
  formatTelegramTestMessage,
  getVietnamDateTimeParts,
  isValidTelegramChatId,
  resolveAppBaseUrl,
  shouldRunScheduledJob,
  stripTelegramHtml,
} from './src/utils/telegramMessages.js';
import {
  formatTelegramCutoffNudgeMessage,
  formatTelegramDailySummaryMessage,
} from './src/utils/telegramCommands.js';
import { addDaysToIso } from './src/utils/storage.js';
import { getSavedDistributionForDate } from './src/utils/dashboardSchedule.js';
import { normalizeMatrix, sortOffersByPointsDesc } from './src/utils/capAlgorithm.js';
import {
  answerAnalyticsWithGemini,
  auditDistributionWithGemini,
  isGeminiConfigured,
  parseDistributionCommandWithGemini,
  parseOffersWithGemini,
} from './src/server/geminiService.ts';

function resolveCliPortAndHost(): { port: number; host: string } {
  const args = process.argv.slice(2);
  let cliPort: number | null = null;
  let cliHost = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '--port' || a === '-p') && args[i + 1]) {
      const parsed = Number(args[i + 1]);
      if (Number.isFinite(parsed) && parsed > 0) cliPort = parsed;
      i++;
    } else if (a.startsWith('--port=')) {
      const parsed = Number(a.slice('--port='.length));
      if (Number.isFinite(parsed) && parsed > 0) cliPort = parsed;
    } else if (a === '--host' && args[i + 1]) {
      cliHost = String(args[i + 1]).trim();
      i++;
    } else if (a.startsWith('--host=')) {
      cliHost = a.slice('--host='.length).trim();
    }
  }
  const envPort = Number(process.env.PORT);
  const port = cliPort ?? (Number.isFinite(envPort) && envPort > 0 ? envPort : 3000);
  const host = cliHost || process.env.HOST || '0.0.0.0';
  return { port, host };
}

const { port: PORT, host: HOST } = resolveCliPortAndHost();
const IS_PROD = process.env.NODE_ENV === 'production';
const IS_TEST = process.env.NODE_ENV === 'test';
const SESSION_COOKIE_NAME = 'cap_leader_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Signing secret stays strictly in server memory / env or tmp key file (never in app source or client)
function resolvePersistentSessionSecret(): string {
  const fromEnv = String(process.env.SESSION_SECRET || '').trim();
  if (fromEnv.length >= 16) return fromEnv;
  const keyFile = path.join(os.tmpdir(), 'cap-manager-session-v1.key');
  try {
    if (fs.existsSync(keyFile)) {
      const existing = fs.readFileSync(keyFile, 'utf8').trim();
      if (existing.length >= 32) return existing;
    }
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(keyFile, generated, { mode: 0o600 });
    return generated;
  } catch {
    return crypto.randomBytes(32).toString('hex');
  }
}

const SESSION_SECRET = resolvePersistentSessionSecret();

const firebaseConfigPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
const firebaseConfig = JSON.parse(fs.readFileSync(firebaseConfigPath, 'utf8'));
const firebaseApp = initializeApp(firebaseConfig, 'cap-server');
const db = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);

interface SessionPayload {
  groupId: string;
  username: string;
  displayName: string;
  exp: number;
}

function getAppBaseUrl(req?: Request): string {
  return resolveAppBaseUrl({
    env: process.env,
    protocol: req ? String(req.headers['x-forwarded-proto'] || req.protocol || 'http') : '',
    host: req ? String(req.headers['x-forwarded-host'] || req.headers.host || '') : '',
    port: PORT,
  });
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function signSessionToken(payload: Omit<SessionPayload, 'exp'>): string {
  const fullPayload: SessionPayload = {
    ...payload,
    exp: Date.now() + SESSION_TTL_MS,
  };
  const encoded = base64UrlEncode(JSON.stringify(fullPayload));
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

function verifySessionToken(token: string | undefined | null): SessionPayload | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  if (!encoded || !sig) return null;

  const expectedSig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(encoded)
    .digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const parsed = JSON.parse(base64UrlDecode(encoded)) as SessionPayload;
    if (
      !parsed ||
      typeof parsed.groupId !== 'string' ||
      typeof parsed.username !== 'string' ||
      typeof parsed.exp !== 'number' ||
      parsed.exp < Date.now()
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  }
  return out;
}

function isHttpsRequest(req: Request): boolean {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const origin = String(req.headers.origin || '').trim().toLowerCase();
  const referer = String(req.headers.referer || '').trim().toLowerCase();
  return (
    req.secure ||
    forwardedProto === 'https' ||
    origin.startsWith('https://') ||
    referer.startsWith('https://')
  );
}

function setSessionCookie(req: Request, res: Response, token: string): void {
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  const https = isHttpsRequest(req);
  const attrs = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${maxAgeSec}`,
    https ? 'SameSite=None' : 'SameSite=Lax',
  ];
  if (https) {
    attrs.push('Secure', 'Partitioned');
  }
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(req: Request, res: Response): void {
  const https = isHttpsRequest(req);
  const attrs = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'Max-Age=0',
    https ? 'SameSite=None' : 'SameSite=Lax',
  ];
  if (https) {
    attrs.push('Secure', 'Partitioned');
  }
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function hasValidSameOriginOrAjaxHeader(req: Request): boolean {
  const xhr = String(req.headers['x-requested-with'] || '').trim();
  if (xhr === 'XMLHttpRequest') return true;

  const origin = String(req.headers.origin || '').trim();
  if (!origin) return false;
  try {
    const originHost = new URL(origin).host.toLowerCase();
    const expectedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    return Boolean(expectedHost && originHost === expectedHost);
  } catch {
    return false;
  }
}

function getAuthenticatedSession(req: Request, { requireCsrfCheck = true } = {}): SessionPayload | null {
  const authHeader = String(req.headers.authorization || '').trim();
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    const bearer = authHeader.slice(7).trim();
    const parsed = verifySessionToken(bearer);
    if (parsed) return parsed;
  }

  const cookies = parseCookies(req.headers.cookie);
  const cookieToken = cookies[SESSION_COOKIE_NAME];
  if (cookieToken) {
    if (requireCsrfCheck && !hasValidSameOriginOrAjaxHeader(req)) {
      return null;
    }
    return verifySessionToken(cookieToken);
  }

  return null;
}

// Simple in-memory sliding-window rate limiter per key
const rateWindowMap = new Map<string, number[]>();
function checkRateLimit(key: string, maxRequests = 15, windowMs = 60_000): boolean {
  const now = Date.now();
  const timestamps = (rateWindowMap.get(key) || []).filter((ts) => now - ts < windowMs);
  if (timestamps.length >= maxRequests) {
    rateWindowMap.set(key, timestamps);
    return false;
  }
  timestamps.push(now);
  rateWindowMap.set(key, timestamps);
  if (rateWindowMap.size > 500) {
    for (const [k, list] of rateWindowMap.entries()) {
      if (list.length === 0 || now - list[list.length - 1] >= windowMs) {
        rateWindowMap.delete(k);
      }
    }
  }
  return true;
}

function getGlobalTelegramBotToken(): string {
  return String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
}

function getTelegramEncryptionKey(): Buffer | null {
  const rawSecret = String(
    process.env.TELEGRAM_ENCRYPTION_KEY ||
      (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16
        ? process.env.SESSION_SECRET
        : '')
  ).trim();
  if (!rawSecret) return null;
  return crypto.createHash('sha256').update(`cap-tg-v1:${rawSecret}`, 'utf8').digest();
}

function encryptBotTokenForStorage(plainToken: string): { value: string; encrypted: boolean } {
  const key = getTelegramEncryptionKey();
  if (!key) {
    return { value: plainToken, encrypted: false };
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainToken, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    value: `enc:v1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`,
    encrypted: true,
  };
}

function decryptBotTokenFromStorage(storedValue: string): { token: string; decryptError: boolean } {
  const raw = String(storedValue || '').trim();
  if (!raw) return { token: '', decryptError: false };
  if (!raw.startsWith('enc:v1:')) {
    return { token: raw, decryptError: false };
  }
  const key = getTelegramEncryptionKey();
  if (!key) {
    return { token: '', decryptError: true };
  }
  const parts = raw.split(':');
  if (parts.length !== 5) {
    return { token: '', decryptError: true };
  }
  try {
    const iv = Buffer.from(parts[2], 'hex');
    const tag = Buffer.from(parts[3], 'hex');
    const ciphertext = Buffer.from(parts[4], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return { token: decrypted, decryptError: false };
  } catch {
    return { token: '', decryptError: true };
  }
}

async function fetchGroupCustomBotRecord(groupId: string) {
  const cleanId = String(groupId || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(cleanId)) return null;
  try {
    const snap = await getDoc(doc(db, 'groupTelegramBots', cleanId));
    if (!snap.exists()) return null;
    const data = snap.data() as {
      botToken?: string;
      botUsername?: string;
      tokenMasked?: string;
      encrypted?: boolean;
    };
    const decoded = decryptBotTokenFromStorage(String(data.botToken || ''));
    return {
      token: decoded.token,
      decryptError: decoded.decryptError,
      botUsername: String(data.botUsername || ''),
      tokenMasked: String(data.tokenMasked || ''),
      encrypted: Boolean(data.encrypted),
    };
  } catch {
    return null;
  }
}

async function resolveGroupTelegramConfig(groupId: string, groupName = '') {
  const envTokenRes = resolveEnvBotTokenForGroup({
    groupId,
    groupName,
    env: process.env,
  });
  const customRecord = await fetchGroupCustomBotRecord(groupId);
  return pickEffectiveGroupBotToken({ envTokenRes, customRecord });
}

async function verifyTelegramBotTokenWithTelegram(botToken: string): Promise<{
  ok: boolean;
  username: string;
  firstName: string;
  error?: string;
}> {
  const cleanToken = String(botToken || '').trim();
  if (!isValidTelegramBotToken(cleanToken)) {
    return {
      ok: false,
      username: '',
      firstName: '',
      error: 'Định dạng Bot Token không hợp lệ (ví dụ: 123456789:AAH...).',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(cleanToken)}/getMe`, {
      method: 'GET',
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
      result?: { username?: string; first_name?: string };
    };
    if (!res.ok || !data?.ok || !data.result) {
      return {
        ok: false,
        username: '',
        firstName: '',
        error: data?.description || 'Telegram từ chối Bot Token này (không hợp lệ hoặc đã thu hồi).',
      };
    }
    return {
      ok: true,
      username: String(data.result.username || ''),
      firstName: String(data.result.first_name || ''),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Không thể xác minh Bot Token với Telegram.';
    return {
      ok: false,
      username: '',
      firstName: '',
      error: msg.includes('abort') ? 'Kết nối Telegram API quá thời gian chờ.' : msg,
    };
  } finally {
    clearTimeout(timer);
  }
}



const MISSING_TOKEN_ERROR =
  'Nhóm chưa có Bot Token Telegram. Hãy dán Bot Token riêng của nhóm trong mục Cài đặt / Nhóm & Leader, hoặc cấu hình TELEGRAM_BOT_TOKEN trên máy chủ.';

function sanitizeReplyMarkup(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = raw as { inline_keyboard?: unknown };
  if (!Array.isArray(candidate.inline_keyboard)) return undefined;
  const safeRows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const row of candidate.inline_keyboard.slice(0, 12)) {
    if (!Array.isArray(row)) continue;
    const safeRow: Array<{ text: string; callback_data: string }> = [];
    for (const btn of row.slice(0, 6)) {
      if (btn && typeof btn === 'object') {
        const b = btn as { text?: unknown; callback_data?: unknown };
        const text = String(b.text || '').trim().slice(0, 64);
        const cb = String(b.callback_data || '').trim().slice(0, 64);
        if (text && cb) {
          safeRow.push({ text, callback_data: cb });
        }
      }
    }
    if (safeRow.length > 0) safeRows.push(safeRow);
  }
  return safeRows.length > 0 ? { inline_keyboard: safeRows } : undefined;
}

async function sendTelegramMessage(
  chatId: string,
  text: string,
  botToken?: string,
  replyMarkup?: unknown,
  replyToMessageId?: number
): Promise<{ ok: boolean; configured: boolean; error?: string; messageId?: number }> {
  const token = String(botToken || getGlobalTelegramBotToken() || '').trim();
  if (!token) {
    return {
      ok: false,
      configured: false,
      error: MISSING_TOKEN_ERROR,
    };
  }

  const cleanChatId = String(chatId || '').trim();
  if (!isValidTelegramChatId(cleanChatId)) {
    return {
      ok: false,
      configured: true,
      error: 'Telegram Group Chat ID không hợp lệ (ví dụ: -1001234567890).',
    };
  }

  const cleanText = String(text || '').trim().slice(0, 4096);
  if (!cleanText) {
    return { ok: false, configured: true, error: 'Nội dung tin nhắn Telegram đang trống.' };
  }

  const safeMarkup = sanitizeReplyMarkup(replyMarkup);
  const attemptSend = async (useHtml: boolean) => {
    const bodyPayload: Record<string, unknown> = {
      chat_id: cleanChatId,
      text: useHtml ? cleanText : stripTelegramHtml(cleanText).slice(0, 4096),
      disable_web_page_preview: true,
    };
    if (useHtml) {
      bodyPayload.parse_mode = 'HTML';
    }
    if (safeMarkup) {
      bodyPayload.reply_markup = safeMarkup;
    }
    if (replyToMessageId && Number.isFinite(replyToMessageId)) {
      bodyPayload.reply_to_message_id = replyToMessageId;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const telegramEndpoint = `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`;
      const response = await fetch(telegramEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify(bodyPayload),
      });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        description?: string;
        result?: { message_id?: number };
      };
      return { response, data };
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let { response, data } = await attemptSend(true);
    if (
      (!response.ok || !data?.ok) &&
      typeof data?.description === 'string' &&
      /parse entities|find end of the entity|can't parse/i.test(data.description)
    ) {
      console.warn('[Telegram sendMessage] HTML parse failed, retrying plain text:', data.description);
      ({ response, data } = await attemptSend(false));
    }

    if (!response.ok || !data?.ok) {
      const errMsg = data?.description || `Telegram API trả về lỗi HTTP ${response.status}.`;
      console.warn('[Telegram sendMessage] Failed:', errMsg);
      return {
        ok: false,
        configured: true,
        error: errMsg,
      };
    }

    return {
      ok: true,
      configured: true,
      messageId: data.result?.message_id,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Không thể kết nối Telegram API.';
    console.warn('[Telegram sendMessage] Network error:', msg);
    return {
      ok: false,
      configured: true,
      error: msg.includes('abort') ? 'Kết nối Telegram API quá thời gian chờ.' : msg,
    };
  }
}

async function sendTelegramPhoto(
  chatId: string,
  imageBase64: string,
  caption: string,
  botToken?: string,
  replyMarkup?: unknown
): Promise<{ ok: boolean; configured: boolean; error?: string; messageId?: number }> {
  const token = String(botToken || getGlobalTelegramBotToken() || '').trim();
  if (!token) {
    return {
      ok: false,
      configured: false,
      error: MISSING_TOKEN_ERROR,
    };
  }

  const cleanChatId = String(chatId || '').trim();
  if (!isValidTelegramChatId(cleanChatId)) {
    return {
      ok: false,
      configured: true,
      error: 'Telegram Group Chat ID không hợp lệ (ví dụ: -1001234567890).',
    };
  }

  const cleanBase64 = String(imageBase64 || '').replace(/^data:image\/png;base64,/, '').trim();
  if (!cleanBase64 || !/^[A-Za-z0-9+/=]+$/.test(cleanBase64)) {
    return { ok: false, configured: true, error: 'Dữ liệu ảnh PNG không hợp lệ.' };
  }

  const imgBuffer = Buffer.from(cleanBase64, 'base64');
  const isPngHeader =
    imgBuffer.length >= 8 &&
    imgBuffer[0] === 0x89 &&
    imgBuffer[1] === 0x50 &&
    imgBuffer[2] === 0x4e &&
    imgBuffer[3] === 0x47;
  if (!isPngHeader || imgBuffer.length > 3 * 1024 * 1024) {
    return { ok: false, configured: true, error: 'Ảnh bảng chia CAP vượt quá kích thước hoặc sai định dạng PNG.' };
  }

  const cleanCaption = String(caption || '').trim().slice(0, 1024);
  const safeMarkup = sanitizeReplyMarkup(replyMarkup);

  const attemptPhoto = async (useHtml: boolean) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const formData = new FormData();
      formData.append('chat_id', cleanChatId);
      formData.append('photo', new Blob([imgBuffer], { type: 'image/png' }), 'bang-chia-cap.png');
      const capText = useHtml ? cleanCaption : stripTelegramHtml(cleanCaption).slice(0, 1024);
      if (capText) {
        formData.append('caption', capText);
        if (useHtml) {
          formData.append('parse_mode', 'HTML');
        }
      }
      if (safeMarkup) {
        formData.append('reply_markup', JSON.stringify(safeMarkup));
      }

      const telegramEndpoint = `https://api.telegram.org/bot${encodeURIComponent(token)}/sendPhoto`;
      const response = await fetch(telegramEndpoint, {
        method: 'POST',
        signal: controller.signal,
        body: formData,
      });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        description?: string;
        result?: { message_id?: number };
      };
      return { response, data };
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let { response, data } = await attemptPhoto(true);
    if (
      (!response.ok || !data?.ok) &&
      cleanCaption &&
      typeof data?.description === 'string' &&
      /parse entities|find end of the entity|can't parse/i.test(data.description)
    ) {
      console.warn('[Telegram sendPhoto] HTML caption parse failed, retrying plain text:', data.description);
      ({ response, data } = await attemptPhoto(false));
    }

    if (!response.ok || !data?.ok) {
      const errMsg = data?.description || `Telegram API trả về lỗi HTTP ${response.status}.`;
      console.warn('[Telegram sendPhoto] Failed:', errMsg);
      return {
        ok: false,
        configured: true,
        error: errMsg,
      };
    }

    return {
      ok: true,
      configured: true,
      messageId: data.result?.message_id,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Không thể kết nối Telegram API.';
    console.warn('[Telegram sendPhoto] Network error:', msg);
    return {
      ok: false,
      configured: true,
      error: msg.includes('abort') ? 'Kết nối Telegram API quá thời gian chờ.' : msg,
    };
  }
}



interface SharedGroupDoc {
  id: string;
  name?: string;
  visibility?: string;
  members?: Array<Record<string, any>>;
  campaigns?: Array<Record<string, any>>;
  matrix?: Record<string, any>;
  completions?: Record<string, any>;
  settings?: Record<string, any>;
}

async function fetchSharedGroupDoc(groupId: string): Promise<SharedGroupDoc | null> {
  const cleanId = String(groupId || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(cleanId)) return null;
  const snap = await getDoc(doc(db, 'groups', cleanId));
  if (!snap.exists()) return null;
  const data = snap.data() as Omit<SharedGroupDoc, 'id'> & { id?: string };
  if (data?.visibility !== 'shared') return null;
  return { ...data, id: data.id || snap.id };
}

async function fetchGroupSavedDistributionForDate(groupId: string, dateStr: string) {
  const histSnap = await getDocs(
    query(collection(db, 'groups', groupId, 'history'), where('groupId', '==', groupId))
  );
  const records = histSnap.docs.map((d) => ({ ...d.data(), id: d.id }));
  return getSavedDistributionForDate(records, dateStr);
}

function getEffectiveRecordForDate(group: SharedGroupDoc, savedRecord: Record<string, any> | null) {
  const members: any[] =
    Array.isArray(savedRecord?.members) && savedRecord.members.length > 0
      ? savedRecord.members.map((m: any) => (group.members || []).find((lm) => lm.id === m.id) || m)
      : group.members || [];
  const campaigns: any[] = sortOffersByPointsDesc(
    Array.isArray(savedRecord?.campaigns) && savedRecord.campaigns.length > 0
      ? savedRecord.campaigns
      : group.campaigns || []
  );
  const matrix: Record<string, Record<string, number>> | null = savedRecord?.matrix
    ? (normalizeMatrix(savedRecord.matrix, campaigns, members) as Record<string, Record<string, number>>)
    : null;
  return { members, campaigns, matrix, hasSavedRecord: Boolean(savedRecord && matrix) };
}

// Scheduled Automated Jobs (Cutoff Nudge + Daily Summary)
interface GroupSchedulerStateData {
  groupId: string;
  lastShiftReminderDate: string;
  lastShiftReminderSentAt: string;
  lastShiftReminderStatus: 'none' | 'sent' | 'failed';
  lastShiftReminderError: string;
  lastCutoffNudgeDate: string;
  lastDailySummaryDate: string;
  lastDistributionSentDate: string;
  lastDistributionMatrixHash: string;
  lastDistributionSentAt: string;
}

const DEFAULT_SCHEDULER_STATE = (groupId: string): GroupSchedulerStateData => ({
  groupId,
  lastShiftReminderDate: '',
  lastShiftReminderSentAt: '',
  lastShiftReminderStatus: 'none',
  lastShiftReminderError: '',
  lastCutoffNudgeDate: '',
  lastDailySummaryDate: '',
  lastDistributionSentDate: '',
  lastDistributionMatrixHash: '',
  lastDistributionSentAt: '',
});

async function getGroupSchedulerState(groupId: string): Promise<GroupSchedulerStateData> {
  const cleanId = String(groupId || '').trim();
  const base = DEFAULT_SCHEDULER_STATE(cleanId);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(cleanId)) return base;
  try {
    const snap = await getDoc(doc(db, 'groupSchedulerState', cleanId));
    if (!snap.exists()) return base;
    const d = snap.data() as Record<string, unknown>;
    return {
      groupId: cleanId,
      lastShiftReminderDate: typeof d.lastShiftReminderDate === 'string' ? d.lastShiftReminderDate : '',
      lastShiftReminderSentAt: typeof d.lastShiftReminderSentAt === 'string' ? d.lastShiftReminderSentAt : '',
      lastShiftReminderStatus:
        d.lastShiftReminderStatus === 'sent' || d.lastShiftReminderStatus === 'failed'
          ? d.lastShiftReminderStatus
          : 'none',
      lastShiftReminderError: typeof d.lastShiftReminderError === 'string' ? d.lastShiftReminderError : '',
      lastCutoffNudgeDate: typeof d.lastCutoffNudgeDate === 'string' ? d.lastCutoffNudgeDate : '',
      lastDailySummaryDate: typeof d.lastDailySummaryDate === 'string' ? d.lastDailySummaryDate : '',
      lastDistributionSentDate: typeof d.lastDistributionSentDate === 'string' ? d.lastDistributionSentDate : '',
      lastDistributionMatrixHash: typeof d.lastDistributionMatrixHash === 'string' ? d.lastDistributionMatrixHash : '',
      lastDistributionSentAt: typeof d.lastDistributionSentAt === 'string' ? d.lastDistributionSentAt : '',
    };
  } catch {
    return base;
  }
}

async function upsertGroupSchedulerState(
  groupId: string,
  patch: Partial<Omit<GroupSchedulerStateData, 'groupId'>>
): Promise<void> {
  const cleanId = String(groupId || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(cleanId)) return;
  try {
    const current = await getGroupSchedulerState(cleanId);
    const merged: Record<string, unknown> = {
      groupId: cleanId,
      lastShiftReminderDate: (patch.lastShiftReminderDate ?? current.lastShiftReminderDate).slice(0, 10),
      lastShiftReminderSentAt: (patch.lastShiftReminderSentAt ?? current.lastShiftReminderSentAt).slice(0, 40),
      lastShiftReminderStatus: patch.lastShiftReminderStatus ?? current.lastShiftReminderStatus,
      lastShiftReminderError: (patch.lastShiftReminderError ?? current.lastShiftReminderError).slice(0, 300),
      lastCutoffNudgeDate: (patch.lastCutoffNudgeDate ?? current.lastCutoffNudgeDate).slice(0, 10),
      lastDailySummaryDate: (patch.lastDailySummaryDate ?? current.lastDailySummaryDate).slice(0, 10),
      lastDistributionSentDate: (patch.lastDistributionSentDate ?? current.lastDistributionSentDate).slice(0, 10),
      lastDistributionMatrixHash: (patch.lastDistributionMatrixHash ?? current.lastDistributionMatrixHash).slice(0, 128),
      lastDistributionSentAt: (patch.lastDistributionSentAt ?? current.lastDistributionSentAt).slice(0, 40),
      updatedAt: serverTimestamp(),
    };
    await setDoc(doc(db, 'groupSchedulerState', cleanId), merged);
  } catch (err) {
    console.warn(`[Telegram Scheduler] Không lưu được trạng thái scheduler cho ${cleanId}:`, err);
  }
}

const schedulerFailureCooldown = new Map<string, number>();
let schedulerRunInFlight = false;
let lastThrottledSchedulerTriggerMs = 0;

async function runScheduledTelegramJobs(): Promise<{
  checkedGroups: number;
  triggeredCount: number;
}> {
  if (IS_TEST || schedulerRunInFlight) {
    return { checkedGroups: 0, triggeredCount: 0 };
  }
  schedulerRunInFlight = true;
  const { dateStr, hour, minute } = getVietnamDateTimeParts(new Date());
  const nextDateStr = addDaysToIso(dateStr, 1);
  let checkedGroups = 0;
  let triggeredCount = 0;

  try {
    const groupsSnap = await getDocs(
      query(collection(db, 'groups'), where('visibility', '==', 'shared'))
    );
    const baseUrl = getAppBaseUrl();

    for (const groupDoc of groupsSnap.docs) {
      const groupData = { ...(groupDoc.data() as Record<string, any>), id: groupDoc.id } as SharedGroupDoc;
      const groupId = groupData.id;
      const groupName = String(groupData.name || groupId);
      const settings = (groupData.settings || {}) as Record<string, any>;
      const telegramEnabled = Boolean(settings.telegramEnabled);
      const chatId = String(settings.telegramChatId || '').trim();

      if (!telegramEnabled || !isValidTelegramChatId(chatId)) {
        continue;
      }

      checkedGroups += 1;
      const schedState = await getGroupSchedulerState(groupId);
      const botCfg = await resolveGroupTelegramConfig(groupId, groupName);

      if (!botCfg.token) {
        continue;
      }

      // Job 2: Scheduled Pre-Cutoff Unfinished CAP Nudge
      const nudgeTime = String(settings.telegramDeadlineReminderTime || '').trim();
      if (
        nudgeTime &&
        shouldRunScheduledJob({
          targetHHMM: nudgeTime,
          curHour: hour,
          curMinute: minute,
          dateStr,
          lastSentDate: schedState.lastCutoffNudgeDate,
          catchUpMinutes: 60,
        })
      ) {
        const cooldownKey = `nudge:${groupId}:${dateStr}`;
        if (Date.now() >= (schedulerFailureCooldown.get(cooldownKey) || 0)) {
          const saved = await fetchGroupSavedDistributionForDate(groupId, dateStr);
          const eff = getEffectiveRecordForDate(groupData, saved);
          if (eff.hasSavedRecord && eff.matrix) {
            const nudgeText = formatTelegramCutoffNudgeMessage({
              groupId,
              groupName,
              dateStr,
              members: eff.members,
              campaigns: eff.campaigns,
              matrix: eff.matrix,
              completionsForDate: (groupData.completions || {})[dateStr] || {},
              appLink: buildDashboardShareLink(baseUrl, groupId, dateStr),
            });
            if (nudgeText) {
              const sendRes = await sendTelegramMessage(chatId, nudgeText, botCfg.token);
              if (sendRes.ok) {
                triggeredCount += 1;
                await upsertGroupSchedulerState(groupId, { lastCutoffNudgeDate: dateStr });
                console.info(
                  `[Telegram Scheduler] Đã gửi nhắc CAP chưa xong (${nudgeTime}) cho ${groupId}.`
                );
              } else {
                schedulerFailureCooldown.set(cooldownKey, Date.now() + 5 * 60_000);
              }
            } else {
              await upsertGroupSchedulerState(groupId, { lastCutoffNudgeDate: dateStr });
            }
          }
        }
      }

      // Job 3: Scheduled End-of-Day Summary
      const summaryTime = String(settings.telegramDailySummaryTime || '').trim();
      if (
        summaryTime &&
        shouldRunScheduledJob({
          targetHHMM: summaryTime,
          curHour: hour,
          curMinute: minute,
          dateStr,
          lastSentDate: schedState.lastDailySummaryDate,
          catchUpMinutes: 60,
        })
      ) {
        const cooldownKey = `summary:${groupId}:${dateStr}`;
        if (Date.now() >= (schedulerFailureCooldown.get(cooldownKey) || 0)) {
          const saved = await fetchGroupSavedDistributionForDate(groupId, dateStr);
          const eff = getEffectiveRecordForDate(groupData, saved);
          if (eff.hasSavedRecord && eff.matrix) {
            const summaryText = formatTelegramDailySummaryMessage({
              groupName,
              dateStr,
              members: eff.members,
              campaigns: eff.campaigns,
              matrix: eff.matrix,
              completionsForDate: (groupData.completions || {})[dateStr] || {},
            });
            if (summaryText) {
              const sendRes = await sendTelegramMessage(chatId, summaryText, botCfg.token);
              if (sendRes.ok) {
                triggeredCount += 1;
                await upsertGroupSchedulerState(groupId, { lastDailySummaryDate: dateStr });
                console.info(
                  `[Telegram Scheduler] Đã gửi tổng kết cuối ngày (${summaryTime}) cho ${groupId}.`
                );
              } else {
                schedulerFailureCooldown.set(cooldownKey, Date.now() + 5 * 60_000);
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn('[Telegram Scheduler] Lỗi khi chạy tác vụ định kỳ:', err);
  } finally {
    schedulerRunInFlight = false;
  }

  return { checkedGroups, triggeredCount };
}

async function startServer(): Promise<void> {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '8mb' }));

  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true, status: 'up' });
  });

  // Auth login: verifies salted SHA-256 credentials against Firestore & sets signed session
  app.post('/api/auth/login', async (req: Request, res: Response) => {
    try {
      const cleanUser = String(req.body?.username || '').trim().toLowerCase();
      const password = String(req.body?.password ?? '');
      if (!cleanUser || !password) {
        res.status(400).json({ ok: false, error: 'Vui lòng nhập tên đăng nhập và mật khẩu.' });
        return;
      }

      const clientIp = String(req.ip || 'unknown');
      if (!checkRateLimit(`login:${clientIp}`, 25, 60_000)) {
        res.status(429).json({ ok: false, error: 'Thử đăng nhập quá nhiều lần. Vui lòng đợi 1 phút.' });
        return;
      }

      const q = query(collection(db, 'groupCredentials'), where('username', '==', cleanUser), limit(5));
      const snap = await getDocs(q);
      if (snap.empty) {
        res.status(401).json({ ok: false, error: 'Sai tên đăng nhập hoặc mật khẩu Leader.' });
        return;
      }

      for (const docSnap of snap.docs) {
        const cred = docSnap.data();
        const matched = await verifyPassword(password, cred.salt, cred.passwordHash);
        if (matched) {
          const session = {
            username: String(cred.username),
            displayName: String(cred.displayName || cred.username),
            groupId: String(cred.groupId),
          };
          const token = signSessionToken(session);
          setSessionCookie(req, res, token);
          res.json({ ok: true, session, token });
          return;
        }
      }

      res.status(401).json({ ok: false, error: 'Sai tên đăng nhập hoặc mật khẩu Leader.' });
    } catch (err) {
      console.error('[API /api/auth/login] Error:', err);
      res.status(500).json({ ok: false, error: 'Lỗi máy chủ khi xác thực Leader.' });
    }
  });

  app.post('/api/auth/logout', (req: Request, res: Response) => {
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  app.get('/api/auth/session', (req: Request, res: Response) => {
    const session = getAuthenticatedSession(req, { requireCsrfCheck: false });
    res.json({
      ok: true,
      authenticated: Boolean(session),
      groupId: session?.groupId || null,
      username: session?.username || null,
    });
  });

  app.get('/api/telegram/status', async (req: Request, res: Response) => {
    if (Date.now() - lastThrottledSchedulerTriggerMs > 60_000) {
      lastThrottledSchedulerTriggerMs = Date.now();
      void runScheduledTelegramJobs();
    }

    const { dateStr, hour, minute } = getVietnamDateTimeParts(new Date());
    const requestedGroupId = String(req.query?.groupId || '').trim();
    const defaultConfigured = Boolean(getGlobalTelegramBotToken());
    const encryptionEnvConfigured = Boolean(getTelegramEncryptionKey());

    const byGroup: Record<
      string,
      {
        configured: boolean;
        source: string;
        botUsername: string;
        tokenMasked: string;
        encryptedAtRest: boolean;
        decryptError: boolean;
        schedulerState: GroupSchedulerStateData;
      }
    > = {};

    try {
      const groupsSnap = await getDocs(
        query(collection(db, 'groups'), where('visibility', '==', 'shared'))
      );
      await Promise.all(
        groupsSnap.docs.map(async (gDoc) => {
          const data = gDoc.data();
          const gid = String(data.id || gDoc.id);
          const gName = String(data.name || gid);
          const [resolved, schedState] = await Promise.all([
            resolveGroupTelegramConfig(gid, gName),
            getGroupSchedulerState(gid),
          ]);
          byGroup[gid] = {
            configured: resolved.configured,
            source: String(resolved.source || 'none'),
            botUsername: resolved.botUsername || '',
            tokenMasked: resolved.tokenMasked,
            encryptedAtRest: resolved.encryptedAtRest,
            decryptError: resolved.decryptError,
            schedulerState: schedState,
          };
        })
      );
    } catch {
      // ignore transient status lookup errors
    }

    const activeStatus = requestedGroupId ? byGroup[requestedGroupId] : null;
    res.json({
      ok: true,
      configured: activeStatus ? activeStatus.configured : defaultConfigured,
      defaultConfigured,
      encryptionEnvConfigured,
      aiConfigured: isGeminiConfigured(),
      byGroup,
      serverDateVN: dateStr,
      serverTimeVN: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    });
  });

  app.all('/api/telegram/cron', async (req: Request, res: Response) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'Method not allowed.' });
      return;
    }
    const cronSecret = String(process.env.CRON_SECRET || '').trim();
    if (cronSecret) {
      const provided = String(
        req.headers['x-cron-secret'] || req.query?.secret || req.headers.authorization?.replace(/^Bearer\s+/i, '') || ''
      ).trim();
      if (provided !== cronSecret) {
        res.status(401).json({ ok: false, error: 'Unauthorized cron trigger.' });
        return;
      }
    }
    if (!checkRateLimit('tg-cron-global', 12, 60_000)) {
      res.status(429).json({ ok: false, error: 'Rate limit exceeded.' });
      return;
    }
    const summary = await runScheduledTelegramJobs();
    const { dateStr, hour, minute } = getVietnamDateTimeParts(new Date());
    res.json({
      ok: true,
      serverDateVN: dateStr,
      serverTimeVN: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      ...summary,
    });
  });

  app.post('/api/telegram/bot-token', async (req: Request, res: Response) => {
    const session = getAuthenticatedSession(req);
    const groupId = String(req.body?.groupId || '').trim();
    const rawToken = String(req.body?.botToken || '').trim();

    if (!session) {
      res.status(401).json({
        ok: false,
        error: 'Phiên xác thực Telegram chưa kích hoạt hoặc đã hết hạn. Vui lòng đăng nhập lại Leader.',
      });
      return;
    }

    if (!groupId || session.groupId !== groupId) {
      res.status(403).json({
        ok: false,
        error: 'Chỉ Leader của nhóm này mới được cài đặt Bot Token riêng.',
      });
      return;
    }

    if (!checkRateLimit(`tg-token:${groupId}`, 12, 60_000)) {
      res.status(429).json({
        ok: false,
        error: 'Thao tác lưu Bot Token quá nhanh. Vui lòng đợi một lát.',
      });
      return;
    }

    const groupDoc = await fetchSharedGroupDoc(groupId);
    if (!groupDoc) {
      res.status(404).json({ ok: false, error: 'Không tìm thấy nhóm.' });
      return;
    }

    const verified = await verifyTelegramBotTokenWithTelegram(rawToken);
    if (!verified.ok) {
      res.status(400).json({ ok: false, error: verified.error || 'Bot Token không hợp lệ.' });
      return;
    }

    try {
      const stored = encryptBotTokenForStorage(rawToken);
      const tokenMasked = maskTelegramBotToken(rawToken);
      await setDoc(doc(db, 'groupTelegramBots', groupId), {
        groupId,
        botToken: stored.value,
        botUsername: verified.username,
        tokenMasked,
        encrypted: stored.encrypted,
        updatedAt: serverTimestamp(),
      });

      res.json({
        ok: true,
        botUsername: verified.username,
        tokenMasked,
        encryptedAtRest: stored.encrypted,
        groupStatus: {
          configured: true,
          source: 'custom',
          botUsername: verified.username,
          tokenMasked,
          encryptedAtRest: stored.encrypted,
          decryptError: false,
        },
      });
    } catch (err) {
      console.error('[API /api/telegram/bot-token POST] Error:', err);
      res.status(500).json({
        ok: false,
        error: 'Không thể lưu Bot Token vào cơ sở dữ liệu. Vui lòng thử lại.',
      });
    }
  });

  app.delete('/api/telegram/bot-token', async (req: Request, res: Response) => {
    const session = getAuthenticatedSession(req);
    const groupId = String(req.body?.groupId || req.query?.groupId || '').trim();

    if (!session) {
      res.status(401).json({
        ok: false,
        error: 'Phiên xác thực Telegram chưa kích hoạt hoặc đã hết hạn. Vui lòng đăng nhập lại Leader.',
      });
      return;
    }

    if (!groupId || session.groupId !== groupId) {
      res.status(403).json({
        ok: false,
        error: 'Chỉ Leader của nhóm này mới được xóa Bot Token riêng.',
      });
      return;
    }

    if (!checkRateLimit(`tg-token:${groupId}`, 12, 60_000)) {
      res.status(429).json({
        ok: false,
        error: 'Thao tác quá nhanh. Vui lòng đợi một lát.',
      });
      return;
    }

    const groupDoc = await fetchSharedGroupDoc(groupId);
    if (!groupDoc) {
      res.status(404).json({ ok: false, error: 'Không tìm thấy nhóm.' });
      return;
    }

    try {
      await deleteDoc(doc(db, 'groupTelegramBots', groupId));
      const fallbackStatus = await resolveGroupTelegramConfig(groupId, groupDoc.name || groupId);
      res.json({
        ok: true,
        groupStatus: {
          configured: fallbackStatus.configured,
          source: String(fallbackStatus.source || 'none'),
          botUsername: fallbackStatus.botUsername,
          tokenMasked: fallbackStatus.tokenMasked,
          encryptedAtRest: fallbackStatus.encryptedAtRest,
          decryptError: fallbackStatus.decryptError,
        },
      });
    } catch (err) {
      console.error('[API /api/telegram/bot-token DELETE] Error:', err);
      res.status(500).json({
        ok: false,
        error: 'Không thể xóa Bot Token riêng của nhóm.',
      });
    }
  });

  app.post('/api/telegram/test', async (req: Request, res: Response) => {
    const session = getAuthenticatedSession(req);
    const groupId = String(req.body?.groupId || '').trim();
    const chatId = String(req.body?.chatId || '').trim();
    const draftBotToken = String(req.body?.botToken || '').trim();

    if (!session) {
      res.status(401).json({
        ok: false,
        configured: Boolean(getGlobalTelegramBotToken()),
        error: 'Phiên xác thực Telegram chưa kích hoạt hoặc đã hết hạn. Vui lòng đăng nhập lại Leader.',
      });
      return;
    }

    if (!groupId || session.groupId !== groupId) {
      res.status(403).json({
        ok: false,
        configured: Boolean(getGlobalTelegramBotToken()),
        error: 'Bạn cần đăng nhập quyền Leader đúng của nhóm này để gửi thử tin nhắn.',
      });
      return;
    }

    if (!checkRateLimit(`tg-test:${groupId}`, 10, 60_000)) {
      res.status(429).json({
        ok: false,
        configured: Boolean(getGlobalTelegramBotToken()),
        error: 'Gửi thử quá nhanh. Vui lòng đợi vài giây.',
      });
      return;
    }

    if (!isValidTelegramChatId(chatId)) {
      res.status(400).json({
        ok: false,
        configured: Boolean(getGlobalTelegramBotToken()),
        error: 'Telegram Group Chat ID không hợp lệ (ví dụ: -1001234567890).',
      });
      return;
    }

    if (draftBotToken && !isValidTelegramBotToken(draftBotToken)) {
      res.status(400).json({
        ok: false,
        configured: false,
        error: 'Bot Token bạn đang nhập chưa đúng định dạng @BotFather (vd: 123456789:AAH...).',
      });
      return;
    }

    const groupDoc = await fetchSharedGroupDoc(groupId);
    if (!groupDoc) {
      res.status(404).json({ ok: false, configured: false, error: 'Không tìm thấy nhóm.' });
      return;
    }

    const botCfg = draftBotToken
      ? { token: draftBotToken, configured: true }
      : await resolveGroupTelegramConfig(groupId, groupDoc.name || groupId);

    if (!botCfg.token) {
      res.status(200).json({
        ok: false,
        configured: false,
        error: MISSING_TOKEN_ERROR,
      });
      return;
    }

    const { dateStr } = getVietnamDateTimeParts(new Date());
    const appLink = buildDashboardShareLink(getAppBaseUrl(req), groupId, dateStr);
    const groupSettings = (groupDoc.settings || {}) as Record<string, unknown>;
    const customTemplates =
      (groupSettings.telegramTemplates as Record<string, unknown> | undefined) || {};
    const testText = formatTelegramTestMessage({
      groupId,
      groupName: String(groupDoc.name || groupId),
      dateStr,
      appLink,
      customTemplate:
        typeof customTemplates.testMessage === 'string' ? customTemplates.testMessage : '',
    });

    const result = await sendTelegramMessage(chatId, testText, botCfg.token);
    res.status(result.ok || !result.configured ? 200 : 400).json(result);
  });

  app.post('/api/telegram/send', async (req: Request, res: Response) => {
    const session = getAuthenticatedSession(req);
    const groupId = String(req.body?.groupId || '').trim();
    const messageText = String(req.body?.message || '').trim();
    const replyMarkup = req.body?.replyMarkup;

    if (!session) {
      res.status(401).json({
        ok: false,
        configured: Boolean(getGlobalTelegramBotToken()),
        error: 'Phiên xác thực Telegram chưa kích hoạt. Vui lòng đăng nhập lại Leader.',
      });
      return;
    }

    if (!groupId || session.groupId !== groupId) {
      res.status(403).json({
        ok: false,
        configured: Boolean(getGlobalTelegramBotToken()),
        error: 'Chỉ Leader của nhóm này mới được gửi thông báo Telegram.',
      });
      return;
    }

    if (!checkRateLimit(`tg-send:${groupId}`, 20, 60_000)) {
      res.status(429).json({
        ok: false,
        configured: Boolean(getGlobalTelegramBotToken()),
        error: 'Gửi thông báo quá nhanh. Vui lòng đợi một lát.',
      });
      return;
    }

    const groupDoc = await fetchSharedGroupDoc(groupId);
    if (!groupDoc) {
      res.status(404).json({ ok: false, configured: false, error: 'Không tìm thấy nhóm.' });
      return;
    }

    const botCfg = await resolveGroupTelegramConfig(groupId, groupDoc.name || groupId);
    const settings = (groupDoc.settings || {}) as Record<string, unknown>;
    const chatId = String(settings.telegramChatId || '').trim();
    if (!settings.telegramEnabled || !isValidTelegramChatId(chatId)) {
      res.status(400).json({
        ok: false,
        configured: botCfg.configured,
        error: 'Nhóm này chưa bật hoặc chưa lưu Telegram Group Chat ID hợp lệ.',
      });
      return;
    }

    const distributionDate = String(req.body?.distributionDate || '').trim();
    const matrixHash = String(req.body?.matrixHash || '').trim();
    const result = await sendTelegramMessage(chatId, messageText, botCfg.token, replyMarkup);
    if (result.ok && /^\d{4}-\d{2}-\d{2}$/.test(distributionDate) && matrixHash) {
      await upsertGroupSchedulerState(groupId, {
        lastDistributionSentDate: distributionDate,
        lastDistributionMatrixHash: matrixHash.slice(0, 128),
        lastDistributionSentAt: new Date().toISOString().slice(0, 40),
      });
    }
    res.status(result.ok || !result.configured ? 200 : 400).json(result);
  });

  app.post('/api/telegram/send-photo', async (req: Request, res: Response) => {
    const session = getAuthenticatedSession(req);
    const groupId = String(req.body?.groupId || '').trim();
    const imageBase64 = String(req.body?.imageBase64 || '');
    const caption = String(req.body?.caption || '').trim();
    const replyMarkup = req.body?.replyMarkup;

    if (!session) {
      res.status(401).json({
        ok: false,
        configured: Boolean(getGlobalTelegramBotToken()),
        error: 'Phiên xác thực Telegram chưa kích hoạt. Vui lòng đăng nhập lại Leader.',
      });
      return;
    }

    if (!groupId || session.groupId !== groupId) {
      res.status(403).json({
        ok: false,
        configured: Boolean(getGlobalTelegramBotToken()),
        error: 'Chỉ Leader của nhóm này mới được gửi ảnh bảng CAP Telegram.',
      });
      return;
    }

    if (!checkRateLimit(`tg-photo:${groupId}`, 15, 60_000)) {
      res.status(429).json({
        ok: false,
        configured: Boolean(getGlobalTelegramBotToken()),
        error: 'Gửi ảnh thông báo quá nhanh. Vui lòng đợi một lát.',
      });
      return;
    }

    const groupDoc = await fetchSharedGroupDoc(groupId);
    if (!groupDoc) {
      res.status(404).json({ ok: false, configured: false, error: 'Không tìm thấy nhóm.' });
      return;
    }

    const botCfg = await resolveGroupTelegramConfig(groupId, groupDoc.name || groupId);
    const settings = (groupDoc.settings || {}) as Record<string, unknown>;
    const chatId = String(settings.telegramChatId || '').trim();
    if (!settings.telegramEnabled || !isValidTelegramChatId(chatId)) {
      res.status(400).json({
        ok: false,
        configured: botCfg.configured,
        error: 'Nhóm này chưa bật hoặc chưa lưu Telegram Group Chat ID hợp lệ.',
      });
      return;
    }

    const distributionDate = String(req.body?.distributionDate || '').trim();
    const matrixHash = String(req.body?.matrixHash || '').trim();
    const result = await sendTelegramPhoto(chatId, imageBase64, caption, botCfg.token, replyMarkup);
    if (result.ok && /^\d{4}-\d{2}-\d{2}$/.test(distributionDate) && matrixHash) {
      await upsertGroupSchedulerState(groupId, {
        lastDistributionSentDate: distributionDate,
        lastDistributionMatrixHash: matrixHash.slice(0, 128),
        lastDistributionSentAt: new Date().toISOString().slice(0, 40),
      });
    }
    res.status(result.ok || !result.configured ? 200 : 400).json(result);
  });

  // Protected Server-Side AI Proxy Endpoints (/api/ai/*)
  app.post('/api/ai/parse-offers', async (req: Request, res: Response) => {
    const session = getAuthenticatedSession(req);
    const groupId = String(req.body?.groupId || '').trim();
    if (!session) {
      res.status(401).json({ ok: false, error: 'Phiên đăng nhập Leader đã hết hạn. Vui lòng đăng nhập lại.' });
      return;
    }
    if (!groupId || session.groupId !== groupId) {
      res.status(403).json({ ok: false, error: 'Bạn không có quyền sử dụng AI cho nhóm này.' });
      return;
    }
    if (!checkRateLimit(`ai-offers:${groupId}`, 12, 60_000)) {
      res.status(429).json({ ok: false, error: 'Gọi AI quá nhanh. Vui lòng đợi ít giây.' });
      return;
    }

    const imageBase64 = String(req.body?.imageBase64 || '');
    if (imageBase64) {
      const rawB64 = imageBase64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');
      if (Buffer.byteLength(rawB64, 'base64') > 3.5 * 1024 * 1024) {
        res.status(400).json({ ok: false, error: 'Ảnh vượt quá giới hạn 3.5MB.' });
        return;
      }
    }

    const result = await parseOffersWithGemini({
      text: String(req.body?.text || ''),
      imageBase64,
      mimeType: String(req.body?.mimeType || 'image/png'),
      existingOffers: Array.isArray(req.body?.existingOffers) ? req.body.existingOffers : [],
    });

    if (!result.ok) {
      console.warn(`[API /api/ai/parse-offers] group=${groupId} failed:`, result.error);
      const status = result.quotaExceeded ? 429 : result.missingKey || result.transient ? 503 : 400;
      res.status(status).json({ ok: false, error: result.error });
      return;
    }
    res.json({ ok: true, summary: result.data.summary, offers: result.data.offers });
  });

  app.post('/api/ai/distribution-command', async (req: Request, res: Response) => {
    const session = getAuthenticatedSession(req);
    const groupId = String(req.body?.groupId || '').trim();
    if (!session) {
      res.status(401).json({ ok: false, error: 'Phiên đăng nhập Leader đã hết hạn. Vui lòng đăng nhập lại.' });
      return;
    }
    if (!groupId || session.groupId !== groupId) {
      res.status(403).json({ ok: false, error: 'Bạn không có quyền điều chỉnh chia CAP nhóm này.' });
      return;
    }
    if (!checkRateLimit(`ai-dist:${groupId}`, 15, 60_000)) {
      res.status(429).json({ ok: false, error: 'Gọi AI quá nhanh. Vui lòng đợi ít giây.' });
      return;
    }

    const result = await parseDistributionCommandWithGemini({
      prompt: String(req.body?.prompt || ''),
      members: Array.isArray(req.body?.members) ? req.body.members : [],
      campaigns: Array.isArray(req.body?.campaigns) ? req.body.campaigns : [],
      matrix: (req.body?.matrix || {}) as Record<string, any>,
      lockedCells: (req.body?.lockedCells || {}) as Record<string, any>,
      dateStr: String(req.body?.dateStr || getVietnamDateTimeParts(new Date()).dateStr),
      settings: (req.body?.settings || {}) as Record<string, unknown>,
    });

    if (!result.ok) {
      console.warn(`[API /api/ai/distribution-command] group=${groupId} failed:`, result.error);
      const status = result.quotaExceeded ? 429 : result.missingKey || result.transient ? 503 : 400;
      res.status(status).json({ ok: false, error: result.error });
      return;
    }
    const directives = { ...result.data };
    if (!directives.settingsPatch?.applySettings) {
      delete (directives as Record<string, unknown>).settingsPatch;
    }
    res.json({ ok: true, directives });
  });

  app.post('/api/ai/audit-distribution', async (req: Request, res: Response) => {
    const session = getAuthenticatedSession(req);
    const groupId = String(req.body?.groupId || '').trim();
    if (!session) {
      res.status(401).json({ ok: false, error: 'Phiên đăng nhập Leader đã hết hạn. Vui lòng đăng nhập lại.' });
      return;
    }
    if (!groupId || session.groupId !== groupId) {
      res.status(403).json({ ok: false, error: 'Bạn không có quyền kiểm toán nhóm này.' });
      return;
    }
    if (!checkRateLimit(`ai-audit:${groupId}`, 10, 60_000)) {
      res.status(429).json({ ok: false, error: 'Gọi AI kiểm tra quá nhanh. Vui lòng đợi ít giây.' });
      return;
    }

    const result = await auditDistributionWithGemini({
      members: Array.isArray(req.body?.members) ? req.body.members : [],
      campaigns: Array.isArray(req.body?.campaigns) ? req.body.campaigns : [],
      matrix: (req.body?.matrix || {}) as Record<string, any>,
      analyticsDataset: (req.body?.analyticsDataset || {}) as Record<string, any>,
      dateStr: String(req.body?.dateStr || getVietnamDateTimeParts(new Date()).dateStr),
    });

    if (!result.ok) {
      console.warn(`[API /api/ai/audit-distribution] group=${groupId} failed:`, result.error);
      const status = result.quotaExceeded ? 429 : result.missingKey || result.transient ? 503 : 400;
      res.status(status).json({ ok: false, error: result.error });
      return;
    }
    res.json({ ok: true, audit: result.data });
  });

  app.post('/api/ai/analytics-qa', async (req: Request, res: Response) => {
    const session = getAuthenticatedSession(req);
    const groupId = String(req.body?.groupId || '').trim();
    if (!session) {
      res.status(401).json({ ok: false, error: 'Phiên đăng nhập Leader đã hết hạn. Vui lòng đăng nhập lại.' });
      return;
    }
    if (!groupId || session.groupId !== groupId) {
      res.status(403).json({ ok: false, error: 'Bạn không có quyền xem thống kê AI nhóm này.' });
      return;
    }
    if (!checkRateLimit(`ai-qa:${groupId}`, 15, 60_000)) {
      res.status(429).json({ ok: false, error: 'Hỏi đáp AI quá nhanh. Vui lòng đợi ít giây.' });
      return;
    }

    const result = await answerAnalyticsWithGemini({
      question: String(req.body?.question || ''),
      analyticsDataset: (req.body?.analyticsDataset || {}) as Record<string, unknown>,
      groupName: String(req.body?.groupName || groupId),
    });

    if (!result.ok) {
      console.warn(`[API /api/ai/analytics-qa] group=${groupId} failed:`, result.error);
      const status = result.quotaExceeded ? 429 : result.missingKey || result.transient ? 503 : 400;
      res.status(status).json({ ok: false, error: result.error });
      return;
    }
    res.json({ ok: true, answer: result.data.answer, highlights: result.data.highlights });
  });

  const httpServer = http.createServer(app);

  if (!IS_PROD) {
    const vitePromise = import('vite').then(({ createServer: createViteServer }) =>
      createViteServer({
        server: {
          middlewareMode: true,
          hmr: process.env.DISABLE_HMR === 'true' ? false : { server: httpServer },
        },
        appType: 'spa',
      })
    );

    app.use(async (req, res, next) => {
      try {
        const vite = await vitePromise;
        vite.middlewares(req, res, next);
      } catch (err) {
        next(err);
      }
    });
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(
      '/assets',
      express.static(path.join(distDir, 'assets'), {
        maxAge: '30d',
        immutable: true,
        etag: true,
      })
    );
    app.use(
      express.static(distDir, {
        index: false,
        maxAge: '1h',
      })
    );
    app.get('*', (_req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer.listen(PORT, HOST, () => {
    console.info(`CAP Manager server running on http://${HOST}:${PORT}`);
    setTimeout(() => {
      void runScheduledTelegramJobs();
    }, 3_500);
    setInterval(() => {
      const now = Date.now();
      for (const [k, expiresAt] of schedulerFailureCooldown.entries()) {
        if (now >= expiresAt) {
          schedulerFailureCooldown.delete(k);
        }
      }
      void runScheduledTelegramJobs();
    }, 60_000);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
