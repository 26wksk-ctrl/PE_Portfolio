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
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import {
  getFirestore, collection, doc, addDoc, setDoc, getDoc, getDocs, deleteDoc, writeBatch, onSnapshot,
  query, where, orderBy, limit, serverTimestamp, Timestamp,
  getCountFromServer, getAggregateFromServer, average
} from 'firebase/firestore';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signOut, onAuthStateChanged
} from 'firebase/auth';

import {
  firebaseConfig, APP_VERSION, TEACHER_EMAILS, RESPONSES_COLLECTION,
  STUDENTS_COLLECTION, TRASH_COLLECTION, SITE_CONFIG_COLLECTION, SITE_CONFIG_DOC,
  LESSON_SETTINGS_DOC, SHEETS_WEBAPP_URL, SHEETS_TOKEN, APP_CHECK_SITE_KEY
} from './config.js';
import {
  getActiveSessions, findSession, getActiveQuestions, getOptions, getOptionLabel
} from './seed-data.js';
import {
  str, normalizeArray, formatDateTime, incCount, countsToArray, sourceLabel,
  sanitizeStudentName
} from './utils.js';

const app = initializeApp(firebaseConfig);

// App Check: Firebase 콘솔에서 Web 앱 + reCAPTCHA Enterprise 설정 후
// config.js의 APP_CHECK_SITE_KEY를 채우고, 콘솔에서 Firestore enforcement를 켜면
// 허가된 웹앱이 아닌 스크립트/도구의 직접 호출을 줄일 수 있습니다.
if (APP_CHECK_SITE_KEY) {
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(APP_CHECK_SITE_KEY),
    isTokenAutoRefreshEnabled: true
  });
}

const db = getFirestore(app);
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

function responsesCol() {
  return collection(db, RESPONSES_COLLECTION);
}

// ===================== 학생 표시 이름 보정(students/{uid}) =====================
//
// 구글 계정 이름(displayName)이 실명과 다른 경우, 교사가 실명을 저장해 두는 곳.
// 표시 이름은 "보정값(students/{uid}.name) → 응답에 저장된 student_name" 순으로 해석한다.
// 한 번 보정하면 지난 기록과 새 기록, 학생 화면 모두에 같은 이름이 반영된다.

function studentsCol() {
  return collection(db, STUDENTS_COLLECTION);
}
function studentDocRef(uid) {
  return doc(db, STUDENTS_COLLECTION, str(uid));
}

// 한 학생(uid)의 보정 정보 1건 조회. 없으면 null. (제출/학생 화면용)
//   - name / session_id / class_id : 교사가 보정한 값(권위)
//   - self_session_id / self_class_id : 학생 본인이 마지막으로 고른 반(서버 기억)
async function fetchStudentOverride(uid) {
  if (!uid) return null;
  try {
    const snap = await getDoc(studentDocRef(uid));
    if (!snap.exists()) return null;
    const d = snap.data();
    return {
      name: str(d.name),
      session_id: str(d.session_id),
      class_id: str(d.class_id),
      self_session_id: str(d.self_session_id),
      self_class_id: str(d.self_class_id)
    };
  } catch (e) {
    console.warn('[students] 보정 정보 조회 실패:', e);
    return null;
  }
}

// 한 학생(uid)의 보정 이름만. 없으면 null.
async function fetchStudentOverrideName(uid) {
  const ov = await fetchStudentOverride(uid);
  return (ov && ov.name) ? ov.name : null;
}

// 전체 보정 정보 매핑(uid -> { name, session_id, class_id }).
// 교사 대시보드에서 이름·학급을 한 번에 통일하는 데 사용.
//
// [읽기 절감] students 컬렉션 전체 읽기를 매 대시보드 새로고침마다 반복하지 않도록 세션 캐시한다.
//   - 한 번 읽으면 메모리에 보관하고, 같은 세션의 다음 조회는 읽기 0.
//   - 교사가 이름/학급을 보정하거나(setStudentName/Class) 학생 데이터를 삭제하면
//     캐시를 그 자리에서 갱신/삭제해, 다시 읽지 않고도 최신값을 유지한다.
//   - force=true 면 강제로 다시 읽는다(다른 교사 계정의 변경까지 반영하고 싶을 때).
let _overridesCache = null;
async function fetchAllOverrides(force) {
  if (_overridesCache && !force) return _overridesCache;
  const map = {};
  try {
    const snap = await getDocs(studentsCol());
    snap.forEach(d => {
      const data = d.data();
      map[d.id] = { name: str(data.name), session_id: str(data.session_id), class_id: str(data.class_id) };
    });
  } catch (e) {
    console.warn('[students] 보정 정보 목록 조회 실패:', e);
    return _overridesCache || map;   // 실패 시 직전 캐시라도 반환
  }
  _overridesCache = map;
  return map;
}

// 보정 캐시를 그 자리에서 갱신(추가 읽기 없음). 교사 보정/삭제 직후 호출한다.
function patchOverridesCache(uid, patch) {
  if (!_overridesCache) return;
  const id = str(uid);
  if (patch === null) { delete _overridesCache[id]; return; }
  _overridesCache[id] = Object.assign(
    { name: '', session_id: '', class_id: '' },
    _overridesCache[id] || {},
    patch
  );
}

