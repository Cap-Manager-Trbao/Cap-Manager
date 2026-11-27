import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSpreadsheetIdAndGid,
  inferYearMonthFromTitle,
  matchMemberRowToGroup,
  parseHeaderDateCell,
  parsePasteTextToRows,
  parseShiftCellTokens,
  parseShiftScheduleGrid,
} from './shiftSheetImport.js';

const SAMPLE_GROUP_MEMBERS = [
  { id: 'mem-1', name: 'Trung Bảo' },
  { id: 'mem-2', name: 'Hiếu' },
  { id: 'mem-3', name: 'Huy Bảo' },
  { id: 'mem-4', name: 'Uyên' },
  { id: 'mem-5', name: 'Hoài' },
  { id: 'mem-6', name: 'Chi Hon' },
  { id: 'mem-7', name: 'Long' },
];

test('extractSpreadsheetIdAndGid parses Google Sheets URL and gid cleanly', () => {
  const url =
    'https://docs.google.com/spreadsheets/d/1vT9k7vftxrz-oFHogJ7jq73VhW92-EauCBAUGUmFtMg/edit?gid=1065971046#gid=1065971046';
  const parsed = extractSpreadsheetIdAndGid(url);
  assert.equal(parsed.spreadsheetId, '1vT9k7vftxrz-oFHogJ7jq73VhW92-EauCBAUGUmFtMg');
  assert.equal(parsed.gid, 1065971046);
});

test('inferYearMonthFromTitle detects Vietnamese and standard month sheet titles', () => {
  assert.deepEqual(inferYearMonthFromTitle('Tháng 11/2026'), { year: 2026, month: 11 });
  assert.deepEqual(inferYearMonthFromTitle('Tháng 12/2026'), { year: 2026, month: 12 });
  assert.deepEqual(inferYearMonthFromTitle('T1-2027'), { year: 2027, month: 1 });
});

test('parseHeaderDateCell handles 1-Nov, DD/MM, ISO, and day integers', () => {
  assert.equal(parseHeaderDateCell('1-Nov', 2026, 11), '2026-11-01');
  assert.equal(parseHeaderDateCell('8-Nov', 2026, 11), '2026-11-08');
  assert.equal(parseHeaderDateCell('01/12/2026', 2026, 11), '2026-12-01');
  assert.equal(parseHeaderDateCell('2026-11-15', 2026, 11), '2026-11-15');
  assert.equal(parseHeaderDateCell(20, 2026, 11), '2026-11-20');
});

test('parseShiftCellTokens normalizes Google Sheets chip strings regardless of order', () => {
  assert.deepEqual(parseShiftCellTokens('Ca1, Ca2').shifts, ['ca1', 'ca2']);
  assert.deepEqual(parseShiftCellTokens('Ca3, Ca2').shifts, ['ca2', 'ca3']);
  assert.deepEqual(parseShiftCellTokens('Ca2, Ca3, Ca1').shifts, ['ca1', 'ca2', 'ca3']);
  assert.deepEqual(parseShiftCellTokens('Ca1 Ca2 Ca3').shifts, ['ca1', 'ca2', 'ca3']);
  assert.deepEqual(parseShiftCellTokens('Ca3').shifts, ['ca3']);
  assert.deepEqual(parseShiftCellTokens('').shifts, []);
  assert.deepEqual(parseShiftCellTokens('Nghỉ').shifts, []);
  assert.deepEqual(parseShiftCellTokens('Full').shifts, ['ca1', 'ca2', 'ca3']);
});

