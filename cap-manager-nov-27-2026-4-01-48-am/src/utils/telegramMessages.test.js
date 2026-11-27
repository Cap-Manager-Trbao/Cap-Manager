import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDashboardShareLink,
  computeDistributionDiff,
  computeDistributionMatrixHash,
  extractOfferNameCode,
  formatTelegramDiffMessage,
  formatTelegramDistributionMessage,
  formatTelegramPhotoCaption,
  formatTelegramShiftReminderMessage,
  formatTelegramTestMessage,
  getDefaultBotIcon,
  getDefaultBotLabel,
  getDefaultTelegramTemplates,
  getVietnamDateTimeParts,
  isValidTelegramChatId,
  renderCustomTelegramTemplate,
  resolveAppBaseUrl,
  sanitizeTelegramTemplates,
  shouldRunScheduledJob,
  stripTelegramHtml,
} from './telegramMessages.js';

test('extractOfferNameCode parses numeric code from offer.name and falls back to offer.code', () => {
  assert.equal(
    extractOfferNameCode({
      code: '1551',
      name: '21997905 - EverydayHealth - Diabetes Snacks',
    }),
    '21997905'
  );
  assert.equal(
    extractOfferNameCode({
      code: '1134',
      name: "999 - Everyday Health - Men's Treatments Path",
    }),
    '999'
  );
  assert.equal(
    extractOfferNameCode({
      code: '1769',
      name: 'Everyday Health Campaign Without Digits',
    }),
    '1769'
  );
});

test('isValidTelegramChatId validates group numeric IDs and channel usernames', () => {
  assert.equal(isValidTelegramChatId('-1001234567890'), true);
  assert.equal(isValidTelegramChatId('-451234567'), true);
  assert.equal(isValidTelegramChatId('@cap_team_group'), true);
  assert.equal(isValidTelegramChatId(''), false);
  assert.equal(isValidTelegramChatId('', { allowEmpty: true }), true);
  assert.equal(isValidTelegramChatId('http://evil.com'), false);
  assert.equal(isValidTelegramChatId('abc'), false);
});

test('computeDistributionDiff detects exact per-member CAP changes using offer name codes', () => {
  const members = [
    { id: 'm1', name: 'Trung Bảo' },
    { id: 'm2', name: 'Uyên' },
    { id: 'm3', name: 'Hiếu' },
  ];
  const campaigns = [
    {
      id: 'offer-1551',
      code: '1551',
      name: '21997905 - EverydayHealth - Diabetes Snacks',
      capHour: '10h',
      pointsPerCap: 25,
    },
    {
      id: 'offer-1769',
      code: '1769',
      name: '22038737 - Everydayhealth - Diabetes Cocktail Guide',
      capHour: '10h',
      pointsPerCap: 35,
    },
  ];

  const prevRecord = {
    members,
    campaigns,
    matrix: {
      'offer-1551': { m1: 2, m2: 2, m3: 1 },
      'offer-1769': { m1: 1, m2: 0, m3: 1 },
    },
  };

  const nextSnapshot = {
    members,
    campaigns,
    matrix: {
      'offer-1551': { m1: 3, m2: 1, m3: 1 },
      'offer-1769': { m1: 1, m2: 0, m3: 1 },
    },
  };

  const diffs = computeDistributionDiff(prevRecord, nextSnapshot);
  assert.equal(diffs.length, 2);
  assert.deepEqual(
    diffs.map((d) => ({ member: d.memberName, delta: d.delta, code: d.offerCode })),
    [
      { member: 'Trung Bảo', delta: 1, code: '21997905' },
      { member: 'Uyên', delta: -1, code: '21997905' },
    ]
  );

  const msg = formatTelegramDiffMessage({
    groupId: 'group-1',
    groupName: 'Nhóm 1',
    dateStr: '2026-11-22',
    diffs,
    stats: { assignedTotalCap: 7, assignedTotalPoints: 195 },
    appLink: buildDashboardShareLink('https://app.example.com', 'group-1', '2026-11-22'),
  });

  assert.match(msg, /Quản gia xin cập nhật – Điều chỉnh CAP Ngày 22\/11 \(Nhóm 1\)/);
  assert.match(msg, /Trung Bảo<\/b> \+1 CAP \(<code>21997905<\/code>\)/);
  assert.match(msg, /Uyên<\/b> -1 CAP \(<code>21997905<\/code>\)/);
  assert.match(msg, /Tổng hiện tại: <b>7 CAP<\/b>/);
  assert.doesNotMatch(msg, /point/);
  assert.match(msg, /groupId=group-1&amp;date=2026-11-22/);
});

