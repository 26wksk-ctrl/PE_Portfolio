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
  const map = { bank: '추천 질문', direct: '직접 입력', previous: '지난 질문 이어가기', 미기록: '미기록' };
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

export function getErrorMessage(err) {
  if (!err) return '오류 발생';
  if (err.message) return err.message;
  return String(err);
}

export function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name) || '';
}
