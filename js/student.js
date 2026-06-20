// --- js/student.js ---
// 학생 화면: ① 학급 → ② 구글 로그인 → ③ 오늘 기록(2분, 칩 선택) → 제출 전 요약 확인
//
// '오늘 기록'의 모든 선택지는 js/lesson-config.js 의 LESSON_CONFIG 한 곳에서 읽어 그린다.
// (마크업 하드코딩 제거 — 교사가 config 만 바꾸면 화면이 바뀌도록)

import {
  getInitialData, getLastNextTry, submitSimpleResponse, getLessonSettings,
  signInWithGoogle, signOutUser, watchAuth, watchSiteStatus,
  setSiteActive, isTeacherUser, getMyProfile, getMyHistory,
  claimStudentProfile
} from './db.js';
import {
  LESSON_CONFIG, getFeedbackConfig, getActivityOptions,
  getDefaultLessonSettings, normalizeLessonSettings
} from './lesson-config.js';
import { escapeHtml, escapeAttr, getErrorMessage, getQueryParam } from './utils.js';

let DATA = null;
let selectedSession = null;
let classEditing = false;   // 반을 선택한 뒤엔 잠그고(현재 반만 표시), "반 변경"을 누르면 다시 그리드를 연다
let isSubmitting = false;
let SESSION_ID_PARAM = '';
let currentUser = null;
let myName = null;          // 교사 보정값 우선의 내 표시 이름 (null=아직 확인 전)
let myLinkedProfile = null; // 연결된 학생 프로필 (null=미연결 또는 확인 전)
let myClass = null;         // 저장된 내 학급 { session_id, class_id, source } (null=없음/확인 전)
let myHistoryLoaded = false; // "내 지난 기록"을 이미 불러왔는지 (계정 바뀌면 false)
let lastTryKey = null;       // "지난 질문"을 이미 읽은 (uid|session) 키 — 로그인당 중복 읽기 방지
let siteActive = null;   // null=확인 전, true=켜짐, false=꺼짐
let isTogglingSite = false;

// --- 오늘 기록(2분) 입력 상태 (칩 선택은 DOM 대신 여기서 관리) ---
// ACTIVE = 현재 적용 중인 수업 설정(lessonSettings). 교사가 Firestore 에 저장한 값을 읽어 쓰고,
// 없으면 기본값(시드)을 쓴다. 모든 칩은 LESSON_CONFIG 가 아니라 ACTIVE 에서 그린다.
let ACTIVE = getDefaultLessonSettings();
let selectedActivity = null;     // 활동 코드
let selectedQuestion = null;     // 오늘 목표/질문 { source, qid, text }
let selectedMethods = [];        // 해본 방법 코드 (최대 maxMethods)
let selectedFeedback = '';       // 친구 피드백 한 줄 (선택)
let selectedResult = '';         // 오늘 결과/증거
let selectedNextTry = '';        // 다음 시간에 바꿔볼 점
let agencyScore = null;          // 자기주도성 1~5
let selectedSel = [];            // SEL 역량 코드 (1개 → 배열로 저장해 통계 호환)
let carriedGoal = null;          // 지난 시간 '다음 시도'에서 자동 이월된 목표

export function initStudent() {
  SESSION_ID_PARAM = getQueryParam('session_id') || getQueryParam('sessionId') || '';
  setLoading(true, '연결하는 중...');

  watchSiteStatus(active => {
    const prev = siteActive;
    siteActive = active;
    isTogglingSite = false;
    if (active) {
      if (prev !== true) buildStudentApp();
    } else {
      renderDisabledScreen();
    }
  });

  watchAuth(user => {
    currentUser = user;
    myName = null;
    myLinkedProfile = null;
    myClass = null;
    myHistoryLoaded = false;
    lastTryKey = null;
    renderTeacherPanel();
    if (siteActive !== true) return;
    renderStudentCard();
    renderHistoryCard();
    if (user) { refreshMyProfile(); loadLastNextTry(); }
    updateSubmitState();
  });
}

async function refreshMyProfile() {
  if (!currentUser) { myName = null; myLinkedProfile = null; return; }
  let prof;
  try { prof = await getMyProfile(); } catch { /* 네트워크 오류 등, null 프로필로 진행 */ }
  myLinkedProfile = (prof && prof.linkedProfile) || null;
  myName = (prof && prof.displayName) || null;

  // 연결된 프로필이 없으면 등록 화면을 보여준다 (교사 계정은 제외)
  if (!myLinkedProfile && !isTeacherUser(currentUser)) {
    renderProfileRegistration();
    return;
  }
  renderStudentCard();
  applyMyClass(prof && prof.class);
}

function applyMyClass(teacherClass) {
  if (!currentUser || SESSION_ID_PARAM) return;
  let res = teacherClass || null;
  if (!res) {
    const saved = readSavedSession(currentUser.uid);
    if (saved) res = { session_id: saved, source: 'history' };
  }
  if (!res || !res.session_id) return;

  const sessions = (DATA && DATA.sessions) || [];
  if (!sessions.some(s => s.session_id === res.session_id)) return;
  if (!res.class_id) res.class_id = classIdOf(res.session_id);
  myClass = res;

  if (!selectedSession || selectedSession.session_id !== res.session_id) {
    loadInitial(res.session_id);
  } else {
    renderSessionCard();
  }
}

function savedSessionKey(uid) { return 'pe_last_session_' + String(uid || ''); }
function readSavedSession(uid) {
  if (!uid) return '';
  try { return localStorage.getItem(savedSessionKey(uid)) || ''; } catch { return ''; }
}
function saveSession(uid, sessionId) {
  if (!uid || !sessionId) return;
  try { localStorage.setItem(savedSessionKey(uid), sessionId); } catch { /* 무시 */ }
}
function classIdOf(sessionId) {
  const s = ((DATA && DATA.sessions) || []).find(x => x.session_id === sessionId);
  return s ? s.class_id : '';
}

