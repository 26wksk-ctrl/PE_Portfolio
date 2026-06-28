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
  initializeFirestore, memoryLocalCache, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, addDoc, setDoc, getDoc, getDocs, deleteDoc, writeBatch, onSnapshot,
  query, where, orderBy, limit, serverTimestamp, Timestamp,
  getCountFromServer, getAggregateFromServer, average
} from 'firebase/firestore';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signOut, onAuthStateChanged,
  setPersistence, browserLocalPersistence
} from 'firebase/auth';
import {
  getDatabase, ref as rtdbRef, set as rtdbSet, get as rtdbGet
} from 'firebase/database';

import {
  firebaseConfig, APP_VERSION, TEACHER_EMAILS, RESPONSES_COLLECTION,
  STUDENTS_COLLECTION, TRASH_COLLECTION, SITE_CONFIG_COLLECTION, SITE_CONFIG_DOC,
  LESSON_SETTINGS_DOC, SHARE_SETTINGS_DOC, APP_CHECK_SITE_KEY,
  STUDENT_ROSTER_COLLECTION, USERS_COLLECTION, SHEETS_WEBAPP_URL,
  RTDB_PUBLIC_LIST_PATH
} from './config.js';
import {
  getActiveSessions, findSession, getActiveQuestions, getOptions, getOptionLabel
} from './seed-data.js';
import {
  str, normalizeArray, formatDateTime, incCount, countsToArray, sourceLabel,
  sanitizeStudentName, parseStudentId, normalizeEmail, getQueryParam
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

// 로컬 캐시는 "어느 화면이냐"에 따라 다르게 둔다.
//
// - 학생 화면(기본): memoryLocalCache.
//     학교/공용 기기에서 로그아웃 뒤 학생 기록이 IndexedDB에 남지 않도록 메모리 캐시만 쓴다.
//     새로고침하면 캐시는 사라진다. (프라이버시 우선)
//
// - 교사 화면(?teacher=1 또는 ?mode=teacher): persistentLocalCache(IndexedDB).
//     교사는 보통 한 기기에서 하루에 여러 번(예: 1시간 간격) 접속한다. 영구 캐시가 있으면
//     onSnapshot 이 매 접속마다 전체 범위를 다시 읽지 않고, 지난 접속 이후 바뀐 문서(델타)만
//     읽어 Firestore 읽기 비용을 크게 줄인다. (교사 본인 기기 기준)
//     ※ 같은 화면을 여러 탭으로 열어도 깨지지 않도록 multiple-tab manager 를 쓴다.
//     ※ 교사 화면에서만 켜지므로, 학생 공용 기기의 IndexedDB 에는 데이터가 남지 않는다.
const isTeacherView = getQueryParam('teacher') === '1' || getQueryParam('mode') === 'teacher';
const db = initializeFirestore(app, {
  localCache: isTeacherView
    ? persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    : memoryLocalCache()
});

const auth = getAuth(app);
auth.languageCode = 'ko';
const googleProvider = new GoogleAuthProvider();

// 로그인 유지 방식을 명시한다. 일부 모바일/학교 브라우저에서는 기본 저장소 판정이
// 불안정해 계정 선택 후 원래 화면으로 돌아와도 상태 반영이 늦거나 실패할 수 있다.
// local persistence 설정이 실패해도 로그인 자체는 계속 시도한다.
const authPersistencePromise = setPersistence(auth, browserLocalPersistence).catch(err => {
  console.warn('[auth] 로그인 저장소 설정 실패(계속 진행):', err);
  return null;
});

function responsesCol() {
  return collection(db, RESPONSES_COLLECTION);
}

// ===================== 학생 명단 & 프로필 연결 (student_roster / users) =====================
//
// 구글 로그인은 본인 확인용으로만 쓰고, 실제 식별은 앱 내부 프로필(student_roster)을 사용한다.
// 학생 → 처음 한 번만 학번+이름을 입력해 본인 항목을 연결(claim). 이후 모든 기록에 반영.
// 교사 → 잘못 연결된 계정을 해제(unclaim)하고 다시 등록 가능하게 할 수 있다.

function studentRosterCol() { return collection(db, STUDENT_ROSTER_COLLECTION); }
function studentRosterRef(studentId) { return doc(db, STUDENT_ROSTER_COLLECTION, str(studentId)); }
function usersRef(uid) { return doc(db, USERS_COLLECTION, str(uid)); }

// 로그인한 사용자의 연결된 학생 프로필을 반환한다. 연결 없으면 null.
export async function getLinkedStudentProfile() {
  const user = auth.currentUser;
  if (!user) return null;
  try {
    const userSnap = await getDoc(usersRef(user.uid));
    if (!userSnap.exists()) return null;
    const studentId = str(userSnap.data().studentId);
    if (!studentId) return null;
    const rosterSnap = await getDoc(studentRosterRef(studentId));
    return rosterSnap.exists() ? rosterSnap.data() : null;
  } catch (e) {
    console.warn('[roster] 연결 프로필 조회 실패:', e);
    return null;
  }
}

// 학생이 학번+이름(+등록코드)을 입력해 본인 항목을 연결(claim)한다.
// 이미 연결된 계정이 있거나, 이름·코드가 맞지 않으면 에러를 던진다.
export async function claimStudentProfile(studentId, name, registrationCode) {
  const user = auth.currentUser;
  if (!user) throw new Error('먼저 구글 로그인을 해주세요.');

  const sid = str(studentId).trim();
  const sname = str(name).trim();
  if (!sid || sid.length !== 5 || !/^\d{5}$/.test(sid)) throw new Error('학번은 숫자 5자리입니다. 다시 확인해 주세요.');
  if (!sname) throw new Error('이름을 입력해 주세요.');

  // 이 UID가 이미 연결되어 있는지 확인
  const userSnap = await getDoc(usersRef(user.uid));
  if (userSnap.exists()) throw new Error('이미 학생 정보가 연결되어 있습니다. 문제가 있으면 선생님께 문의하세요.');

  // roster에서 학번 조회
  const rosterSnap = await getDoc(studentRosterRef(sid));
  if (!rosterSnap.exists()) throw new Error('학번을 찾을 수 없습니다. 학번을 다시 확인하거나 선생님께 문의하세요.');

  const rd = rosterSnap.data();
  if (rd.isClaimed) throw new Error('이미 다른 계정으로 등록된 학번입니다. 잘못된 경우 선생님께 문의하세요.');
  if (rd.status && rd.status !== 'active') throw new Error('등록이 비활성화된 학번입니다. 선생님께 문의하세요.');
  if (str(rd.name) !== sname) throw new Error('이름이 일치하지 않습니다. 학생 명부의 이름을 정확히 입력해 주세요.');
  // 등록 코드가 roster에 있으면 확인
  if (rd.registrationCode) {
    const inputCode = str(registrationCode).trim();
    if (!inputCode) throw new Error('선생님이 알려준 등록 코드 4자리를 입력해 주세요.');
    if (rd.registrationCode !== inputCode) throw new Error('등록 코드가 맞지 않습니다. 다시 확인해 주세요.');
  }

  // batch: roster 연결 + users 문서 생성
  const batch = writeBatch(db);
  batch.update(studentRosterRef(sid), {
    linkedUid: user.uid,
    linkedEmail: str(user.email),
    isClaimed: true,
    claimedAt: serverTimestamp()
  });
  batch.set(usersRef(user.uid), {
    uid: user.uid,
    email: str(user.email),
    role: 'student',
    studentId: sid,
    createdAt: serverTimestamp()
  });
  await batch.commit();

  return { ok: true, studentId: sid, name: str(rd.name), displayName: str(rd.displayName || rd.name) };
}

// 교사: 학생 연결 해제. roster의 linkedUid/Email/isClaimed를 초기화하고 users 문서를 삭제.
export async function unclaimStudentProfile(studentId) {
  const user = auth.currentUser;
  if (!isTeacherUser(user)) throw new Error('교사 계정만 연결을 해제할 수 있습니다.');
  const sid = str(studentId).trim();
  const rosterSnap = await getDoc(studentRosterRef(sid));
  if (!rosterSnap.exists()) throw new Error('학생을 찾을 수 없습니다.');
  const rd = rosterSnap.data();
  const linkedUid = str(rd.linkedUid || '');

  const batch = writeBatch(db);
  batch.update(studentRosterRef(sid), {
    linkedUid: null, linkedEmail: null, isClaimed: false, claimedAt: null
  });
  if (linkedUid) batch.delete(usersRef(linkedUid));
  await batch.commit();
  return { ok: true };
}

// 교사: 전체 학생 명단 조회.
export async function getStudentRoster() {
  const user = auth.currentUser;
  if (!isTeacherUser(user)) throw new Error('교사 계정만 학생 명단을 볼 수 있습니다.');
  const snap = await getDocs(studentRosterCol());
  const rows = [];
  snap.forEach(d => rows.push(Object.assign({ _id: d.id }, d.data())));
  rows.sort((a, b) =>
    String(a.className || '').localeCompare(String(b.className || ''), 'ko') ||
    (Number(a.studentNumber) - Number(b.studentNumber))
  );
  return rows;
}

// 교사: 학생 한 명을 명단에 추가.
// 학번 5자리(학년+반+번호)에서 반·번호를 자동 분해하므로, 교사는 학번+이름만 넣으면 된다.
// email(학교 구글 계정)을 함께 등록해 두면, 학생이 로그인할 때 이메일이 일치하는 항목에 자동 연결된다.
export async function addStudentToRoster(data) {
  const user = auth.currentUser;
  if (!isTeacherUser(user)) throw new Error('교사 계정만 학생을 추가할 수 있습니다.');
  const sid = str(data.studentId).trim();
  if (!sid || sid.length !== 5 || !/^\d{5}$/.test(sid)) throw new Error('학번은 숫자 5자리입니다. (학년1 + 반2 + 번호2, 예: 10418)');
  if (!data.name) throw new Error('이름이 필요합니다.');
  const existing = await getDoc(studentRosterRef(sid));
  if (existing.exists()) throw new Error(`학번 ${sid}는 이미 등록되어 있습니다.`);

  // 학번에서 반·번호 자동 분해. (교사가 따로 입력하지 않아도 됨)
  const parsed = parseStudentId(sid) || { className: '', studentNumber: 0 };
  const className = parsed.className;
  const studentNumber = parsed.studentNumber;
  const displayName = str(data.displayName || (className ? `${className} ${studentNumber}번 ${data.name}` : data.name));
  const email = normalizeEmail(data.email);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('이메일 형식이 올바르지 않습니다. (자동 연결용 학교 구글 계정)');

  await setDoc(studentRosterRef(sid), {
    studentId: sid,
    className,
    classNumber: parsed.classNo || 0,
    studentNumber,
    name: str(data.name),
    displayName,
    email: email || null,
    registrationCode: data.registrationCode ? str(data.registrationCode).slice(0, 4) : null,
    linkedUid: null, linkedEmail: null, isClaimed: false, claimedAt: null,
    status: 'active',
    createdAt: serverTimestamp(),
    createdBy: str(user.email)
  });
  return { ok: true, studentId: sid };
}

// 교사: 학생 등록 코드 설정/초기화.
export async function setStudentRegistrationCode(studentId, code) {
  const user = auth.currentUser;
  if (!isTeacherUser(user)) throw new Error('교사 계정만 등록 코드를 설정할 수 있습니다.');
  const sid = str(studentId).trim();
  await setDoc(studentRosterRef(sid), {
    registrationCode: code ? str(code).slice(0, 4) : null
  }, { merge: true });
  return { ok: true };
}

// 교사: 학생의 자동 연결용 이메일(학교 구글 계정) 설정/초기화.
// 이미 다른 계정과 연결(isClaimed)된 학생은 먼저 연결을 해제해야 안전하게 바꿀 수 있다.
export async function setStudentEmail(studentId, email) {
  const user = auth.currentUser;
  if (!isTeacherUser(user)) throw new Error('교사 계정만 이메일을 설정할 수 있습니다.');
  const sid = str(studentId).trim();
  const norm = normalizeEmail(email);
  if (norm && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(norm)) throw new Error('이메일 형식이 올바르지 않습니다.');
  await setDoc(studentRosterRef(sid), { email: norm || null }, { merge: true });
  return { ok: true, studentId: sid, email: norm || null };
}

// 학생: 로그인한 구글 계정의 이메일과 일치하는 명단 항목을 찾아 자동으로 연결(claim)한다.
//   - 교사가 명단에 email 을 미리 등록해 두면, 학생은 타이핑 없이 로그인만 하면 연결된다.
//   - 결과: { ok, studentId, name, displayName } 또는 { ok:false, reason } (미등록/이미연결/충돌)
// 이미 users/{uid} 가 있으면(이미 연결됨) 그 프로필을 그대로 돌려준다.
export async function autoLinkByEmail() {
  const user = auth.currentUser;
  if (!user) return { ok: false, reason: 'not-signed-in' };

  // 이미 연결되어 있으면 그대로 사용
  const existingUser = await getDoc(usersRef(user.uid));
  if (existingUser.exists()) {
    const linked = await getLinkedStudentProfile();
    if (linked) return { ok: true, studentId: linked.studentId, name: str(linked.name), displayName: str(linked.displayName || linked.name) };
  }

  const myEmail = normalizeEmail(user.email);
  if (!myEmail) return { ok: false, reason: 'no-email' };

  // 명단에서 이메일이 일치하는 항목 조회
  const snap = await getDocs(query(studentRosterCol(), where('email', '==', myEmail)));
  if (snap.empty) return { ok: false, reason: 'not-registered' };

  // 같은 이메일이 여러 건이면(설정 오류) 자동 연결하지 않고 교사 확인을 요청
  if (snap.size > 1) return { ok: false, reason: 'duplicate-email' };

  const docSnap = snap.docs[0];
  const rd = docSnap.data();
  const sid = str(rd.studentId || docSnap.id);

  if (rd.isClaimed) {
    // 본인 계정으로 이미 연결된 경우는 정상, 다른 계정이면 충돌
    if (str(rd.linkedUid) === user.uid) {
      return { ok: true, studentId: sid, name: str(rd.name), displayName: str(rd.displayName || rd.name), className: str(rd.className), studentNumber: rd.studentNumber || '' };
    }
    return { ok: false, reason: 'already-claimed' };
  }
  if (rd.status && rd.status !== 'active') return { ok: false, reason: 'inactive' };

  // batch: roster 연결 + users 문서 생성 (claimStudentProfile 과 동일한 화이트리스트)
  // ※ linkedEmail 은 반드시 "원본" 이메일(user.email)로 저장한다.
  //    firestore.rules 가 linkedEmail == request.auth.token.email(원본)을 요구하므로,
  //    소문자로 정규화한 값을 쓰면 대문자가 섞인 계정에서 쓰기가 거부되어 자동 연결이 실패한다.
  const batch = writeBatch(db);
  batch.update(studentRosterRef(sid), {
    linkedUid: user.uid,
    linkedEmail: str(user.email),
    isClaimed: true,
    claimedAt: serverTimestamp()
  });
  batch.set(usersRef(user.uid), {
    uid: user.uid,
    email: str(user.email),
    role: 'student',
    studentId: sid,
    createdAt: serverTimestamp()
  });
  await batch.commit();

  return { ok: true, studentId: sid, name: str(rd.name), displayName: str(rd.displayName || rd.name), className: str(rd.className), studentNumber: rd.studentNumber || '' };
}

// 교사: 학생 명단에서 삭제 (roster 항목 및 연결된 users 문서 제거).
export async function removeStudentFromRoster(studentId) {
  const user = auth.currentUser;
  if (!isTeacherUser(user)) throw new Error('교사 계정만 학생을 삭제할 수 있습니다.');
  const sid = str(studentId).trim();
  const rosterSnap = await getDoc(studentRosterRef(sid));
  if (!rosterSnap.exists()) throw new Error('학생을 찾을 수 없습니다.');
  const rd = rosterSnap.data();
  const linkedUid = str(rd.linkedUid || '');
  const batch = writeBatch(db);
  batch.delete(studentRosterRef(sid));
  if (linkedUid) batch.delete(usersRef(linkedUid));
  await batch.commit();
  return { ok: true };
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

// 로그인한 본인의 프로필(표시 이름 + 학급 + 연결된 학생 정보)을 반환한다.
//   - linkedProfile: student_roster 연결 정보 (없으면 null → 등록 화면을 보여줘야 함)
//   - displayName: 연결 프로필 이름 → 교사 보정 이름 → 구글 프로필 이름
//   - class: 교사 보정 학급(우선) → 본인이 마지막으로 고른 반 → 없으면 null
export async function getMyProfile() {
  const user = auth.currentUser;
  if (!user) return { displayName: '', class: null, linkedProfile: null };

  // 연결된 학생 프로필 우선 확인 (users/{uid} + student_roster/{studentId})
  const linkedProfile = await getLinkedStudentProfile();

  const ov = await fetchStudentOverride(user.uid);
  const displayName = linkedProfile
    ? str(linkedProfile.displayName || linkedProfile.name)
    : ((ov && ov.name) ? ov.name : str(user.displayName || user.email || ''));

  let cls = null;
  if (ov && ov.session_id) {
    const session = findSession(ov.session_id);
    if (session) cls = { session_id: session.sessionId, class_id: session.classId, source: 'teacher' };
  }
  if (!cls && ov && ov.self_session_id) {
    const session = findSession(ov.self_session_id);
    if (session) cls = { session_id: session.sessionId, class_id: session.classId, source: 'self' };
  }
  return { displayName, class: cls, linkedProfile: linkedProfile || null };
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
      reflection: str(r.reflection_text),
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
const redirectResultPromise = authPersistencePromise.then(() => getRedirectResult(auth)).catch(err => {
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

function isRedirectSafeHere() {
  const host = (window.location && window.location.hostname) ? window.location.hostname.toLowerCase() : '';
  const authHost = String(firebaseConfig.authDomain || '').trim().toLowerCase();
  return !authHost || host === authHost;
}

function shouldPreferRedirect() {
  const ua = (navigator && navigator.userAgent) ? navigator.userAgent : '';
  // 모바일/인앱 브라우저는 팝업 결과 전달이 불안정한 경우가 많아서 처음부터 redirect를 쓴다.
  return /Android|iPhone|iPad|iPod|Mobile|KAKAOTALK|Line\/|FBAN|FBAV|Instagram|; wv\)/i.test(ua);
}

async function signInWithRedirectSafely() {
  if (!isRedirectSafeHere()) {
    const e = new Error('현재 주소와 Firebase authDomain이 달라 redirect 로그인 결과를 안정적으로 받을 수 없습니다. Firebase Hosting 주소에서 열어 주세요.');
    e.code = 'auth/redirect-domain-mismatch';
    throw e;
  }
  await signInWithRedirect(auth, googleProvider);
  return null;
}

// 로그인 상태 변화를 구독. callback(user|null) 형태로 호출됨.
export function watchAuth(callback) {
  const unsubscribe = onAuthStateChanged(auth, callback);
  // 일부 브라우저에서 redirect 직후 authState 콜백이 늦게 오거나 UI가 먼저 그려지는 경우가 있어
  // redirect 결과가 있으면 한 번 더 명시적으로 화면 갱신을 요청한다.
  redirectResultPromise.then(result => {
    if (result && result.user) callback(result.user);
  });
  return unsubscribe;
}

export async function signInWithGoogle() {
  await authPersistencePromise;

  // 모바일에서는 팝업을 먼저 띄우지 않고 redirect로 간다.
  // 증상: 계정 선택 창은 뜨는데 선택 후 원래 화면에 로그인 상태가 반영되지 않음.
  if (shouldPreferRedirect()) {
    console.warn('[auth] 모바일/인앱 브라우저 감지 → 리다이렉트 로그인 사용');
    return signInWithRedirectSafely();
  }

  // 데스크톱은 팝업 우선, 실패 시 redirect 폴백.
  try {
    const result = await signInWithPopup(auth, googleProvider);
    return result.user;
  } catch (err) {
    if (isPopupFallbackError(err)) {
      console.warn('[auth] 팝업 로그인 실패 → 리다이렉트 방식으로 전환:', err.code);
      return signInWithRedirectSafely();
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
// 문서가 없거나 active 가 boolean 이 아니면 "켜짐" 으로 간주하고, active === false 일 때만 닫습니다.

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
      // Rules와 같은 기준: site 문서가 없거나 active가 boolean false가 아니면 열린 상태로 본다.
      // 교사가 명시적으로 사이트를 끈 경우(active === false)에만 학생 화면을 닫는다.
      callback(!data || data.active !== false);
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
  // merge:true를 쓰면 예전에 잘못 들어간 여분 필드가 남아 Rules의 hasOnly 검증을 계속 깨뜨릴 수 있다.
  // 사이트 상태 문서는 허용 필드 3개만 남도록 항상 전체 교체한다.
  await setDoc(
    siteConfigRef(),
    {
      active: !!active,
      updated_at: serverTimestamp(),
      updated_by: str(user.email)
    }
  );
  return { ok: true, active: !!active };
}

// 교사 화면 진입 시 사이트 상태 문서를 자동 점검/복구한다.
// - 문서가 없거나 active가 boolean이 아니면 defaultActive로 새로 만든다.
// - active가 이미 boolean이어도 같은 값을 다시 써서, 오래된/꼬인 상태 문서를 정상 스키마로 정리한다.
// - 학생은 이 함수를 호출해도 쓰기 권한이 없으며, 교사 계정에서만 작동한다.
export async function ensureSiteStatusDocument(defaultActive) {
  const user = auth.currentUser;
  if (!isTeacherUser(user)) return { ok: false, reason: 'not-teacher' };

  const fallback = defaultActive === undefined ? true : !!defaultActive;
  const snap = await getDoc(siteConfigRef());
  const data = snap.exists() ? snap.data() : null;
  const hasBooleanActive = !!(data && typeof data.active === 'boolean');
  const active = hasBooleanActive ? data.active : fallback;

  await setDoc(siteConfigRef(), {
    active,
    updated_at: serverTimestamp(),
    updated_by: str(user.email)
  });

  return {
    ok: true,
    active,
    repaired: !snap.exists() || !hasBooleanActive,
    refreshed: snap.exists() && hasBooleanActive
  };
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

// 수업 설정 변화를 실시간 구독한다. callback(rawDataOrNull) 형태로 호출됨. 반환값은 구독 해제 함수.
// 사이트 상태(watchSiteStatus)처럼 실시간으로 반영해, 교사가 입력 잠금(inputEnabled)이나
// 수업 옵션을 바꾸면 학생이 새로고침/사이트 재토글 없이도 즉시 반영되도록 한다.
// 읽기는 누구나 가능(app_config/lesson: read true)하며, 실패 시 null(기본값)으로 fail-open 한다.
export function watchLessonSettings(callback) {
  return onSnapshot(
    lessonSettingsRef(),
    snap => callback(snap.exists() ? snap.data() : null),
    err => {
      console.warn('[lesson] 설정 구독 오류:', err);
      callback(null);
    }
  );
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

// ===================== 우리반 공유 대시보드 (익명·집계) =====================
//
// 학생은 보안 규칙상 같은 반 친구들의 기록을 직접 읽을 수 없다(개인정보 보호).
// 그래서 교사가 ?teacher=1 대시보드를 열 때, 화면이 이미 읽어 둔 기록으로 "익명 집계"만
// 공개 문서(app_config/share)에 자동 발행한다(교사가 따로 발행 버튼을 누르지 않아도 됨).
// 담는 값은 학급별 집계뿐이며 이름·피드백 원문·주도성 점수 같은 민감 정보는 절대 넣지 않는다.

function shareRef() {
  return doc(db, SITE_CONFIG_COLLECTION, SHARE_SETTINGS_DOC);
}

// 읽은 기록들(rows)로 학급별 익명 집계를 만든다. (개인 식별 정보 제외)
//   - top_goals  : 많이 고른 목표·질문 (inquiry_question 빈도 상위)
//   - top_methods: 많이 해본 방법 (method_labels 빈도 상위)
//   - top_sel    : 많이 발휘한 SEL 역량 (참고용 집계, 순위·점수 아님)
function buildClassShare(rows) {
  const byClassMap = {};
  rows.forEach(row => {
    const cls = str(row.class_id);
    if (!cls) return;
    const b = byClassMap[cls] || (byClassMap[cls] = { count: 0, goals: {}, methods: {}, sels: {} });
    b.count++;
    const q = str(row.inquiry_question);
    if (q) incCount(b.goals, q);
    normalizeArray(row.method_labels).forEach(l => { if (l) incCount(b.methods, l); });
    const sels = row.sel_competency_labels
      ? normalizeArray(row.sel_competency_labels)
      : [str(row.sel_competency_label)].filter(Boolean);
    sels.forEach(l => { if (l) incCount(b.sels, l); });
  });

  const topN = (obj, n) => countsToArray(obj).slice(0, n).map(x => ({ label: str(x.label), count: x.count }));
  const byClass = {};
  Object.keys(byClassMap).forEach(cls => {
    const b = byClassMap[cls];
    byClass[cls] = {
      count: b.count,
      top_goals: topN(b.goals, 5),
      top_methods: topN(b.methods, 5),
      top_sel: topN(b.sels, 5)
    };
  });
  return byClass;
}

// 익명 집계를 공개 문서에 발행(교사만). 실패해도 대시보드 흐름을 막지 않으므로 호출 측에서 await 하지 않는다.
async function saveClassShare(byClass) {
  const user = auth.currentUser;
  if (!isTeacherUser(user)) return { ok: false };
  try {
    await setDoc(shareRef(), {
      by_class: byClass || {},
      updated_at: serverTimestamp(),
      updated_by: str(user.email)
    });
    return { ok: true };
  } catch (e) {
    console.warn('[share] 공유 대시보드 자동 발행 실패:', e);
    return { ok: false };
  }
}

// 학생/교사 화면이 공유 대시보드를 1회 읽어 온다(없으면 null). 로그인 사용자만 읽을 수 있다.
export async function getClassShare() {
  const snap = await getDoc(shareRef());
  return snap.exists() ? snap.data() : null;
}

// ===================== Realtime Database 공유 미러 (Firestore 읽기 절감) =====================
//
// 위 익명 집계(by_class)를 RTDB(public/list)에도 그대로 미러해 둔다.
//   - 원본/폴백 : Firestore(app_config/share). RTDB 가 꺼져 있거나 실패하면 여기로 폴백한다.
//   - 미러      : RTDB(public/list). 학생은 여기서 먼저 읽어 Firestore 읽기를 RTDB 대역폭 읽기로 옮긴다.
//   - 동기화    : Cloud Function 없이 교사 대시보드(교사 권한 클라이언트)가 집계를 다시 만들 때마다 함께 쓴다.
//                (교사 대시보드가 열려 있거나 다시 열릴 때 제출/수정/삭제가 반영된다.)
//   - 권한      : 쓰기=교사만(클라이언트 + database.rules.json 이중 게이트), 읽기=로그인 사용자만.
//
// databaseURL(config.js)이 비어 있으면 미러는 "꺼짐" 상태이고, 모든 동작은 기존 Firestore 흐름 그대로다.

let _rtdb = null;
let _rtdbInitTried = false;

// RTDB 를 쓸 수 있는 환경인지. databaseURL 이 채워졌을 때만 켜진다.
export function isShareMirrorEnabled() {
  return !!str(firebaseConfig.databaseURL);
}

// RTDB 인스턴스를 (한 번만) 초기화한다. 꺼져 있거나 실패하면 null 을 돌려 폴백하게 한다.
function getRtdb() {
  if (_rtdb || _rtdbInitTried) return _rtdb;
  _rtdbInitTried = true;
  if (!isShareMirrorEnabled()) return null;
  try {
    _rtdb = getDatabase(app);
  } catch (e) {
    console.warn('[rtdb] 초기화 실패(Firestore 폴백 사용):', e);
    _rtdb = null;
  }
  return _rtdb;
}

// 교사: 익명 집계를 RTDB 미러에 발행한다. 실패해도 대시보드 흐름을 막지 않는다(fire-and-forget).
async function saveClassShareToMirror(byClass) {
  const database = getRtdb();
  if (!database) return { ok: false, reason: 'disabled' };
  const user = auth.currentUser;
  if (!isTeacherUser(user)) return { ok: false, reason: 'not-teacher' };
  try {
    await rtdbSet(rtdbRef(database, RTDB_PUBLIC_LIST_PATH), {
      by_class: byClass || {},
      updated_at: Date.now(),
      updated_by: str(user.email)
    });
    return { ok: true };
  } catch (e) {
    console.warn('[rtdb] 공유 미러 발행 실패(Firestore 발행은 별도로 유지됨):', e);
    return { ok: false };
  }
}

// 학생/교사 화면: 공유 집계를 1회 읽는다. RTDB 미러를 먼저 시도하고, 꺼져 있거나 실패하면 Firestore 로 폴백한다.
// 반환 형태는 Firestore 와 동일하다({ by_class, updated_at, updated_by }) — 화면 렌더는 by_class 만 쓴다.
export async function getPublicShare() {
  const database = getRtdb();
  if (database) {
    try {
      const snap = await rtdbGet(rtdbRef(database, RTDB_PUBLIC_LIST_PATH));
      if (snap.exists()) return snap.val();
      // 미러가 아직 비어 있으면(교사 대시보드가 한 번도 안 열림) Firestore 폴백으로 채운다.
    } catch (e) {
      console.warn('[rtdb] 공유 미러 읽기 실패(Firestore 로 폴백):', e);
    }
  }
  return getClassShare();
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
  // 읽기 절감: 예전처럼 본인의 해당 반 기록 전체를 읽지 않고,
  // 현재 세션의 최신 기록 몇 건만 본다. 보통 1~3건이면 충분하지만 서버 시간 지연/빈 next_try를 고려해 10건으로 제한.
  const snap = await getDocs(query(
    responsesCol(),
    where('student_id', '==', studentId),
    where('class_id', '==', session.classId),
    where('session_id', '==', session.sessionId),
    orderBy('submitted_at', 'desc'),
    limit(10)
  ));
  const rows = [];
  snap.forEach(d => rows.push(d.data()));

  for (const row of rows) {
    const nextTry = str(row.next_try);
    if (nextTry) {
      return { ok: true, found: true, next_try: nextTry, submitted_at: formatDateTime(toDate(row.submitted_at)) };
    }
  }
  return { ok: true, found: false };
}


// --- 제출 permission-denied 진단/예방용 ---
// Firestore Rules는 어느 조건이 실패했는지 알려주지 않으므로,
// addDoc 직전 payload와 클라이언트 기준 사전 점검 결과를 콘솔에 남긴다.
// 또한 lessonSettings에서 예전 방식(code=label)으로 저장된 긴 선택지 코드가 있더라도
// 제출 문서에는 Rules를 통과할 수 있는 짧고 안전한 code로 정규화한다.
function submitSafeOptionToken(value, fallback) {
  const v = str(value);
  if (v && v.length <= 80 && !/[<>]/.test(v) && !/^[=+@-]/.test(v)) return v;
  return fallback;
}

function submitSafeCodeList(values, prefix, maxItems) {
  return normalizeArray(values)
    .slice(0, maxItems)
    .map((code, index) => submitSafeOptionToken(code, `${prefix}_${String(index + 1).padStart(2, '0')}`));
}

function submitSafeLabel(value, max, fallback) {
  let v = str(value);
  if (!v) v = fallback || '미입력';
  v = v.replace(/</g, '〈').replace(/>/g, '〉');
  if (/^[=+@-]/.test(v)) v = `'${v}`;
  return v.slice(0, max);
}

function submitSafeLabelList(values, maxItems, maxText) {
  return normalizeArray(values)
    .slice(0, maxItems)
    .map(label => submitSafeLabel(label, maxText, '미입력'))
    .filter(Boolean);
}

function submitShortString(value, max) {
  const v = str(value);
  return v.length <= max ? v : '';
}

function debugSubmitDocForConsole(record) {
  const out = Object.assign({}, record || {});
  if ('submitted_at' in out) out.submitted_at = '[serverTimestamp()]';
  return out;
}

function debugIsString(value, max, min) {
  return typeof value === 'string'
    && value.length >= (min || 0)
    && value.length <= max;
}

function debugSafeText(value, max, min) {
  return debugIsString(value, max, min || 1)
    && !/[<>]/.test(value)
    && !/^[=+@-]/.test(value);
}

function debugSafeOptionToken(value) {
  return debugSafeText(value, 80, 1);
}

function debugSafeCodeList(value, min, max) {
  if (!Array.isArray(value)) return false;
  if (value.length < min || value.length > max) return false;
  return value.every(debugSafeOptionToken);
}

function debugSafeStringList(value, maxItems, maxText) {
  if (!Array.isArray(value)) return false;
  if (value.length > maxItems) return false;
  return value.every(v => debugSafeText(v, maxText, 1));
}

function debugValidateStudentResponseDoc(record, uid) {
  const failed = [];
  const keys = Object.keys(record || {}).sort();
  const allowed = [
    'submitted_at', 'session_id', 'class_id', 'student_id', 'student_name',
    'record_no', 'record_no_value', 'activity_code', 'activity_today',
    'question_source', 'question_qid', 'inquiry_question',
    'method_codes', 'method_labels', 'evidence_result', 'next_try',
    'agency_score', 'sel_competency_codes', 'sel_competency_labels',
    'sel_competency_code', 'sel_competency_label',
    'record_type', 'feedback_mode', 'peer_feedback', 'reflection_text', 'app_version',
    'roster_student_id', 'roster_class_name', 'roster_student_number', 'roster_display_name',
    'deep_question_evolution', 'deep_question_evolution_label',
    'deep_unit_growth_code', 'deep_unit_growth_label',
    'deep_next_unit_code', 'deep_next_unit_label', 'deep_unit'
  ];
  const required = [
    'submitted_at', 'session_id', 'class_id', 'student_id', 'student_name',
    'activity_code', 'inquiry_question', 'method_codes', 'evidence_result', 'next_try',
    'agency_score', 'sel_competency_codes', 'app_version'
  ];
  const allowedSet = new Set(allowed);
  const extra = keys.filter(k => !allowedSet.has(k));
  if (extra.length) failed.push({ field: 'keys', reason: 'Rules 허용 목록에 없는 필드', value: extra });
  required.forEach(k => {
    if (!(k in record)) failed.push({ field: k, reason: '필수 필드 없음' });
  });

  if (record.student_id !== uid) failed.push({ field: 'student_id', reason: '현재 로그인 uid와 다름', value: record.student_id, uid });
  if (!debugIsString(record.session_id, 50, 1)) failed.push({ field: 'session_id', reason: '문자열 1~50자 아님', value: record.session_id });
  if (!debugIsString(record.class_id, 20, 1)) failed.push({ field: 'class_id', reason: '문자열 1~20자 아님', value: record.class_id });
  if (!debugIsString(record.student_name, 50, 1)) failed.push({ field: 'student_name', reason: '문자열 1~50자 아님', value: record.student_name });
  if ('record_no' in record && !debugIsString(record.record_no, 30, 0)) failed.push({ field: 'record_no', reason: '문자열 30자 초과', value: record.record_no });
  if ('record_no_value' in record && !(Number.isInteger(record.record_no_value) && record.record_no_value >= 1 && record.record_no_value <= 300)) failed.push({ field: 'record_no_value', reason: '정수 1~300 아님', value: record.record_no_value });
  if (!debugSafeOptionToken(record.activity_code)) failed.push({ field: 'activity_code', reason: 'safe option token 아님', value: record.activity_code });
  if ('activity_today' in record && !debugIsString(record.activity_today, 200, 1)) failed.push({ field: 'activity_today', reason: '문자열 1~200자 아님', value: record.activity_today });
  if ('question_source' in record && !['bank', 'previous', 'direct', 'manual', 'custom', 'deep', ''].includes(record.question_source)) failed.push({ field: 'question_source', reason: '허용값 아님', value: record.question_source });
  if ('question_qid' in record && !debugIsString(record.question_qid, 80, 0)) failed.push({ field: 'question_qid', reason: '문자열 80자 초과', value: record.question_qid });
  if (!debugIsString(record.inquiry_question, 1000, 1)) failed.push({ field: 'inquiry_question', reason: '문자열 1~1000자 아님', value: record.inquiry_question });
  if (!debugSafeCodeList(record.method_codes, 1, 5)) failed.push({ field: 'method_codes', reason: 'safe option token 리스트 1~5개 아님', value: record.method_codes });
  if ('method_labels' in record && !debugSafeStringList(record.method_labels, 10, 200)) failed.push({ field: 'method_labels', reason: 'safe text 리스트 아님', value: record.method_labels });
  if (!debugIsString(record.evidence_result, 2000, 1)) failed.push({ field: 'evidence_result', reason: '문자열 1~2000자 아님', value: record.evidence_result });
  if (!debugIsString(record.next_try, 1000, 1)) failed.push({ field: 'next_try', reason: '문자열 1~1000자 아님', value: record.next_try });
  if (!(Number.isInteger(record.agency_score) && record.agency_score >= 1 && record.agency_score <= 5)) failed.push({ field: 'agency_score', reason: '정수 1~5 아님', value: record.agency_score });
  if (!debugSafeCodeList(record.sel_competency_codes, 1, 3)) failed.push({ field: 'sel_competency_codes', reason: 'safe option token 리스트 1~3개 아님', value: record.sel_competency_codes });
  if ('sel_competency_labels' in record && !debugSafeStringList(record.sel_competency_labels, 10, 200)) failed.push({ field: 'sel_competency_labels', reason: 'safe text 리스트 아님', value: record.sel_competency_labels });
  if ('sel_competency_code' in record && !debugSafeText(record.sel_competency_code, 200, 1)) failed.push({ field: 'sel_competency_code', reason: 'safe text 아님', value: record.sel_competency_code });
  if ('sel_competency_label' in record && !debugSafeText(record.sel_competency_label, 200, 1)) failed.push({ field: 'sel_competency_label', reason: 'safe text 아님', value: record.sel_competency_label });
  if ('record_type' in record && !['quick', 'deep'].includes(record.record_type)) failed.push({ field: 'record_type', reason: '허용값 아님', value: record.record_type });
  if ('feedback_mode' in record && !['', 'received', 'given'].includes(record.feedback_mode)) failed.push({ field: 'feedback_mode', reason: '허용값 아님', value: record.feedback_mode });
  if ('peer_feedback' in record && !debugIsString(record.peer_feedback, 500, 0)) failed.push({ field: 'peer_feedback', reason: '문자열 500자 초과', value: record.peer_feedback });
  if ('reflection_text' in record && !debugIsString(record.reflection_text, 2000, 0)) failed.push({ field: 'reflection_text', reason: '문자열 2000자 초과', value: record.reflection_text });
  if (!debugIsString(record.app_version, 100, 1)) failed.push({ field: 'app_version', reason: '문자열 1~100자 아님', value: record.app_version });

  return {
    ok: failed.length === 0,
    failed,
    note: 'submitted_at == request.time, site.active, lesson.inputEnabled는 클라이언트에서 완전히 판정할 수 없어 Firebase 값도 함께 확인해야 합니다.'
  };
}


// --- 응답 제출 ---
export async function submitSimpleResponse(payload) {
  if (!payload) throw new Error('제출 데이터가 없습니다.');

  const user = auth.currentUser;
  if (!user) throw new Error('먼저 구글 로그인을 해주세요.');
  console.log('[submit-debug] submitSimpleResponse 시작', {
    uid: user.uid,
    email: user.email,
    payload
  });

  const session = findSession(payload.sessionId);
  if (!session) throw new Error('학급 세션을 찾을 수 없습니다.');
  if (String(session.status).toLowerCase() === 'closed') throw new Error('닫힌 세션입니다.');

  const classId = session.classId;
  const studentId = user.uid;                                  // 학생 식별 = 구글 계정 uid (변경 없음)

  // 연결된 학생 프로필이 있으면 그 정보를 사용하고, 없으면 기존 방식(교사 보정/구글 이름)으로 폴백.
  console.log('[submit-debug] 연결 프로필 조회 시작');
  const linkedProfile = await getLinkedStudentProfile();
  console.log('[submit-debug] 연결 프로필 조회 완료', linkedProfile ? {
    studentId: str(linkedProfile.studentId || ''),
    className: str(linkedProfile.className || ''),
    studentNumber: linkedProfile.studentNumber || ''
  } : null);
  let studentName, rosterStudentId = null, rosterClassName = null, rosterStudentNumber = null, rosterDisplayName = null;
  if (linkedProfile) {
    studentName = str(linkedProfile.name).slice(0, 50);
    rosterStudentId = str(linkedProfile.studentId || '');
    rosterClassName = str(linkedProfile.className || '');
    rosterStudentNumber = Number(linkedProfile.studentNumber) || null;
    rosterDisplayName = str(linkedProfile.displayName || linkedProfile.name);
  } else {
    console.log('[submit-debug] 보정 이름 조회 시작');
    const overrideName = await fetchStudentOverrideName(studentId);
    console.log('[submit-debug] 보정 이름 조회 완료', { hasOverrideName: !!overrideName });
    studentName = str(overrideName || user.displayName || user.email || '이름없음').slice(0, 50);
  }

  const rawActivityCode = str(payload.activityCode);
  const activityCode = submitSafeOptionToken(rawActivityCode, 'activity_custom');
  const activityOtherText = str(payload.activityOtherText || '');
  const question = payload.question || {};
  const questionText = str(question.text).slice(0, 1000);
  const questionSourceRaw = str(question.source || 'bank');
  const questionSource = ['bank', 'previous', 'direct', 'manual', 'custom', 'deep', ''].includes(questionSourceRaw)
    ? questionSourceRaw
    : 'bank';
  const questionQid = submitShortString(question.qid || '', 80);
  const rawMethodCodes = normalizeArray(payload.methodCodes);
  const methodCodes = submitSafeCodeList(rawMethodCodes, 'method', 5);
  const evidenceResult = str(payload.evidenceResult).slice(0, 2000);
  const nextTry = str(payload.nextTry).slice(0, 1000);
  const agencyScore = Number(payload.agencyScore);
  const rawSelCodes = normalizeArray(payload.selCompetencyCodes || (payload.selCompetencyCode ? [payload.selCompetencyCode] : []));
  const selCodes = submitSafeCodeList(rawSelCodes, 'sel', 3);
  // 2분 기록(quick) 화면에서 들어오는 새 필드들. 기존 기록과의 호환을 위해 모두 선택적으로 처리한다.
  const recordTypeRaw = str(payload.recordType || 'quick');
  const recordType = recordTypeRaw === 'deep' ? 'deep' : 'quick';
  const feedbackModeRaw = str(payload.feedbackMode || '');
  const feedbackMode = ['received', 'given'].includes(feedbackModeRaw) ? feedbackModeRaw : '';           // 'received' | 'given'
  const peerFeedback = str(payload.peerFeedback || '').slice(0, 500); // 친구 피드백 한 줄 (선택)
  const reflectionText = str(payload.reflectionText || '').slice(0, 2000); // 선택값으로 조립한 요약 문장

  const missing = [];
  if (!activityCode) missing.push('오늘 활동');
  if (rawActivityCode === 'other' && !activityOtherText) missing.push('기타 활동 내용');
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
  const activityTodayRaw = (rawActivityCode === 'other' && activityOtherText)
    ? activityOtherText
    : (str(payload.activityLabel) || getOptionLabel('activities', rawActivityCode));
  const activityToday = str(activityTodayRaw || rawActivityCode || '활동').slice(0, 200);
  const rawMethodLabels = payloadMethodLabels.length
    ? payloadMethodLabels
    : rawMethodCodes.map(code => getOptionLabel('practice_methods', code)).filter(Boolean);
  const rawSelLabels = payloadSelLabels.length
    ? payloadSelLabels
    : rawSelCodes.map(code => getOptionLabel('sel_competencies', code)).filter(Boolean);
  const methodLabels = submitSafeLabelList(rawMethodLabels, 10, 200);
  const selLabels = submitSafeLabelList(rawSelLabels, 10, 200);
  const selCompetencyLabelText = submitSafeLabel(selLabels.join(' / ') || selCodes.join(' / '), 200, 'SEL');

  // 차시 = 이 학생이 (반과 무관하게) 지금까지 남긴 기록 수 + 1.
  //  - 반을 잘못 골랐다가 바꿔도 차시가 갈리지 않도록 student_id 기준으로 센다.
  //  - 중복 제출 방어(최근 30초)도 학생 기준이라, 반을 바꿔 다시 내도 막힌다.
  console.log('[submit-debug] 기존 기록 조회 시작');
  const existing = await fetchStudentResponsesByStudent(studentId);
  console.log('[submit-debug] 기존 기록 조회 완료', { count: existing.length });
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
    // 연결된 학생 프로필 정보 (연결된 경우에만 저장)
    ...(rosterStudentId ? {
      roster_student_id: rosterStudentId,
      roster_class_name: rosterClassName,
      roster_student_number: rosterStudentNumber,
      roster_display_name: rosterDisplayName
    } : {}),
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
    sel_competency_label: selCompetencyLabelText,
    // 2분 기록(quick) 화면 추가 필드 (기존 대시보드는 이 필드들을 무시해도 동작)
    record_type: recordType,
    feedback_mode: feedbackMode,
    peer_feedback: peerFeedback,
    reflection_text: reflectionText,
    // 단원 deep 포트폴리오 전용 필드 (record_type === 'deep' 인 경우만 존재)
    ...(recordType === 'deep' && payload.deepFields ? {
      deep_question_evolution: submitShortString(payload.deepFields.questionEvolutionCode || '', 80),
      deep_question_evolution_label: submitShortString(payload.deepFields.questionEvolutionLabel || '', 200),
      deep_unit_growth_code: submitShortString(payload.deepFields.unitGrowthCode || '', 80),
      deep_unit_growth_label: submitShortString(payload.deepFields.unitGrowthLabel || '', 200),
      deep_next_unit_code: submitShortString(payload.deepFields.nextUnitCode || '', 80),
      deep_next_unit_label: submitShortString(payload.deepFields.nextUnitLabel || '', 200),
      deep_unit: submitShortString(payload.deepFields.unit || '', 80),
    } : {}),
    app_version: APP_VERSION
  };

  console.log('[submit-debug] addDoc 직전 문서', debugSubmitDocForConsole(doc));
  console.log('[submit-debug] Rules 사전 점검', debugValidateStudentResponseDoc(doc, studentId));
  const ref = await addDoc(responsesCol(), doc);
  console.log('[submit-debug] addDoc 성공', { id: ref.id });
  // 다음에 어떤 기기에서 로그인해도 이 반이 자동 선택되도록 본인 문서에 기억(서버). 실패해도 제출은 성공.
  await rememberMyClass(studentId, session.sessionId);
  return { ok: true, responseId: ref.id, submittedAt: formatDateTime(new Date()), message: '제출 완료' };
}

// ===================== 교사 대시보드 =====================

const DASHBOARD_CHART_CAP = 4000;

function dashboardWindowConstraints(params) {
  params = params || {};
  const filterClassId = str(params.classId);
  const startDate = toDate(params.start);   // 조회 시작(이상). null 이면 제한 없음
  const endDate = toDate(params.end);       // 조회 끝(미만).  null 이면 제한 없음
  const constraints = [];
  if (filterClassId) constraints.push(where('class_id', '==', filterClassId));
  if (startDate) constraints.push(where('submitted_at', '>=', Timestamp.fromDate(startDate)));
  if (endDate) constraints.push(where('submitted_at', '<', Timestamp.fromDate(endDate)));
  return constraints;
}

function dashboardQuery(params) {
  return query(responsesCol(), ...dashboardWindowConstraints(params), orderBy('submitted_at', 'desc'), limit(DASHBOARD_CHART_CAP));
}

async function buildTeacherDashboardFromRows(params, inputRows, meta) {
  params = params || {};
  meta = meta || {};
  const filterClassId = str(params.classId);
  const filterActivity = str(params.activityText);

  // 교사 보정 정보(uid -> {name, session_id, class_id}). 지난 기록까지 한 번에 교정하기 위해 표시 단계에서 합친다.
  // fetchAllOverrides()는 세션 캐시가 있어 첫 호출 뒤에는 추가 읽기 없이 메모리 값을 쓴다.
  const overrideAll = await fetchAllOverrides();
  const overrideMap = {};   // uid -> 보정 이름 (기존 코드 호환용)
  Object.keys(overrideAll).forEach(uid => { if (overrideAll[uid].name) overrideMap[uid] = overrideAll[uid].name; });

  let rows = (inputRows || []).slice();
  const capped = !!meta.capped || rows.length >= DASHBOARD_CHART_CAP;

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

    // 학생 타임라인 (드릴다운 + 세특 근거 정리판)
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
        ms: (toDate(row.submitted_at) || new Date(0)).getTime(),
        methods: normalizeArray(row.method_labels),
        peer_feedback: str(row.peer_feedback),
        evidence: str(row.evidence_result),
        sel: normalizeArray(row.sel_competency_labels || []).join(' / ') || str(row.sel_competency_label),
        reflection: str(row.reflection_text)
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
  const totalResponses = (!usingActivityFilter && meta.windowTotal != null && meta.windowTotal !== '') ? meta.windowTotal : rows.length;
  const agencyAverage = (!usingActivityFilter && meta.agencyAverageExact !== '' && meta.agencyAverageExact != null)
    ? meta.agencyAverageExact
    : (agencyCount ? Math.round((agencySum / agencyCount) * 10) / 10 : '');

  // 우리반 공유 대시보드 자동 발행: 전체 학급을 보고 있을 때만(특정 반/활동 필터가 없을 때)
  // 읽어 둔 기록으로 익명 집계를 만들어 공개 문서에 저장한다. (교사가 따로 발행할 필요 없음)
  // 필터가 걸리면 일부 학급이 빠질 수 있어 발행을 건너뛴다(부분 집계로 덮어쓰지 않도록).
  if (!filterClassId && !usingActivityFilter) {
    const byClass = buildClassShare(rows);
    saveClassShare(byClass);          // Firestore(app_config/share): 원본/폴백 — fire-and-forget
    saveClassShareToMirror(byClass);  // RTDB(public/list): 학생 읽기 미러 — fire-and-forget(꺼져 있으면 자동 skip)
  }

  return {
    ok: true,
    generatedAt: formatDateTime(new Date()),
    totalResponses,
    uniqueStudentCount: Object.keys(uniqueStudents).length,
    agencyAverage,
    capped,                          // 차트 표본이 상한(DASHBOARD_CHART_CAP)에 걸렸는지
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

export async function getTeacherDashboardData(params) {
  params = params || {};

  const user = auth.currentUser;
  if (!isTeacherUser(user)) {
    throw new Error('교사 권한이 없는 계정입니다. 교사용 구글 계정으로 로그인하세요.');
  }

  let windowTotal = null;
  let agencyAverageExact = '';
  try {
    const countQ = query(responsesCol(), ...dashboardWindowConstraints(params));
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

  const snap = await getDocs(dashboardQuery(params));
  const rows = [];
  snap.forEach(d => rows.push(Object.assign({ _id: d.id }, d.data())));
  return buildTeacherDashboardFromRows(params, rows, {
    windowTotal,
    agencyAverageExact,
    capped: rows.length >= DASHBOARD_CHART_CAP
  });
}

// 교사 대시보드 실시간/증분 구독.
// 최초 연결 때는 현재 조회 범위 문서를 한 번 읽지만, 이후 같은 탭을 열어 둔 동안에는
// Firestore가 추가·수정·제거된 문서만 전달한다. 화면 계산은 메모리 캐시(rowsById)를 갱신해 다시 한다.
export function watchTeacherDashboardData(params, onData, onError) {
  params = params || {};
  const user = auth.currentUser;
  if (!isTeacherUser(user)) {
    const err = new Error('교사 권한이 없는 계정입니다. 교사용 구글 계정으로 로그인하세요.');
    setTimeout(() => { if (onError) onError(err); }, 0);
    return () => {};
  }

  const rowsById = new Map();
  const q = dashboardQuery(params);
  let buildSeq = 0;

  return onSnapshot(q, snapshot => {
    snapshot.docChanges().forEach(change => {
      if (change.type === 'removed') {
        rowsById.delete(change.doc.id);
      } else {
        rowsById.set(change.doc.id, Object.assign({ _id: change.doc.id }, change.doc.data()));
      }
    });

    const seq = ++buildSeq;
    buildTeacherDashboardFromRows(params, Array.from(rowsById.values()), {
      windowTotal: null,
      agencyAverageExact: '',
      capped: rowsById.size >= DASHBOARD_CHART_CAP
    }).then(data => {
      if (seq !== buildSeq) return; // 빠른 연속 변경 시 오래된 렌더 무시
      data.live = true;
      data.changeCount = snapshot.docChanges().length;
      data.fromCache = snapshot.metadata ? !!snapshot.metadata.fromCache : false;
      if (onData) onData(data);
    }).catch(err => {
      if (onError) onError(err);
      else console.warn('[dashboard] 실시간 데이터 계산 실패:', err);
    });
  }, err => {
    if (onError) onError(err);
    else console.warn('[dashboard] 실시간 구독 실패:', err);
  });
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
// 브라우저는 시트에 쓸 rows를 보내지 않는다. Firebase ID Token과 필터만 Apps Script에 보내고,
// Apps Script가 교사 권한을 검증한 뒤 Firestore를 직접 읽어 시트를 새로 쓴다.

export async function exportToSheet(params) {
  params = params || {};
  const user = auth.currentUser;
  if (!isTeacherUser(user)) {
    throw new Error('교사 계정으로 로그인해야 내보낼 수 있습니다.');
  }
  if (!SHEETS_WEBAPP_URL) {
    throw new Error('SHEETS_WEBAPP_URL이 비어 있습니다. Apps Script 웹앱 URL을 js/config.js에 넣어 주세요.');
  }

  const idToken = await user.getIdToken(true);
  const body = {
    idToken,
    classId: str(params.classId),
    activityText: str(params.activityText),
    start: params.start ? toDate(params.start).toISOString() : '',
    end: params.end ? toDate(params.end).toISOString() : ''
  };

  const res = await fetch(SHEETS_WEBAPP_URL, {
    method: 'POST',
    mode: 'cors',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Apps Script 응답을 해석하지 못했습니다: ' + text.slice(0, 200));
  }
  if (!res.ok || !data.ok) {
    throw new Error((data && data.error) || '시트 내보내기에 실패했습니다.');
  }
  return Object.assign({ type: 'sheets' }, data);
}