test('formatTelegramPhotoCaption stays concise for initial publish, small diffs, and bulk re-distributions', () => {
  const appLink = 'https://cap.example.com/?groupId=group-1&date=2026-11-23';

  const initialCap = formatTelegramPhotoCaption({
    groupId: 'group-1',
    groupName: 'Nhóm 1',
    dateStr: '2026-11-23',
    stats: { assignedTotalCap: 49 },
    isUpdate: false,
    appLink,
  });
  assert.match(initialCap, /Quản gia xin thông báo – Bảng chia CAP Ngày 23\/11 \(Nhóm 1\)/);
  assert.match(initialCap, /49 CAP/);
  assert.ok(initialCap.length <= 1020);

  const smallDiffCap = formatTelegramPhotoCaption({
    groupName: 'Nhóm 1',
    dateStr: '2026-11-23',
    stats: { assignedTotalCap: 49 },
    diffs: [{ memberName: 'Trung Bảo', delta: 1, offerCode: '21997905' }],
    isUpdate: true,
    appLink,
  });
  assert.match(smallDiffCap, /Điều chỉnh: <b>Trung Bảo<\/b> \+1 CAP/);

  const bulkDiffs = Array.from({ length: 12 }, (_, idx) => ({
    memberName: `TV ${idx}`,
    delta: 1,
    offerCode: '21997905',
  }));
  const bulkCap = formatTelegramPhotoCaption({
    groupName: 'Nhóm 1',
    dateStr: '2026-11-23',
    stats: { assignedTotalCap: 49 },
    diffs: bulkDiffs,
    isUpdate: true,
    appLink,
  });
  assert.match(bulkCap, /vừa cập nhật lại bảng chia mới/);
  assert.doesNotMatch(bulkCap, /TV 0/);
});

test('formatTelegramDistributionMessage outputs Butler style grouped cleanly by offer without points/hour clutter', () => {
  const members = [
    { id: 'm1', name: 'Trung Bảo', active: true },
    { id: 'm2', name: 'Hiếu', active: true },
    { id: 'm3', name: 'Huy Bảo', active: true },
    { id: 'm4', name: 'Uyên', active: true },
    { id: 'm5', name: 'Chi Hon', active: true },
    { id: 'm6', name: 'Long', active: true },
  ];
  const campaigns = [
    {
      id: 'offer-1551',
      code: '1551',
      name: '21997905 - EverydayHealth - Diabetes Snacks',
      capHour: '10h',
      pointsPerCap: 25,
    },
    {
      id: 'offer-1769',
      code: '1769',
      name: '22038737 - Everydayhealth - Diabetes Cocktail Guide',
      capHour: '10h',
      pointsPerCap: 35,
    },
    {
      id: 'offer-1257',
      code: '1257',
      name: '21927987 - Everydayhealth - Diabetes Cocktail Guide',
      capHour: '23h',
      pointsPerCap: 20,
    },
  ];
  const matrix = {
    'offer-1551': { m1: 4, m2: 3, m3: 3, m4: 3, m5: 2, m6: 3 },
    'offer-1769': { m1: 1, m2: 1, m3: 1, m4: 1, m5: 1, m6: 1 },
    'offer-1257': { m1: 0, m2: 1, m3: 2, m4: 0, m5: 0, m6: 2 },
  };
  const stats = {
    assignedTotalCap: 29,
    assignedTotalPoints: 760,
    capSpread: 2,
  };

  const msg = formatTelegramDistributionMessage({
    groupId: 'group-1',
    groupName: 'Nhóm 1',
    dateStr: '2026-11-22',
    members,
    campaigns,
    matrix,
    stats,
    appLink: 'https://cap.example.com/?groupId=group-1&date=2026-11-22',
  });

  assert.match(msg, /Quản gia xin thông báo – Bảng chia CAP Ngày 22\/11/);
  assert.match(
    msg,
    /21997905 - EverydayHealth - Diabetes Snacks<\/b>: <b>18 CAP<\/b> — Mỗi người 3 cap \(Chi Hon 2 cap, Trung Bảo 4 cap\)/
  );
  assert.match(
    msg,
    /22038737 - Everydayhealth - Diabetes Cocktail Guide<\/b>: <b>6 CAP<\/b> — Mỗi người 1 cap/
  );
  assert.match(
    msg,
    /21927987 - Everydayhealth - Diabetes Cocktail Guide<\/b>: <b>5 CAP<\/b> — Hiếu 1 cap · Huy Bảo, Long 2 cap/
  );
  assert.doesNotMatch(msg, /point|260p|21h30:/);
  assert.match(msg, /https:\/\/cap\.example\.com\/\?groupId=group-1&amp;date=2026-11-22/);
});