function renderDisabledScreen() {
  setLoading(false);
  const app = document.getElementById('app');
  if (!app) return;
  app.innerHTML = `
    <header>
      <h1>자기주도 체육탐구</h1>
    </header>
    <section class="card" style="text-align:center; padding:40px 20px;">
      <div style="font-size:52px; line-height:1; margin-bottom:14px;">🔒</div>
      <h2>지금은 기록을 받지 않습니다</h2>
      <p class="muted" style="margin-top:8px;">선생님이 수업을 시작하면 이 화면에서 오늘의 탐구를 기록할 수 있어요.</p>
    </section>
    <section id="teacherPanel" class="card" style="display:none;"></section>
  `;
  renderTeacherPanel();
}

function buildStudentApp() {
  renderStudentShell();
  loadInitial(SESSION_ID_PARAM);
  loadActiveSettings();          // 교사 수업 설정을 읽어와 칩을 갱신(비동기)
  if (currentUser) { refreshMyProfile(); loadLastNextTry(); }
  updateSubmitState();
  renderHistoryCard();
  renderTeacherPanel();
}

// 교사가 저장한 수업 설정(lessonSettings)을 1회 읽어 ACTIVE 에 반영하고 폼을 다시 그린다.
// 읽기 실패 시 기본값을 유지한다. (학생당 1읽기 — 사이트 상태처럼 가볍게)
async function loadActiveSettings() {
  try {
    const raw = await getLessonSettings();
    ACTIVE = normalizeLessonSettings(raw);
  } catch {
    ACTIVE = getDefaultLessonSettings();
  }
  // 교사가 오늘 활동을 지정했고 학생이 아직 안 골랐으면 기본 선택으로 표시
  if (!selectedActivity && ACTIVE.activity) selectedActivity = ACTIVE.activity;
  if (document.getElementById('mainFormCard')) renderMainForm();
  updateSubmitState();
}

function renderTeacherPanel() {
  const el = document.getElementById('teacherPanel');
  if (!el) return;

  if (!currentUser) {
    el.style.display = 'block';
    el.innerHTML = `
      <details>
        <summary class="muted" style="cursor:pointer; font-size:13px;">선생님이신가요? 로그인</summary>
        <div style="margin-top:10px;">
          <button id="teacherSignInBtn" type="button" class="btn ghost">구글로 로그인</button>
        </div>
      </details>
    `;
    document.getElementById('teacherSignInBtn').addEventListener('click', async () => {
      try { await signInWithGoogle(); } catch (e) { showError(getErrorMessage(e)); }
    });
    return;
  }

  if (!isTeacherUser(currentUser)) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }

  el.style.display = 'block';
  const on = siteActive === true;
  el.innerHTML = `
    <h2>선생님 전용 · 사이트 상태</h2>
    <div class="selected-box">
      현재 상태: <strong style="color:${on ? '#16a34a' : '#dc2626'};">${on ? '켜짐 — 학생이 기록할 수 있습니다.' : '꺼짐 — 학생에게는 안내 메시지만 보입니다.'}</strong>
    </div>
    <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
      <button id="siteToggleBtn" type="button" class="btn ${on ? 'ghost' : 'primary'}" ${isTogglingSite ? 'disabled' : ''}>${isTogglingSite ? '변경 중...' : (on ? '사이트 끄기' : '사이트 켜기')}</button>
      <button id="teacherSignOutBtn" type="button" class="btn ghost">로그아웃</button>
      <span class="muted" style="font-size:12px;">${escapeHtml(currentUser.email)}</span>
    </div>
    <p class="muted" style="font-size:12px; margin-top:8px;">자세한 대시보드는 <code>?teacher=1</code> 주소에서 볼 수 있습니다.</p>
  `;
  document.getElementById('siteToggleBtn').addEventListener('click', toggleSiteFromStudent);
  document.getElementById('teacherSignOutBtn').addEventListener('click', async () => {
    try { await signOutUser(); } catch (e) { showError(getErrorMessage(e)); }
  });
}

async function toggleSiteFromStudent() {
  if (isTogglingSite || siteActive === null) return;
  clearMessages();
  isTogglingSite = true;
  renderTeacherPanel();
  try {
    await setSiteActive(!siteActive);
  } catch (e) {
    isTogglingSite = false;
    renderTeacherPanel();
    showError(getErrorMessage(e));
  }
}

function renderStudentShell() {
  document.getElementById('app').innerHTML = `
    <header>
      <h1>자기주도 체육탐구</h1>
      <p class="muted">수업을 마치며 오늘의 탐구를 짧게 기록합니다. (목표: 2분 · 탭으로 선택)</p>
    </header>
    <div id="errorBox" style="display:none;"></div>
    <div id="successBox" style="display:none;"></div>
    <section id="sessionCard" class="card"></section>
    <section id="studentCard" class="card"></section>
    <section id="lastQuestionCard" class="card"></section>
    <section id="mainFormCard" class="card"></section>
    <div class="footer-actions">
      <section class="card" style="margin-bottom:0;">
        <button id="submitBtn" class="btn primary" type="button">기록 확인하고 제출</button>
        <button id="resetBtn" class="btn ghost" type="button" style="display:none;">새 응답 작성</button>
      </section>
    </div>
    <section id="historyCard" class="card" style="display:none;"></section>
    <section id="teacherPanel" class="card" style="display:none;"></section>
  `;
  document.getElementById('submitBtn').addEventListener('click', reviewBeforeSubmit);
  document.getElementById('resetBtn').addEventListener('click', () => location.reload());
  updateSubmitState();
}

function loadInitial(sessionId) {
  setLoading(true, '수업 데이터를 불러오는 중...');
  try {
    const data = getInitialData({ sessionId: sessionId || '' });
    setLoading(false);
    DATA = data;
    const prevSessionId = selectedSession ? selectedSession.session_id : null;
    selectedSession = sessionId ? data.session : null;
    if (sessionId) classEditing = false;   // 반을 정했으면 잠금 화면으로 (실수 변경 방지)
    // 입력 상태 초기화 (활동은 교사가 지정한 기본값이 있으면 그것으로)
    selectedActivity = (ACTIVE && ACTIVE.activity) || null;
    selectedQuestion = null;
    selectedMethods = [];
    selectedFeedback = '';
    selectedResult = '';
    selectedNextTry = '';
    agencyScore = null;
    selectedSel = [];
    const curSessionId = selectedSession ? selectedSession.session_id : null;
    if (prevSessionId !== curSessionId) { lastTryKey = null; carriedGoal = null; }
    renderSessionCard();
    renderStudentCard();
    renderLastQuestionCard();
    renderMainForm();
    if (currentUser) loadLastNextTry();
    updateSubmitState();
  } catch (err) {
    setLoading(false);
    showError(getErrorMessage(err));
  }
}

