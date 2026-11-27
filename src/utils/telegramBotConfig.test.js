import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidTelegramBotToken,
  maskTelegramBotToken,
  normalizeGroupEnvKey,
  parseTelegramBotTokensEnv,
  pickEffectiveGroupBotToken,
  resolveEnvBotTokenForGroup,
} from './telegramBotConfig.js';

const SAMPLE_TOKEN_1 = '123456789:AAH1234567890abcdefghijklmnop_qrs';
const SAMPLE_TOKEN_2 = '987654321:BBG0987654321zyxwvutsrqponmlk_jih';
const SAMPLE_TOKEN_GLOBAL = '555666777:CCX5556667770abcdefghijklmno_pqrs';

test('isValidTelegramBotToken validates BotFather format accurately', () => {
  assert.equal(isValidTelegramBotToken(SAMPLE_TOKEN_1), true);
  assert.equal(isValidTelegramBotToken(`  ${SAMPLE_TOKEN_2}  `), true);
  assert.equal(isValidTelegramBotToken(''), false);
  assert.equal(isValidTelegramBotToken('', { allowEmpty: true }), true);
  assert.equal(isValidTelegramBotToken('not-a-token'), false);
  assert.equal(isValidTelegramBotToken('123:short'), false);
  assert.equal(isValidTelegramBotToken('abc:AAH1234567890abcdefghijklmnop_qrs'), false);
  assert.equal(isValidTelegramBotToken(`${SAMPLE_TOKEN_1}/evil`), false);
});

test('maskTelegramBotToken reveals only the last 4 characters', () => {
  assert.equal(maskTelegramBotToken(SAMPLE_TOKEN_1), '••••••_qrs');
  assert.equal(maskTelegramBotToken(''), '');
});

test('normalizeGroupEnvKey formats group IDs into env suffix', () => {
  assert.equal(normalizeGroupEnvKey('group-1'), 'GROUP_1');
  assert.equal(normalizeGroupEnvKey('group-m8k3-ab'), 'GROUP_M8K3_AB');
});

test('parseTelegramBotTokensEnv ignores invalid JSON or malformed tokens', () => {
  assert.deepEqual(parseTelegramBotTokensEnv('not json'), {});
  assert.deepEqual(parseTelegramBotTokensEnv('["arr"]'), {});
  const parsed = parseTelegramBotTokensEnv(
    JSON.stringify({
      'group-1': SAMPLE_TOKEN_1,
      'group-bad': 'bad-token',
    })
  );
  assert.deepEqual(parsed, { 'group-1': SAMPLE_TOKEN_1 });
});

test('resolveEnvBotTokenForGroup follows per-group env > JSON map > global fallback', () => {
  const env = {
    TELEGRAM_BOT_TOKEN: SAMPLE_TOKEN_GLOBAL,
    TELEGRAM_BOT_TOKEN_GROUP_2: SAMPLE_TOKEN_2,
    TELEGRAM_BOT_TOKENS: JSON.stringify({
      'group-1': SAMPLE_TOKEN_1,
      'Nhóm 3': SAMPLE_TOKEN_2,
    }),
  };

  assert.deepEqual(
    resolveEnvBotTokenForGroup({ groupId: 'group-2', groupName: 'Nhóm 2', env }),
    { token: SAMPLE_TOKEN_2, source: 'env_group' }
  );
  assert.deepEqual(
    resolveEnvBotTokenForGroup({ groupId: 'group-1', groupName: 'Nhóm 1', env }),
    { token: SAMPLE_TOKEN_1, source: 'env_group' }
  );
  assert.deepEqual(
    resolveEnvBotTokenForGroup({ groupId: 'group-99', groupName: 'Nhóm 3', env }),
    { token: SAMPLE_TOKEN_2, source: 'env_group' }
  );
  assert.deepEqual(
    resolveEnvBotTokenForGroup({ groupId: 'group-other', groupName: 'Nhóm Khác', env }),
    { token: SAMPLE_TOKEN_GLOBAL, source: 'env_default' }
  );
  assert.deepEqual(
    resolveEnvBotTokenForGroup({ groupId: 'group-other', groupName: 'Nhóm Khác', env: {} }),
    { token: '', source: 'none' }
  );
});

test('pickEffectiveGroupBotToken prioritizes custom DB token over env fallback', () => {
  const envTokenRes = { token: SAMPLE_TOKEN_GLOBAL, source: 'env_default' };
  const customRes = pickEffectiveGroupBotToken({
    envTokenRes,
    customRecord: {
      token: SAMPLE_TOKEN_2,
      botUsername: 'nhom2_cap_bot',
      tokenMasked: '••••••_jih',
      encrypted: true,
    },
  });
  assert.equal(customRes.token, SAMPLE_TOKEN_2);
  assert.equal(customRes.source, 'custom');
  assert.equal(customRes.botUsername, 'nhom2_cap_bot');
  assert.equal(customRes.encryptedAtRest, true);

  const fallbackRes = pickEffectiveGroupBotToken({ envTokenRes, customRecord: null });
  assert.equal(fallbackRes.token, SAMPLE_TOKEN_GLOBAL);
  assert.equal(fallbackRes.source, 'env_default');
  assert.equal(fallbackRes.tokenMasked, '••••••pqrs');
});
