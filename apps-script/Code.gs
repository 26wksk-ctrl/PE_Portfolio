/**
 * 자기주도 체육탐구 포트폴리오 - 보안 강화 Google Sheets 내보내기 엔드포인트
 *
 * 구조
 *   - 브라우저는 rows를 보내지 않습니다. Firebase Auth ID Token + 필터만 보냅니다.
 *   - Apps Script가 ID Token을 검증해 교사 계정인지 확인합니다.
 *   - Apps Script 실행 계정 권한으로 Firestore를 직접 읽고, Google Sheet를 덮어씁니다.
 *
 * 배포 전 Script Properties에 아래 값을 넣으세요.
 *   PROJECT_ID                  예: pe-portfolio
 *   IDENTITY_TOOLKIT_API_KEY    서버 측 검증용 API key. API 제한은 Identity Toolkit API만 허용 권장
 *   TEACHER_EMAILS              예: visionaryshl@gmail.com,simsy0924@gmail.com
 *   SPREADSHEET_ID              선택. 비우면 이 스크립트가 연결된 스프레드시트를 사용
 *   RESPONSES_COLLECTION        선택. 기본값 simple_responses
 *   STUDENTS_COLLECTION         선택. 기본값 students
 *   SHEET_NAME                  선택. 기본값 responses
 */

const DEFAULT_RESPONSES_COLLECTION = 'simple_responses';
const DEFAULT_STUDENTS_COLLECTION = 'students';
const DEFAULT_SHEET_NAME = 'responses';
const MAX_EXPORT_ROWS = 10000;
const RATE_LIMIT_PER_MINUTE = 5;

function doPost(e) {
  const started = new Date();
  const lock = LockService.getScriptLock();

  try {
    const body = parseJsonBody(e);
    const teacher = verifyFirebaseTeacher_(String(body.idToken || ''));
    enforceRateLimit_(teacher.email);

    if (!lock.tryLock(30000)) {
      throw new Error('다른 내보내기가 진행 중입니다. 잠시 후 다시 시도해 주세요.');
    }

    const props = getProps_();
    const projectId = requireProp_(props, 'PROJECT_ID');
    const responsesCollection = props.RESPONSES_COLLECTION || DEFAULT_RESPONSES_COLLECTION;
    const studentsCollection = props.STUDENTS_COLLECTION || DEFAULT_STUDENTS_COLLECTION;
    const sheetName = props.SHEET_NAME || DEFAULT_SHEET_NAME;

    const filter = normalizeFilter_(body);
    const overrideMap = fetchOverrideNameMap_(projectId, studentsCollection);
    const rows = fetchCollection_(projectId, responsesCollection)
      .filter(row => matchesFilter_(row, filter))
      .sort((a, b) => toTime_(b.submitted_at) - toTime_(a.submitted_at));

    if (rows.length > MAX_EXPORT_ROWS) {
      throw new Error('내보낼 기록이 너무 많습니다. 기간/학급 필터를 좁혀 주세요.');
    }

    const table = buildExportTable_(rows, overrideMap);
    writeSheet_(sheetName, table);

    return json_({
      ok: true,
      count: rows.length,
      sheetName,
      exportedBy: teacher.email,
      generatedAt: new Date().toISOString(),
      elapsedMs: new Date().getTime() - started.getTime()
    });
  } catch (err) {
    console.error('[export] failed', err && err.stack ? err.stack : err);
    return json_({ ok: false, error: safeError_(err) });
  } finally {
    try { lock.releaseLock(); } catch (_e) {}
  }
}

function doGet() {
  return json_({ ok: true, message: 'PE Portfolio secure Sheets export endpoint is live.' });
}

function parseJsonBody(e) {
  if (!e || !e.postData || !e.postData.contents) throw new Error('요청 본문이 비어 있습니다.');
  try {
    return JSON.parse(e.postData.contents);
  } catch (_err) {
    throw new Error('JSON 형식이 올바르지 않습니다.');
  }
}