function renderSessionCard() {
  const el = document.getElementById('sessionCard');
  const sessions = DATA.sessions || [];
  const session = selectedSession || {};

  let html = `<h2>① 학급 확인</h2>`;

  if (SESSION_ID_PARAM) {
    // 고정 링크(?session_id=)로 들어온 경우: 그 학급으로 고정 표시.
    html += `<div class="info-box"><strong>${escapeHtml(session.title || '-')}</strong></div>`;
    el.innerHTML = html;
    return;
  }

  // 반을 이미 골라 잠긴 상태: 현재 반만 보여 주고 "반 변경" 버튼으로만 바꾼다(실수 변경 방지).
  if (selectedSession && !classEditing) {
    const lead = (myClass && myClass.session_id === session.session_id)
      ? (myClass.source === 'teacher' ? '선생님이 정해 준 ' : '지난번에 고른 ')
      : '';
    html += `
      <div class="selected-box" style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;">
        <span>${escapeHtml(lead)}<strong>${escapeHtml(session.class_id)}</strong>(으)로 기록합니다.</span>
        <button id="changeClassBtn" type="button" class="btn ghost" style="padding:6px 12px;">반 변경</button>
      </div>
      <p class="muted" style="font-size:12px; margin-top:6px;">반이 다르면 <strong>반 변경</strong>을 눌러 고르세요.</p>
    `;
    el.innerHTML = html;
    const changeBtn = document.getElementById('changeClassBtn');
    if (changeBtn) changeBtn.addEventListener('click', () => { classEditing = true; renderSessionCard(); });
    return;
  }

  // 아직 안 골랐거나(필수 선택) "반 변경"을 눌러 편집 중: 학급 그리드를 보여 준다.
  html += `
    <div class="field">
      <label class="label">학급 선택</label>
      <div class="session-grid">
        ${sessions.map(s => `
          <label class="session-card${s.session_id === session.session_id ? ' selected' : ''}">
            <input type="radio" name="sessionRadio" value="${escapeAttr(s.session_id)}"${s.session_id === session.session_id ? ' checked' : ''}>
            <span>${escapeHtml(s.class_id)}</span>
          </label>
        `).join('')}
      </div>
    </div>
  `;
  if (!selectedSession) {
    html += `<div class="warning-box" style="margin-top:4px;">먼저 <strong>본인 반</strong>을 선택해 주세요. 반을 골라야 기록을 제출할 수 있어요.</div>`;
  } else {
    html += `<p class="muted" style="font-size:12px; margin-top:2px;">반을 누르면 그 반으로 맞춰집니다.</p>`;
  }
  el.innerHTML = html;
  Array.from(document.getElementsByName('sessionRadio')).forEach(input => {
    input.addEventListener('change', function () { loadInitial(this.value); });
  });
}

function renderStudentCard() {
  const el = document.getElementById('studentCard');
  if (!el) return;

  if (currentUser) {
    const shownName = myName || currentUser.displayName || currentUser.email;
    const profileTag = myLinkedProfile
      ? `<div class="muted" style="font-size:12px; margin-top:4px;">학번 <strong>${escapeHtml(myLinkedProfile.studentId || '')}</strong> · ${escapeHtml(myLinkedProfile.className || '')} · ${escapeHtml(myLinkedProfile.studentNumber || '')}번</div>`
      : `<div class="muted" style="font-size:12px; margin-top:4px; color:#dc2626;">⚠️ 아직 학생 정보가 연결되지 않았습니다.</div>`;
    el.innerHTML = `
      <h2>② 로그인</h2>
      <div class="selected-box">
        <strong>${escapeHtml(shownName)}</strong> 님으로 기록합니다.
        ${profileTag}
      </div>
      <button id="signOutBtn" type="button" class="btn ghost">로그아웃</button>
    `;
    document.getElementById('signOutBtn').addEventListener('click', async () => {
      try { await signOutUser(); } catch (err) { showError(getErrorMessage(err)); }
    });
  } else {
    el.innerHTML = `
      <h2>② 로그인</h2>
      <p class="muted">학교 구글 계정으로 로그인하면 학번·이름이 자동으로 연결됩니다.</p>
      <button id="signInBtn" type="button" class="btn primary">구글로 로그인</button>
    `;
    document.getElementById('signInBtn').addEventListener('click', async () => {
      try { await signInWithGoogle(); } catch (err) { showError(getErrorMessage(err)); }
    });
  }
}

// 로그인 후 프로필 미연결 상태일 때 보여주는 학생 정보 등록 화면.
// 학번 5자리 + 이름을 입력하면 student_roster와 대조해 연결(claim)한다.
function renderProfileRegistration() {
  const el = document.getElementById('studentCard');
  if (!el) return;

  el.innerHTML = `
    <h2>② 학생 정보 등록 (처음 한 번만)</h2>
    <p class="muted">구글 계정과 학번을 연결해야 기록을 제출할 수 있습니다. 학번과 이름은 선생님이 미리 등록해 둔 명단과 대조됩니다.</p>
    <div class="field">
      <label class="label">학번 (5자리 숫자)</label>
      <input id="regStudentId" type="text" inputmode="numeric" maxlength="5" placeholder="예: 10203" style="letter-spacing:2px;">
    </div>
    <div class="field">
      <label class="label">이름</label>
      <input id="regName" type="text" maxlength="20" placeholder="예: 홍길동">
    </div>
    <div id="regCodeWrap" class="field" style="display:none;">
      <label class="label">등록 코드 (선생님이 알려준 4자리)</label>
      <input id="regCode" type="text" inputmode="numeric" maxlength="4" placeholder="1234" style="letter-spacing:4px;">
    </div>
    <div id="regError" style="display:none;" class="notice error"></div>
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">
      <button id="regSubmitBtn" type="button" class="btn primary">연결하기</button>
      <button id="regSignOutBtn" type="button" class="btn ghost">로그아웃</button>
    </div>
    <p class="muted" style="font-size:12px; margin-top:10px;">학번 또는 이름을 모르거나 오류가 나면 선생님께 문의하세요.</p>
  `;
  // 학번 5자리 입력 시 등록 코드 칸 표시 여부는 서버에서 확인해야 알 수 있으므로
  // 여기서는 항상 숨겨두고, 에러 메시지로 코드 요청 시 칸을 열어준다.
  document.getElementById('regSubmitBtn').addEventListener('click', doClaimProfile);
  document.getElementById('regSignOutBtn').addEventListener('click', async () => {
    try { await signOutUser(); } catch (err) { showError(getErrorMessage(err)); }
  });
}

