// --- js/student.js ---
// 학생 화면: ① 학급 → ② 구글 로그인 → ③ 지난 질문 회상 → ④ 오늘 기록 → 다음 질문

import {
  getInitialData, getLastNextTry, submitSimpleResponse,
  signInWithGoogle, signOutUser, watchAuth, watchSiteStatus,
  setSiteActive, isTeacherUser, getMyProfile, getMyHistory
} from './db.js';
import { escapeHtml, escapeAttr, sourceLabel, getErrorMessage, getQueryParam } from './utils.js';

let DATA = null;
let selectedSession = null;
let classEditing = false;   // 반을 선택한 뒤엔 잠그고(현재 반만 표시), "반 변경"을 누르면 다시 그리드를 연다
let selectedQuestion = null;
let selectedSel = [];
let isSubmitting = false;
let SESSION_ID_PARAM = '';
let currentUser = null;
let myName = null;          // 교사 보정값 우선의 내 표시 이름 (null=아직 확인 전)
let myClass = null;         // 저장된 내 학급 { session_id, class_id, source } (null=없음/확인 전)
let myHistoryLoaded = false; // "내 지난 기록"을 이미 불러왔는지 (계정 바뀌면 false)
let lastTryKey = null;       // "지난 질문"을 이미 읽은 (uid|session) 키 — 로그인당 중복 읽기 방지
let siteActive = null;   // null=확인 전, true=켜짐, false=꺼짐
let isTogglingSite = false;

export function initStudent() {
  SESSION_ID_PARAM = getQueryParam('session_id') || getQueryParam('sessionId') || '';
  setLoading(true, '연결하는 중...');

  // 사이트 상태(켜짐/꺼짐)를 실시간으로 구독한다.
  // - 꺼짐: 간단한 안내 메시지만 표시
  // - 켜짐: 평소처럼 학생 기록 화면을 구성
  watchSiteStatus(active => {
    const prev = siteActive;
    siteActive = active;
    isTogglingSite = false;
    if (active) {
      // 꺼짐→켜짐(또는 첫 진입)일 때만 화면을 새로 구성한다.
      if (prev !== true) buildStudentApp();
    } else {
      renderDisabledScreen();
    }
  });

  // 로그인 상태가 바뀌면 ②번 카드와 제출 버튼을 갱신하고, 로그인 시 지난 질문을 자동으로 불러온다.
  watchAuth(user => {
    currentUser = user;
    myName = null;                     // 계정이 바뀌면 표시 이름을 다시 확인
    myClass = null;                    // 계정이 바뀌면 저장된 학급도 다시 확인
    myHistoryLoaded = false;           // 계정이 바뀌면 내 기록도 다시 불러오게
    lastTryKey = null;                 // 계정이 바뀌면 "지난 질문"도 다시 읽도록
    renderTeacherPanel();              // 교사 로그인 시 켜기/끄기 토글 갱신 (켜짐/꺼짐 모두)
    if (siteActive !== true) return;   // 비활성 화면에서는 학생 카드가 없음
    renderStudentCard();
    renderHistoryCard();
    if (user) { refreshMyProfile(); loadLastNextTry(); }
    updateSubmitState();
  });
}

// 로그인 시 본인 프로필(이름 + 교사 보정 학급)을 students/{uid} "한 번 읽기"로 가져와
// ②번 이름 카드와 ①번 학급 자동 선택을 함께 처리한다. (이름·학급을 따로 읽지 않음)
async function refreshMyProfile() {
  if (!currentUser) { myName = null; return; }
  let prof = null;
  try { prof = await getMyProfile(); } catch { prof = null; }   // 본인 문서 1읽기
  myName = (prof && prof.displayName) || null;
  renderStudentCard();
  applyMyClass(prof && prof.class);
}

