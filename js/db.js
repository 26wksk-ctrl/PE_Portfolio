// --- js/db.js ---
//
// Firestore 데이터 계층 + Firebase Authentication(구글 로그인) + 구글 시트 내보내기.
//
//   watchAuth() / signInWithGoogle() / signOutUser() / isTeacherUser()  <- 로그인 관련
//   getInitialData()           <- 학생 화면 초기 데이터 (세션·옵션·질문)
//   getLastNextTry()           <- 직전 차시의 "다음 질문" (로그인한 본인 기준)
//   submitSimpleResponse()     <- 응답 제출 (학생 식별 = 구글 계정 uid)
//   getTeacherDashboardData()  <- 교사 대시보드 집계 (교사 계정만)
//   exportToSheet()            <- 현재 응답 전체를 구글 시트로 내보내기 (Apps Script 브리지)
//
// 학생 식별이 "학급-이름" → 구글 계정 uid 로 바뀌었습니다.
// 이름은 구글 프로필(displayName)에서 자동으로 가져오므로 오타로 기록이 끊기지 않습니다.

import { initializeApp } from 'firebase/app';
import {
  getFirestore, collection, doc, addDoc, setDoc, getDocs, onSnapshot,
  query, where, serverTimestamp, Timestamp
} from 'firebase/firestore';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signOut, onAuthStateChanged
} from 'firebase/auth';

import {
  firebaseConfig, APP_VERSION, TEACHER_EMAILS, RESPONSES_COLLECTION,
  SITE_CONFIG_COLLECTION, SITE_CONFIG_DOC, ACTIVATION_CODE,
  SHEETS_WEBAPP_URL, SHEETS_TOKEN
} from './config.js';
import {
  getActiveSessions, findSession, getActiveQuestions, getOptions, getOptionLabel
} from './seed-data.js';
import {
  str, normalizeArray, formatDateTime, incCount, countsToArray, sourceLabel
} from './utils.js';

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