async function doClaimProfile() {
  const btn = document.getElementById('regSubmitBtn');
  const errEl = document.getElementById('regError');
  const sid = (document.getElementById('regStudentId') || {}).value || '';
  const name = (document.getElementById('regName') || {}).value || '';
  const code = (document.getElementById('regCode') || {}).value || '';

  if (errEl) errEl.style.display = 'none';
  if (btn) { btn.disabled = true; btn.textContent = '확인 중...'; }

  try {
    const res = await claimStudentProfile(sid.trim(), name.trim(), code.trim());
    myLinkedProfile = { studentId: res.studentId, name: res.name, displayName: res.displayName };
    myName = res.displayName;
    renderStudentCard();
    applyMyClass(null);
  } catch (err) {
    const msg = getErrorMessage(err);
    // 등록 코드 요청 에러이면 코드 칸을 열어준다.
    if (msg.includes('등록 코드')) {
      const wrap = document.getElementById('regCodeWrap');
      if (wrap) wrap.style.display = 'block';
    }
    if (errEl) { errEl.style.display = 'block'; errEl.textContent = msg; }
    if (btn) { btn.disabled = false; btn.textContent = '연결하기'; }
  }
}

function renderLastQuestionCard() {
  document.getElementById('lastQuestionCard').innerHTML = `
    <span class="step-tag step-before">수업 전 · 지난 질문 회상</span>
    <h2>③ 지난 시간 질문 이어가기</h2>
    <div id="lastTryBox" class="warning-box">로그인하면 지난 시간에 남긴 '다음 시도'를 불러와 오늘 목표로 자동 이어줍니다.</div>
    <button id="loadLastBtn" type="button" class="btn ghost">지난 질문 다시 불러오기</button>
  `;
  document.getElementById('loadLastBtn').addEventListener('click', () => loadLastNextTry(true));
}

// =================== 오늘 기록 (2분, 칩 선택) ===================

function renderMainForm() {
  const card = document.getElementById('mainFormCard');
  if (!card) return;

  // 교사가 입력을 잠갔으면(inputEnabled=false) 폼 대신 안내만 보여준다. (사이트 켜기와 별개)
  if (!ACTIVE.inputEnabled) {
    card.innerHTML = `
      <span class="step-tag step-during">수업 중 · 오늘 한 탐구</span>
      <h2>④ 오늘 기록</h2>
      <div class="warning-box">지금은 기록 입력이 잠겨 있습니다. 선생님 안내를 기다려 주세요.</div>
    `;
    return;
  }

  const fb = getFeedbackConfig(ACTIVE.feedbackMode);
  const coreBox = ACTIVE.coreQuestion
    ? `<div class="info-box" style="margin-bottom:8px;"><div class="muted" style="font-size:12px;">오늘 핵심 질문</div><strong>${escapeHtml(ACTIVE.coreQuestion)}</strong></div>`
    : '';
  card.innerHTML = `
    <span class="step-tag step-during">수업 중 · 오늘 한 탐구</span>
    <h2>④ 오늘 기록 (2분)</h2>

    <div class="q-step">
      <label class="label">① 오늘 활동</label>
      <div id="activityChips" class="chip-grid cols-3"></div>
      <div id="activityOtherWrap" class="chip-direct" style="display:none;">
        <input type="text" id="activityOtherText" placeholder="활동을 직접 입력하세요.">
      </div>
    </div>

    <div class="q-step">
      <label class="label">② 오늘 목표 · 질문</label>
      <p class="q-hint">지난 시간에 정한 '다음 시도'가 있으면 맨 위에 자동으로 떠요. 탭해서 고르세요.</p>
      ${coreBox}
      <div id="goalChips" class="chip-grid"></div>
      <div id="goalNote" class="q-hint" style="margin-top:6px;"></div>
      <div class="chip-direct">
        <input type="text" id="goalDirect" placeholder="원하는 목표/질문이 없다면 직접 쓰기 (선택)">
        <button id="goalDirectBtn" type="button" class="btn green" style="margin-top:8px;">직접 쓴 목표 사용</button>
      </div>
    </div>

    <div class="q-step">
      <label class="label">③ 해본 방법 <span class="muted" style="font-weight:400;">(최대 ${LESSON_CONFIG.defaults.maxMethods}개)</span></label>
      <div id="methodChips" class="chip-grid"></div>
    </div>

    <div class="q-step">
      <label class="label" id="feedbackLabel">④ ${escapeHtml(fb.prompt)}</label>
      <p class="q-hint">친구 피드백은 활동 중 '말로' 주고받고, 여기엔 결과 한 줄만 남겨요. (선택)</p>
      <div id="feedbackChips" class="chip-grid"></div>
      <div class="chip-direct">
        <input type="text" id="feedbackDirect" placeholder="${escapeAttr(fb.placeholder)}">
      </div>
    </div>

    <div class="q-step">
      <label class="label">⑤ 오늘 결과 · 증거</label>
      <div id="resultChips" class="chip-grid"></div>
      <div class="chip-direct">
        <input type="text" id="resultDirect" placeholder="직접 쓰기 (선택)">
      </div>
    </div>

    <div class="q-step">
      <span class="step-tag step-after">수업 후 · 다음 도전</span>
      <label class="label">⑥ 다음 시간에 바꿔볼 점</label>
      <div id="nextChips" class="chip-grid"></div>
      <div class="chip-direct">
        <input type="text" id="nextDirect" placeholder="직접 쓰기 (선택)">
      </div>
    </div>

    <div class="q-step">
      <label class="label">⑦ 오늘 나는 스스로 선택하고, 시도하고, 바꿔보았다.</label>
      <div id="agencyChips" class="scale-row"></div>
      <div id="agencyLabel" class="q-hint" style="margin-top:8px;">점수를 탭하면 설명이 나와요.</div>
    </div>

    <div class="q-step">
      <label class="label">⑧ 오늘 특히 발휘한 SEL 역량 <span class="muted" style="font-weight:400;">(1개)</span></label>
      <div id="selChips" class="chip-grid"></div>
    </div>
  `;

  renderActivityChips();
  renderGoalChips();
  renderMethodChips();
  renderFeedbackChips();
  renderResultChips();
  renderNextChips();
  renderAgencyChips();
  renderSelChips();

  // 직접 입력 칸 바인딩 (입력하면 해당 칩 선택은 해제되고 직접 값이 우선)
  const aOther = document.getElementById('activityOtherText');
  if (aOther) aOther.addEventListener('input', () => { /* 값은 제출 시 읽음 */ });
  document.getElementById('goalDirectBtn').addEventListener('click', useDirectGoal);
  bindDirect('feedbackDirect', v => { selectedFeedback = v; renderFeedbackChips(); });
  bindDirect('resultDirect', v => { selectedResult = v; renderResultChips(); });
  bindDirect('nextDirect', v => { selectedNextTry = v; renderNextChips(); });
}