test('matchMemberRowToGroup accurately distinguishes Trung Bảo vs Huy Bảo and skips other groups', () => {
  assert.equal(
    matchMemberRowToGroup('Nguyễn Ngọc Trung Bảo', '84', SAMPLE_GROUP_MEMBERS).memberId,
    'mem-1'
  );
  assert.equal(
    matchMemberRowToGroup('Nguyễn Ngọc Huy Bảo', '83', SAMPLE_GROUP_MEMBERS).memberId,
    'mem-3'
  );
  assert.equal(
    matchMemberRowToGroup('Dương Thị Uyên', '66', SAMPLE_GROUP_MEMBERS).memberId,
    'mem-4'
  );
  assert.equal(
    matchMemberRowToGroup('Mai Hiếu', '73', SAMPLE_GROUP_MEMBERS).memberId,
    'mem-2'
  );
  assert.equal(
    matchMemberRowToGroup('Phan Văn Tấn', '7', SAMPLE_GROUP_MEMBERS).memberId,
    null
  );
});

test('parseShiftScheduleGrid parses Google Sheets monthly layout matching user spreadsheet', () => {
  const rows = [
    ['', '', '', '', 'Ngày', '1-Nov', '2-Nov', '3-Nov', '4-Nov'],
    ['STT', 'ID', 'Họ và Tên', '', '', 'CN', 'T2', 'T3', 'T4'],
    ['1', '7', 'Phan Văn Tấn', 'Remote', 'Loan-Submit', 'Ca3', 'Ca3', 'Ca3', 'Ca3'],
    ['6', '66', 'Dương Thị Uyên', 'Onsite', 'Loan-Submit', 'Ca1 Ca2 Ca3', 'Ca1 Ca2', 'Ca1 Ca2 Ca3', 'Ca1 Ca2'],
    ['9', '73', 'Mai Hiếu', 'Onsite', 'Loan-Submit', 'Ca2 Ca3', 'Ca2', 'Ca2 Ca3', ''],
    ['10', '83', 'Nguyễn Ngọc Huy Bảo', 'Onsite', 'Loan-Submit', 'Ca2 Ca3', 'Ca1 Ca2', 'Ca2 Ca3', 'Ca1 Ca2 Ca3'],
    ['11', '84', 'Nguyễn Ngọc Trung Bảo', 'Onsite', 'Loan-Submit', 'Ca2 Ca3', 'Ca1 Ca2', 'Ca2 Ca3', 'Ca1 Ca2 Ca3'],
    ['17', '124', 'Dương Nhật Long', 'Onsite', 'Loan-Submit', 'Ca1 Ca2', '', 'Ca1 Ca2', 'Ca1 Ca2'],
    ['18', '126', 'Võ Thị Thanh Hoài', 'Onsite', 'Loan-Submit', 'Ca1 Ca2 Ca3', 'Ca1 Ca2', 'Ca2 Ca3', 'Ca1 Ca2'],
  ];

  const parsed = parseShiftScheduleGrid(rows, {
    groupMembers: SAMPLE_GROUP_MEMBERS,
    sheetTitle: 'Tháng 11/2026',
  });

  assert.equal(parsed.ok, true);
  assert.equal(parsed.dates.length, 4);
  assert.equal(parsed.minDate, '2026-11-01');
  assert.equal(parsed.maxDate, '2026-11-04');
  assert.equal(parsed.matchedRows.length, 6);
  assert.equal(parsed.ignoredOtherRows.length, 1); // Phan Văn Tấn
  assert.deepEqual(parsed.unmatchedGroupMembers.map((m) => m.name), ['Chi Hon']);
  assert.deepEqual(parsed.memberDateShiftsMap['mem-2']['2026-11-04'], []); // Mai Hiếu off on 4-Nov
  assert.deepEqual(parsed.memberDateShiftsMap['mem-1']['2026-11-02'], ['ca1', 'ca2']);
});

test('parsePasteTextToRows splits TSV copied from Google Sheets', () => {
  const tsv = 'STT\tID\tHọ và Tên\t1-Dec\t2-Dec\n1\t84\tNguyễn Ngọc Trung Bảo\tCa2, Ca3\tCa1, Ca2';
  const rows = parsePasteTextToRows(tsv);
  assert.equal(rows.length, 2);
  assert.equal(rows[1][2], 'Nguyễn Ngọc Trung Bảo');
  assert.equal(rows[1][3], 'Ca2, Ca3');
});
