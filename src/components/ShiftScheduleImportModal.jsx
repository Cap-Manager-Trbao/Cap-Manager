import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Input, Modal, Radio, Select, Tag } from 'antd';
import {
  CheckCircle2,
  ClipboardPaste,
  FileSpreadsheet,
  Link2,
  LogOut,
  RefreshCw,
  Upload,
  Users,
} from 'lucide-react';
import { SHIFTS } from '../data/defaultData.js';
import {
  getTodayDateString,
  loadFromStorage,
  saveToStorage,
} from '../utils/storage.js';
import {
  extractSpreadsheetIdAndGid,
  inferYearMonthFromTitle,
  normalizeVietnameseText,
  parsePasteTextToRows,
  parseShiftScheduleGrid,
} from '../utils/shiftSheetImport.js';
import {
  fetchSpreadsheetMetadata,
  fetchSpreadsheetSheetValues,
  getGoogleSheetsAccessToken,
  initGoogleSheetsAuth,
  signInWithGoogleSheets,
  signOutGoogleSheets,
} from '../utils/googleSheetsAuth.js';

function GoogleSignInButton({ onClick, loading, label = 'Sign in with Google' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className="inline-flex items-center gap-2.5 h-10 px-4 rounded-md bg-white border border-slate-300 text-slate-800 text-sm font-medium shadow-xs hover:bg-slate-50 hover:border-slate-400 active:bg-slate-100 disabled:opacity-60 cursor-pointer transition-colors"
    >
      <svg className="w-4.5 h-4.5 shrink-0" viewBox="0 0 48 48" aria-hidden="true">
        <path
          fill="#EA4335"
          d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
        />
        <path
          fill="#4285F4"
          d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
        />
        <path
          fill="#FBBC05"
          d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
        />
        <path
          fill="#34A853"
          d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
        />
      </svg>
      <span>{loading ? 'Đang kết nối...' : label}</span>
    </button>
  );
}

function formatCompactShiftsLabel(shifts) {
  if (!Array.isArray(shifts) || shifts.length === 0) return 'Nghỉ';
  return shifts
    .map((id) => {
      if (id === 'ca1') return '1';
      if (id === 'ca2') return '2';
      if (id === 'ca3') return '3';
      return SHIFTS.find((s) => s.id === id)?.label || id;
    })
    .join(',');
}