// 전체 보정 이름 매핑(uid -> name). (시트 내보내기/휴지통 등 이름만 필요한 곳)
async function fetchAllOverrideNames() {
  const all = await fetchAllOverrides();
  const map = {};
  Object.keys(all).forEach(uid => { if (all[uid].name) map[uid] = all[uid].name; });
  return map;
}

// 로그인한 본인의 프로필(표시 이름 + 학급)을 students/{uid} "한 번 읽기"로 함께 돌려준다.
// 이름과 학급을 따로 읽지 않으므로 로그인당 본인 문서 읽기가 1건으로 줄어든다.
//   - displayName: 교사 보정 이름 → 구글 프로필 이름/이메일
//   - class: 교사 보정 학급(우선) → 본인이 마지막으로 고른 반(서버 기억) → 없으면 null
//     교사가 보정해 두면 어떤 기기에서든 그 반으로, 아니면 본인이 직전에 고른 반으로 자동 선택된다.
export async function getMyProfile() {
  const user = auth.currentUser;
  if (!user) return { displayName: '', class: null };

  const ov = await fetchStudentOverride(user.uid);   // 1읽기 (본인 문서)
  const displayName = (ov && ov.name) ? ov.name : str(user.displayName || user.email || '');
  let cls = null;
  if (ov && ov.session_id) {
    const session = findSession(ov.session_id);
    if (session) cls = { session_id: session.sessionId, class_id: session.classId, source: 'teacher' };
  }
  if (!cls && ov && ov.self_session_id) {
    const session = findSession(ov.self_session_id);
    if (session) cls = { session_id: session.sessionId, class_id: session.classId, source: 'self' };
  }
  return { displayName, class: cls };
}

// 학생 본인이 고른 반을 자기 students/{uid} 문서에 기억해 둔다(서버 기억).
// 어떤 기기에서 로그인해도 다음에 자동 선택되도록. (교사 보정과 분리된 self_* 필드만 씀)
// 비핵심 쓰기라 실패해도 제출 흐름을 막지 않는다.
async function rememberMyClass(uid, sessionId) {
  if (!uid || !sessionId) return;
  const session = findSession(str(sessionId));
  if (!session) return;
  try {
    await setDoc(
      studentDocRef(uid),
      { self_session_id: session.sessionId, self_class_id: session.classId, self_updated_at: serverTimestamp() },
      { merge: true }
    );
  } catch (e) {
    console.warn('[students] 본인 반 기억 저장 실패:', e);
  }
}

// 교사: 특정 학생(uid)의 표시 이름을 실명으로 보정 저장.
export async function setStudentName(uid, name) {
  const user = auth.currentUser;
  if (!isTeacherUser(user)) {
    throw new Error('교사 계정만 학생 이름을 수정할 수 있습니다.');
  }
  const clean = sanitizeStudentName(name);
  if (!clean) throw new Error('이름을 입력해 주세요. (한글/영문/숫자, 최대 20자)');
  await setDoc(
    studentDocRef(uid),
    { name: clean, updated_at: serverTimestamp(), updated_by: str(user.email) },
    { merge: true }
  );
  patchOverridesCache(uid, { name: clean });   // 다음 대시보드 조회 시 다시 읽지 않도록 캐시 갱신
  return { ok: true, uid: str(uid), name: clean };
}

// 교사: 특정 학생(uid)의 학급(세션)을 보정 저장. 학생 화면 자동 선택과 새 기록에 반영된다.
// (지난 기록의 class_id 는 그대로 보존된다 — 통계 일관성 + 데이터 보존)
export async function setStudentClass(uid, sessionId) {
  const user = auth.currentUser;
  if (!isTeacherUser(user)) {
    throw new Error('교사 계정만 학생의 학급을 수정할 수 있습니다.');
  }
  const session = sessionId ? findSession(str(sessionId)) : null;
  if (!session) throw new Error('학급(세션)을 찾을 수 없습니다.');
  await setDoc(
    studentDocRef(uid),
    {
      session_id: session.sessionId, class_id: session.classId,
      updated_at: serverTimestamp(), updated_by: str(user.email)
    },
    { merge: true }
  );
  patchOverridesCache(uid, { session_id: session.sessionId, class_id: session.classId });
  return { ok: true, uid: str(uid), session_id: session.sessionId, class_id: session.classId };
}

// 교사: 특정 학생(uid)의 데이터를 정리한다. (테스트용 학생 청소)
//   - 그 학생의 모든 응답을 휴지통(trash_responses)으로 이동 → 통계·명단에서 빠지고, 필요하면 복원 가능
//   - 이름·학급 보정 문서(students/{uid})도 삭제 → 명단에서 완전히 사라짐
//
// ※ 구글 로그인 계정 자체는 브라우저(클라이언트)에서 삭제할 수 없다. 같은 계정으로 다시 제출하면 새로 생긴다.
export async function deleteStudentData(uid) {
  const user = auth.currentUser;
  if (!isTeacherUser(user)) throw new Error('교사 계정만 학생 데이터를 삭제할 수 있습니다.');
  const sid = str(uid);
  if (!sid) throw new Error('학생을 찾을 수 없습니다.');

  // 1) 이 학생의 모든 응답을 읽어 휴지통으로 이동 (move = 2작업/건 → 150건씩 끊어 처리)
  const snap = await getDocs(query(responsesCol(), where('student_id', '==', sid)));
  const docs = [];
  snap.forEach(d => docs.push({ id: d.id, data: d.data() }));

  let moved = 0;
  for (const part of chunkList(docs, 150)) {
    const batch = writeBatch(db);
    part.forEach(({ id, data }) => {
      batch.set(trashRef(id), Object.assign({}, data, {
        trashed_at: serverTimestamp(), trashed_by: str(user.email), trashed_reason: 'student_cleanup'
      }));
      batch.delete(doc(db, RESPONSES_COLLECTION, id));
      moved++;
    });
    await batch.commit();
  }

  // 2) 이름·학급 보정 문서 삭제 (없으면 무시)
  try {
    await deleteDoc(studentDocRef(sid));
  } catch (e) {
    console.warn('[students] 보정 문서 삭제 실패(없을 수 있음):', e);
  }

  // 3) 보정 캐시에서 제거 (다음 조회에서 다시 읽지 않도록)
  patchOverridesCache(sid, null);

  return { ok: true, count: moved };
}