// 학급 자동 선택: 교사 보정 학급(prof.class) → 이 기기에 기억된 내 마지막 제출 학급(localStorage, 읽기 0).
// 고정 링크(?session_id=)로 들어온 경우엔 그 학급을 존중하고 자동 전환하지 않는다.
function applyMyClass(teacherClass) {
  if (!currentUser || SESSION_ID_PARAM) return;
  let res = teacherClass || null;
  if (!res) {
    const saved = readSavedSession(currentUser.uid);          // 기기 캐시 (Firestore 읽기 없음)
    if (saved) res = { session_id: saved, source: 'history' };
  }
  if (!res || !res.session_id) return;

  const sessions = (DATA && DATA.sessions) || [];
  if (!sessions.some(s => s.session_id === res.session_id)) return;  // 사라진 학급이면 무시
  if (!res.class_id) res.class_id = classIdOf(res.session_id);
  myClass = res;

  // 저장된 학급이 현재 선택과 다르면 그 학급으로 다시 구성한다(로그인 직후라 입력 손실 없음).
  if (!selectedSession || selectedSession.session_id !== res.session_id) {
    loadInitial(res.session_id);
  } else {
    renderSessionCard();   // 같은 학급이면 안내 문구만 갱신
  }
}

// 학급 자동 선택용 기기 캐시. "이 학생(uid)이 이 기기에서 마지막으로 제출한 학급".
// 서버 기록을 매번 스캔하지 않아 Firestore 읽기를 아낀다.
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

// 사이트 비활성(꺼짐) 안내 화면. 교사 패널은 항상 포함해 선생님이 여기서 바로 켤 수 있게 한다.
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

// 사이트가 켜져 있을 때 학생 기록 화면을 구성한다.
function buildStudentApp() {
  renderStudentShell();
  loadInitial(SESSION_ID_PARAM);
  if (currentUser) { refreshMyProfile(); loadLastNextTry(); }
  updateSubmitState();
  renderHistoryCard();
  renderTeacherPanel();
}