export default function ShiftScheduleImportModal({
  open,
  onClose,
  activeGroup,
  members,
  onBatchImportShiftSchedule,
  onImportedJumpToDate,
  onNotify,
}) {
  const groupId = activeGroup?.id || 'default';
  const urlStorageKey = `cap_manager_shift_sheet_url_${groupId}`;
  const mapStorageKey = `cap_manager_shift_sheet_map_${groupId}`;
  const todayStr = getTodayDateString();
  const [todayYear, todayMonth] = todayStr.split('-').map(Number);

  const [sourceTab, setSourceTab] = useState('google'); // 'google' | 'excel' | 'paste'
  const [googleUser, setGoogleUser] = useState(null);
  const [hasGoogleToken, setHasGoogleToken] = useState(() => Boolean(getGoogleSheetsAccessToken()));
  const [signingInGoogle, setSigningInGoogle] = useState(false);

  const [sheetUrlInput, setSheetUrlInput] = useState(() => loadFromStorage(urlStorageKey, ''));
  const [savedMappings, setSavedMappings] = useState(() => loadFromStorage(mapStorageKey, {}));

  const [loadingSheets, setLoadingSheets] = useState(false);
  const [loadingSheetRows, setLoadingSheetRows] = useState(false);
  const [sheetError, setSheetError] = useState('');

  // Loaded spreadsheet metadata + tabs (shared structure for Google Sheets & Excel)
  const [spreadsheetTitle, setSpreadsheetTitle] = useState('');
  const [googleSpreadsheetId, setGoogleSpreadsheetId] = useState('');
  const [sheetTabs, setSheetTabs] = useState([]); // [{ key, title, sheetId? }]
  const [selectedTabKey, setSelectedTabKey] = useState('');
  const [excelWorkbook, setExcelWorkbook] = useState(null);
  const [excelFileName, setExcelFileName] = useState('');
  const xlsxRef = useRef(null);

  const [pasteText, setPasteText] = useState('');
  const [pasteYearMonth, setPasteYearMonth] = useState(
    () => `${todayYear}-${String(todayMonth).padStart(2, '0')}`
  );

  // Active grid rows + title before parsing
  const [rawGridRows, setRawGridRows] = useState([]);
  const [activeSheetTitle, setActiveSheetTitle] = useState('');
  const [applyScope, setApplyScope] = useState('future'); // 'future' | 'all'
  const [savingImport, setSavingImport] = useState(false);
  const [importedTabsMap, setImportedTabsMap] = useState({});
  const [onlyMonthTabs, setOnlyMonthTabs] = useState(false);

  useEffect(() => {
    setSheetUrlInput(loadFromStorage(urlStorageKey, ''));
    setSavedMappings(loadFromStorage(mapStorageKey, {}));
    setRawGridRows([]);
    setSheetTabs([]);
    setSelectedTabKey('');
    setSheetError('');
    setImportedTabsMap({});
  }, [groupId, urlStorageKey, mapStorageKey]);

  useEffect(() => {
    const unsub = initGoogleSheetsAuth(
      (user) => {
        setGoogleUser(user);
        setHasGoogleToken(true);
      },
      (user) => {
        setGoogleUser(user);
        setHasGoogleToken(Boolean(getGoogleSheetsAccessToken()));
      }
    );
    return () => {
      if (typeof unsub === 'function') unsub();
    };
  }, []);

  const fallbackYm = useMemo(() => {
    if (sourceTab === 'paste' && /^\d{4}-\d{2}$/.test(pasteYearMonth)) {
      const [y, m] = pasteYearMonth.split('-').map(Number);
      return { year: y, month: m };
    }
    return inferYearMonthFromTitle(activeSheetTitle, todayYear, todayMonth);
  }, [sourceTab, pasteYearMonth, activeSheetTitle, todayYear, todayMonth]);

  const parsedResult = useMemo(() => {
    if (!Array.isArray(rawGridRows) || rawGridRows.length === 0) return null;
    return parseShiftScheduleGrid(rawGridRows, {
      groupMembers: members,
      sheetTitle: activeSheetTitle,
      fallbackYear: fallbackYm.year,
      fallbackMonth: fallbackYm.month,
      savedMappings,
    });
  }, [rawGridRows, members, activeSheetTitle, fallbackYm, savedMappings]);

  // Adjust default apply scope whenever a new month range is parsed
  useEffect(() => {
    if (!parsedResult?.ok || parsedResult.dates.length === 0) return;
    const hasPast = parsedResult.dates.some((d) => d < todayStr);
    const hasFutureOrToday = parsedResult.dates.some((d) => d >= todayStr);
    setApplyScope(hasPast && hasFutureOrToday ? 'future' : 'all');
  }, [parsedResult?.minDate, parsedResult?.maxDate, todayStr]);

  const handleGoogleSignIn = async () => {
    setSigningInGoogle(true);
    setSheetError('');
    try {
      const res = await signInWithGoogleSheets();
      setGoogleUser(res.user);
      setHasGoogleToken(Boolean(res.accessToken));
      onNotify?.('success', `Đã kết nối Google (${res.user?.email || 'tài khoản Google'}).`);
      if (sheetUrlInput.trim()) {
        await handleLoadGoogleSpreadsheet(res.accessToken, sheetUrlInput);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Đăng nhập Google thất bại.';
      if (!msg.includes('popup-closed-by-user')) {
        setSheetError(msg);
      }
    } finally {
      setSigningInGoogle(false);
    }
  };

  const handleGoogleSignOut = async () => {
    await signOutGoogleSheets();
    setGoogleUser(null);
    setHasGoogleToken(false);
    setSheetTabs([]);
    setRawGridRows([]);
    setSelectedTabKey('');
  };

  const handleSelectGoogleTab = async (tabKey, tabsList = sheetTabs, spId = googleSpreadsheetId, tok = null) => {
    const target = tabsList.find((t) => t.key === tabKey);
    if (!target || !spId) return;
    setSelectedTabKey(tabKey);
    setActiveSheetTitle(target.title);
    setLoadingSheetRows(true);
    setSheetError('');
    try {
      const values = await fetchSpreadsheetSheetValues(spId, target.title, tok);
      setRawGridRows(values);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Không đọc được dữ liệu tab này.';
      if (msg === 'AUTH_REQUIRED') {
        setHasGoogleToken(false);
        setSheetError('Vui lòng bấm "Sign in with Google" để kết nối lại.');
      } else {
        setSheetError(msg);
      }
    } finally {
      setLoadingSheetRows(false);
    }
  };

  const handleLoadGoogleSpreadsheet = async (overrideToken = null, overrideUrl = null) => {
    const rawInput = String(overrideUrl ?? sheetUrlInput).trim();
    const { spreadsheetId, gid } = extractSpreadsheetIdAndGid(rawInput);
    if (!spreadsheetId) {
      setSheetError('Link hoặc ID Google Sheets chưa hợp lệ. Hãy dán nguyên đường dẫn từ trình duyệt.');
      return;
    }

    const token = overrideToken || getGoogleSheetsAccessToken();
    if (!token) {
      setHasGoogleToken(false);
      setSheetError('Hãy bấm "Sign in with Google" trước để đọc file Google Sheets riêng tư của bạn.');
      return;
    }

    saveToStorage(urlStorageKey, rawInput);
    setLoadingSheets(true);
    setSheetError('');
    setRawGridRows([]);
    try {
      const meta = await fetchSpreadsheetMetadata(spreadsheetId, token);
      const tabs = meta.sheets.map((s) => ({
        key: `gs-${s.sheetId}-${s.title}`,
        sheetId: s.sheetId,
        title: s.title,
      }));
      setSpreadsheetTitle(meta.spreadsheetTitle);
      setGoogleSpreadsheetId(spreadsheetId);
      setSheetTabs(tabs);

      if (tabs.length === 0) {
        setSheetError('File Google Sheets này chưa có tab nào.');
        return;
      }

      const byGid = gid !== null ? tabs.find((t) => t.sheetId === gid) : null;
      const byMonth = tabs.find((t) => /th[aá]ng|20\d{2}/i.test(t.title));
      const initialTab = byGid || byMonth || tabs[0];
      await handleSelectGoogleTab(initialTab.key, tabs, spreadsheetId, token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Không tải được Google Sheets.';
      if (msg === 'AUTH_REQUIRED') {
        setHasGoogleToken(false);
        setSheetError('Phiên kết nối Google chưa sẵn sàng. Hãy bấm "Sign in with Google".');
      } else {
        setSheetError(msg);
      }
    } finally {
      setLoadingSheets(false);
    }
  };

  const handleExcelFileChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setSheetError('');
    try {
      const XLSX = xlsxRef.current || (await import('xlsx-js-style')).default;
      xlsxRef.current = XLSX;
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: 'array' });
      const tabs = (wb.SheetNames || []).map((name, idx) => ({
        key: `xls-${idx}-${name}`,
        title: name,
      }));
      if (tabs.length === 0) {
        setSheetError('File Excel không có sheet nào.');
        return;
      }
      setExcelWorkbook(wb);
      setExcelFileName(file.name);
      setSpreadsheetTitle(file.name);
      setSheetTabs(tabs);

      const initial = tabs.find((t) => /th[aá]ng|20\d{2}/i.test(t.title)) || tabs[0];
      handleSelectExcelTab(initial.key, tabs, wb, XLSX);
    } catch {
      setSheetError('Không đọc được file Excel này. Hãy thử lưu dạng .xlsx hoặc .csv.');
    }
  };

  const handleSelectExcelTab = async (
    tabKey,
    tabsList = sheetTabs,
    wb = excelWorkbook,
    xlsxLib = xlsxRef.current
  ) => {
    const target = tabsList.find((t) => t.key === tabKey);
    if (!target || !wb) return;
    const XLSX = xlsxLib || (await import('xlsx-js-style')).default;
    xlsxRef.current = XLSX;
    setSelectedTabKey(tabKey);
    setActiveSheetTitle(target.title);
    const ws = wb.Sheets[target.title];
    if (!ws) return;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
    setRawGridRows(rows);
  };

  const handleParsePaste = () => {
    setSheetError('');
    const rows = parsePasteTextToRows(pasteText);
    if (rows.length === 0) {
      setSheetError('Hãy dán bảng dữ liệu từ Google Sheets hoặc Excel vào ô bên trên.');
      return;
    }
    setActiveSheetTitle(`Tháng ${pasteYearMonth.split('-')[1]}/${pasteYearMonth.split('-')[0]}`);
    setRawGridRows(rows);
  };

  const handleBindMemberMapping = (memberId, rowIndexStr) => {
    if (!parsedResult || !rowIndexStr) return;
    const rowObj = parsedResult.ignoredOtherRows.find(
      (r) => String(r.rowIndex) === String(rowIndexStr)
    );
    if (!rowObj) return;
    const normName = normalizeVietnameseText(rowObj.sheetName);
    const nextMappings = {
      ...savedMappings,
      [`name:${normName}`]: memberId,
    };
    if (rowObj.sheetExternalId) {
      nextMappings[`id:${rowObj.sheetExternalId}`] = memberId;
    }
    setSavedMappings(nextMappings);
    saveToStorage(mapStorageKey, nextMappings);
  };

  const datesToApply = useMemo(() => {
    if (!parsedResult?.ok) return [];
    if (applyScope === 'future') {
      return parsedResult.dates.filter((d) => d >= todayStr);
    }
    return parsedResult.dates;
  }, [parsedResult, applyScope, todayStr]);

  const handleApplyMonthImport = async () => {
    if (!parsedResult?.ok || parsedResult.matchedRows.length === 0) return;
    if (datesToApply.length === 0) {
      onNotify?.(
        'warning',
        'Không có ngày nào từ hôm nay trở đi trong tab tháng này. Hãy chọn "Cả tháng trong tab" nếu muốn lưu ngày cũ.'
      );
      return;
    }

    const allowedSet = new Set(datesToApply);
    const filteredMemberMap = {};
    for (const row of parsedResult.matchedRows) {
      const dateMap = {};
      for (const [d, sh] of Object.entries(row.shiftsByDate)) {
        if (allowedSet.has(d)) {
          dateMap[d] = sh;
        }
      }
      if (Object.keys(dateMap).length > 0) {
        filteredMemberMap[row.memberId] = dateMap;
      }
    }

    setSavingImport(true);
    try {
      const ok = await onBatchImportShiftSchedule(filteredMemberMap);
      if (ok) {
        const tabMarkKey = selectedTabKey || activeSheetTitle || `${parsedResult.inferredYear}-${parsedResult.inferredMonth}`;
        setImportedTabsMap((prev) => ({ ...prev, [tabMarkKey]: true }));
        const jumpTarget =
          datesToApply.includes(todayStr) ? todayStr : datesToApply[0];
        onImportedJumpToDate?.(jumpTarget);
        onNotify?.(
          'success',
          `Đã đồng bộ lịch ${String(parsedResult.inferredMonth).padStart(2, '0')}/${parsedResult.inferredYear} (${datesToApply.length} ngày) cho ${parsedResult.matchedRows.length} thành viên.`
        );
      }
    } finally {
      setSavingImport(false);
    }
  };

  const previewDates = parsedResult?.ok ? parsedResult.dates : [];

  const visibleSheetTabs = useMemo(() => {
    if (!onlyMonthTabs) return sheetTabs;
    const filtered = sheetTabs.filter((t) =>
      /(?:th[aá]ng|l[iị]ch\s*l[aà]m|\bt\s*\d{1,2}\b|20\d{2})/i.test(t.title)
    );
    return filtered.length > 0 ? filtered : sheetTabs;
  }, [sheetTabs, onlyMonthTabs]);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={980}
      title={
        <div className="flex items-center gap-2">
          <FileSpreadsheet className="w-5 h-5 text-[#2563EB]" aria-hidden="true" />
          <span>Nhập lịch ca từng tháng – {activeGroup?.name}</span>
        </div>
      }
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <span className="text-xs text-slate-500 text-left">
            Mẹo: Bạn có thể chọn lần lượt từng tab tháng (vd: Tháng 11/2026, Tháng 12/2026...) và bấm Lưu để cộng dồn vào lịch nhóm.
          </span>
          <div className="flex items-center gap-2">
            <Button onClick={onClose}>Đóng</Button>
            <Button
              type="primary"
              loading={savingImport}
              disabled={!parsedResult?.ok || parsedResult.matchedRows.length === 0 || datesToApply.length === 0}
              onClick={handleApplyMonthImport}
            >
              {parsedResult?.ok
                ? `Lưu lịch tháng ${String(parsedResult.inferredMonth).padStart(2, '0')}/${parsedResult.inferredYear} (${datesToApply.length} ngày)`
                : 'Lưu lịch tháng'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4 mt-2">
        {/* Source Selector */}
        <div className="flex flex-wrap items-center gap-2 p-1 bg-slate-100 rounded-lg border border-slate-200 w-fit">
          <button
            type="button"
            onClick={() => {
              setSourceTab('google');
              setSheetError('');
            }}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs sm:text-sm font-semibold cursor-pointer transition-colors ${
              sourceTab === 'google'
                ? 'bg-[#2563EB] text-white shadow-xs'
                : 'text-slate-700 hover:bg-white/80'
            }`}
          >
            <Link2 className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Google Sheets (Đăng nhập)</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setSourceTab('excel');
              setSheetError('');
              setSheetTabs(
                excelWorkbook
                  ? (excelWorkbook.SheetNames || []).map((name, idx) => ({
                      key: `xls-${idx}-${name}`,
                      title: name,
                    }))
                  : []
              );
            }}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs sm:text-sm font-semibold cursor-pointer transition-colors ${
              sourceTab === 'excel'
                ? 'bg-[#2563EB] text-white shadow-xs'
                : 'text-slate-700 hover:bg-white/80'
            }`}
          >
            <Upload className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Tải file Excel (.xlsx / .csv)</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setSourceTab('paste');
              setSheetError('');
            }}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs sm:text-sm font-semibold cursor-pointer transition-colors ${
              sourceTab === 'paste'
                ? 'bg-[#2563EB] text-white shadow-xs'
                : 'text-slate-700 hover:bg-white/80'
            }`}
          >
            <ClipboardPaste className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Dán bảng (Copy – Paste)</span>
          </button>
        </div>

        {/* Tab 1: Google Sheets */}
        {sourceTab === 'google' && (
          <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              {hasGoogleToken && googleUser ? (
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-700">
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-emerald-50 border border-emerald-200 text-emerald-800 font-medium">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" aria-hidden="true" />
                    Đã kết nối Google: {googleUser.email || googleUser.displayName}
                  </span>
                  <Button size="small" onClick={handleGoogleSignIn} loading={signingInGoogle}>
                    Đổi tài khoản
                  </Button>
                  <Button
                    size="small"
                    icon={<LogOut className="w-3.5 h-3.5" />}
                    onClick={handleGoogleSignOut}
                  >
                    Đăng xuất
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <GoogleSignInButton onClick={handleGoogleSignIn} loading={signingInGoogle} />
                  <span className="text-xs text-slate-500">
                    Đăng nhập bằng đúng tài khoản Google có quyền xem file Google Sheets của nhóm.
                  </span>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={sheetUrlInput}
                onChange={(e) => setSheetUrlInput(e.target.value)}
                placeholder="Dán link Google Sheets (vd: https://docs.google.com/spreadsheets/d/.../edit?gid=...)"
                className="flex-1 min-w-[260px]"
              />
              <Button
                type="primary"
                icon={<RefreshCw className="w-3.5 h-3.5" />}
                loading={loadingSheets}
                disabled={!sheetUrlInput.trim()}
                onClick={() => handleLoadGoogleSpreadsheet()}
              >
                Tải các tab tháng
              </Button>
            </div>
          </div>
        )}

        {/* Tab 2: Excel Upload */}
        {sourceTab === 'excel' && (
          <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-slate-600">
              Từ Google Sheets chọn <strong>Tệp → Tải xuống → Microsoft Excel (.xlsx)</strong> rồi chọn file tại đây để nạp lần lượt từng tab tháng.
              {excelFileName && (
                <span className="ml-2 font-semibold text-slate-900">Đang mở: {excelFileName}</span>
              )}
            </div>
            <label className="inline-flex items-center gap-2 px-3.5 py-2 rounded-md bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-xs sm:text-sm font-semibold cursor-pointer transition-colors">
              <Upload className="w-4 h-4" aria-hidden="true" />
              <span>Chọn file .xlsx / .csv</span>
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleExcelFileChange}
                className="hidden"
              />
            </label>
          </div>
        )}

        {/* Tab 3: Copy-Paste */}
        {sourceTab === 'paste' && (
          <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 flex flex-col gap-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-slate-600">
                Bôi đen bảng từ Google Sheets (bao gồm hàng ngày <code className="font-mono">1-Nov, 2-Nov...</code> và cột tên) rồi dán vào đây:
              </span>
              <div className="flex items-center gap-2">
                <label htmlFor="paste-month-input" className="text-xs font-medium text-slate-700">
                  Tháng áp dụng:
                </label>
                <Input
                  id="paste-month-input"
                  type="month"
                  size="small"
                  value={pasteYearMonth}
                  onChange={(e) => setPasteYearMonth(e.target.value)}
                  className="w-36 font-tabular"
                />
              </div>
            </div>
            <Input.TextArea
              rows={4}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder="Ctrl+V dữ liệu bảng phân ca từ Google Sheets vào đây..."
              className="font-mono text-xs"
            />
            <div className="flex justify-end">
              <Button type="primary" size="small" onClick={handleParsePaste} disabled={!pasteText.trim()}>
                Đọc dữ liệu đã dán
              </Button>
            </div>
          </div>
        )}

        {/* Month Tabs Selector (for Google Sheets & Excel multi-tab workbooks) */}
        {(sourceTab === 'google' || sourceTab === 'excel') && sheetTabs.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <div className="text-xs font-semibold text-slate-700 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="truncate">
                  Chọn tab tháng để xem &amp; lưu ({spreadsheetTitle}):
                </span>
                {sheetTabs.length > 8 && (
                  <button
                    type="button"
                    onClick={() => setOnlyMonthTabs((prev) => !prev)}
                    className={`px-2 py-0.5 rounded text-[11px] font-medium border cursor-pointer transition-colors shrink-0 ${
                      onlyMonthTabs
                        ? 'bg-blue-50 text-[#1D4ED8] border-blue-200'
                        : 'bg-white text-slate-600 border-slate-300 hover:border-slate-400'
                    }`}
                  >
                    {onlyMonthTabs
                      ? `Đang lọc tab tháng (${visibleSheetTabs.length}/${sheetTabs.length})`
                      : `Lọc nhanh tab tháng (${sheetTabs.length} tab)`}
                  </button>
                )}
              </div>
              {loadingSheetRows && (
                <span className="text-[#2563EB] font-normal shrink-0">Đang tải dữ liệu tab...</span>
              )}
            </div>
            <div className="max-h-28 overflow-y-auto p-2 rounded-lg bg-slate-50 border border-slate-200 flex flex-wrap gap-1.5 cap-table-scroll">
              {visibleSheetTabs.map((tab) => {
                const isSelected = selectedTabKey === tab.key;
                const isImported = Boolean(importedTabsMap[tab.key]);
                return (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() =>
                      sourceTab === 'google'
                        ? handleSelectGoogleTab(tab.key)
                        : handleSelectExcelTab(tab.key)
                    }
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold border transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-[#2563EB] text-white border-[#2563EB]'
                        : isImported
                        ? 'bg-emerald-50 text-emerald-800 border-emerald-300 hover:bg-emerald-100'
                        : 'bg-white text-slate-700 border-slate-300 hover:border-[#2563EB]'
                    }`}
                  >
                    <span>{tab.title}</span>
                    {isImported && <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {sheetError && <Alert type="error" showIcon title={sheetError} />}

        {parsedResult && !parsedResult.ok && (
          <Alert type="warning" showIcon title={parsedResult.error} />
        )}

        {/* Parsed Preview & Member Mapping */}
        {parsedResult?.ok && (
          <div className="flex flex-col gap-3 border-t border-slate-200 pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Tag color="blue" className="m-0 font-tabular font-semibold">
                  Tháng {String(parsedResult.inferredMonth).padStart(2, '0')}/{parsedResult.inferredYear} ({parsedResult.minDate} → {parsedResult.maxDate})
                </Tag>
                <Tag color="green" className="m-0 font-semibold">
                  Khớp {parsedResult.matchedRows.length}/{members.length} thành viên nhóm
                </Tag>
                {parsedResult.ignoredOtherRows.length > 0 && (
                  <span className="text-slate-500">
                    (Đã lọc bỏ {parsedResult.ignoredOtherRows.length} người ngoài nhóm)
                  </span>
                )}
              </div>

              <Radio.Group
                size="small"
                value={applyScope}
                onChange={(e) => setApplyScope(e.target.value)}
              >
                <Radio.Button value="future">Từ hôm nay trở đi</Radio.Button>
                <Radio.Button value="all">Cả tháng ({previewDates.length} ngày)</Radio.Button>
              </Radio.Group>
            </div>

            {/* Unmatched group member manual linker */}
            {parsedResult.unmatchedGroupMembers.length > 0 &&
              parsedResult.ignoredOtherRows.length > 0 && (
                <div className="p-3 rounded-lg bg-amber-50/70 border border-amber-200 flex flex-col gap-2">
                  <div className="text-xs font-semibold text-amber-900 flex items-center gap-1.5">
                    <Users className="w-3.5 h-3.5" aria-hidden="true" />
                    Có {parsedResult.unmatchedGroupMembers.length} thành viên trong nhóm chưa tự khớp tên với Sheet (chọn 1 lần, các tháng sau tự nhớ):
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {parsedResult.unmatchedGroupMembers.map((mem) => (
                      <div key={mem.id} className="flex items-center gap-2 text-xs">
                        <span className="font-semibold text-slate-800 w-28 truncate">{mem.name}:</span>
                        <Select
                          size="small"
                          showSearch
                          optionFilterProp="label"
                          placeholder="Chọn tên tương ứng trong Sheet..."
                          className="flex-1"
                          onChange={(rowIdx) => handleBindMemberMapping(mem.id, rowIdx)}
                          options={parsedResult.ignoredOtherRows.map((r) => ({
                            value: String(r.rowIndex),
                            label: r.sheetExternalId ? `${r.sheetName} (ID ${r.sheetExternalId})` : r.sheetName,
                          }))}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

            {/* Preview Matrix */}
            <div className="border border-slate-200 rounded-lg overflow-auto max-h-64 cap-table-scroll bg-white relative">
              <table className="w-full text-xs border-separate border-spacing-0">
                <thead>
                  <tr>
                    <th className="text-left px-3 py-2 border-b border-r border-slate-200 font-semibold text-slate-700 sticky left-0 top-0 z-30 bg-slate-50 min-w-[185px] w-[185px] shadow-[2px_0_4px_-2px_rgba(15,23,42,0.12)]">
                      Thành viên (Nhóm ↔ Sheet)
                    </th>
                    {previewDates.map((d) => {
                      const [, mo, day] = d.split('-');
                      const isIncluded = applyScope === 'all' || d >= todayStr;
                      return (
                        <th
                          key={d}
                          className={`px-2 py-2 border-b border-r border-slate-200 text-center font-tabular whitespace-nowrap sticky top-0 z-20 ${
                            isIncluded ? 'text-slate-800 bg-slate-50' : 'text-slate-400 bg-slate-100'
                          }`}
                        >
                          {day}/{mo}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {parsedResult.matchedRows.map((row) => (
                    <tr key={row.memberId} className="group">
                      <td className="px-3 py-1.5 border-b border-r border-slate-200 sticky left-0 z-10 bg-white group-hover:bg-slate-50 min-w-[185px] w-[185px] shadow-[2px_0_4px_-2px_rgba(15,23,42,0.12)]">
                        <div className="font-semibold text-slate-900 truncate max-w-[165px]">
                          {row.memberName}
                        </div>
                        <div className="text-[11px] text-slate-500 truncate max-w-[165px]">
                          {row.sheetName}
                        </div>
                      </td>
                      {previewDates.map((d) => {
                        const shifts = row.shiftsByDate[d] || [];
                        const isIncluded = applyScope === 'all' || d >= todayStr;
                        const label = formatCompactShiftsLabel(shifts);
                        const isOff = shifts.length === 0;
                        return (
                          <td
                            key={d}
                            className={`px-1.5 py-1.5 border-b border-r border-slate-100 text-center font-tabular whitespace-nowrap ${
                              !isIncluded ? 'bg-slate-50' : 'bg-white group-hover:bg-slate-50/70'
                            }`}
                          >
                            <span
                              className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-semibold ${
                                !isIncluded ? 'opacity-45' : ''
                              } ${
                                isOff
                                  ? 'text-slate-400 bg-slate-100'
                                  : 'text-[#1D4ED8] bg-blue-50 border border-blue-200'
                              }`}
                            >
                              {label}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  {parsedResult.matchedRows.length === 0 && (
                    <tr>
                      <td
                        colSpan={previewDates.length + 1}
                        className="px-4 py-6 text-center text-slate-500"
                      >
                        Chưa khớp được thành viên nào trong tab này với danh sách {activeGroup?.name}.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