// 로그인한 학생 본인의 전체 기록을 시간순으로 모아 돌려준다. (학생 화면 "내 지난 기록"용)
// student_id 단일 equality 쿼리라 복합 색인이 필요 없고, 읽기는 본인 문서 수만큼만 든다.
// (버튼을 눌렀을 때만 호출 → 평소 읽기 비용 증가 없음)
export async function getMyHistory() {
  const user = auth.currentUser;
  if (!user) throw new Error('먼저 구글 로그인을 해주세요.');

  const snap = await getDocs(query(responsesCol(), where('student_id', '==', user.uid)));
  const rows = [];
  snap.forEach(d => rows.push(d.data()));
  rows.sort((a, b) => (toDate(a.submitted_at) || 0) - (toDate(b.submitted_at) || 0));

  let agencySum = 0, agencyCount = 0;
  const items = rows.map((r, i) => {
    const agency = Number(r.agency_score);
    const hasAgency = !isNaN(agency) && agency > 0;
    if (hasAgency) { agencySum += agency; agencyCount++; }
    return {
      seq: i + 1,
      record_no: str(r.record_no),
      class_id: str(r.class_id),
      date: formatDateTime(toDate(r.submitted_at)),
      activity: str(r.activity_today),
      source: sourceLabel(str(r.question_source)),
      question: str(r.inquiry_question),
      next_try: str(r.next_try),
      evidence: str(r.evidence_result),
      agency: hasAgency ? agency : null,
      sel: normalizeArray(r.sel_competency_labels || []).join(' / ') || str(r.sel_competency_label)
    };
  });

  return {
    ok: true,
    count: items.length,
    agencyAverage: agencyCount ? Math.round((agencySum / agencyCount) * 10) / 10 : '',
    items
  };
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

// 사이트를 켜거나 끔. 교사 계정만 가능.
export async function setSiteActive(active) {
  const user = auth.currentUser;
  if (!isTeacherUser(user)) {
    throw new Error('교사 계정만 사이트를 켜고 끌 수 있습니다.');
  }
  await setDoc(
    siteConfigRef(),
    {
      active: !!active,
      updated_at: serverTimestamp(),
      updated_by: str(user.email)
    },
    { merge: true }
  );
  return { ok: true, active: !!active };
}

// ===================== 수업 설정 (lessonSettings) =====================
//
// 교사가 코드 수정 없이 학생 화면 구성을 바꿀 수 있도록 설정을 Firestore(app_config/lesson)에 둔다.
//   - 읽기: 누구나(학생 포함) — 규칙상 app_config 는 read:true
//   - 쓰기: 교사 계정만 — 규칙상 app_config 는 write:isTeacher()
// 저장된 문서가 없으면 학생/교사 화면은 lesson-config.js 의 기본값을 사용한다.

function lessonSettingsRef() {
  return doc(db, SITE_CONFIG_COLLECTION, LESSON_SETTINGS_DOC);
}

// 현재 수업 설정을 1회 읽어 온다(없으면 null). 정규화는 호출 측(lesson-config)에서 한다.
export async function getLessonSettings() {
  const snap = await getDoc(lessonSettingsRef());
  return snap.exists() ? snap.data() : null;
}

// 수업 설정을 저장한다(교사만). 전체 교체(merge 안 함)라 옵션 삭제도 반영된다.
export async function saveLessonSettings(settings) {
  const user = auth.currentUser;
  if (!isTeacherUser(user)) throw new Error('교사 계정만 수업 설정을 저장할 수 있습니다.');
  if (!settings || typeof settings !== 'object') throw new Error('저장할 설정이 없습니다.');
  await setDoc(lessonSettingsRef(), {
    ...settings,
    updated_at: serverTimestamp(),
    updated_by: str(user.email)
  });
  return { ok: true };
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

// 한 학생(student_id)의 전체 기록(반과 무관). 차시 계산·중복 방어에 쓴다.
// student_id 단일 equality 라 복합 색인이 필요 없고, 본인은 보안 규칙상 자기 기록을 읽을 수 있다.
async function fetchStudentResponsesByStudent(studentId) {
  const snap = await getDocs(query(responsesCol(), where('student_id', '==', studentId)));
  const rows = [];
  snap.forEach(doc => rows.push(doc.data()));
  return rows;
}

// 적재된 기록들에 "학생별 제출 순서(차시)"를 매겨 Map(기록객체 -> 차시) 로 돌려준다.
// 반과 무관하게 같은 student_id 안에서 submitted_at 오름차순으로 1, 2, 3...
// (학생이 반을 잘못 골랐다 바꿔도 차시가 갈리지 않게 하려는 것. 저장값은 건드리지 않고 표시용으로만 계산)
function sequenceByStudent(rows) {
  const seq = new Map();
  const asc = rows.slice().sort((a, b) => (toDate(a.submitted_at) || 0) - (toDate(b.submitted_at) || 0));
  const counter = {};
  asc.forEach(r => {
    const uid = str(r.student_id);
    if (!uid) return;
    counter[uid] = (counter[uid] || 0) + 1;
    seq.set(r, counter[uid]);
  });
  return seq;
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
  // 표시 이름은 교사 보정값(students/{uid})이 있으면 그것을, 없으면 구글 프로필 이름을 쓴다.
  const overrideName = await fetchStudentOverrideName(studentId);
  const studentName = str(overrideName || user.displayName || user.email || '이름없음').slice(0, 50);
  const studentEmail = str(user.email);

  const activityCode = str(payload.activityCode);
  const activityOtherText = str(payload.activityOtherText || '');
  const question = payload.question || {};
  const questionText = str(question.text);
  const questionSource = str(question.source || 'bank');
  const questionQid = str(question.qid || '');
  const methodCodes = normalizeArray(payload.methodCodes);
  const evidenceResult = str(payload.evidenceResult);
  const nextTry = str(payload.nextTry);
  const agencyScore = Number(payload.agencyScore);
  const selCodes = normalizeArray(payload.selCompetencyCodes || (payload.selCompetencyCode ? [payload.selCompetencyCode] : []));
  // 2분 기록(quick) 화면에서 들어오는 새 필드들. 기존 기록과의 호환을 위해 모두 선택적으로 처리한다.
  const recordType = str(payload.recordType || 'quick');
  const feedbackMode = str(payload.feedbackMode || '');           // 'received' | 'given'
  const peerFeedback = str(payload.peerFeedback || '').slice(0, 500); // 친구 피드백 한 줄 (선택)
  const reflectionText = str(payload.reflectionText || '').slice(0, 2000); // 선택값으로 조립한 요약 문장

  const missing = [];
  if (!activityCode) missing.push('오늘 활동');
  if (activityCode === 'other' && !activityOtherText) missing.push('기타 활동 내용');
  if (!questionText) missing.push('오늘의 탐구 질문');
  if (!methodCodes.length) missing.push('오늘 해본 방법');
  if (!evidenceResult) missing.push('오늘 해본 결과 및 과정 피드백');
  if (!nextTry) missing.push('다음 시간에 탐구할 질문');
  if (!agencyScore || isNaN(agencyScore)) missing.push('주도성 점수');
  if (!selCodes.length) missing.push('오늘 발휘한 SEL 역량');
  if (missing.length) throw new Error('필수 항목을 입력해 주세요: ' + missing.join(' / '));

  if (agencyScore < 1 || agencyScore > 5) throw new Error('주도성 점수는 1~5 사이여야 합니다.');

  // 라벨은 payload(학생 화면이 칩에서 읽은 값)를 우선 사용한다.
  // 교사가 lessonSettings 에서 만든 자유 옵션은 seed-data 에 없으므로 payload 라벨이 있어야 통계가 정확하다.
  // payload 라벨이 없으면(구버전 호출) 기존 seed-data 변환으로 안전하게 대체한다.
  const payloadMethodLabels = normalizeArray(payload.methodLabels);
  const payloadSelLabels = normalizeArray(payload.selLabels);
  const activityToday = (activityCode === 'other' && activityOtherText)
    ? activityOtherText
    : (str(payload.activityLabel) || getOptionLabel('activities', activityCode));
  const methodLabels = payloadMethodLabels.length
    ? payloadMethodLabels
    : methodCodes.map(code => getOptionLabel('practice_methods', code)).filter(Boolean);
  const selLabels = payloadSelLabels.length
    ? payloadSelLabels
    : selCodes.map(code => getOptionLabel('sel_competencies', code)).filter(Boolean);

  // 차시 = 이 학생이 (반과 무관하게) 지금까지 남긴 기록 수 + 1.
  //  - 반을 잘못 골랐다가 바꿔도 차시가 갈리지 않도록 student_id 기준으로 센다.
  //  - 중복 제출 방어(최근 30초)도 학생 기준이라, 반을 바꿔 다시 내도 막힌다.
  const existing = await fetchStudentResponsesByStudent(studentId);
  const nowMs = Date.now();
  const recentDup = existing.some(r => {
    const t = toDate(r.submitted_at);
    return t && (nowMs - t.getTime()) < 30000;
  });
  if (recentDup) throw new Error('방금 제출한 기록이 있습니다. 잠시 후 다시 시도해 주세요.');

  // "지난 질문 이어가기"로 고른 질문이, 제출 시점에도 내 기록에 실제로 남아 있는지 확인한다.
  //  - 교사가 그 기록을 삭제(휴지통 이동)했다면 existing 에 더 이상 없으므로 막는다.
  //  - 이미 읽어 둔 existing 으로 검사하므로 추가 읽기 비용이 없다. (삭제 반영 지연 방지)
  if (questionSource === 'previous' && questionText) {
    const stillThere = existing.some(r => str(r.next_try) === questionText);
    if (!stillThere) {
      throw new Error('이어가려던 지난 질문이 삭제되었거나 바뀌었습니다. ③에서 "지난 질문 불러오기"를 다시 눌러 확인한 뒤 제출해 주세요.');
    }
  }

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
    sel_competency_codes: selCodes,
    sel_competency_labels: selLabels,
    sel_competency_code: selCodes.join(','),
    sel_competency_label: selLabels.join(' / '),
    // 2분 기록(quick) 화면 추가 필드 (기존 대시보드는 이 필드들을 무시해도 동작)
    record_type: recordType,
    feedback_mode: feedbackMode,
    peer_feedback: peerFeedback,
    reflection_text: reflectionText,
    app_version: APP_VERSION
  };

  const ref = await addDoc(responsesCol(), doc);
  // 다음에 어떤 기기에서 로그인해도 이 반이 자동 선택되도록 본인 문서에 기억(서버). 실패해도 제출은 성공.
  await rememberMyClass(studentId, session.sessionId);
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
  const startDate = toDate(params.start);   // 조회 시작(이상). null 이면 제한 없음
  const endDate = toDate(params.end);       // 조회 끝(미만).  null 이면 제한 없음

  // 한 번에 읽어 들이는 문서 상한. 선택 범위가 아주 넓을 때 비용/메모리를 보호한다.
  // (헤드라인 숫자는 집계 쿼리로 정확히 계산하므로, 차트만 이 상한의 영향을 받는다.)
  const CHART_CAP = 4000;

  // 교사 보정 정보(uid -> {name, session_id, class_id}). 지난 기록까지 한 번에 교정하기 위해 표시 단계에서 합친다.
  const overrideAll = await fetchAllOverrides();
  const overrideMap = {};   // uid -> 보정 이름 (기존 코드 호환용)
  Object.keys(overrideAll).forEach(uid => { if (overrideAll[uid].name) overrideMap[uid] = overrideAll[uid].name; });

  // 선택한 기간/학급으로 좁힌 Firestore 쿼리 (전체 스캔 방지).
  // submitted_at 범위는 firestore.indexes.json 의 복합 색인(class_id + submitted_at)을 사용한다.
  const windowConstraints = [];
  if (filterClassId) windowConstraints.push(where('class_id', '==', filterClassId));
  if (startDate) windowConstraints.push(where('submitted_at', '>=', Timestamp.fromDate(startDate)));
  if (endDate) windowConstraints.push(where('submitted_at', '<', Timestamp.fromDate(endDate)));

  // 헤드라인 숫자는 집계 쿼리로 서버에서 계산 (문서를 읽지 않음 → 어떤 범위든 저렴).
  let windowTotal = 0;
  let agencyAverageExact = '';
  try {
    const countQ = query(responsesCol(), ...windowConstraints);
    const countSnap = await getCountFromServer(countQ);
    windowTotal = countSnap.data().count;
    if (windowTotal > 0) {
      const aggSnap = await getAggregateFromServer(countQ, { avg: average('agency_score') });
      const avg = aggSnap.data().avg;
      agencyAverageExact = (avg == null) ? '' : Math.round(avg * 10) / 10;
    }
  } catch (e) {
    console.warn('[dashboard] 집계 쿼리 실패(색인 미배포 가능). 차트 데이터로 대체합니다:', e);
  }

  // 차트/표/드릴다운용 문서를 최신순으로 상한까지 읽는다.
  const docsQ = query(responsesCol(), ...windowConstraints, orderBy('submitted_at', 'desc'), limit(CHART_CAP));
  const snap = await getDocs(docsQ);
  let rows = [];
  snap.forEach(d => rows.push(Object.assign({ _id: d.id }, d.data())));
  const capped = rows.length >= CHART_CAP;

  // 활동 필터는 부분일치라 Firestore where 로 못 걸어 읽은 문서에서 거른다.
  if (filterActivity) {
    rows = rows.filter(row => str(row.activity_today).indexOf(filterActivity) !== -1);
  }

  const classCounts = {}, activityCounts = {}, questionSourceCounts = {}, methodCounts = {}, selCounts = {}, uniqueStudents = {};
  let agencySum = 0, agencyCount = 0;

  rows.forEach(row => {
    incCount(classCounts, str(row.class_id) || '미입력');
    incCount(activityCounts, str(row.activity_today) || '미입력');
    incCount(questionSourceCounts, sourceLabel(str(row.question_source) || '미기록'));
    // 고유 학생 수는 student_id(구글 uid)만으로 센다.
    //  - 예전엔 class_id+student_id 로 세서, 반을 잘못 골랐다 바꾼 학생이 2명으로 부풀려졌다.
    if (str(row.student_id)) uniqueStudents[str(row.student_id)] = true;

    const agency = Number(row.agency_score);
    if (!isNaN(agency) && agency > 0) { agencySum += agency; agencyCount++; }

    normalizeArray(row.method_labels).forEach(label => incCount(methodCounts, label));
    const selLabelsArr = row.sel_competency_labels
      ? normalizeArray(row.sel_competency_labels)
      : [str(row.sel_competency_label)].filter(Boolean);
    selLabelsArr.forEach(label => { if (label) incCount(selCounts, label); });
  });

  // 학생 이름 관리용 명단: uid 별로 모아 가장 최근 기록의 이름/학급/이메일을 대표값으로 잡는다.
  const rosterMap = {};
  rows.forEach(row => {
    const uid = str(row.student_id);
    if (!uid) return;
    const ms = (toDate(row.submitted_at) || new Date(0)).getTime();
    let entry = rosterMap[uid];
    if (!entry) entry = rosterMap[uid] = { uid, email: '', class_id: '', response_name: '', last_ms: -1, count: 0 };
    entry.count++;
    if (ms >= entry.last_ms) {
      entry.last_ms = ms;
      entry.class_id = str(row.class_id);
      entry.response_name = str(row.student_name);
      if (str(row.student_email)) entry.email = str(row.student_email);
    }
  });
  const students = Object.keys(rosterMap).map(uid => {
    const e = rosterMap[uid];
    const ov = overrideAll[uid] || {};
    const override = str(ov.name);
    const overrideClass = str(ov.class_id);
    const overrideSession = str(ov.session_id);
    return {
      uid,
      email: e.email,
      class_id: overrideClass || e.class_id,   // 표시 학급 (교사 보정 우선)
      response_class: e.class_id,              // 기존 기록 기준 학급(보존)
      override_class: overrideClass,           // 교사가 보정한 학급 (없으면 '')
      override_session_id: overrideSession,    // 보정 학급의 세션 id
      response_name: e.response_name,          // 기존 기록에 저장된 이름(보통 구글 계정 이름)
      override_name: override,                 // 교사가 보정한 실명 (없으면 '')
      display_name: override || e.response_name,
      count: e.count
    };
  }).sort((a, b) =>
    String(a.class_id).localeCompare(String(b.class_id), 'ko') ||
    String(a.display_name).localeCompare(String(b.display_name), 'ko')
  );

  // ----- 차트용 집계 -----
  const trendAll = {};        // record_no -> { sum, count }  (전체 평균 주도성)
  const trendByClass = {};    // class_id -> { record_no -> { sum, count } }
  const classAgg = {};        // class_id -> { count, agencySum, agencyCount, students{} }
  const srcAgg = { bank: 0, direct: 0, previous: 0, other: 0, total: 0 };
  const timelines = {};       // uid -> { uid, name, class_id, items[] }

  // 차시는 저장된 record_no_value 대신 "학생별 제출 순서"로 표시 계산한다(반이 갈려도 연속).
  const seqByStudent = sequenceByStudent(rows);

  rows.forEach(row => {
    const rn = seqByStudent.get(row);
    const agency = Number(row.agency_score);
    const cls = str(row.class_id) || '미입력';
    const uid = str(row.student_id);
    const hasRn = !isNaN(rn) && rn > 0;
    const hasAgency = !isNaN(agency) && agency > 0;

    // 차시별 주도성 추이 (전체 + 학급별)
    if (hasRn && hasAgency) {
      (trendAll[rn] = trendAll[rn] || { sum: 0, count: 0 });
      trendAll[rn].sum += agency; trendAll[rn].count++;
      const tc = (trendByClass[cls] = trendByClass[cls] || {});
      (tc[rn] = tc[rn] || { sum: 0, count: 0 });
      tc[rn].sum += agency; tc[rn].count++;
    }

    // 학급별 집계
    const ca = (classAgg[cls] = classAgg[cls] || { count: 0, agencySum: 0, agencyCount: 0, students: {} });
    ca.count++;
    if (hasAgency) { ca.agencySum += agency; ca.agencyCount++; }
    if (uid) ca.students[uid] = true;

    // 질문 출처 (질문 주도성 지표)
    const src = str(row.question_source) || 'bank';
    srcAgg.total++;
    if (src === 'bank' || src === 'direct' || src === 'previous') srcAgg[src]++;
    else srcAgg.other++;

    // 학생 타임라인 (드릴다운)
    if (uid) {
      const tl = (timelines[uid] = timelines[uid] || {
        uid, name: str(overrideMap[uid] || row.student_name), class_id: cls, items: []
      });
      tl.items.push({
        record_no: hasRn ? rn : null,
        agency: hasAgency ? agency : null,
        source: src,
        question: str(row.inquiry_question),
        next_try: str(row.next_try),
        activity: str(row.activity_today),
        date: formatDateTime(toDate(row.submitted_at)),
        ms: (toDate(row.submitted_at) || new Date(0)).getTime()
      });
    }
  });

  const toTrendArray = obj => Object.keys(obj)
    .map(k => ({ record_no: Number(k), avg: Math.round((obj[k].sum / obj[k].count) * 10) / 10, count: obj[k].count }))
    .sort((a, b) => a.record_no - b.record_no);

  const agencyTrend = toTrendArray(trendAll);
  const agencyTrendByClass = Object.keys(trendByClass)
    .sort((a, b) => a.localeCompare(b, 'ko'))
    .map(cls => ({ class_id: cls, points: toTrendArray(trendByClass[cls]) }));

  const classStats = Object.keys(classAgg)
    .map(cls => {
      const c = classAgg[cls];
      return {
        class_id: cls,
        count: c.count,
        agency_avg: c.agencyCount ? Math.round((c.agencySum / c.agencyCount) * 10) / 10 : 0,
        student_count: Object.keys(c.students).length
      };
    })
    .sort((a, b) => String(a.class_id).localeCompare(String(b.class_id), 'ko'));

  const questionSourceStats = {
    bank: srcAgg.bank, direct: srcAgg.direct, previous: srcAgg.previous,
    other: srcAgg.other, total: srcAgg.total,
    continuity_rate: srcAgg.total ? Math.round((srcAgg.previous / srcAgg.total) * 100) : 0,
    self_made_rate: srcAgg.total ? Math.round(((srcAgg.direct + srcAgg.previous) / srcAgg.total) * 100) : 0
  };

  // 학생 타임라인 정렬 (차시 → 시간 오름차순)
  Object.keys(timelines).forEach(uid => {
    timelines[uid].items.sort((a, b) => (a.record_no || 0) - (b.record_no || 0) || a.ms - b.ms);
  });

  rows.sort((a, b) => (toDate(b.submitted_at) || 0) - (toDate(a.submitted_at) || 0));

  // 활동 필터가 걸리면 집계 쿼리(범위 전체 기준)와 어긋나므로 읽은 문서 기준으로 계산한다.
  const usingActivityFilter = !!filterActivity;
  const totalResponses = (!usingActivityFilter && windowTotal) ? windowTotal : rows.length;
  const agencyAverage = (!usingActivityFilter && agencyAverageExact !== '')
    ? agencyAverageExact
    : (agencyCount ? Math.round((agencySum / agencyCount) * 10) / 10 : '');

  return {
    ok: true,
    generatedAt: formatDateTime(new Date()),
    totalResponses,
    uniqueStudentCount: Object.keys(uniqueStudents).length,
    agencyAverage,
    capped,                          // 차트 표본이 상한(CHART_CAP)에 걸렸는지
    chartSampleSize: rows.length,    // 차트/표 계산에 실제 사용한 문서 수
    classCounts: countsToArray(classCounts),
    activityCounts: countsToArray(activityCounts),
    questionSourceCounts: countsToArray(questionSourceCounts),
    methodCounts: countsToArray(methodCounts),
    selCounts: countsToArray(selCounts),
    students,
    agencyTrend,
    agencyTrendByClass,
    classStats,
    questionSourceStats,
    studentTimelines: timelines,
    classOptions: getActiveSessions().map(s => ({ session_id: s.sessionId, class_id: s.classId, title: s.title })),
    recent: rows.slice(0, 1000).map(row => ({
      id: str(row._id),
      student_id: str(row.student_id),   // 이름 보정 후 화면을 메모리에서 갱신할 때 매칭용(내부)
      submitted_at: formatDateTime(toDate(row.submitted_at)),
      class_id: str(row.class_id),
      student_name: str(overrideMap[str(row.student_id)] || row.student_name),
      record_no: seqByStudent.get(row) ? seqByStudent.get(row) + '번째 기록' : str(row.record_no),
      activity_today: str(row.activity_today),
      question_source: sourceLabel(str(row.question_source)),
      inquiry_question: str(row.inquiry_question),
      method_labels: normalizeArray(row.method_labels).join(', '),
      evidence_result: str(row.evidence_result),
      next_try: str(row.next_try),
      agency_score: str(row.agency_score),
      sel_competency: normalizeArray(row.sel_competency_labels || []).join(' / ') || str(row.sel_competency_label)
    }))
  };
}

// ===================== 휴지통 (삭제 / 일괄 삭제 / 복원) =====================
//
// "삭제" 는 즉시 영구 삭제가 아니라 휴지통(trash_responses)으로 이동입니다.
// - 이동: 원본을 trash 로 복사(trashed_at/by 추가) 후 simple_responses 에서 제거
// - 복원: trash 에서 원래 컬렉션으로 되돌림(원래 문서 ID 유지)
// - 완전 삭제 / 비우기: trash 에서 영구 제거
// 통계·차트는 simple_responses 만 보므로, 휴지통에 있는 동안은 통계에서 자동으로 빠집니다.

function trashCol() { return collection(db, TRASH_COLLECTION); }
function trashRef(id) { return doc(db, TRASH_COLLECTION, str(id)); }

// 배열을 size 개씩 끊는다. (writeBatch 는 한 번에 최대 500 작업)
function chunkList(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function cleanIds(ids) {
  return (Array.isArray(ids) ? ids : [ids]).map(str).filter(Boolean);
}

// 교사: 선택한 응답(1건 이상)을 휴지통으로 이동.
export async function moveResponsesToTrash(ids) {
  const user = auth.currentUser;
  if (!isTeacherUser(user)) throw new Error('교사 계정만 기록을 삭제할 수 있습니다.');
  const list = cleanIds(ids);
  if (!list.length) throw new Error('선택된 기록이 없습니다.');

  let moved = 0;
  for (const part of chunkList(list, 150)) {           // move = 2작업/건 → 150건이면 300작업
    const snaps = await Promise.all(part.map(id => getDoc(doc(db, RESPONSES_COLLECTION, id))));
    const batch = writeBatch(db);
    snaps.forEach((snap, i) => {
      if (!snap.exists()) return;
      batch.set(trashRef(part[i]), Object.assign({}, snap.data(), {
        trashed_at: serverTimestamp(), trashed_by: str(user.email)
      }));
      batch.delete(doc(db, RESPONSES_COLLECTION, part[i]));
      moved++;
    });
    await batch.commit();
  }
  return { ok: true, count: moved };
}

// 교사: 휴지통 목록 조회 (최신 삭제순).
export async function listTrash() {
  const user = auth.currentUser;
  if (!isTeacherUser(user)) throw new Error('교사 권한이 필요합니다.');
  const overrideMap = await fetchAllOverrideNames();
  const snap = await getDocs(query(trashCol(), orderBy('trashed_at', 'desc'), limit(500)));
  const rows = [];
  snap.forEach(d => {
    const r = d.data();
    rows.push({
      id: d.id,
      trashed_at: formatDateTime(toDate(r.trashed_at)),
      trashed_by: str(r.trashed_by),
      submitted_at: formatDateTime(toDate(r.submitted_at)),
      class_id: str(r.class_id),
      student_name: str(overrideMap[str(r.student_id)] || r.student_name),
      record_no: str(r.record_no),
      activity_today: str(r.activity_today),
      inquiry_question: str(r.inquiry_question),
      agency_score: str(r.agency_score)
    });
  });
  return { ok: true, rows };
}

// 교사: 선택한 휴지통 기록을 원래 컬렉션으로 복원.
export async function restoreResponses(ids) {
  const user = auth.currentUser;
  if (!isTeacherUser(user)) throw new Error('교사 계정만 복원할 수 있습니다.');
  const list = cleanIds(ids);
  if (!list.length) throw new Error('선택된 기록이 없습니다.');

  let restored = 0;
  for (const part of chunkList(list, 150)) {
    const snaps = await Promise.all(part.map(id => getDoc(trashRef(id))));
    const batch = writeBatch(db);
    snaps.forEach((snap, i) => {
      if (!snap.exists()) return;
      const data = Object.assign({}, snap.data());
      delete data.trashed_at;
      delete data.trashed_by;
      batch.set(doc(db, RESPONSES_COLLECTION, part[i]), data);
      batch.delete(trashRef(part[i]));
      restored++;
    });
    await batch.commit();
  }
  return { ok: true, count: restored };
}

// 교사: 휴지통에서 영구 삭제 (선택 또는 전체).
export async function purgeTrash(ids) {
  const user = auth.currentUser;
  if (!isTeacherUser(user)) throw new Error('교사 계정만 영구 삭제할 수 있습니다.');
  let list = cleanIds(ids);
  if (!list.length) throw new Error('선택된 기록이 없습니다.');

  let purged = 0;
  for (const part of chunkList(list, 400)) {
    const batch = writeBatch(db);
    part.forEach(id => { batch.delete(trashRef(id)); purged++; });
    await batch.commit();
  }
  return { ok: true, count: purged };
}

// 교사: 휴지통 전체 비우기.
export async function emptyTrash() {
  const user = auth.currentUser;
  if (!isTeacherUser(user)) throw new Error('교사 계정만 휴지통을 비울 수 있습니다.');
  const snap = await getDocs(trashCol());
  const ids = [];
  snap.forEach(d => ids.push(d.id));
  if (!ids.length) return { ok: true, count: 0 };
  return purgeTrash(ids);
}

// ===================== 구글 시트 내보내기 =====================
//
// 선택한 기간/학급 범위의 응답을 Apps Script 웹앱으로 보내, 시트를 통째로 새로 씁니다.
// (매번 덮어쓰기라 중복 행이 생기지 않습니다.) 범위를 비우면(전체) 모든 기록을 내보냅니다.

export async function exportToSheet(params) {
  params = params || {};
  if (!SHEETS_WEBAPP_URL) {
    throw new Error('config.js 의 SHEETS_WEBAPP_URL 이 비어 있습니다. Apps Script 배포 후 URL 을 넣어 주세요.');
  }
  const user = auth.currentUser;
  if (!isTeacherUser(user)) {
    throw new Error('교사 계정으로 로그인해야 내보낼 수 있습니다.');
  }

  const overrideMap = await fetchAllOverrideNames();

  const filterClassId = str(params.classId);
  const startDate = toDate(params.start);
  const endDate = toDate(params.end);
  const constraints = [];
  if (filterClassId) constraints.push(where('class_id', '==', filterClassId));
  if (startDate) constraints.push(where('submitted_at', '>=', Timestamp.fromDate(startDate)));
  if (endDate) constraints.push(where('submitted_at', '<', Timestamp.fromDate(endDate)));

  const snap = await getDocs(query(responsesCol(), ...constraints));
  let rows = [];
  snap.forEach(d => rows.push(d.data()));
  if (params.activityText) {
    const a = str(params.activityText);
    rows = rows.filter(r => str(r.activity_today).indexOf(a) !== -1);
  }
  rows.sort((a, b) => (toDate(b.submitted_at) || 0) - (toDate(a.submitted_at) || 0));

  // 차시는 저장값 대신 학생별 제출 순서로 계산해 내보낸다(대시보드 표시와 동일 기준).
  const seqByStudent = sequenceByStudent(rows);

  const header = [
    '제출시간', '학급', '이름', '차시', '활동', '질문출처',
    '탐구질문', '해본방법', '결과/과정피드백', '다음질문', '주도성', 'SEL역량'
  ];
  const body2d = rows.map(r => [
    formatDateTime(toDate(r.submitted_at)),
    str(r.class_id),
    str(overrideMap[str(r.student_id)] || r.student_name),
    seqByStudent.get(r) ? seqByStudent.get(r) + '번째 기록' : str(r.record_no),
    str(r.activity_today),
    sourceLabel(str(r.question_source)),
    str(r.inquiry_question),
    normalizeArray(r.method_labels).join(', '),
    str(r.evidence_result),
    str(r.next_try),
    str(r.agency_score),
    normalizeArray(r.sel_competency_labels || []).join(', ') || str(r.sel_competency_label)
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