// data-value 를 읽는 공통 칩 클릭 위임 바인딩
function bindChipClick(containerId, handler) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.addEventListener('click', e => {
    const btn = e.target.closest('button[data-value]');
    if (!btn || btn.disabled) return;
    handler(btn.dataset.value, btn);
  });
}
function bindDirect(id, onValue) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', () => onValue(String(el.value || '').trim()));
}
function chipHtml(value, label, selected, opts) {
  opts = opts || {};
  const sub = opts.sub ? `<span class="chip-sub">${escapeHtml(opts.sub)}</span>` : '';
  const cls = 'chip' + (selected ? ' selected' : '') + (opts.num ? ' chip-num' : '');
  return `<button type="button" class="${cls}" data-value="${escapeAttr(value)}"${opts.disabled ? ' disabled' : ''}>${escapeHtml(label)}${sub}</button>`;
}

// ① 활동
function renderActivityChips() {
  const el = document.getElementById('activityChips');
  if (!el) return;
  el.innerHTML = getActivityOptions(ACTIVE)
    .map(a => chipHtml(a.code, a.label, selectedActivity === a.code))
    .join('');
  if (!el.dataset.bound) {
    bindChipClick('activityChips', code => {
      selectedActivity = code;
      const wrap = document.getElementById('activityOtherWrap');
      if (wrap) wrap.style.display = code === 'other' ? 'block' : 'none';
      renderActivityChips();
      renderGoalChips();   // 활동에 맞는 추천 목표로 갱신
    });
    el.dataset.bound = '1';
  }
}

// ② 목표/질문 — 이월된 '다음 시도' + 교사 설정 목표(goalOptions)
function currentGoalItems() {
  const items = [];
  if (carriedGoal && carriedGoal.text) {
    items.push({ key: '__carried__', source: 'previous', qid: '', text: carriedGoal.text, label: carriedGoal.text, sub: '지난 시간 이어가기' });
  }
  ACTIVE.goalOptions.forEach(g => {
    items.push({ key: g.code, source: 'bank', qid: g.code, text: g.label, label: g.label });
  });
  return items;
}
function renderGoalChips() {
  const el = document.getElementById('goalChips');
  if (!el) return;
  const items = currentGoalItems();
  el.innerHTML = items
    .map(it => chipHtml(it.key, it.label, selectedQuestion && selectedQuestion.text === it.text, { sub: it.sub }))
    .join('');
  const note = document.getElementById('goalNote');
  if (note) {
    note.innerHTML = selectedQuestion && selectedQuestion.text
      ? `선택됨: <strong>${escapeHtml(selectedQuestion.text)}</strong>`
      : '아직 목표를 고르지 않았어요.';
  }
  if (!el.dataset.bound) {
    bindChipClick('goalChips', key => {
      const found = currentGoalItems().find(it => it.key === key);
      if (!found) return;
      selectedQuestion = { source: found.source, qid: found.qid, text: found.text };
      const direct = document.getElementById('goalDirect');
      if (direct) direct.value = '';
      renderGoalChips();
    });
    el.dataset.bound = '1';
  }
}
function useDirectGoal() {
  const text = valueOf('goalDirect');
  if (!text) return showError('직접 쓴 목표/질문을 입력해 주세요.');
  selectedQuestion = { source: 'direct', qid: '', text };
  renderGoalChips();
}

// ③ 해본 방법 (최대 maxMethods)
function renderMethodChips() {
  const el = document.getElementById('methodChips');
  if (!el) return;
  const full = selectedMethods.length >= LESSON_CONFIG.defaults.maxMethods;
  el.innerHTML = ACTIVE.methodOptions
    .map(m => {
      const on = selectedMethods.includes(m.code);
      return chipHtml(m.code, m.label, on, { disabled: !on && full });
    })
    .join('');
  if (!el.dataset.bound) {
    bindChipClick('methodChips', code => {
      const idx = selectedMethods.indexOf(code);
      if (idx >= 0) selectedMethods.splice(idx, 1);
      else if (selectedMethods.length < LESSON_CONFIG.defaults.maxMethods) selectedMethods.push(code);
      renderMethodChips();
    });
    el.dataset.bound = '1';
  }
}

// ④ 친구 피드백 (단일 선택, 선택)
function renderFeedbackChips() {
  const el = document.getElementById('feedbackChips');
  if (!el) return;
  el.innerHTML = ACTIVE.feedbackOptions
    .map(o => chipHtml(o.label, o.label, selectedFeedback === o.label))
    .join('');
  if (!el.dataset.bound) {
    bindChipClick('feedbackChips', val => {
      selectedFeedback = (selectedFeedback === val) ? '' : val; // 다시 누르면 해제
      const direct = document.getElementById('feedbackDirect');
      if (direct) direct.value = '';
      renderFeedbackChips();
    });
    el.dataset.bound = '1';
  }
}