// 학생 화면에서 보이는 교사 전용 패널.
//   - 로그인 안 함: "선생님 로그인" 접이식 버튼 (학생에게 방해되지 않게 작게)
//   - 교사 로그인:  사이트 켜기/끄기 토글
//   - 학생(비교사) 로그인: 숨김
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
    // 학생 본인 로그인 등 비교사 계정 → 패널 숨김
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }

  // 교사 로그인 → 사이트 켜기/끄기 토글
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
    // 상태 반영(화면 전환)은 watchSiteStatus 구독이 처리한다.
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
      <p class="muted">수업을 마치며 오늘의 탐구를 기록합니다. (목표: 60초)</p>
    </header>
    <div id="errorBox" style="display:none;"></div>
    <div id="successBox" style="display:none;"></div>
    <section id="sessionCard" class="card"></section>
    <section id="studentCard" class="card"></section>
    <section id="lastQuestionCard" class="card"></section>
    <section id="mainFormCard" class="card"></section>
    <div class="footer-actions">
      <section class="card" style="margin-bottom:0;">
        <button id="submitBtn" class="btn primary" type="button">제출하기</button>
        <button id="resetBtn" class="btn ghost" type="button" style="display:none;">새 응답 작성</button>
      </section>
    </div>
    <section id="historyCard" class="card" style="display:none;"></section>
    <section id="teacherPanel" class="card" style="display:none;"></section>
  `;
  document.getElementById('submitBtn').addEventListener('click', submitPortfolio);
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
    // 반을 명시적으로 지정(고정 링크 / 직접 선택 / 기억된 반)했을 때만 선택한다.
    // 아니면 미선택(null)으로 두어, 학생이 반드시 본인 반을 직접 고르게 한다(기본값 1반 오입력 방지).
    selectedSession = sessionId ? data.session : null;
    if (sessionId) classEditing = false;   // 반을 정했으면 잠금 화면으로 (실수 변경 방지)
    selectedQuestion = null;
    selectedSel = null;
    const curSessionId = selectedSession ? selectedSession.session_id : null;
    if (prevSessionId !== curSessionId) lastTryKey = null;  // 학급이 바뀌면 지난 질문을 다시 읽도록
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
    el.innerHTML = `
      <h2>② 로그인</h2>
      <div class="selected-box">
        <strong>${escapeHtml(shownName)}</strong> 님으로 기록합니다.
      </div>
      <p class="muted" style="font-size:12px;">이름이 실제와 다르면 선생님이 바로잡아 드립니다.</p>
      <button id="signOutBtn" type="button" class="btn ghost">로그아웃</button>
    `;
    document.getElementById('signOutBtn').addEventListener('click', async () => {
      try { await signOutUser(); } catch (err) { showError(getErrorMessage(err)); }
    });
  } else {
    el.innerHTML = `
      <h2>② 로그인</h2>
      <p class="muted">학교 구글 계정으로 로그인하면 이름이 자동으로 연결됩니다. (이름 오타 걱정 없음)</p>
      <button id="signInBtn" type="button" class="btn primary">구글로 로그인</button>
    `;
    document.getElementById('signInBtn').addEventListener('click', async () => {
      try { await signInWithGoogle(); } catch (err) { showError(getErrorMessage(err)); }
    });
  }
}

function renderLastQuestionCard() {
  document.getElementById('lastQuestionCard').innerHTML = `
    <span class="step-tag step-before">수업 전 · 지난 질문 회상</span>
    <h2>③ 지난 시간 질문 이어가기</h2>
    <div id="lastTryBox" class="warning-box">로그인하면 지난 시간에 남긴 질문을 불러옵니다.</div>
    <button id="loadLastBtn" type="button" class="btn ghost">지난 질문 불러오기</button>
  `;
  document.getElementById('loadLastBtn').addEventListener('click', () => loadLastNextTry(true));
}

function renderMainForm() {
  document.getElementById('mainFormCard').innerHTML = `
    <span class="step-tag step-during">수업 중 · 오늘 한 탐구</span>
    <h2>④ 오늘 기록</h2>
    <div class="field">
      <label class="label" for="activityToday">오늘 활동</label>
      <select id="activityToday"><option value="">선택</option>${renderOptions('activities')}</select>
    </div>
    <div class="field" id="activityOtherField" style="display:none;">
      <label class="label" for="activityOtherText">활동 직접 입력</label>
      <input type="text" id="activityOtherText" placeholder="오늘 한 활동을 직접 입력하세요.">
    </div>
    <div class="field">
      <label class="label">오늘 내가 답을 찾아본 탐구 질문</label>
      <div id="questionGridCore" class="question-grid"></div>
      <button id="showMoreQuestionsBtn" class="expand-btn" type="button">추천 질문 더보기 ▾</button>
      <div id="questionGridMore" class="question-grid" style="display:none;"></div>
    </div>
    <div class="field">
      <label class="label" for="directQuestion">직접 질문 쓰기</label>
      <textarea id="directQuestion" placeholder="원하는 질문이 없다면 직접 작성하세요."></textarea>
      <button id="useDirectBtn" type="button" class="btn green" style="margin-top:8px;">직접 쓴 질문 사용</button>
    </div>
    <div class="field">
      <div id="selectedQuestionBox" class="warning-box">아직 질문을 선택하지 않았습니다.</div>
      <label class="label">이 질문을 탐구하면서 오늘 해본 방법 <span class="muted" style="font-weight:400;">(복수 선택)</span></label>
      <div class="check-grid">${renderPracticeMethodChecks()}</div>
    </div>
    <div class="field">
      <label class="label" for="evidenceResult">오늘 해본 결과 및 과정 피드백</label>
      <textarea id="evidenceResult" placeholder="예: 슛 10개 중 4개 성공 / 자세를 낮추니 공이 덜 흔들렸다 / 친구가 팔을 뻗으라고 했다"></textarea>
    </div>

    <div class="field">
      <label class="label">오늘 나는 스스로 선택하고, 시도하고, 바꿔보았다.</label>
      <div class="scale-row">
        ${[1, 2, 3, 4, 5].map(n => `<label class="scale-option"><input type="radio" name="agencyScore" value="${n}"><span>${n}</span></label>`).join('')}
      </div>
      <div class="score-labels">
        <div><strong>1점:</strong> 거의 참여하지 못했다.</div>
        <div><strong>2점:</strong> 선생님이 지시하는 만큼만 수동적으로 했다.</div>
        <div><strong>3점:</strong> 내 질문을 해결하기 위해 스스로 시도했다.</div>
        <div><strong>4점:</strong> 실패 원인을 찾고 연습 방법을 바꿔보았다.</div>
        <div><strong>5점:</strong> 포기하지 않고 끝까지 조정하며 도전했다.</div>
      </div>
    </div>

    <div class="field">
      <label class="label">오늘 이 활동에서 특히 발휘한 SEL 역량 <span class="muted" style="font-weight:400;">(복수 선택 가능)</span></label>
      <div id="selGrid" class="sel-grid">${renderSelCards()}</div>
    </div>

    <div class="field">
      <span class="step-tag step-after">수업 후 · 다음 질문 만들기</span>
      <label class="label" for="nextTry">다음 시간에 탐구할 질문</label>
      <textarea id="nextTry" placeholder="예: 다음 시간에는 속도를 늦추면 더 정확해질까? 친구와 호흡을 맞추려면 무엇을 해야 할까?"></textarea>
      <div class="muted" style="font-size:12px; margin-top:5px;">여기 적은 질문이 다음 시간 ③번에 다시 나타납니다.</div>
    </div>
  `;
  document.getElementById('useDirectBtn').addEventListener('click', useDirectQuestion);
  document.getElementById('showMoreQuestionsBtn').addEventListener('click', function () {
    document.getElementById('questionGridMore').style.display = 'grid';
    this.style.display = 'none';
  });
  document.getElementById('activityToday').addEventListener('change', function () {
    const otherField = document.getElementById('activityOtherField');
    if (otherField) otherField.style.display = this.value === 'other' ? 'block' : 'none';
  });
  renderQuestionCards();
  bindSelCards();
}

function getOptions(setId) {
  return DATA && DATA.optionsBySet ? DATA.optionsBySet[setId] || [] : [];
}
function renderOptions(setId) {
  return getOptions(setId).map(opt => `<option value="${escapeAttr(opt.option_code)}">${escapeHtml(opt.option_label)}</option>`).join('');
}
function renderPracticeMethodChecks() {
  return getOptions('practice_methods').map(opt => `<label class="check-card"><input type="checkbox" name="practiceMethod" value="${escapeAttr(opt.option_code)}"><span>${escapeHtml(opt.option_label)}</span></label>`).join('');
}
function renderSelCards() {
  return getOptions('sel_competencies').map(opt => `<label class="sel-card"><input type="checkbox" name="selCompetency" value="${escapeAttr(opt.option_code)}"><span>${escapeHtml(opt.option_label)}</span></label>`).join('');
}
function bindSelCards() {
  Array.from(document.getElementsByName('selCompetency')).forEach(input => {
    input.addEventListener('change', function () {
      selectedSel = Array.from(document.getElementsByName('selCompetency'))
        .filter(i => i.checked)
        .map(i => i.value);
      Array.from(document.getElementsByName('selCompetency')).forEach(i => {
        i.closest('label').classList.toggle('selected', i.checked);
      });
    });
  });
}

function renderQuestionCards() {
  const coreGrid = document.getElementById('questionGridCore');
  const moreGrid = document.getElementById('questionGridMore');
  if (!coreGrid || !moreGrid) return;

  const questions = DATA.questions || [];
  const coreQuestions = questions.slice(0, 4);
  const moreQuestions = questions.slice(4);

  const makeHtml = q => `
    <button type="button" class="question-card ${selectedQuestion && selectedQuestion.qid === q.qid ? 'selected' : ''}" data-qid="${escapeAttr(q.qid)}">
      <strong>${escapeHtml(q.short_label)}</strong>
      <div class="muted">${escapeHtml(q.question_text)}</div>
    </button>
  `;

  coreGrid.innerHTML = coreQuestions.map(makeHtml).join('');
  moreGrid.innerHTML = moreQuestions.map(makeHtml).join('');
  if (!moreQuestions.length) {
    const moreBtn = document.getElementById('showMoreQuestionsBtn');
    if (moreBtn) moreBtn.style.display = 'none';
  }

  Array.from(document.querySelectorAll('.question-card')).forEach(btn => {
    btn.addEventListener('click', function () {
      const q = questions.find(item => item.qid === this.dataset.qid);
      if (!q) return;
      selectedQuestion = { source: 'bank', qid: q.qid, text: q.question_text, short_label: q.short_label };
      renderSelectedQuestionBox();
      renderQuestionCards();
    });
  });
}

function renderSelectedQuestionBox() {
  const box = document.getElementById('selectedQuestionBox');
  if (!selectedQuestion || !selectedQuestion.text) {
    box.className = 'warning-box';
    box.innerHTML = '아직 질문을 선택하지 않았습니다.';
    return;
  }
  box.className = 'selected-box';
  box.innerHTML = `<div class="muted">${escapeHtml(sourceLabel(selectedQuestion.source))}</div><strong>${escapeHtml(selectedQuestion.text)}</strong>`;
}

function useDirectQuestion() {
  const text = valueOf('directQuestion');
  if (!text) return showError('직접 쓴 질문을 입력해 주세요.');
  selectedQuestion = { source: 'direct', qid: '', text };
  renderSelectedQuestionBox();
  renderQuestionCards();
}

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

  // 로그인 직후엔 이 함수가 여러 경로에서 거의 동시에 불릴 수 있다.
  // 같은 (계정|학급)으로 이미 읽었으면 다시 읽지 않는다(force 일 때만 강제 재조회).
  const key = currentUser.uid + '|' + (selectedSession ? selectedSession.session_id : '');
  if (!force && key === lastTryKey) return;
  lastTryKey = key;   // 동시 호출까지 함께 막도록 읽기 시작 시점에 기록

  box.style.display = 'block';
  box.className = 'warning-box';
  box.innerHTML = '지난 기록 확인 중...';

  try {
    const res = await getLastNextTry({ sessionId: selectedSession.session_id });
    if (!res || !res.found) {
      box.className = 'warning-box';
      box.innerHTML = '지난 시간 기록이 없습니다. 오늘은 추천 질문에서 골라 시작하세요.';
      return;
    }
    box.className = 'selected-box';
    box.innerHTML = `<div class="muted">지난 시간에 내가 만든 다음 탐구 질문</div><p style="font-weight:900; margin:6px 0 10px;">${escapeHtml(res.next_try)}</p><button id="useLastAsQuestionBtn" type="button" class="btn green">오늘의 탐구 질문으로 사용</button>`;
    document.getElementById('useLastAsQuestionBtn').addEventListener('click', () => {
      selectedQuestion = { source: 'previous', qid: '', text: res.next_try };
      renderSelectedQuestionBox();
      renderQuestionCards();
      document.getElementById('mainFormCard').scrollIntoView({ behavior: 'smooth' });
    });
  } catch (err) {
    lastTryKey = null;   // 실패 시 다음에 다시 시도할 수 있도록
    box.className = 'notice error';
    box.innerHTML = escapeHtml(getErrorMessage(err));
  }
}

// --- 내 지난 기록 (학생 본인 열람) ---

// 로그인했을 때만 보이는 "내 지난 기록" 카드. 처음엔 버튼만 두고, 눌렀을 때 불러온다.
// (불러오기를 눌러야 Firestore 를 읽으므로 평소 읽기 비용이 늘지 않는다.)
function renderHistoryCard() {
  const el = document.getElementById('historyCard');
  if (!el) return;
  if (!currentUser) { el.style.display = 'none'; el.innerHTML = ''; myHistoryLoaded = false; return; }
  el.style.display = 'block';
  if (myHistoryLoaded) return;   // 이미 불러온 내용은 그대로 둔다
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

// 주도성(1~5) 꺾은선 그래프. 외부 라이브러리 없이 인라인 SVG 로 그린다.
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

async function submitPortfolio() {
  if (isSubmitting) return;
  clearMessages();

  if (!currentUser) return showError('먼저 구글 로그인을 해주세요.');
  if (!selectedSession) return showError('먼저 본인 반을 선택해 주세요.');

  const activityCode = valueOf('activityToday');
  const activityOtherText = activityCode === 'other' ? valueOf('activityOtherText') : '';
  const methodCodes = Array.from(document.getElementsByName('practiceMethod')).filter(i => i.checked).map(i => i.value);
  const evidenceResult = valueOf('evidenceResult');
  const nextTry = valueOf('nextTry');
  const agencyChecked = Array.from(document.getElementsByName('agencyScore')).find(i => i.checked);
  const agencyScore = agencyChecked ? Number(agencyChecked.value) : '';
  const selCompetencyCodes = Array.isArray(selectedSel) ? selectedSel : [];

  const errors = [];
  if (!activityCode) errors.push('오늘 활동');
  if (activityCode === 'other' && !activityOtherText) errors.push('기타 활동 내용 (직접 입력)');
  if (!selectedQuestion || !selectedQuestion.text) errors.push('오늘의 탐구 질문');
  if (!methodCodes.length) errors.push('오늘 해본 방법');
  if (!evidenceResult) errors.push('결과 및 과정 피드백');
  if (!agencyScore) errors.push('주도성 점수');
  if (!selCompetencyCodes.length) errors.push('오늘 발휘한 SEL 역량');
  if (!nextTry) errors.push('다음 시간에 탐구할 질문');

  if (errors.length) return showError('입력 누락:\n- ' + errors.join('\n- '));

  const payload = {
    sessionId: selectedSession.session_id, activityCode,
    activityOtherText,
    question: selectedQuestion, methodCodes, evidenceResult,
    nextTry, agencyScore, selCompetencyCodes
  };

  const submitBtn = document.getElementById('submitBtn');
  isSubmitting = true;
  submitBtn.disabled = true;
  submitBtn.textContent = '제출 중...';

  try {
    await submitSimpleResponse(payload);
    // 다음 로그인 때 이 학급을 자동 선택하도록 기기에 기억(서버 추가 읽기 없음).
    if (currentUser) saveSession(currentUser.uid, selectedSession.session_id);
    myHistoryLoaded = false;          // 방금 제출분이 반영되도록 "내 기록"을 다시 불러오게
    lastTryKey = null;                // 방금 쓴 "다음 질문"이 지난 질문으로 반영되도록
    renderHistoryCard();
    showSuccess('제출 성공! (수고하셨습니다)');
    submitBtn.textContent = '제출 완료';
    document.getElementById('resetBtn').style.display = 'inline-block';
  } catch (err) {
    isSubmitting = false;
    submitBtn.disabled = false;
    submitBtn.textContent = '제출하기';
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
    if (placeholders.indexOf(btn.textContent) !== -1) btn.textContent = '제출하기';
  }
}
function valueOf(id) { const el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; }
function showError(msg) { const e = document.getElementById('errorBox'); if (!e) return alert(msg); e.className = 'notice error'; e.style.display = 'block'; e.innerHTML = escapeHtml(msg); window.scrollTo({ top: 0, behavior: 'smooth' }); }
function showSuccess(msg) { const s = document.getElementById('successBox'), e = document.getElementById('errorBox'); s.className = 'notice success'; s.style.display = 'block'; s.innerHTML = escapeHtml(msg); if (e) e.style.display = 'none'; window.scrollTo({ top: 0, behavior: 'smooth' }); }
function clearMessages() { const e = document.getElementById('errorBox'), s = document.getElementById('successBox'); if (e) e.style.display = 'none'; if (s) s.style.display = 'none'; }
function setLoading(show, text) { const el = document.getElementById('loading'), t = document.getElementById('loadingText'); if (t) t.textContent = text || '로딩 중...'; if (el) el.style.display = show ? 'flex' : 'none'; }