function verifyFirebaseTeacher_(idToken) {
  if (!idToken || idToken.length < 100) throw new Error('로그인 토큰이 없습니다. 다시 로그인해 주세요.');

  const props = getProps_();
  const apiKey = requireProp_(props, 'IDENTITY_TOOLKIT_API_KEY');
  const teacherEmails = splitCsv_(requireProp_(props, 'TEACHER_EMAILS')).map(s => s.toLowerCase());

  const res = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(apiKey), {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ idToken }),
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code < 200 || code >= 300) {
    console.warn('[auth] token lookup failed', code, text.slice(0, 300));
    throw new Error('로그인 검증에 실패했습니다. 다시 로그인해 주세요.');
  }

  const data = JSON.parse(text);
  const user = data.users && data.users[0];
  const email = String((user && user.email) || '').trim().toLowerCase();
  if (!email) throw new Error('이메일을 확인할 수 없습니다.');
  if (user.emailVerified === false) throw new Error('이메일 인증이 확인되지 않은 계정입니다.');
  if (teacherEmails.indexOf(email) === -1) throw new Error('교사 계정만 시트 내보내기를 실행할 수 있습니다.');
  return { email, localId: String(user.localId || '') };
}

function enforceRateLimit_(email) {
  const cache = CacheService.getScriptCache();
  const key = 'export-rate:' + String(email).toLowerCase().replace(/[^a-z0-9_.@-]/g, '_');
  const current = Number(cache.get(key) || '0');
  if (current >= RATE_LIMIT_PER_MINUTE) {
    throw new Error('내보내기 요청이 너무 잦습니다. 1분 뒤 다시 시도해 주세요.');
  }
  cache.put(key, String(current + 1), 60);
}

function normalizeFilter_(body) {
  const start = parseDateOrNull_(body.start);
  const end = parseDateOrNull_(body.end);
  if (start && end && start.getTime() >= end.getTime()) throw new Error('기간 설정이 올바르지 않습니다.');
  return {
    classId: cleanSmallString_(body.classId, 40),
    activityText: cleanSmallString_(body.activityText, 80),
    start,
    end
  };
}

function cleanSmallString_(value, maxLen) {
  const s = String(value || '').trim();
  if (s.length > maxLen) throw new Error('필터 값이 너무 깁니다.');
  return s;
}

function parseDateOrNull_(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) throw new Error('날짜 형식이 올바르지 않습니다.');
  return d;
}

function matchesFilter_(row, filter) {
  if (filter.classId && String(row.class_id || '') !== filter.classId) return false;
  if (filter.activityText && String(row.activity_today || '').indexOf(filter.activityText) === -1) return false;
  const submitted = parseDateOrNull_(row.submitted_at);
  if (filter.start && (!submitted || submitted.getTime() < filter.start.getTime())) return false;
  if (filter.end && (!submitted || submitted.getTime() >= filter.end.getTime())) return false;
  return true;
}

function fetchOverrideNameMap_(projectId, collectionId) {
  const docs = fetchCollection_(projectId, collectionId);
  const map = {};
  docs.forEach(row => {
    const id = String(row._id || '');
    const name = String(row.name || '').trim();
    if (id && name) map[id] = name;
  });
  return map;
}

function fetchCollection_(projectId, collectionId) {
  const encodedCollection = encodeURIComponent(collectionId).replace(/%2F/g, '/');
  let url = 'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(projectId) +
    '/databases/(default)/documents/' + encodedCollection + '?pageSize=300';
  const docs = [];
  const token = ScriptApp.getOAuthToken();

  while (url) {
    const res = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    const text = res.getContentText();
    if (code < 200 || code >= 300) {
      console.warn('[firestore] list failed', code, text.slice(0, 500));
      throw new Error('Firestore 읽기에 실패했습니다. Apps Script 실행 계정의 프로젝트 권한/IAM을 확인해 주세요.');
    }
    const data = JSON.parse(text || '{}');
    (data.documents || []).forEach(doc => docs.push(decodeDocument_(doc)));
    if (docs.length > MAX_EXPORT_ROWS + 1000) throw new Error('읽은 문서가 너무 많습니다. 데이터 정리가 필요합니다.');
    url = data.nextPageToken
      ? 'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(projectId) +
        '/databases/(default)/documents/' + encodedCollection + '?pageSize=300&pageToken=' + encodeURIComponent(data.nextPageToken)
      : '';
  }
  return docs;
}