// ⑤ 결과/증거 (단일 선택)
function renderResultChips() {
  const el = document.getElementById('resultChips');
  if (!el) return;
  el.innerHTML = ACTIVE.resultOptions
    .map(o => chipHtml(o.label, o.label, selectedResult === o.label))
    .join('');
  if (!el.dataset.bound) {
    bindChipClick('resultChips', val => {
      selectedResult = (selectedResult === val) ? '' : val;
      const direct = document.getElementById('resultDirect');
      if (direct) direct.value = '';
      renderResultChips();
    });
    el.dataset.bound = '1';
  }
}

// ⑥ 다음 시도 (단일 선택)
function renderNextChips() {
  const el = document.getElementById('nextChips');
  if (!el) return;
  el.innerHTML = ACTIVE.nextTryOptions
    .map(o => chipHtml(o.label, o.label, selectedNextTry === o.label))
    .join('');
  if (!el.dataset.bound) {
    bindChipClick('nextChips', val => {
      selectedNextTry = (selectedNextTry === val) ? '' : val;
      const direct = document.getElementById('nextDirect');
      if (direct) direct.value = '';
      renderNextChips();
    });
    el.dataset.bound = '1';
  }
}

// ⑦ 자기주도성 1~5
function renderAgencyChips() {
  const el = document.getElementById('agencyChips');
  if (!el) return;
  const { min, max, labels } = LESSON_CONFIG.agency;
  let html = '';
  for (let n = min; n <= max; n++) html += chipHtml(String(n), String(n), agencyScore === n, { num: true });
  el.innerHTML = html;
  const lab = document.getElementById('agencyLabel');
  if (lab) lab.innerHTML = agencyScore ? `<strong>${agencyScore}점:</strong> ${escapeHtml(labels[agencyScore] || '')}` : '점수를 탭하면 설명이 나와요.';
  if (!el.dataset.bound) {
    bindChipClick('agencyChips', val => {
      agencyScore = Number(val);
      renderAgencyChips();
    });
    el.dataset.bound = '1';
  }
}

// ⑧ SEL 역량 (1개)
function renderSelChips() {
  const el = document.getElementById('selChips');
  if (!el) return;
  el.innerHTML = ACTIVE.selFocus
    .map(s => chipHtml(s.code, s.label, selectedSel[0] === s.code))
    .join('');
  if (!el.dataset.bound) {
    bindChipClick('selChips', code => {
      selectedSel = (selectedSel[0] === code) ? [] : [code];
      renderSelChips();
    });
    el.dataset.bound = '1';
  }
}

// 활동 목록 = 고정 활동 + 교사 추가분(getActivityOptions). (lessonSettings 의 activity 는 '기본 선택값')
function labelOfActivity(code) { const o = getActivityOptions(ACTIVE).find(a => a.code === code); return o ? o.label : code; }
function labelOfMethod(code) { const o = ACTIVE.methodOptions.find(a => a.code === code); return o ? o.label : code; }
function labelOfSel(code) { const o = ACTIVE.selFocus.find(a => a.code === code); return o ? o.label : code; }

async function loadLastNextTry(force) {
  const box = document.getElementById('lastTryBox');
  if (!box) return;

  if (!currentUser) {
    box.className = 'warning-box';
    box.innerHTML = '먼저 구글 로그인을 해주세요.';
    return;
  }
  if (!selectedSession) {
    box.className = 'warning-box';
    box.innerHTML = '먼저 본인 반을 선택해 주세요.';
    return;
  }

  const key = currentUser.uid + '|' + (selectedSession ? selectedSession.session_id : '');
  if (!force && key === lastTryKey) return;
  lastTryKey = key;

  box.style.display = 'block';
  box.className = 'warning-box';
  box.innerHTML = '지난 기록 확인 중...';

  try {
    const res = await getLastNextTry({ sessionId: selectedSession.session_id });
    if (!res || !res.found) {
      carriedGoal = null;
      box.className = 'warning-box';
      box.innerHTML = '지난 시간 기록이 없습니다. 오늘은 ②에서 추천 목표를 골라 시작하세요.';
      return;
    }
    // 지난 '다음 시도'를 오늘 목표로 자동 이월(기본 선택)
    carriedGoal = { source: 'previous', qid: '', text: res.next_try };
    if (!selectedQuestion || !selectedQuestion.text) {
      selectedQuestion = { source: 'previous', qid: '', text: res.next_try };
    }
    renderGoalChips();
    box.className = 'selected-box';
    box.innerHTML = `<div class="muted">지난 시간에 내가 만든 다음 탐구 질문</div>
      <p style="font-weight:900; margin:6px 0 10px;">${escapeHtml(res.next_try)}</p>
      <div class="muted" style="font-size:12px;">✓ 오늘 목표(②) 맨 위에 자동으로 선택해 뒀어요. 바꾸려면 ②에서 다른 칩을 누르세요.</div>`;
  } catch (err) {
    lastTryKey = null;
    box.className = 'notice error';
    box.innerHTML = escapeHtml(getErrorMessage(err));
  }
}

// --- 내 지난 기록 (학생 본인 열람) ---
function renderHistoryCard() {
  const el = document.getElementById('historyCard');
  if (!el) return;
  if (!currentUser) { el.style.display = 'none'; el.innerHTML = ''; myHistoryLoaded = false; return; }
  el.style.display = 'block';
  if (myHistoryLoaded) return;
  el.innerHTML = `
    <h2>📈 내 지난 기록</h2>
    <p class="muted">지금까지 내가 남긴 탐구 질문과 주도성 변화를 그래프로 볼 수 있어요.</p>
    <button id="loadHistoryBtn" type="button" class="btn ghost">내 지난 기록 보기</button>
    <div id="historyBody"></div>
  `;
  document.getElementById('loadHistoryBtn').addEventListener('click', loadMyHistory);
}

async function loadMyHistory() {
  const btn = document.getElementById('loadHistoryBtn');
  const body = document.getElementById('historyBody');
  if (btn) { btn.disabled = true; btn.textContent = '불러오는 중...'; }
  if (body) body.innerHTML = '';
  try {
    const res = await getMyHistory();
    myHistoryLoaded = true;
    renderMyHistory(res);
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = '내 지난 기록 보기'; }
    if (body) body.innerHTML = `<div class="notice error" style="margin-top:10px;">${escapeHtml(getErrorMessage(err))}</div>`;
  }
}