function responsesCol() {
  return collection(db, RESPONSES_COLLECTION);
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// ===================== 인증(Authentication) =====================

// 모든 계정에서 항상 계정 선택 화면을 띄운다 (여러 구글 계정 로그인 시 엉뚱한 계정 자동 선택 방지).
googleProvider.setCustomParameters({ prompt: 'select_account' });

// 페이지 로드 시 리다이렉트 로그인 결과를 한 번 처리한다.
// (signInWithRedirect 로 폴백된 경우, 돌아온 직후 결과/에러를 확인하기 위함)
// 이 Promise 를 watchAuth 가 기다리지 않아도 onAuthStateChanged 가 사용자 변화를 알려준다.
const redirectResultPromise = getRedirectResult(auth).catch(err => {
  console.warn('[auth] 리다이렉트 로그인 결과 처리 중 오류:', err);
  return null;
});

// 팝업 로그인이 실패했을 때 "리다이렉트로 다시 시도"가 의미 있는 에러인지 판단.
function isPopupFallbackError(err) {
  const code = err && err.code ? String(err.code) : '';
  return [
    'auth/popup-blocked',            // 브라우저가 팝업 차단
    'auth/popup-closed-by-user',     // 팝업이 결과 전달 전에 닫힘 (COOP 등)
    'auth/cancelled-popup-request',  // 팝업 중복 요청
    'auth/internal-error',           // 팝업 통신 실패 시 자주 나타남
    'auth/web-storage-unsupported'   // 팝업이 저장소에 접근 불가
  ].includes(code);
}

// 로그인 상태 변화를 구독. callback(user|null) 형태로 호출됨.
export function watchAuth(callback) {
  return onAuthStateChanged(auth, callback);
}

export async function signInWithGoogle() {
  // 1순위: 팝업 방식 로그인.
  // 2순위: 팝업이 (COOP / 팝업 차단 / 통신 실패 등으로) 에러로 닫히면 리다이렉트 방식으로 자동 폴백.
  //   - GitHub Pages 같은 정적 호스팅에서 팝업 결과가 부모 창으로 전달되지 못해
  //     "팝업은 뜨는데 에러로 닫힘" 증상이 나는 경우를 해결한다.
  //   - 리다이렉트는 페이지가 통째로 이동했다가 돌아오므로, 돌아온 뒤
  //     getRedirectResult / onAuthStateChanged 로 로그인 상태가 반영된다.
  try {
    const result = await signInWithPopup(auth, googleProvider);
    return result.user;
  } catch (err) {
    if (isPopupFallbackError(err)) {
      console.warn('[auth] 팝업 로그인 실패 → 리다이렉트 방식으로 전환:', err.code);
      // 페이지가 구글 로그인 화면으로 이동하므로 이 함수는 사실상 반환하지 않는다.
      await signInWithRedirect(auth, googleProvider);
      return null;
    }
    throw err;
  }
}

// 페이지가 리다이렉트 로그인에서 막 돌아왔는지 (UI 에서 안내용으로 사용 가능)
export async function getPendingRedirectUser() {
  const result = await redirectResultPromise;
  return result ? result.user : null;
}

export async function signOutUser() {
  return signOut(auth);
}

export function getCurrentUser() {
  return auth.currentUser;
}

// 교사 이메일 허용목록에 포함되는지 (대시보드/내보내기 접근용)
export function isTeacherUser(user) {
  const u = user || auth.currentUser;
  if (!u || !u.email) return false;
  const email = String(u.email).trim().toLowerCase();
  return TEACHER_EMAILS.some(e => String(e).trim().toLowerCase() === email);
}

// ===================== 사이트 활성/비활성 상태 =====================
//
// 교사가 학생 화면을 언제든 켜고 끌 수 있게 하는 전역 스위치.
// 상태는 Firestore (app_config/site) 에 저장되어 모든 학생 기기에 실시간 반영됩니다.
// 문서가 없거나 active 가 true 가 아니면 "꺼짐(비활성)" 으로 간주합니다.

function siteConfigRef() {
  return doc(db, SITE_CONFIG_COLLECTION, SITE_CONFIG_DOC);
}

// 사이트 상태 변화를 실시간 구독. callback(active:boolean) 형태로 호출됨.
// 반환값은 구독 해제 함수.
export function watchSiteStatus(callback) {
  return onSnapshot(
    siteConfigRef(),
    snap => {
      const data = snap.exists() ? snap.data() : null;
      callback(!!(data && data.active === true));
    },
    err => {
      // 읽기 실패 시(권한/네트워크) 안전하게 "꺼짐" 으로 처리.
      console.warn('[site] 상태 구독 오류:', err);
      callback(false);
    }
  );
}

// 상태 문서에 active 값을 쓴다. (firestore.rules 가 active + updated_at 만 허용하므로 그 두 필드만 씀)
async function writeSiteActive(active) {
  await setDoc(siteConfigRef(), {
    active: !!active,
    updated_at: serverTimestamp()
  });
}

// 사이트를 켜거나 끔 — 구글 교사 로그인 경로.
export async function setSiteActive(active) {
  const user = auth.currentUser;
  if (!isTeacherUser(user)) {
    throw new Error('교사 계정만 사이트를 켜고 끌 수 있습니다.');
  }
  await writeSiteActive(active);
  return { ok: true, active: !!active };
}

// 사이트를 켜거나 끔 — 비밀코드 경로(구글 로그인 불필요).
// 코드가 맞을 때만 쓰기를 시도한다. (코드 자체는 Firestore 에 저장하지 않음)
export async function setSiteActiveByCode(active, code) {
  if (String(code || '') !== ACTIVATION_CODE) {
    throw new Error('비밀코드가 올바르지 않습니다.');
  }
  await writeSiteActive(active);
  return { ok: true, active: !!active };
}

// ===================== 학생 화면 데이터 =====================

// 옵션 묶음을 화면용 형태로 (학생 화면에 그대로 전달)
function getOptionsBySets(setIds) {
  const grouped = {};
  setIds.forEach(id => {
    grouped[id] = getOptions(id).map(o => ({
      option_code: o.code, option_label: o.label,
      score: o.score === '' ? '' : Number(o.score)
    }));
  });
  return grouped;
}

export function getInitialData(params) {
  params = params || {};
  const requestedSessionId = str(params.sessionId);
  const sessions = getActiveSessions();

  let session = requestedSessionId ? findSession(requestedSessionId) : null;
  if (!session || !session.active) session = sessions.length ? sessions[0] : null;
  if (!session) throw new Error('열린 학급 세션이 없습니다. seed-data.js 의 SESSIONS 를 확인하세요.');

  return {
    ok: true,
    appVersion: APP_VERSION,
    session: { session_id: session.sessionId, class_id: session.classId, title: session.title, question_focus: session.questionFocus },
    sessions: sessions.map(s => ({ session_id: s.sessionId, class_id: s.classId, title: s.title })),
    optionsBySet: getOptionsBySets(['activities', 'practice_methods', 'sel_competencies']),
    questions: getActiveQuestions(session.questionFocus).map(q => ({
      qid: q.qid, short_label: q.shortLabel, question_text: q.questionText,
      question_type: q.questionType, dimension: q.dimension, focus: q.focus
    }))
  };
}

// 로그인한 학생 본인의 해당 학급 응답 문서 (equality 필터만 → 복합 색인 불필요)
async function fetchStudentResponses(classId, studentId) {
  const q = query(responsesCol(), where('student_id', '==', studentId), where('class_id', '==', classId));
  const snap = await getDocs(q);
  const rows = [];
  snap.forEach(doc => rows.push(doc.data()));
  return rows;
}

// --- 직전 차시의 "다음 질문" 불러오기 (로그인한 본인 기준) ---
export async function getLastNextTry(params) {
  params = params || {};
  const session = findSession(params.sessionId);
  if (!session) return { ok: true, found: false, message: '세션을 찾지 못했습니다.' };

  const user = auth.currentUser;
  if (!user) return { ok: true, found: false, message: '먼저 구글 로그인을 해주세요.' };

  const studentId = user.uid;
  const rows = (await fetchStudentResponses(session.classId, studentId))
    .filter(r => str(r.session_id) === session.sessionId)
    .sort((a, b) => (toDate(b.submitted_at) || 0) - (toDate(a.submitted_at) || 0));

  for (const row of rows) {
    const nextTry = str(row.next_try);
    if (nextTry) {
      return { ok: true, found: true, next_try: nextTry, submitted_at: formatDateTime(toDate(row.submitted_at)) };
    }
  }
  return { ok: true, found: false };
}

// --- 응답 제출 ---
export async function submitSimpleResponse(payload) {
  if (!payload) throw new Error('제출 데이터가 없습니다.');

  const user = auth.currentUser;
  if (!user) throw new Error('먼저 구글 로그인을 해주세요.');

  const session = findSession(payload.sessionId);
  if (!session) throw new Error('학급 세션을 찾을 수 없습니다.');
  if (String(session.status).toLowerCase() === 'closed') throw new Error('닫힌 세션입니다.');

  const classId = session.classId;
  const studentId = user.uid;                                  // 학생 식별 = 구글 계정 uid
  const studentName = str(user.displayName || user.email || '이름없음').slice(0, 50);
  const studentEmail = str(user.email);

  const activityCode = str(payload.activityCode);
  const question = payload.question || {};
  const questionText = str(question.text);
  const questionSource = str(question.source || 'bank');
  const questionQid = str(question.qid || '');
  const methodCodes = normalizeArray(payload.methodCodes);
  const evidenceResult = str(payload.evidenceResult);
  const nextTry = str(payload.nextTry);
  const agencyScore = Number(payload.agencyScore);
  const selCode = str(payload.selCompetencyCode);

  const missing = [];
  if (!activityCode) missing.push('오늘 활동');
  if (!questionText) missing.push('오늘의 탐구 질문');
  if (!methodCodes.length) missing.push('오늘 해본 방법');
  if (!evidenceResult) missing.push('오늘 해본 결과 및 과정 피드백');
  if (!nextTry) missing.push('다음 시간에 탐구할 질문');
  if (!agencyScore || isNaN(agencyScore)) missing.push('주도성 점수');
  if (!selCode) missing.push('오늘 발휘한 SEL 역량');
  if (missing.length) throw new Error('필수 항목을 입력해 주세요: ' + missing.join(' / '));

  if (agencyScore < 1 || agencyScore > 5) throw new Error('주도성 점수는 1~5 사이여야 합니다.');

  const activityToday = getOptionLabel('activities', activityCode);
  const methodLabels = methodCodes.map(code => getOptionLabel('practice_methods', code)).filter(Boolean);
  const selLabel = getOptionLabel('sel_competencies', selCode);

  // 차시 계산 + 중복 제출 방어 (최근 30초 내 동일 학생 차단)
  const existing = await fetchStudentResponses(classId, studentId);
  const nowMs = Date.now();
  const recentDup = existing.some(r => {
    const t = toDate(r.submitted_at);
    return t && (nowMs - t.getTime()) < 30000;
  });
  if (recentDup) throw new Error('방금 제출한 기록이 있습니다. 잠시 후 다시 시도해 주세요.');

  const recordNo = existing.length + 1;

  const doc = {
    submitted_at: serverTimestamp(),
    session_id: session.sessionId,
    class_id: classId,
    student_id: studentId,
    student_name: studentName,
    student_email: studentEmail,
    record_no: recordNo + '번째 기록',
    record_no_value: recordNo,
    activity_code: activityCode,
    activity_today: activityToday,
    question_source: questionSource,
    question_qid: questionQid,
    inquiry_question: questionText,
    method_codes: methodCodes,
    method_labels: methodLabels,
    evidence_result: evidenceResult,
    next_try: nextTry,
    agency_score: agencyScore,
    sel_competency_code: selCode,
    sel_competency_label: selLabel,
    app_version: APP_VERSION
  };

  const ref = await addDoc(responsesCol(), doc);
  return { ok: true, responseId: ref.id, submittedAt: formatDateTime(new Date()), message: '제출 완료' };
}

// ===================== 교사 대시보드 =====================

export async function getTeacherDashboardData(params) {
  params = params || {};

  const user = auth.currentUser;
  if (!isTeacherUser(user)) {
    throw new Error('교사 권한이 없는 계정입니다. 교사용 구글 계정으로 로그인하세요.');
  }

  const filterClassId = str(params.classId);
  const filterActivity = str(params.activityText);

  const snap = await getDocs(responsesCol());
  let rows = [];
  snap.forEach(d => rows.push(d.data()));

  rows = rows.filter(row => {
    if (filterClassId && str(row.class_id) !== filterClassId) return false;
    if (filterActivity && str(row.activity_today).indexOf(filterActivity) === -1) return false;
    return true;
  });

  const classCounts = {}, activityCounts = {}, questionSourceCounts = {}, methodCounts = {}, selCounts = {}, uniqueStudents = {};
  let agencySum = 0, agencyCount = 0;

  rows.forEach(row => {
    incCount(classCounts, str(row.class_id) || '미입력');
    incCount(activityCounts, str(row.activity_today) || '미입력');
    incCount(questionSourceCounts, sourceLabel(str(row.question_source) || '미기록'));
    uniqueStudents[str(row.class_id) + '_' + str(row.student_id)] = true;

    const agency = Number(row.agency_score);
    if (!isNaN(agency) && agency > 0) { agencySum += agency; agencyCount++; }

    normalizeArray(row.method_labels).forEach(label => incCount(methodCounts, label));
    const selLabel = str(row.sel_competency_label);
    if (selLabel) incCount(selCounts, selLabel);
  });

  rows.sort((a, b) => (toDate(b.submitted_at) || 0) - (toDate(a.submitted_at) || 0));

  return {
    ok: true,
    generatedAt: formatDateTime(new Date()),
    totalResponses: rows.length,
    uniqueStudentCount: Object.keys(uniqueStudents).length,
    agencyAverage: agencyCount ? Math.round((agencySum / agencyCount) * 10) / 10 : '',
    classCounts: countsToArray(classCounts),
    activityCounts: countsToArray(activityCounts),
    questionSourceCounts: countsToArray(questionSourceCounts),
    methodCounts: countsToArray(methodCounts),
    selCounts: countsToArray(selCounts),
    recent: rows.slice(0, 120).map(row => ({
      submitted_at: formatDateTime(toDate(row.submitted_at)),
      class_id: str(row.class_id),
      student_name: str(row.student_name),
      record_no: str(row.record_no),
      activity_today: str(row.activity_today),
      question_source: sourceLabel(str(row.question_source)),
      inquiry_question: str(row.inquiry_question),
      method_labels: normalizeArray(row.method_labels).join(', '),
      evidence_result: str(row.evidence_result),
      next_try: str(row.next_try),
      agency_score: str(row.agency_score),
      sel_competency: str(row.sel_competency_label)
    }))
  };
}

// ===================== 구글 시트 내보내기 =====================
//
// 현재 Firestore 의 응답 전체를 Apps Script 웹앱으로 보내, 시트를 통째로 새로 씁니다.
// (매번 덮어쓰기라 중복 행이 생기지 않습니다.)

export async function exportToSheet() {
  if (!SHEETS_WEBAPP_URL) {
    throw new Error('config.js 의 SHEETS_WEBAPP_URL 이 비어 있습니다. Apps Script 배포 후 URL 을 넣어 주세요.');
  }
  const user = auth.currentUser;
  if (!isTeacherUser(user)) {
    throw new Error('교사 계정으로 로그인해야 내보낼 수 있습니다.');
  }

  const snap = await getDocs(responsesCol());
  const rows = [];
  snap.forEach(d => rows.push(d.data()));
  rows.sort((a, b) => (toDate(b.submitted_at) || 0) - (toDate(a.submitted_at) || 0));

  const header = [
    '제출시간', '학급', '이름', '이메일', '차시', '활동', '질문출처',
    '탐구질문', '해본방법', '결과/과정피드백', '다음질문', '주도성', 'SEL역량'
  ];
  const body2d = rows.map(r => [
    formatDateTime(toDate(r.submitted_at)),
    str(r.class_id),
    str(r.student_name),
    str(r.student_email),
    str(r.record_no),
    str(r.activity_today),
    sourceLabel(str(r.question_source)),
    str(r.inquiry_question),
    normalizeArray(r.method_labels).join(', '),
    str(r.evidence_result),
    str(r.next_try),
    str(r.agency_score),
    str(r.sel_competency_label)
  ]);

  // Content-Type 을 text/plain 으로 보내 CORS preflight 를 피한다.
  // (Apps Script 웹앱을 브라우저에서 호출하는 표준 패턴)
  const res = await fetch(SHEETS_WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ token: SHEETS_TOKEN, sheetName: 'responses', header, rows: body2d })
  });

  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error('시트 응답을 해석하지 못했습니다. 웹앱 배포(액세스 권한)와 URL 을 확인하세요.');
  }
  if (!data || !data.ok) {
    throw new Error((data && data.error) || '시트 내보내기에 실패했습니다.');
  }
  return { ok: true, count: data.count };
}
