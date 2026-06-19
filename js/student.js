// --- js/student.js ---
// 학생 화면: ① 학급 → ② 구글 로그인 → ③ 지난 질문 회상 → ④ 오늘 기록 → 다음 질문

import {
  getInitialData, getLastNextTry, submitSimpleResponse,
  signInWithGoogle, signOutUser, watchAuth, watchSiteStatus,
  setSiteActive, isTeacherUser, getMyDisplayName
} from './db.js';
import { escapeHtml, escapeAttr, sourceLabel, getErrorMessage, getQueryParam } from './utils.js';

let DATA = null;
let selectedSession = null;
let selectedQuestion = null;
let selectedSel = [];
let isSubmitting = false;
let SESSION_ID_PARAM = '';
let currentUser = null;
let myName = null;          // 교사 보정값 우선의 내 표시 이름 (null=아직 확인 전)
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
    renderTeacherPanel();              // 교사 로그인 시 켜기/끄기 토글 갱신 (켜짐/꺼짐 모두)
    if (siteActive !== true) return;   // 비활성 화면에서는 학생 카드가 없음
    renderStudentCard();
    if (user) { refreshMyName(); loadLastNextTry(); }
    updateSubmitState();
  });
}

// 교사 보정값을 포함한 내 표시 이름을 불러와 ②번 카드를 갱신한다.
async function refreshMyName() {
  if (!currentUser) { myName = null; return; }
  try { myName = await getMyDisplayName(); } catch { myName = null; }
  renderStudentCard();
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
  if (currentUser) loadLastNextTry();
  updateSubmitState();
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
    selectedSession = data.session;
    selectedQuestion = null;
    selectedSel = null;
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
  if (!SESSION_ID_PARAM) {
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
  } else {
    html += `<div class="info-box"><strong>${escapeHtml(session.title || '-')}</strong></div>`;
  }
  el.innerHTML = html;
  if (!SESSION_ID_PARAM) {
    Array.from(document.getElementsByName('sessionRadio')).forEach(input => {
      input.addEventListener('change', function () { loadInitial(this.value); });
    });
  }
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
  document.getElementById('loadLastBtn').addEventListener('click', loadLastNextTry);
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

async function loadLastNextTry() {
  const box = document.getElementById('lastTryBox');
  if (!box) return;

  if (!currentUser) {
    box.className = 'warning-box';
    box.innerHTML = '먼저 구글 로그인을 해주세요.';
    return;
  }

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
    box.className = 'notice error';
    box.innerHTML = escapeHtml(getErrorMessage(err));
  }
}

async function submitPortfolio() {
  if (isSubmitting) return;
  clearMessages();

  if (!currentUser) return showError('먼저 구글 로그인을 해주세요.');

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
  if (currentUser) {
    btn.disabled = false;
    if (btn.textContent === '로그인 후 제출 가능') btn.textContent = '제출하기';
  } else {
    btn.disabled = true;
    btn.textContent = '로그인 후 제출 가능';
  }
}
function valueOf(id) { const el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; }
function showError(msg) { const e = document.getElementById('errorBox'); if (!e) return alert(msg); e.className = 'notice error'; e.style.display = 'block'; e.innerHTML = escapeHtml(msg); window.scrollTo({ top: 0, behavior: 'smooth' }); }
function showSuccess(msg) { const s = document.getElementById('successBox'), e = document.getElementById('errorBox'); s.className = 'notice success'; s.style.display = 'block'; s.innerHTML = escapeHtml(msg); if (e) e.style.display = 'none'; window.scrollTo({ top: 0, behavior: 'smooth' }); }
function clearMessages() { const e = document.getElementById('errorBox'), s = document.getElementById('successBox'); if (e) e.style.display = 'none'; if (s) s.style.display = 'none'; }
function setLoading(show, text) { const el = document.getElementById('loading'), t = document.getElementById('loadingText'); if (t) t.textContent = text || '로딩 중...'; if (el) el.style.display = show ? 'flex' : 'none'; }