function renderMyHistory(res) {
  const el = document.getElementById('historyCard');
  if (!el) return;
  const items = (res && res.items) || [];

  if (!items.length) {
    el.innerHTML = `<h2>📈 내 지난 기록</h2>
      <p class="muted">아직 남긴 기록이 없어요. 오늘 첫 기록을 남겨보세요!</p>
      <button id="loadHistoryBtn" type="button" class="btn ghost">새로고침</button>`;
    document.getElementById('loadHistoryBtn').addEventListener('click', loadMyHistory);
    return;
  }

  const pts = items.filter(i => i.agency != null).map(i => ({ seq: i.seq, agency: i.agency }));
  const chart = pts.length >= 2
    ? historyLineChart(pts)
    : '<p class="muted">기록이 2개 이상 쌓이면 주도성 변화 그래프가 나타나요.</p>';

  const cards = items.slice().reverse().map(i => `
    <div class="selected-box" style="margin-bottom:8px;">
      <div class="muted" style="font-size:12px;">${escapeHtml(i.date)} · ${escapeHtml(i.class_id)} · ${escapeHtml(i.seq + '차시')}${i.agency != null ? ' · 주도성 ' + escapeHtml(i.agency) + '점' : ''}</div>
      <div style="margin-top:4px;"><strong>Q.</strong> ${escapeHtml(i.question)}</div>
      ${(i.activity || i.sel) ? `<div class="muted" style="font-size:12px; margin-top:2px;">${i.activity ? '활동: ' + escapeHtml(i.activity) : ''}${(i.activity && i.sel) ? ' · ' : ''}${i.sel ? 'SEL: ' + escapeHtml(i.sel) : ''}</div>` : ''}
      ${i.evidence ? `<div style="font-size:13px; margin-top:4px;">결과/피드백: ${escapeHtml(i.evidence)}</div>` : ''}
      ${i.next_try ? `<div style="font-size:13px; margin-top:4px; color:#2563eb;">→ 다음 질문: ${escapeHtml(i.next_try)}</div>` : ''}
    </div>
  `).join('');

  el.innerHTML = `
    <h2>📈 내 지난 기록</h2>
    <div class="stat-grid" style="grid-template-columns:repeat(2,1fr); margin-bottom:10px;">
      <div class="stat-box"><div class="muted">총 기록</div><div class="value">${escapeHtml(res.count)}</div></div>
      <div class="stat-box"><div class="muted">주도성 평균</div><div class="value">${escapeHtml(res.agencyAverage || '-')}</div></div>
    </div>
    <h3 class="chart-sub-title">주도성 변화 (기록 순서대로 · 1~5점)</h3>
    ${chart}
    <h3 class="chart-sub-title" style="margin-top:12px;">기록 모아보기 (최신순)</h3>
    ${cards}
    <button id="loadHistoryBtn" type="button" class="btn ghost" style="margin-top:8px;">새로고침</button>
  `;
  document.getElementById('loadHistoryBtn').addEventListener('click', loadMyHistory);
}

function historyLineChart(points) {
  const W = 360, H = 170, padL = 26, padR = 12, padT = 14, padB = 24;
  const yMin = 1, yMax = 5;
  const n = points.length;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const xOf = i => padL + (n <= 1 ? plotW / 2 : (plotW * i / (n - 1)));
  const yOf = v => padT + plotH * (1 - (v - yMin) / (yMax - yMin));
  const coords = points.map((p, i) => ({ cx: xOf(i), cy: yOf(p.agency), v: p.agency }));

  const grid = [1, 2, 3, 4, 5].map(v => {
    const y = yOf(v);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${(W - padR)}" y2="${y.toFixed(1)}" stroke="#eef2f7" stroke-width="1"/>`
         + `<text x="${padL - 6}" y="${(y + 3).toFixed(1)}" font-size="9" fill="#94a3b8" text-anchor="end">${v}</text>`;
  }).join('');
  const poly = coords.map(c => `${c.cx.toFixed(1)},${c.cy.toFixed(1)}`).join(' ');
  const dots = coords.map(c =>
    `<circle cx="${c.cx.toFixed(1)}" cy="${c.cy.toFixed(1)}" r="3.5" fill="#2563eb"/>`
    + `<text x="${c.cx.toFixed(1)}" y="${(c.cy - 7).toFixed(1)}" font-size="9" fill="#2563eb" text-anchor="middle">${c.v}</text>`
  ).join('');
  const xlabels = coords.map((c, i) =>
    `<text x="${c.cx.toFixed(1)}" y="${H - 6}" font-size="9" fill="#94a3b8" text-anchor="middle">${i + 1}</text>`
  ).join('');

  return `<div style="overflow-x:auto;"><svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:520px; height:auto;" role="img" aria-label="주도성 변화 그래프">
    ${grid}
    <polyline points="${poly}" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}${xlabels}
  </svg></div>`;
}

// =================== 제출 전 요약 → 제출 ===================

// 고른 값들을 정해진 문장 틀에 끼워 한 단락으로 만든다. (AI/API 없음, 무료 템플릿)
function buildReflectionText() {
  const activityLabel = selectedActivity === 'other' ? valueOf('activityOtherText') : labelOfActivity(selectedActivity);
  const goalText = selectedQuestion ? selectedQuestion.text : '';
  const methodText = selectedMethods.map(labelOfMethod).join(', ');
  const selLabel = selectedSel.length ? labelOfSel(selectedSel[0]) : '';
  const labels = LESSON_CONFIG.agency.labels;

  const parts = [];
  parts.push(`오늘 ${activityLabel}에서 "${goalText}"을(를) 탐구했다.`);
  if (methodText) parts.push(`${methodText}을(를) 해봤다.`);
  if (selectedFeedback) {
    parts.push(ACTIVE.feedbackMode === 'given'
      ? `친구에게 "${selectedFeedback}"라고 피드백을 해줬다.`
      : `친구에게 "${selectedFeedback}"라는 피드백을 받았다.`);
  }
  if (selectedResult) parts.push(`그 결과 ${selectedResult}.`);
  if (selectedNextTry) parts.push(`다음 시간에는 ${selectedNextTry}.`);
  if (agencyScore) parts.push(`오늘 나의 자기주도성은 ${agencyScore}점(${labels[agencyScore] || ''})이다.`);
  if (selLabel) parts.push(`특히 '${selLabel}'을(를) 발휘했다.`);
  return parts.join(' ');
}