test('formatTelegramShiftReminderMessage uses Butler tone to remind members to register shifts', () => {
  const dateStr = '2026-11-22';
  const nextDateStr = '2026-11-23';
  const members = [
    { id: 'm1', name: 'Trung Bảo', active: true, shifts: ['ca1', 'ca2'], shiftSchedule: { [nextDateStr]: ['ca1', 'ca3'] } },
    { id: 'm2', name: 'Uyên', active: true, shifts: ['ca2'], shiftSchedule: { [dateStr]: ['ca1', 'ca2'] } },
    { id: 'm3', name: 'Long', active: true, shifts: ['ca1'], shiftSchedule: { [nextDateStr]: [] } },
    { id: 'm4', name: 'Nghỉ', active: false, shifts: ['ca1'], shiftSchedule: { [nextDateStr]: ['ca1'] } },
  ];

  const appLink = buildDashboardShareLink('https://cap.example.com', 'group-1', dateStr, 'members');
  const msg = formatTelegramShiftReminderMessage({
    groupId: 'group-1',
    groupName: 'Nhóm 1',
    dateStr,
    members,
    appLink,
  });

  assert.match(msg, /Quản gia xin nhắc nhẹ – Đăng ký ca làm \(22\/11\)/);
  assert.match(msg, /đăng ký \/ cập nhật lịch ca của mình/);
  assert.match(msg, /Chưa cập nhật ca ngày mai \(23\/11\): Uyên/);
  assert.match(msg, /Đã đăng ký ngày mai \(23\/11\): Trung Bảo \(Ca 1, Ca 3\) · Long \(Nghỉ\)/);
  assert.match(msg, /tab=members/);
  assert.doesNotMatch(msg, /Nghỉ</);

  // 2026-11-22T04:00:00Z is 11:00:00 Asia/Ho_Chi_Minh (UTC+7)
  const vn = getVietnamDateTimeParts(new Date('2026-11-22T04:05:00Z'));
  assert.equal(vn.dateStr, '2026-11-22');
  assert.equal(vn.hour, 11);
  assert.equal(vn.minute, 5);
});

test('sanitizeTelegramTemplates enforces allowed keys and 800-char bounds', () => {
  const longStr = 'a'.repeat(900);
  const res = sanitizeTelegramTemplates({
    capPublish: `  **Chào {group}**\r\n${longStr}`,
    capUpdate: '  Cập nhật {changes}  ',
    shiftReminder: '',
    testMessage: 'OK',
    rogueKey: 'should be stripped',
  });
  assert.equal(Object.keys(res).length, 4);
  assert.equal('rogueKey' in res, false);
  assert.equal(res.capPublish.length, 800);
  assert.equal(res.capPublish.includes('\r'), false);
  assert.equal(res.capUpdate, 'Cập nhật {changes}');
  assert.equal(res.shiftReminder, '');
  assert.equal(res.testMessage, 'OK');
});

