// --- js/utils.js ---
// 공통 유틸리티 (서버/클라 양쪽에서 쓰던 함수들을 정리해 통합)

export function str(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return formatDateTime(value);
  return String(value).trim();
}

export function normalizeArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(str).filter(Boolean);
  return String(value).split(/[|,]/).map(str).filter(Boolean);
}

// 한글·영문·숫자만 허용, 공백 제거, 최대 20자
export function sanitizeStudentName(value) {
  return str(value)
    .replace(/\s+/g, '')
    .replace(/[^가-힣a-zA-Z0-9]/g, '')
    .slice(0, 20);
}

export function makeStudentId(classId, studentName) {
  return str(classId) + '-' + sanitizeStudentName(studentName);
}

export function formatDateTime(value) {
  if (!value) return '';
  const d = (value instanceof Date) ? value : new Date(value);
  if (isNaN(d.getTime())) return String(value);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function escapeAttr(v) {
  return escapeHtml(v);
}

export function sourceLabel(source) {
  const map = { bank: '추천 질문', direct: '직접 입력', previous: '지난 질문 이어가기', deep: '단원 포트폴리오', 미기록: '미기록' };
  return map[source] || source || '';
}

export function incCount(obj, key) {
  key = key || '미입력';
  obj[key] = (obj[key] || 0) + 1;
}

export function countsToArray(obj) {
  return Object.keys(obj)
    .map(key => ({ label: key, count: obj[key] }))
    .sort((a, b) => b.count - a.count);
}

// Firebase 인증 에러 코드 → 사람이 읽을 수 있는 한국어 안내
const AUTH_ERROR_MESSAGES = {
  'auth/popup-blocked': '브라우저가 로그인 팝업을 차단했습니다. 팝업 차단을 해제하거나 다시 시도해 주세요. (자동으로 리다이렉트 방식으로 전환됩니다.)',
  'auth/popup-closed-by-user': '로그인 창이 완료 전에 닫혔습니다. 다시 시도해 주세요.',
  'auth/cancelled-popup-request': '이전 로그인 요청이 취소되었습니다. 다시 시도해 주세요.',
  'auth/unauthorized-domain': '이 도메인은 Firebase 인증에 허용되지 않았습니다. Firebase 콘솔 → Authentication → 설정 → 승인된 도메인에 현재 주소를 추가하세요.',
  'auth/operation-not-allowed': 'Google 로그인이 비활성화되어 있습니다. Firebase 콘솔 → Authentication → 로그인 방법에서 Google 을 사용 설정하세요.',
  'auth/network-request-failed': '네트워크 오류로 로그인하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.',
  'auth/internal-error': '로그인 처리 중 내부 오류가 발생했습니다. 다시 시도해 주세요.'
};

export function getErrorMessage(err) {
  if (!err) return '오류 발생';
  if (err.code && AUTH_ERROR_MESSAGES[err.code]) {
    return AUTH_ERROR_MESSAGES[err.code];
  }
  if (err.code) return `${err.message || '오류'} (${err.code})`;
  if (err.message) return err.message;
  return String(err);
}

export function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name) || '';
}