// 입력값을 모아 검증하고 payload 를 만든다.
function gatherRecord() {
  const activityCode = selectedActivity || '';
  const activityOtherText = activityCode === 'other' ? valueOf('activityOtherText') : '';

  const errors = [];
  if (!activityCode) errors.push('오늘 활동');
  if (activityCode === 'other' && !activityOtherText) errors.push('활동 직접 입력');
  if (!selectedQuestion || !selectedQuestion.text) errors.push('오늘 목표·질문');
  if (!selectedMethods.length) errors.push('해본 방법');
  if (!selectedResult) errors.push('오늘 결과·증거');
  if (!selectedNextTry) errors.push('다음 시간에 바꿔볼 점');
  if (!agencyScore) errors.push('자기주도성 점수');
  if (!selectedSel.length) errors.push('SEL 역량');

  const reflectionText = buildReflectionText();
  const payload = {
    sessionId: selectedSession ? selectedSession.session_id : '',
    activityCode,
    activityOtherText,
    // 교사가 만든 자유 옵션도 통계가 정확하도록 라벨을 함께 보낸다(db 가 우선 사용).
    activityLabel: activityCode === 'other' ? activityOtherText : labelOfActivity(activityCode),
    question: selectedQuestion,
    methodCodes: selectedMethods,
    methodLabels: selectedMethods.map(labelOfMethod),
    evidenceResult: selectedResult,
    nextTry: selectedNextTry,
    agencyScore,
    selCompetencyCodes: selectedSel,
    selLabels: selectedSel.map(labelOfSel),
    recordType: ACTIVE.recordType || 'quick',
    feedbackMode: ACTIVE.feedbackMode,
    peerFeedback: selectedFeedback,
    reflectionText
  };
  return { errors, payload, reflectionText };
}

// 제출 버튼 → 검증 후 요약 확인 모달을 띄운다.
function reviewBeforeSubmit() {
  if (isSubmitting) return;
  clearMessages();
  if (!currentUser) return showError('먼저 구글 로그인을 해주세요.');
  if (!selectedSession) return showError('먼저 본인 반을 선택해 주세요.');
  if (!ACTIVE.inputEnabled) return showError('지금은 기록 입력이 잠겨 있습니다. 선생님 안내를 기다려 주세요.');

  if (!myLinkedProfile && !isTeacherUser(currentUser)) {
    return showError('학생 정보가 연결되지 않았습니다. ② 로그인 칸에서 학번과 이름을 입력해 주세요.');
  }
  const { errors, payload, reflectionText } = gatherRecord();
  if (errors.length) return showError('입력 누락:\n- ' + errors.join('\n- '));
  showSummaryModal(reflectionText, payload);
}

function showSummaryModal(reflectionText, payload) {
  closeSummaryModal();
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.id = 'summaryBackdrop';
  back.innerHTML = `
    <div class="modal-card">
      <h2>오늘 기록 요약</h2>
      <p class="muted" style="margin-bottom:10px;">아래 내용으로 제출할까요? 고칠 부분이 있으면 '수정'을 누르세요.</p>
      <div class="summary-para">${escapeHtml(reflectionText)}</div>
      <div class="modal-actions">
        <button id="summaryEditBtn" type="button" class="btn ghost">수정</button>
        <button id="summaryConfirmBtn" type="button" class="btn primary">확인하고 제출</button>
      </div>
    </div>
  `;
  document.body.appendChild(back);
  back.addEventListener('click', e => { if (e.target === back) closeSummaryModal(); });
  document.getElementById('summaryEditBtn').addEventListener('click', closeSummaryModal);
  document.getElementById('summaryConfirmBtn').addEventListener('click', () => {
    closeSummaryModal();
    doSubmit(payload);
  });
}
function closeSummaryModal() {
  const back = document.getElementById('summaryBackdrop');
  if (back) back.remove();
}

async function doSubmit(payload) {
  if (isSubmitting) return;
  const submitBtn = document.getElementById('submitBtn');
  isSubmitting = true;
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '제출 중...'; }

  try {
    await submitSimpleResponse(payload);
    if (currentUser) saveSession(currentUser.uid, selectedSession.session_id);
    myHistoryLoaded = false;
    lastTryKey = null;
    renderHistoryCard();
    showSuccess('제출 성공! (수고하셨습니다)');
    if (submitBtn) submitBtn.textContent = '제출 완료';
    document.getElementById('resetBtn').style.display = 'inline-block';
  } catch (err) {
    isSubmitting = false;
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '기록 확인하고 제출'; }
    showError(getErrorMessage(err));
  }
}

// --- 공통 UI 유틸 ---
function updateSubmitState() {
  const btn = document.getElementById('submitBtn');
  if (!btn || isSubmitting) return;
  const placeholders = ['로그인 후 제출 가능', '반을 먼저 선택하세요'];
  if (!currentUser) {
    btn.disabled = true;
    btn.textContent = '로그인 후 제출 가능';
  } else if (!selectedSession) {
    btn.disabled = true;
    btn.textContent = '반을 먼저 선택하세요';
  } else {
    btn.disabled = false;
    if (placeholders.indexOf(btn.textContent) !== -1) btn.textContent = '기록 확인하고 제출';
  }
}
function valueOf(id) { const el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; }
function showError(msg) { const e = document.getElementById('errorBox'); if (!e) return alert(msg); e.className = 'notice error'; e.style.display = 'block'; e.innerHTML = escapeHtml(msg); window.scrollTo({ top: 0, behavior: 'smooth' }); }
function showSuccess(msg) { const s = document.getElementById('successBox'), e = document.getElementById('errorBox'); s.className = 'notice success'; s.style.display = 'block'; s.innerHTML = escapeHtml(msg); if (e) e.style.display = 'none'; window.scrollTo({ top: 0, behavior: 'smooth' }); }
function clearMessages() { const e = document.getElementById('errorBox'), s = document.getElementById('successBox'); if (e) e.style.display = 'none'; if (s) s.style.display = 'none'; }
function setLoading(show, text) { const el = document.getElementById('loading'), t = document.getElementById('loadingText'); if (t) t.textContent = text || '로딩 중...'; if (el) el.style.display = show ? 'flex' : 'none'; }