test('custom bot message templates escape raw HTML, convert **bold**, and support placeholders across publish/update/reminder/test', () => {
  const safeCustom = renderCustomTelegramTemplate('**Chào <team> & {group}**\nXem tại: {link}', {
    plainVars: { group: 'Nhóm <1>' },
    linkHtml: '<a href="https://app.example.com/?a=1&amp;b=2">Mở App</a>',
  });
  assert.equal(
    safeCustom,
    '<b>Chào &lt;team&gt; &amp; Nhóm &lt;1&gt;</b>\nXem tại: <a href="https://app.example.com/?a=1&amp;b=2">Mở App</a>'
  );

  const customPublishCap = formatTelegramPhotoCaption({
    groupName: 'Nhóm 2',
    dateStr: '2026-11-23',
    stats: { assignedTotalCap: 32, assignedTotalPoints: 890 },
    isUpdate: false,
    appLink: 'https://cap.example.com/?groupId=group-2',
    customTemplate: '**Bảng CAP {group} ({date})**\nTổng: {totalCap} CAP ({totalPoints} điểm)',
  });
  assert.match(customPublishCap, /<b>Bảng CAP Nhóm 2 \(23\/11\)<\/b>/);
  assert.match(customPublishCap, /Tổng: 32 CAP \(890 điểm\)/);
  assert.match(customPublishCap, /<a href="https:\/\/cap\.example\.com\/\?groupId=group-2">/);

  const customUpdateCap = formatTelegramPhotoCaption({
    groupName: 'Nhóm 2',
    dateStr: '2026-11-23',
    stats: { assignedTotalCap: 32 },
    diffs: [{ memberName: 'Hiếu', delta: 2, offerCode: '1769' }],
    isUpdate: true,
    appLink: 'https://cap.example.com/?groupId=group-2',
    customTemplate: '**{group} đổi CAP {date}**\n{changes}',
  });
  assert.match(customUpdateCap, /<b>Nhóm 2 đổi CAP 23\/11<\/b>/);
  assert.match(customUpdateCap, /Điều chỉnh: <b>Hiếu<\/b> \+2 CAP \(<code>1769<\/code>\)/);

  const customReminder = formatTelegramShiftReminderMessage({
    groupName: 'Nhóm 2',
    dateStr: '2026-11-23',
    members: [
      { id: 'm1', name: 'An', active: true, shifts: ['ca1'], shiftSchedule: {} },
    ],
    appLink: 'https://cap.example.com/?tab=members',
    customTemplate: 'Nhắc {group} ({pendingCount} người chưa đăng ký):\n{shiftSummary}',
  });
  assert.match(customReminder, /Nhắc Nhóm 2 \(1 người chưa đăng ký\):/);
  assert.match(customReminder, /Chưa cập nhật ca ngày mai \(24\/11\): An/);

  const customTest = formatTelegramTestMessage({
    groupName: 'Nhóm 2',
    dateStr: '2026-11-23',
    appLink: 'https://cap.example.com/',
    customTemplate: '**Test Bot {group}** ngày {date} thành công!',
  });
  assert.match(customTest, /<b>Test Bot Nhóm 2<\/b> ngày 23\/11 thành công!/);
  assert.match(customTest, /Mở CAP Manager/);
});

test('shouldRunScheduledJob supports 180-min catch-up and deduplicates by VN date', () => {
  assert.equal(
    shouldRunScheduledJob({
      targetHHMM: '11:00',
      curHour: 10,
      curMinute: 59,
      dateStr: '2026-11-24',
      lastSentDate: '',
      catchUpMinutes: 180,
    }),
    false
  );
  assert.equal(
    shouldRunScheduledJob({
      targetHHMM: '11:00',
      curHour: 11,
      curMinute: 0,
      dateStr: '2026-11-24',
      lastSentDate: '',
      catchUpMinutes: 180,
    }),
    true
  );
  assert.equal(
    shouldRunScheduledJob({
      targetHHMM: '11:00',
      curHour: 13,
      curMinute: 45,
      dateStr: '2026-11-24',
      lastSentDate: '',
      catchUpMinutes: 180,
    }),
    true
  );
  assert.equal(
    shouldRunScheduledJob({
      targetHHMM: '11:00',
      curHour: 14,
      curMinute: 1,
      dateStr: '2026-11-24',
      lastSentDate: '',
      catchUpMinutes: 180,
    }),
    false
  );
  assert.equal(
    shouldRunScheduledJob({
      targetHHMM: '11:00',
      curHour: 11,
      curMinute: 15,
      dateStr: '2026-11-24',
      lastSentDate: '2026-11-24',
      catchUpMinutes: 180,
    }),
    false
  );
  assert.equal(
    shouldRunScheduledJob({
      targetHHMM: '99:00',
      curHour: 11,
      curMinute: 0,
      dateStr: '2026-11-24',
    }),
    false
  );
});

test('computeDistributionMatrixHash is order-independent and detects single-CAP mutations', () => {
  const campaigns = [{ id: 'o2' }, { id: 'o1' }];
  const members = [{ id: 'm2' }, { id: 'm1' }];
  const mA = { o1: { m1: 2, m2: 1 }, o2: { m1: 0, m2: 3 } };
  const mB = { o2: { m2: 3 }, o1: { m2: 1, m1: 2 } };
  const mC = { o1: { m1: 2, m2: 2 }, o2: { m1: 0, m2: 2 } };

  const hashA = computeDistributionMatrixHash(campaigns, members, mA);
  const hashB = computeDistributionMatrixHash([...campaigns].reverse(), [...members].reverse(), mB);
  const hashC = computeDistributionMatrixHash(campaigns, members, mC);

  assert.equal(hashA, hashB);
  assert.notEqual(hashA, hashC);
});

