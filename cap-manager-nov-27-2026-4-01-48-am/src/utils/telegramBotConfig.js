/**
 * Pure helpers for per-group Telegram Bot Token validation, masking, and env/custom resolution.
 * Browser-safe (no Node-only imports) so both server.ts and React components can share it.
 */

export function isValidTelegramBotToken(rawToken, { allowEmpty = false } = {}) {
  const clean = String(rawToken || '').trim();
  if (!clean) return allowEmpty;
  return /^\d{5,16}:[A-Za-z0-9_-]{20,120}$/.test(clean);
}

export function maskTelegramBotToken(rawToken) {
  const clean = String(rawToken || '').trim();
  if (!clean) return '';
  const tail = clean.slice(-4);
  return `••••••${tail}`;
}

export function normalizeGroupEnvKey(groupId) {
  return String(groupId || '')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

export function parseTelegramBotTokensEnv(rawJson) {
  const text = String(rawJson || '').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      const cleanKey = String(k || '').trim();
      const cleanVal = String(v || '').trim();
      if (cleanKey && isValidTelegramBotToken(cleanVal)) {
        out[cleanKey] = cleanVal;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Resolve server environment Bot Token for a group:
 * 1) TELEGRAM_BOT_TOKEN_<NORMALIZED_GROUP_ID>
 * 2) TELEGRAM_BOT_TOKENS JSON map (by groupId, exact groupName, or trimmed lowercase groupName)
 * 3) Global TELEGRAM_BOT_TOKEN fallback
 */
export function resolveEnvBotTokenForGroup({
  groupId = '',
  groupName = '',
  env = {},
} = {}) {
  const safeEnv = env || {};
  const cleanGroupId = String(groupId || '').trim();
  const cleanGroupName = String(groupName || '').trim();

  if (cleanGroupId) {
    const envVarKey = `TELEGRAM_BOT_TOKEN_${normalizeGroupEnvKey(cleanGroupId)}`;
    const directVal = String(safeEnv[envVarKey] || '').trim();
    if (isValidTelegramBotToken(directVal)) {
      return { token: directVal, source: 'env_group' };
    }
  }

  const mapTokens = parseTelegramBotTokensEnv(safeEnv.TELEGRAM_BOT_TOKENS);
  if (Object.keys(mapTokens).length > 0) {
    if (cleanGroupId && mapTokens[cleanGroupId]) {
      return { token: mapTokens[cleanGroupId], source: 'env_group' };
    }
    if (cleanGroupName && mapTokens[cleanGroupName]) {
      return { token: mapTokens[cleanGroupName], source: 'env_group' };
    }
    const lowerName = cleanGroupName.toLowerCase();
    const matchedEntry = Object.entries(mapTokens).find(
      ([k]) => k.toLowerCase() === lowerName || k.toLowerCase() === cleanGroupId.toLowerCase()
    );
    if (matchedEntry) {
      return { token: matchedEntry[1], source: 'env_group' };
    }
  }

  const globalVal = String(safeEnv.TELEGRAM_BOT_TOKEN || '').trim();
  if (globalVal) {
    return { token: globalVal, source: 'env_default' };
  }

  return { token: '', source: 'none' };
}

/**
 * Pick the effective Bot Token and sanitized public metadata for a group.
 * Precedence: custom saved token (UI/DB) > group-specific env > global default env.
 * @param {{
 *   envTokenRes?: { token?: string, source?: string },
 *   customRecord?: { token?: string, decryptError?: boolean, botUsername?: string, tokenMasked?: string, encrypted?: boolean } | null
 * }} params
 */
export function pickEffectiveGroupBotToken({
  envTokenRes = { token: '', source: 'none' },
  customRecord = null,
} = {}) {
  const customToken = String(customRecord?.token || '').trim();
  if (customToken && isValidTelegramBotToken(customToken)) {
    return {
      token: customToken,
      source: 'custom',
      configured: true,
      botUsername: String(customRecord?.botUsername || '').trim(),
      tokenMasked: String(customRecord?.tokenMasked || maskTelegramBotToken(customToken)),
      encryptedAtRest: Boolean(customRecord?.encrypted),
      decryptError: false,
    };
  }

  if (customRecord?.decryptError) {
    // Fallback to env if available, while surfacing decrypt warning metadata when no env exists
    if (envTokenRes?.token) {
      return {
        token: envTokenRes.token,
        source: envTokenRes.source,
        configured: true,
        botUsername: '',
        tokenMasked: maskTelegramBotToken(envTokenRes.token),
        encryptedAtRest: true,
        decryptError: true,
      };
    }
    return {
      token: '',
      source: 'none',
      configured: false,
      botUsername: '',
      tokenMasked: '',
      encryptedAtRest: false,
      decryptError: true,
    };
  }

  if (envTokenRes?.token) {
    return {
      token: envTokenRes.token,
      source: envTokenRes.source,
      configured: true,
      botUsername: '',
      tokenMasked: maskTelegramBotToken(envTokenRes.token),
      encryptedAtRest: true,
      decryptError: false,
    };
  }

  return {
    token: '',
    source: 'none',
    configured: false,
    botUsername: '',
    tokenMasked: '',
    encryptedAtRest: false,
    decryptError: false,
  };
}
