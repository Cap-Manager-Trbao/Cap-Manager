import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ThinkingLevel } from '@google/genai';
import {
  GEMINI_FALLBACK_MODEL,
  GEMINI_MODEL,
  buildGeminiAttemptConfig,
  extractShortGeminiReason,
  formatGeminiError,
  isAuthGeminiError,
  isDailyQuotaExceeded,
  isQuotaGeminiError,
  isTransientGeminiError,
  isTransientNetworkGeminiError,
  parseGeminiJsonText,
  parseGeminiRetryDelayMs,
} from './geminiService.js';

describe('geminiService helpers', () => {
  it('separates quota (429) errors from network/503 errors and parses retry delays accurately', () => {
    const rpmErr = new Error(
      '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"15s"}]}}'
    );
    const rpdErr = new Error(
      '{"error":{"code":429,"message":"GenerateRequestsPerDayPerProjectPerModel-FreeTier. Please retry in 17h46m19.5s."}}'
    );
    const netErr = new Error('503 UNAVAILABLE');
    const timeoutErr = new Error('Request timeout after 4000ms');

    assert.equal(isQuotaGeminiError(rpmErr), true);
    assert.equal(isTransientNetworkGeminiError(rpmErr), false);
    assert.equal(isDailyQuotaExceeded(rpmErr), false);
    assert.equal(parseGeminiRetryDelayMs(rpmErr), 15_000);

    assert.equal(isQuotaGeminiError(rpdErr), true);
    assert.equal(isDailyQuotaExceeded(rpdErr), true);
    assert.ok(parseGeminiRetryDelayMs(rpdErr) > 60_000_000);

    assert.equal(isQuotaGeminiError(netErr), false);
    assert.equal(isTransientNetworkGeminiError(netErr), true);
    assert.equal(extractShortGeminiReason(netErr), '503 UNAVAILABLE');
    assert.equal(extractShortGeminiReason(new Error('EMPTY_RESPONSE(finishReason=MAX_TOKENS)')), 'EMPTY_RESPONSE(finishReason=MAX_TOKENS)');
    assert.equal(isTransientGeminiError(timeoutErr), true);
    assert.equal(isTransientGeminiError(new Error('400 INVALID_ARGUMENT: bad schema')), false);
    assert.equal(isTransientGeminiError(new Error('403 PERMISSION_DENIED: API_KEY_INVALID')), false);
  });

  it('formats distinct localized messages for auth, RPM, daily RPD quota, and network errors', () => {
    const authErr = new Error('403 API_KEY_INVALID');
    assert.equal(isAuthGeminiError(authErr), true);
    assert.match(formatGeminiError(authErr), /GEMINI_API_KEY không hợp lệ/);

    const rpmErr = new Error('429 RESOURCE_EXHAUSTED "retryDelay":"15s"');
    assert.match(formatGeminiError(rpmErr), /giới hạn tốc độ \(RPM\)/);

    const rpdErr = new Error('429 RESOURCE_EXHAUSTED GenerateRequestsPerDayPerProjectPerModel-FreeTier');
    assert.match(formatGeminiError(rpdErr), /Free Tier.*theo ngày đã tạm hết/);

    const netErr = new Error('UND_ERR_CONNECT_TIMEOUT');
    assert.match(formatGeminiError(netErr), /tạm thời gián đoạn/);
  });

  it('parses raw JSON and strips accidental markdown code fences', () => {
    const plain = parseGeminiJsonText<{ ok: boolean }>('{"ok":true}');
    assert.equal(plain.ok, true);

    const fenced = parseGeminiJsonText<{ answer: string; highlights: string[] }>(
      '```json\n{"answer":"Tổng kết","highlights":["A"]}\n```'
    );
    assert.equal(fenced.answer, 'Tổng kết');
    assert.deepEqual(fenced.highlights, ['A']);

    assert.throws(() => parseGeminiJsonText('   '), /EMPTY_RESPONSE/);
  });

  it('steps down ThinkingLevel.MEDIUM to LOW on retry and omits thinkingConfig on fallback model', () => {
    const base = {
      systemInstruction: 'sys',
      thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
      responseMimeType: 'application/json',
    };

    const first = buildGeminiAttemptConfig(base, GEMINI_MODEL, 0);
    assert.equal((first.thinkingConfig as { thinkingLevel: ThinkingLevel }).thinkingLevel, ThinkingLevel.MEDIUM);

    const retry = buildGeminiAttemptConfig(base, GEMINI_MODEL, 1);
    assert.equal((retry.thinkingConfig as { thinkingLevel: ThinkingLevel }).thinkingLevel, ThinkingLevel.LOW);

    const fallback = buildGeminiAttemptConfig(base, GEMINI_FALLBACK_MODEL, 0);
    assert.equal('thinkingConfig' in fallback, false);
    assert.equal(fallback.systemInstruction, 'sys');
  });
});