test('formatTelegramPhotoCaption truncates safely without leaving unclosed HTML tags and stripTelegramHtml cleans tags', () => {
  const repeatedTags = Array.from({ length: 45 }, (_, i) => `**Mục số ${i} siêu dài cho thành viên**`).join(' ');
  const cap = formatTelegramPhotoCaption({
    groupName: 'Nhóm 1',
    dateStr: '2026-11-24',
    stats: { assignedTotalCap: 40 },
    appLink: 'https://cap.example.com/?groupId=group-1&date=2026-11-24',
    customTemplate: `${repeatedTags}\n{link}`,
  });

  assert.ok(cap.length <= 1020);
  const openBold = (cap.match(/<b>/g) || []).length;
  const closeBold = (cap.match(/<\/b>/g) || []).length;
  assert.equal(openBold, closeBold);
  assert.doesNotMatch(cap, /<[^>]*$/);

  const plain = stripTelegramHtml('<b>Xin chào</b> &amp; <a href="https://example.com">Mở</a>');
  assert.equal(plain, 'Xin chào & Mở (https://example.com)');
});

test('non-group-1 groups default to Bot / 🤖 instead of Quản gia / 🎩 while group-1 preserves Quản gia', () => {
  assert.equal(getDefaultBotLabel('group-1'), 'Quản gia');
  assert.equal(getDefaultBotIcon('group-1'), '🎩');
  assert.equal(getDefaultBotLabel('group-2'), 'Bot');
  assert.equal(getDefaultBotIcon('group-2'), '🤖');
  assert.equal(getDefaultBotLabel(''), 'Bot');

  const g1Templates = getDefaultTelegramTemplates('group-1');
  const g2Templates = getDefaultTelegramTemplates('group-2');
  assert.match(g1Templates.capPublish, /Quản gia/);
  assert.match(g2Templates.capPublish, /Bot/);
  assert.doesNotMatch(g2Templates.capPublish, /Quản gia/);
  assert.doesNotMatch(g2Templates.shiftReminder, /Quản gia/);

  const msg = formatTelegramDistributionMessage({
    groupId: 'group-2',
    groupName: 'Nhóm 2',
    dateStr: '2026-11-24',
    members: [{ id: 'm1', name: 'An', active: true }],
    campaigns: [{ id: 'o1', code: '100', name: '100 - Test', capHour: '10h', pointsPerCap: 20 }],
    matrix: { o1: { m1: 2 } },
    stats: { assignedTotalCap: 2 },
    appLink: 'https://cap.example.com/?groupId=group-2',
  });
  assert.match(msg, /🤖 <b>Bot xin thông báo/);
  assert.doesNotMatch(msg, /Quản gia/);

  const testMsg = formatTelegramTestMessage({
    groupId: 'group-2',
    groupName: 'Nhóm 2',
    dateStr: '2026-11-24',
    appLink: 'https://cap.example.com/?groupId=group-2',
  });
  assert.match(testMsg, /🤖 <b>Bot đã sẵn sàng phục vụ Nhóm 2!/);
  assert.doesNotMatch(testMsg, /Quản gia/);
});

test('resolveAppBaseUrl resolves APP_URL, RENDER_EXTERNAL_URL, KOYEB_PUBLIC_DOMAIN, headers, and localhost', () => {
  assert.equal(
    resolveAppBaseUrl({
      env: {
        APP_URL: 'https://custom.example.com/',
        RENDER_EXTERNAL_URL: 'https://cap-manager.onrender.com',
      },
    }),
    'https://custom.example.com'
  );

  assert.equal(
    resolveAppBaseUrl({
      env: {
        APP_URL: 'MY_APP_URL',
        RENDER_EXTERNAL_URL: 'https://cap-manager.onrender.com/',
      },
    }),
    'https://cap-manager.onrender.com'
  );

  assert.equal(
    resolveAppBaseUrl({
      env: {
        KOYEB_PUBLIC_DOMAIN: 'cap-manager-team.koyeb.app',
      },
    }),
    'https://cap-manager-team.koyeb.app'
  );

  assert.equal(
    resolveAppBaseUrl({
      env: {},
      protocol: 'https, http',
      host: 'proxy.example.com',
      port: 3000,
    }),
    'https://proxy.example.com'
  );

  assert.equal(
    resolveAppBaseUrl({
      env: {},
      port: 3099,
    }),
    'http://localhost:3099'
  );
});
