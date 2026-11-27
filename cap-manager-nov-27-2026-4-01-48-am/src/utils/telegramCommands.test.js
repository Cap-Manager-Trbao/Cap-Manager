import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDistributionPublishKeyboard,
  buildMemberCapChecklistKeyboard,
  buildShiftReminderKeyboard,
  buildTransferApprovalKeyboard,
  computeCompletionProgress,
  formatMemberTelegramCapMessage,
  formatTelegramCutoffNudgeMessage,
  formatTelegramHelpMessage,
  formatTelegramProgressMessage,
  matchTelegramSenderToMember,
  parseCallbackData,
  parseTelegramCommand,
  resolveMemberByQuery,
  resolveOfferByQuery,
} from './telegramCommands.js';
import { DEFAULT_MEMBERS, DEFAULT_OFFERS } from '../data/defaultData.js';

describe('telegramCommands', () => {
  it('matches Telegram sender by userId, @username, or unique Vietnamese name', () => {
    const members = [
      { ...DEFAULT_MEMBERS[0], telegramUsername: '@TrungBao_Cap', telegramUserId: '1001' },
      { ...DEFAULT_MEMBERS[1], telegramUsername: 'hieu_dev', telegramUserId: '' },
      { ...DEFAULT_MEMBERS[2], telegramUsername: '', telegramUserId: '' },
    ];

    const byId = matchTelegramSenderToMember({ id: 1001, username: 'other', first_name: 'X' }, members);
    assert.equal(byId.member.id, 'mem-trung-bao');
    assert.equal(byId.matchType, 'userId');

    const byUser = matchTelegramSenderToMember({ id: 2002, username: 'Hieu_Dev', first_name: 'H' }, members);
    assert.equal(byUser.member.id, 'mem-hieu');
    assert.equal(byUser.matchType, 'username');

    const byName = matchTelegramSenderToMember({ id: 3003, first_name: 'Huy', last_name: 'Bao' }, members);
    assert.equal(byName.member.id, 'mem-huy-bao');
    assert.equal(byName.matchType, 'name');
  });

  it('parses /ca, /nhuong, /link, /cap, /tiendo slash commands cleanly', () => {
    const ca1 = parseTelegramCommand('/ca@MyCapBot ca1 ca3');
    assert.equal(ca1.type, 'ca');
    assert.deepEqual(ca1.shifts, ['ca1', 'ca3']);
    assert.equal(ca1.dayOffset, 1);
    assert.equal(ca1.isOff, false);

    const caOff = parseTelegramCommand('/ca nghỉ hôm nay');
    assert.equal(caOff.type, 'ca');
    assert.deepEqual(caOff.shifts, []);
    assert.equal(caOff.isOff, true);
    assert.equal(caOff.dayOffset, 0);

    const nhuong = parseTelegramCommand('/nhuong 2 1769 @hieu ban viec dot xuat');
    assert.equal(nhuong.type, 'nhuong');
    assert.equal(nhuong.qty, 2);
    assert.equal(nhuong.offerQuery, '1769');
    assert.equal(nhuong.targetQuery, '@hieu');
    assert.equal(nhuong.note, 'ban viec dot xuat');

    const link = parseTelegramCommand('/link Uyên');
    assert.equal(link.type, 'link');
    assert.equal(link.argsText, 'Uyên');

    const unknown = parseTelegramCommand('/menu@other_bot arg1');
    assert.equal(unknown.type, 'unknown');
    assert.equal(unknown.commandName, 'menu');
    assert.equal(unknown.mentionedBot, 'other_bot');
    assert.equal(unknown.argsText, 'arg1');
  });

  it('keeps callback_data well under 64 bytes and round-trips cleanly', () => {
    const longMembers = [
      { id: 'mem-very-long-id-1234567890-abcdef', name: 'Trung Bảo' },
    ];
    const longOffers = [
      { id: 'offer-very-long-id-9876543210-xyz', code: '1769', name: '22038737 - Diabetes', capHour: '10h', pointsPerCap: 35 },
    ];
    const matrix = {
      'offer-very-long-id-9876543210-xyz': { 'mem-very-long-id-1234567890-abcdef': 2 },
    };

    const kb = buildMemberCapChecklistKeyboard({
      dateStr: '2026-11-23',
      member: longMembers[0],
      campaigns: longOffers,
      matrix,
      completionsForDate: {},
    });

    for (const row of kb.inline_keyboard) {
      for (const btn of row) {
        assert.ok(Buffer.byteLength(btn.callback_data, 'utf8') <= 64);
      }
    }

    const firstCb = parseCallbackData(kb.inline_keyboard[0][0].callback_data);
    assert.equal(firstCb.type, 'toggle_cap_done');
    assert.equal(firstCb.dateStr, '2026-11-23');

    const pubKb = buildDistributionPublishKeyboard('2026-11-23');
    assert.equal(parseCallbackData(pubKb.inline_keyboard[0][0].callback_data).type, 'open_my_cap');
    assert.equal(parseCallbackData(pubKb.inline_keyboard[0][1].callback_data).type, 'show_progress');

    const shKb = buildShiftReminderKeyboard('2026-11-24');
    assert.equal(parseCallbackData(shKb.inline_keyboard[0][0].callback_data).shiftCode, 'ca1');

    const trKb = buildTransferApprovalKeyboard('tr-123');
    assert.equal(parseCallbackData(trKb.inline_keyboard[0][0].callback_data).type, 'approve_transfer');
    assert.equal(parseCallbackData(trKb.inline_keyboard[0][1].callback_data).type, 'reject_transfer');
  });

  it('computes real-time completion progress and formats unfinished nudge', () => {
    const members = DEFAULT_MEMBERS.slice(0, 2);
    const campaigns = DEFAULT_OFFERS.slice(0, 2);
    const matrix = {
      [campaigns[0].id]: { [members[0].id]: 2, [members[1].id]: 1 },
      [campaigns[1].id]: { [members[0].id]: 0, [members[1].id]: 3 },
    };
    const completionsForDate = {
      [campaigns[0].id]: { [members[0].id]: true },
    };

    const progress = computeCompletionProgress({
      members,
      campaigns,
      matrix,
      completionsForDate,
      dateStr: '2026-11-23',
    });
    assert.equal(progress.totalCap, 6);
    assert.equal(progress.completedCap, 2);
    assert.equal(progress.percent, 33);
    assert.equal(progress.completedMembers.length, 1);
    assert.equal(progress.unfinishedByMember.length, 1);

    const progressMsg = formatTelegramProgressMessage({
      groupName: 'Nhóm 1',
      dateStr: '2026-11-23',
      members,
      campaigns,
      matrix,
      completionsForDate,
    });
    assert.match(progressMsg, /2\/6 CAP/);
    assert.match(progressMsg, /Hiếu/);

    const nudgeMsg = formatTelegramCutoffNudgeMessage({
      groupName: 'Nhóm 1',
      dateStr: '2026-11-23',
      members,
      campaigns,
      matrix,
      completionsForDate,
    });
    assert.match(nudgeMsg, /Hiếu/);

    const personalMsg = formatMemberTelegramCapMessage({
      member: members[0],
      dateStr: '2026-11-23',
      campaigns,
      matrix,
      completionsForDate,
    });
    assert.match(personalMsg, /Trung Bảo/);
    assert.match(personalMsg, /2\/2 CAP/);
  });

  it('resolves members and offers by partial Vietnamese text or code', () => {
    assert.equal(resolveMemberByQuery('huy bao', DEFAULT_MEMBERS)?.id, 'mem-huy-bao');
    assert.equal(resolveOfferByQuery('22038737', DEFAULT_OFFERS)?.code, '1769');
    assert.equal(resolveOfferByQuery('1706', DEFAULT_OFFERS)?.code, '1706');
  });

  it('formats help and nudge messages with Quản gia only for group-1 and Bot for other groups', () => {
    const g1Help = formatTelegramHelpMessage('Nhóm 1', 'group-1');
    const g2Help = formatTelegramHelpMessage('Nhóm 2', 'group-2');
    assert.match(g1Help, /🎩 <b>Hướng dẫn Quản gia 2 chiều/);
    assert.match(g2Help, /🤖 <b>Hướng dẫn Bot 2 chiều/);
    assert.doesNotMatch(g2Help, /Quản gia/);

    const members = DEFAULT_MEMBERS.slice(0, 1);
    const campaigns = DEFAULT_OFFERS.slice(0, 1);
    const matrix = { [campaigns[0].id]: { [members[0].id]: 2 } };
    const nudgeG2 = formatTelegramCutoffNudgeMessage({
      groupId: 'group-2',
      groupName: 'Nhóm 2',
      dateStr: '2026-11-24',
      members,
      campaigns,
      matrix,
      completionsForDate: {},
    });
    assert.match(nudgeG2, /🤖 <b>Bot nhắc nhẹ/);
    assert.doesNotMatch(nudgeG2, /Quản gia/);
  });
});

