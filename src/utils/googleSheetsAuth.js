import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup } from 'firebase/auth';
import { auth } from '../firebase.js';

export const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

const sheetsProvider = new GoogleAuthProvider();
for (const scope of SCOPES) {
  sheetsProvider.addScope(scope);
}
sheetsProvider.setCustomParameters({
  prompt: 'select_account',
});

// Access token kept strictly in memory (never localStorage / sessionStorage)
let isSigningIn = false;
let cachedAccessToken = null;

export function initGoogleSheetsAuth(onAuthSuccess, onAuthFailure) {
  return onAuthStateChanged(auth, (user) => {
    if (user && cachedAccessToken) {
      if (onAuthSuccess) onAuthSuccess(user, cachedAccessToken);
    } else {
      if (!user || !isSigningIn) {
        cachedAccessToken = null;
      }
      if (onAuthFailure) onAuthFailure(user || null);
    }
  });
}

export async function signInWithGoogleSheets() {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, sheetsProvider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Không lấy được quyền truy cập Google Sheets từ cửa sổ đăng nhập.');
    }
    cachedAccessToken = credential.accessToken;
    return {
      user: result.user,
      accessToken: cachedAccessToken,
    };
  } finally {
    isSigningIn = false;
  }
}

export async function signOutGoogleSheets() {
  cachedAccessToken = null;
  try {
    await auth.signOut();
  } catch {
    // ignore signOut errors
  }
}

export function getGoogleSheetsAccessToken() {
  return cachedAccessToken;
}

export function clearGoogleSheetsAccessToken() {
  cachedAccessToken = null;
}

function mapSheetsApiError(status, message) {
  if (status === 401) {
    cachedAccessToken = null;
    return 'Phiên đăng nhập Google đã hết hạn. Vui lòng bấm Đăng nhập Google lại.';
  }
  if (status === 403) {
    return 'Tài khoản Google này chưa có quyền xem file Sheet này (hoặc tổ chức chặn ứng dụng ngoài). Bạn có thể đổi tài khoản hoặc dùng tab Tải Excel / Dán bảng.';
  }
  if (status === 404) {
    return 'Không tìm thấy Google Sheet theo đường dẫn đã nhập. Hãy kiểm tra lại link Sheet.';
  }
  return message || `Lỗi kết nối Google Sheets (HTTP ${status}).`;
}

export async function fetchSpreadsheetMetadata(spreadsheetId, accessToken) {
  const token = accessToken || cachedAccessToken;
  if (!token) {
    throw new Error('AUTH_REQUIRED');
  }
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
    spreadsheetId
  )}?fields=properties.title,sheets.properties(sheetId,title,index)`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(mapSheetsApiError(res.status, data?.error?.message));
  }

  return {
    spreadsheetTitle: data?.properties?.title || 'Google Sheets',
    sheets: Array.isArray(data?.sheets)
      ? data.sheets
          .map((s) => ({
            sheetId: Number(s?.properties?.sheetId),
            title: String(s?.properties?.title || ''),
            index: Number(s?.properties?.index ?? 0),
          }))
          .filter((s) => s.title)
          .sort((a, b) => a.index - b.index)
      : [],
  };
}

export async function fetchSpreadsheetSheetValues(spreadsheetId, sheetTitle, accessToken) {
  const token = accessToken || cachedAccessToken;
  if (!token) {
    throw new Error('AUTH_REQUIRED');
  }
  const safeSheet = `'${String(sheetTitle || '').replace(/'/g, "''")}'!A1:BZ200`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
    spreadsheetId
  )}/values/${encodeURIComponent(safeSheet)}?valueRenderOption=FORMATTED_VALUE`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(mapSheetsApiError(res.status, data?.error?.message));
  }

  return Array.isArray(data?.values) ? data.values : [];
}