function decodeDocument_(doc) {
  const fields = doc.fields || {};
  const out = {};
  Object.keys(fields).forEach(key => { out[key] = decodeValue_(fields[key]); });
  out._name = doc.name || '';
  out._id = out._name ? out._name.split('/').pop() : '';
  return out;
}

function decodeValue_(v) {
  if (!v) return '';
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return !!v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return '';
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue_);
  if ('mapValue' in v) {
    const obj = {};
    const fields = v.mapValue.fields || {};
    Object.keys(fields).forEach(key => { obj[key] = decodeValue_(fields[key]); });
    return obj;
  }
  return '';
}

function buildExportTable_(rows, overrideMap) {
  const header = [
    '제출시간', '학급', '이름', '차시', '활동', '질문출처',
    '탐구질문', '해본방법', '결과/과정피드백', '다음질문', '주도성', 'SEL역량'
  ];
  const seqMap = sequenceByStudent_(rows);
  const body = rows.map(row => [
    formatDateTime_(parseDateOrNull_(row.submitted_at)),
    safeSheetCell_(row.class_id),
    safeSheetCell_(overrideMap[String(row.student_id || '')] || row.student_name),
    seqMap[String(row._id || '')] ? seqMap[String(row._id || '')] + '번째 기록' : safeSheetCell_(row.record_no),
    safeSheetCell_(row.activity_today),
    safeSheetCell_(sourceLabel_(row.question_source)),
    safeSheetCell_(row.inquiry_question),
    safeSheetCell_(asArray_(row.method_labels).join(', ')),
    safeSheetCell_(row.evidence_result),
    safeSheetCell_(row.next_try),
    safeSheetCell_(row.agency_score),
    safeSheetCell_(asArray_(row.sel_competency_labels).join(', ') || row.sel_competency_label)
  ]);
  return [header].concat(body);
}

function sequenceByStudent_(rows) {
  const seq = {};
  const counter = {};
  rows.slice()
    .sort((a, b) => toTime_(a.submitted_at) - toTime_(b.submitted_at))
    .forEach(row => {
      const uid = String(row.student_id || '');
      const id = String(row._id || '');
      if (!uid || !id) return;
      counter[uid] = (counter[uid] || 0) + 1;
      seq[id] = counter[uid];
    });
  return seq;
}

function writeSheet_(sheetName, table) {
  const props = getProps_();
  const ss = props.SPREADSHEET_ID
    ? SpreadsheetApp.openById(props.SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('스프레드시트를 찾을 수 없습니다. SPREADSHEET_ID를 설정하거나 시트에 바인딩된 스크립트로 배포하세요.');

  const cleanName = String(sheetName || DEFAULT_SHEET_NAME).replace(/[\\/?*\[\]:]/g, '').slice(0, 80) || DEFAULT_SHEET_NAME;
  let sheet = ss.getSheetByName(cleanName);
  if (!sheet) sheet = ss.insertSheet(cleanName);

  sheet.clearContents();
  if (table.length && table[0].length) {
    sheet.getRange(1, 1, table.length, table[0].length).setValues(table);
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, table[0].length);
  }
}

function asArray_(value) {
  return Array.isArray(value) ? value : [];
}

function sourceLabel_(value) {
  const v = String(value || '');
  if (v === 'bank') return '질문은행';
  if (v === 'direct') return '직접입력';
  if (v === 'previous') return '지난기록';
  return v;
}

function formatDateTime_(date) {
  if (!date) return '';
  return Utilities.formatDate(date, 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
}

function toTime_(value) {
  const d = parseDateOrNull_(value);
  return d ? d.getTime() : 0;
}

function safeSheetCell_(value) {
  let s = String(value == null ? '' : value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ').trim();
  if (s.length > 5000) s = s.slice(0, 5000) + '…';
  // Google Sheets/Excel formula injection 방지
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

function splitCsv_(value) {
  return String(value || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function getProps_() {
  return PropertiesService.getScriptProperties().getProperties();
}

function requireProp_(props, key) {
  const value = String(props[key] || '').trim();
  if (!value) throw new Error('Apps Script 설정 누락: ' + key);
  return value;
}

function safeError_(err) {
  const msg = String((err && err.message) || err || '알 수 없는 오류');
  return msg.replace(/AIza[0-9A-Za-z_-]+/g, '[API_KEY]').slice(0, 500);
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
