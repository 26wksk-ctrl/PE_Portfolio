// --- js/teacher.js ---
// 교사용 대시보드: 구글 로그인 → 통계 + SEL 분포 + 학급별 제출 수 + 최근 기록 + 구글 시트 내보내기
//
// (진단용) 내보내기 버튼이 "반응 없음"인 문제를 잡기 위해:
//   - 버튼 바인딩을 controlCard 가 보이는 시점(renderAuthState)에서 onclick 으로 다시 묶음
//   - 클릭/성공/실패 시 console.log 로 흐름을 찍음  → 해결되면 console.log 줄은 지워도 됩니다.

import {
  getTeacherDashboardData, exportToSheet, setStudentName, setStudentClass, deleteStudentData,
  moveResponsesToTrash, listTrash, restoreResponses, purgeTrash, emptyTrash,
  signInWithGoogle, signOutUser, watchAuth, isTeacherUser,
  watchSiteStatus, setSiteActive, getLessonSettings, saveLessonSettings,
  getStudentRoster, addStudentToRoster, unclaimStudentProfile, removeStudentFromRoster, setStudentEmail
} from './db.js';
import { escapeHtml, escapeAttr, getErrorMessage, sourceLabel, str, incCount, countsToArray, parseStudentId } from './utils.js';
import {
  getDefaultLessonSettings, normalizeLessonSettings,
  getActivityOptions, FIXED_ACTIVITIES, OTHER_ACTIVITY
} from './lesson-config.js';
import { PATCH_NOTES } from './patch-notes.js';

let currentUser = null;
let siteActive = null;     // null=확인 전, true=켜짐, false=꺼짐
let siteUnsub = null;
let isTogglingSite = false;
let lastDashboard = null;  // 마지막 대시보드 데이터 (학생 드릴다운 재렌더용)
let recentShown = 100;     // "최근 기록" 표에서 현재 보여주는 행 수 (더 보기로 증가)
let lastTrash = null;      // 마지막으로 불러온 휴지통 목록
let lessonSettingsLoaded = false; // 수업 설정 폼을 이미 불러왔는지 (교사 로그인당 1회 읽기)

const CHART_COLORS = ['#2563eb', '#16a34a', '#dc2626', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];

// 조회 설정의 기간 프리셋을 { start, end, label } 로 변환한다. (end 는 "미만")
function getSelectedRange() {
  const sel = document.getElementById('dashRange');
  const mode = sel ? sel.value : 'month';
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  if (mode === 'all') return { start: null, end: null, label: '전체 기간' };
  if (mode === '3months') return { start: new Date(y, m - 2, 1), end: new Date(y, m + 1, 1), label: '최근 3개월' };
  if (mode === 'year') return { start: new Date(y, 0, 1), end: new Date(y + 1, 0, 1), label: y + '년' };
  if (mode === 'custom') {
    const sv = (document.getElementById('dashStartMonth') || {}).value || '';
    const ev = (document.getElementById('dashEndMonth') || {}).value || '';
    const start = sv ? new Date(sv + '-01T00:00:00') : null;
    let end = null;
    if (ev) { const d = new Date(ev + '-01T00:00:00'); end = new Date(d.getFullYear(), d.getMonth() + 1, 1); }
    return { start, end, label: (sv || '처음') + ' ~ ' + (ev || '끝') };
  }
  return { start: new Date(y, m, 1), end: new Date(y, m + 1, 1), label: y + '년 ' + (m + 1) + '월' };
}

export function initTeacher() {
  renderTeacherShell();
  watchAuth(user => { currentUser = user; renderAuthState(); });

  // 사이트 상태를 실시간 구독해 토글 버튼에 반영한다. (읽기는 누구나 가능)
  siteUnsub = watchSiteStatus(active => {
    siteActive = active;
    isTogglingSite = false;
    renderSiteControl();
  });
}

function renderTeacherShell() {
  document.getElementById('app').innerHTML = `
    <header><h1>교사용 대시보드</h1><p class="muted">학생들의 누적 자동 차시 기록 확인.</p></header>
    <div id="teacherError" style="display:none;"></div>
    <div id="teacherInfo" style="display:none;"></div>
    <section id="authCard" class="card"></section>
    <section id="siteControlCard" class="card" style="display:none;">
      <h2>사이트 상태 (학생 화면 켜기 / 끄기)</h2>
      <p class="muted">꺼 두면 학생에게는 안내 메시지만 보이고, 켜면 기록 화면이 나타납니다. 언제든 바꿀 수 있습니다.</p>
      <div id="siteStatusBox" class="selected-box">상태 확인 중...</div>
      <button id="siteToggleBtn" type="button" class="btn primary" disabled>상태 확인 중...</button>
    </section>
    <section id="lessonSettingsCard" class="card" style="display:none;">
      <h2>수업 설정 (학생 화면 구성)</h2>
      <p class="muted">여기서 바꾸면 코드 수정 없이 학생 '오늘 기록' 화면의 활동·질문·선택지가 바뀝니다. 저장하면 즉시 적용됩니다.</p>
      <div id="lessonSettingsBody"><p class="muted">불러오는 중...</p></div>
    </section>
    <section id="controlCard" class="card" style="display:none;">
      <h2>조회 설정</h2>
      <div class="field">
        <label class="label">조회 기간 (기본: 이번 달 — 넓힐수록 더 많이 읽습니다)</label>
        <select id="dashRange">
          <option value="month">이번 달</option>
          <option value="3months">최근 3개월</option>
          <option value="year">올해</option>
          <option value="all">전체 기간</option>
          <option value="custom">사용자 지정(월 범위)</option>
        </select>
      </div>
      <div id="customRangeRow" class="two-col" style="display:none;">
        <div class="field"><label class="label">시작 월</label><input id="dashStartMonth" type="month"></div>
        <div class="field"><label class="label">끝 월 (포함)</label><input id="dashEndMonth" type="month"></div>
      </div>
      <div class="two-col">
        <div class="field"><label class="label">학급 필터</label><input id="dashClassId" type="text" placeholder="예: 1반"></div>
        <div class="field"><label class="label">활동 필터</label><input id="dashActivity" type="text" placeholder="예: 농구"></div>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button id="loadDashBtn" type="button" class="btn primary">대시보드 새로고침</button>
        <button id="exportBtn" type="button" class="btn green">구글 시트로 내보내기</button>
      </div>
    </section>
    <div id="dashboardResult"></div>
    <section id="rosterCard" class="card" style="display:none;">
      <h2>학생 명단 관리</h2>
      <p class="muted">학번 5자리(학년1 + 반2 + 번호2, 예: <code>10418</code>=1학년 4반 18번)만 넣으면 반·번호가 자동으로 채워집니다. 학생의 <strong>학교 구글 이메일</strong>을 함께 등록해 두면, 학생은 그 계정으로 <strong>로그인만 하면 자동 연결</strong>됩니다(학번·이름 타이핑 불필요). 잘못 연결된 경우 여기서 해제할 수 있습니다.</p>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px;">
        <button id="rosterLoadBtn" type="button" class="btn primary">명단 불러오기</button>
        <button id="rosterAddToggleBtn" type="button" class="btn ghost">+ 학생 추가</button>
      </div>
      <div id="rosterAddForm" style="display:none;" class="selected-box">
        <h3 style="margin:0 0 10px;">학생 추가</h3>
        <div class="two-col">
          <div class="field">
            <label class="label">학번 (5자리)</label>
            <input id="raStudentId" type="text" inputmode="numeric" maxlength="5" placeholder="10418">
            <p id="raStudentIdHint" class="muted" style="font-size:12px; margin-top:4px;">학년·반·번호가 자동으로 채워집니다.</p>
          </div>
          <div class="field"><label class="label">이름</label><input id="raName" type="text" maxlength="20" placeholder="심우용"></div>
        </div>
        <div class="field">
          <label class="label">학교 구글 이메일 (자동 연결용, 선택)</label>
          <input id="raEmail" type="email" maxlength="120" placeholder="student@school.example.com">
          <p class="muted" style="font-size:12px; margin-top:4px;">등록해 두면 학생이 이 계정으로 로그인할 때 자동 연결됩니다. 비워두면 학생이 학번+이름을 직접 입력해 연결합니다.</p>
        </div>
        <div class="field"><label class="label">등록 코드 (선택, 4자리)</label><input id="raCode" type="text" inputmode="numeric" maxlength="4" placeholder="비워두면 코드 없음"></div>
        <div style="display:flex; gap:8px; margin-top:4px;">
          <button id="raSubmitBtn" type="button" class="btn primary">추가</button>
          <button id="raCancelBtn" type="button" class="btn ghost">취소</button>
        </div>
      </div>
      <div id="rosterBody"></div>
    </section>
    <section id="patchNotesCard" class="card">
      <h2>패치노트</h2>
      <p class="muted">앱 변경 이력입니다. (최신순)</p>
      <div id="patchNotesBody"></div>
    </section>
  `;
  // 1차 바인딩 (셸 생성 시점)
  bindControlButtons();
  renderPatchNotes();
}

// 패치노트(변경 이력) 렌더링.
//   - 최신 2개 버전만 기본으로 펼쳐 보여준다.
//   - 그 이전 버전은 "이전 패치노트 보기 ▼" 버튼으로 접었다 펼친다.
//   - 각 항목에 완료 날짜와 시간(있으면)을 함께 표기한다.
function patchNoteHtml(note) {
  const ver = note.version ? `<span class="step-tag step-after">${escapeHtml(note.version)}</span>` : '';
  const when = escapeHtml(note.date) + (note.time ? ' ' + escapeHtml(note.time) : '');
  const items = (note.items || []).map(it => `<li>${escapeHtml(it)}</li>`).join('');
  return `
      <div class="patch-note">
        <div class="patch-note-head">${ver}<strong>${escapeHtml(note.title)}</strong><span class="muted">${when}</span></div>
        <ul class="patch-note-list">${items}</ul>
      </div>`;
}

function renderPatchNotes() {
  const body = document.getElementById('patchNotesBody');
  if (!body) return;
  if (!PATCH_NOTES || !PATCH_NOTES.length) {
    body.innerHTML = '<p class="muted">등록된 변경 이력이 없습니다.</p>';
    return;
  }
  const latest = PATCH_NOTES.slice(0, 2);
  const older = PATCH_NOTES.slice(2);

  let html = latest.map(patchNoteHtml).join('');
  if (older.length) {
    html += `<button id="patchNotesToggle" type="button" class="expand-btn">이전 패치노트 보기 (${older.length}개) ▼</button>
      <div id="patchNotesOlder" style="display:none;">${older.map(patchNoteHtml).join('')}</div>`;
  }
  body.innerHTML = html;

  const toggle = document.getElementById('patchNotesToggle');
  if (toggle) toggle.onclick = function () {
    const olderBox = document.getElementById('patchNotesOlder');
    if (!olderBox) return;
    const open = olderBox.style.display !== 'none';
    olderBox.style.display = open ? 'none' : 'block';
    this.textContent = open ? `이전 패치노트 보기 (${older.length}개) ▼` : '이전 패치노트 접기 ▲';
  };
}

// 버튼을 확실하게 묶는다. onclick 이라 여러 번 호출해도 중복 등록되지 않음.
function bindControlButtons() {
  const loadBtn = document.getElementById('loadDashBtn');
  const expBtn = document.getElementById('exportBtn');
  const siteBtn = document.getElementById('siteToggleBtn');
  const rangeSel = document.getElementById('dashRange');
  if (loadBtn) loadBtn.onclick = loadTeacherDashboard;
  if (expBtn) expBtn.onclick = exportToGoogleSheet;
  if (siteBtn) siteBtn.onclick = toggleSite;
  if (rangeSel) rangeSel.onchange = function () {
    const row = document.getElementById('customRangeRow');
    if (row) row.style.display = (this.value === 'custom') ? 'grid' : 'none';
  };
}

// 사이트 켜기/끄기 카드 렌더링. 교사로 로그인한 경우에만 보인다.
function renderSiteControl() {
  const card = document.getElementById('siteControlCard');
  if (!card) return;

  const isTeacher = isTeacherUser(currentUser);
  card.style.display = isTeacher ? 'block' : 'none';
  if (!isTeacher) return;

  const box = document.getElementById('siteStatusBox');
  const btn = document.getElementById('siteToggleBtn');
  if (!box || !btn) return;

  if (isTogglingSite) {
    btn.disabled = true;
    btn.textContent = '변경 중...';
    return;
  }
  if (siteActive === null) {
    box.textContent = '상태 확인 중...';
    btn.disabled = true;
    btn.textContent = '상태 확인 중...';
    return;
  }

  box.innerHTML = siteActive
    ? '현재 상태: <strong style="color:#16a34a;">켜짐 — 학생이 기록할 수 있습니다.</strong>'
    : '현재 상태: <strong style="color:#dc2626;">꺼짐 — 학생에게는 안내 메시지만 보입니다.</strong>';
  btn.disabled = false;
  btn.textContent = siteActive ? '사이트 끄기' : '사이트 켜기';
  btn.className = siteActive ? 'btn ghost' : 'btn primary';
}

async function toggleSite() {
  if (isTogglingSite || siteActive === null) return;
  clearTeacherError();
  const target = !siteActive;
  isTogglingSite = true;
  renderSiteControl();
  try {
    await setSiteActive(target);
    // 실제 상태 반영은 watchSiteStatus 구독이 처리한다.
    showTeacherInfo(target ? '사이트를 켰습니다. 학생 화면이 활성화됩니다.' : '사이트를 껐습니다. 학생 화면이 비활성화됩니다.');
  } catch (err) {
    isTogglingSite = false;
    renderSiteControl();
    showTeacherError(getErrorMessage(err));
  }
}

// ----- 수업 설정 (lessonSettings) -----

// 교사 로그인 시 현재 수업 설정을 1회 읽어 폼을 채운다. (force=true 면 다시 읽음)
function loadLessonSettingsForm(force) {
  const card = document.getElementById('lessonSettingsCard');
  if (!card) return;
  const isTeacher = isTeacherUser(currentUser);
  card.style.display = isTeacher ? 'block' : 'none';
  if (!isTeacher) { lessonSettingsLoaded = false; return; }
  if (lessonSettingsLoaded && !force) return;

  const body = document.getElementById('lessonSettingsBody');
  if (body) body.innerHTML = '<p class="muted">불러오는 중...</p>';
  getLessonSettings()
    .then(raw => { lessonSettingsLoaded = true; renderLessonSettingsForm(normalizeLessonSettings(raw)); })
    .catch(e => { if (body) body.innerHTML = ''; showTeacherError(getErrorMessage(e)); });
}

function renderLessonSettingsForm(s) {
  const body = document.getElementById('lessonSettingsBody');
  if (!body) return;
  const optText = arr => (arr || []).map(o => o.label).join('\n');
  // 기본 활동 기본값 선택지 = 고정 활동 + 교사 추가분 ('직접 입력'은 기본값 후보에서 제외)
  const actOpts = ['<option value="">지정 안 함 (학생이 직접 선택)</option>']
    .concat(getActivityOptions(s)
      .filter(a => a.code !== OTHER_ACTIVITY.code)
      .map(a => `<option value="${escapeAttr(a.code)}"${s.activity === a.code ? ' selected' : ''}>${escapeHtml(a.label)}</option>`)).join('');
  const fixedLabels = FIXED_ACTIVITIES.map(a => a.label).join(', ');

  body.innerHTML = `
    <div class="field">
      <label class="label">① 오늘 활동 목록 (추가 활동)</label>
      <p class="muted" style="font-size:12px; margin:2px 0 6px;">고정 활동 <strong>${escapeHtml(fixedLabels)}</strong> 와 <strong>직접 입력</strong>은 항상 표시됩니다. 그 외에 더 쓸 활동을 아래 칸에 <strong>한 줄에 하나씩</strong> 적으면 학생 화면에 함께 나옵니다. (지우면 사라집니다)</p>
      <textarea id="lsActivityOptions" style="min-height:90px;" placeholder="예: 미션활동&#10;걷기&#10;농구 드리블">${escapeHtml(optText(s.activityOptions))}</textarea>
    </div>
    <div class="field"><label class="label">오늘 활동 기본값</label><select id="lsActivity">${actOpts}</select></div>
    <div class="field"><label class="label">오늘 핵심 질문 (선택)</label><input id="lsCoreQuestion" type="text" value="${escapeAttr(s.coreQuestion)}" placeholder="학생 화면 ②에 강조 표시됩니다."></div>
    <div class="two-col">
      <div class="field"><label class="label">친구 피드백 방향</label><select id="lsFeedbackMode">
        <option value="received"${s.feedbackMode === 'received' ? ' selected' : ''}>받은 피드백</option>
        <option value="given"${s.feedbackMode === 'given' ? ' selected' : ''}>해준 피드백</option>
      </select></div>
      <div class="field"><label class="label">기록 유형</label><select id="lsRecordType">
        <option value="quick"${s.recordType === 'quick' ? ' selected' : ''}>quick (2분 기록)</option>
        <option value="deep"${s.recordType === 'deep' ? ' selected' : ''}>deep (단원 마무리 포트폴리오)</option>
      </select></div>
    </div>
    <p class="muted" style="margin:10px 0 4px;">아래 칸은 <strong>한 줄에 하나씩</strong> 선택지를 적습니다. 학생 화면의 칩이 이 목록대로 바뀝니다.</p>
    <div class="two-col">
      <div class="field"><label class="label">② 목표 · 질문 선택지</label><textarea id="lsGoals" style="min-height:130px;">${escapeHtml(optText(s.goalOptions))}</textarea></div>
      <div class="field"><label class="label">③ 해본 방법 선택지</label><textarea id="lsMethods" style="min-height:130px;">${escapeHtml(optText(s.methodOptions))}</textarea></div>
    </div>
    <div class="two-col">
      <div class="field"><label class="label">④ 친구 피드백 선택지</label><textarea id="lsFeedback" style="min-height:110px;">${escapeHtml(optText(s.feedbackOptions))}</textarea></div>
      <div class="field"><label class="label">⑤ 결과 · 증거 선택지</label><textarea id="lsResults" style="min-height:110px;">${escapeHtml(optText(s.resultOptions))}</textarea></div>
    </div>
    <div class="two-col">
      <div class="field"><label class="label">⑥ 다음 시도 선택지</label><textarea id="lsNext" style="min-height:110px;">${escapeHtml(optText(s.nextTryOptions))}</textarea></div>
      <div class="field"><label class="label">⑧ SEL 역량 선택지</label><textarea id="lsSel" style="min-height:110px;">${escapeHtml(optText(s.selFocus))}</textarea></div>
    </div>
    <div class="field">
      <label class="label" style="display:flex; gap:8px; align-items:center; font-weight:700;"><input id="lsInputEnabled" type="checkbox"${s.inputEnabled ? ' checked' : ''}> 학생 입력 허용 (끄면 학생 화면에 입력 잠금 안내가 표시됩니다)</label>
      <label class="label" style="display:flex; gap:8px; align-items:center; margin-top:6px; font-weight:700;"><input id="lsShareDash" type="checkbox"${s.shareDashboardEnabled ? ' checked' : ''}> 우리반 공유 대시보드 사용 (켜면 학생 화면에 익명 집계가 표시됩니다)</label>
    </div>
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">
      <button id="lsSaveBtn" type="button" class="btn primary">수업 설정 저장</button>
      <button id="lsResetBtn" type="button" class="btn ghost">기본값으로 되돌리기</button>
    </div>
  `;
  document.getElementById('lsSaveBtn').onclick = saveLessonSettingsForm;
  document.getElementById('lsResetBtn').onclick = () => {
    if (window.confirm('현재 입력을 기본값으로 되돌립니다. (저장을 눌러야 실제 반영됩니다)')) {
      renderLessonSettingsForm(getDefaultLessonSettings());
    }
  };
}

// 폼 입력을 lessonSettings 형태로 수집한다. (옵션은 줄바꿈 구분 → {code,label}, code=label)
function gatherLessonSettingsForm() {
  const lines = id => valueOf(id).split('\n').map(t => t.trim()).filter(Boolean);
  const toOpts = arr => arr.map(label => ({ code: label, label }));
  const checked = id => { const el = document.getElementById(id); return !!(el && el.checked); };
  return {
    // 단원/차시ID/날짜 입력칸은 제거함. 날짜는 기록 저장 시 자동(서버 시각)으로 들어간다.
    lessonId: '',
    date: '',
    classId: '',
    unit: '',
    activity: valueOf('lsActivity'),
    activityOptions: toOpts(lines('lsActivityOptions')),
    coreQuestion: valueOf('lsCoreQuestion'),
    goalOptions: toOpts(lines('lsGoals')),
    methodOptions: toOpts(lines('lsMethods')),
    feedbackMode: valueOf('lsFeedbackMode') === 'given' ? 'given' : 'received',
    feedbackOptions: toOpts(lines('lsFeedback')),
    resultOptions: toOpts(lines('lsResults')),
    nextTryOptions: toOpts(lines('lsNext')),
    selFocus: toOpts(lines('lsSel')),
    inputEnabled: checked('lsInputEnabled'),
    shareDashboardEnabled: checked('lsShareDash'),
    recordType: valueOf('lsRecordType') === 'deep' ? 'deep' : 'quick'
  };
}

async function saveLessonSettingsForm() {
  clearTeacherError();
  const raw = gatherLessonSettingsForm();
  if (!raw.goalOptions.length || !raw.methodOptions.length || !raw.selFocus.length) {
    return showTeacherError('목표 · 방법 · SEL 선택지는 각각 최소 1개 이상 필요합니다.');
  }
  const settings = normalizeLessonSettings(raw);
  const btn = document.getElementById('lsSaveBtn');
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '저장 중...'; }
  try {
    await saveLessonSettings(settings);
    showTeacherInfo('수업 설정을 저장했습니다. 학생 화면에 바로 반영됩니다.');
  } catch (e) {
    showTeacherError(getErrorMessage(e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

function renderAuthState() {
  const authCard = document.getElementById('authCard');
  const controlCard = document.getElementById('controlCard');
  clearTeacherError();

  // 로그아웃 상태
  if (!currentUser) {
    authCard.innerHTML = `
      <h2>로그인</h2>
      <p class="muted">교사용 구글 계정으로 로그인하세요.</p>
      <button id="tSignIn" type="button" class="btn primary">구글로 로그인</button>
    `;
    controlCard.style.display = 'none';
    document.getElementById('dashboardResult').innerHTML = '';
    document.getElementById('tSignIn').addEventListener('click', async () => {
      try { await signInWithGoogle(); } catch (e) { showTeacherError(getErrorMessage(e)); }
    });
    renderSiteControl();   // 로그아웃 시 사이트 컨트롤 숨김
    loadLessonSettingsForm();   // 로그아웃 시 수업 설정 카드 숨김
    return;
  }

  // 로그인 상태
  authCard.innerHTML = `
    <h2>로그인됨</h2>
    <div class="selected-box"><strong>${escapeHtml(currentUser.email)}</strong></div>
    <button id="tSignOut" type="button" class="btn ghost">로그아웃</button>
  `;
  document.getElementById('tSignOut').addEventListener('click', async () => {
    try { await signOutUser(); } catch (e) { showTeacherError(getErrorMessage(e)); }
  });

  if (isTeacherUser(currentUser)) {
    controlCard.style.display = 'block';
    // 2차 바인딩 (버튼이 화면에 보이는 시점에 한 번 더 확실히 묶음)
    bindControlButtons();
    showRosterCard();
  } else {
    controlCard.style.display = 'none';
    document.getElementById('dashboardResult').innerHTML = '';
    const rosterCard = document.getElementById('rosterCard');
    if (rosterCard) rosterCard.style.display = 'none';
    showTeacherError('이 계정은 교사 권한이 없습니다. config.js 와 firestore.rules 의 교사 이메일 목록을 확인하세요.');
  }
  renderSiteControl();   // 교사일 때만 사이트 켜기/끄기 카드 표시
  loadLessonSettingsForm();   // 교사일 때만 수업 설정 카드 표시 + 1회 로드
}

async function loadTeacherDashboard() {
  console.log('[teacher] 대시보드 새로고침 클릭됨');
  document.getElementById('dashboardResult').innerHTML = '<section class="card">불러오는 중...</section>';
  try {
    const range = getSelectedRange();
    const data = await getTeacherDashboardData({
      classId: valueOf('dashClassId'), activityText: valueOf('dashActivity'),
      start: range.start, end: range.end
    });
    data._rangeLabel = range.label;
    renderTeacherDashboard(data);
  } catch (err) {
    document.getElementById('dashboardResult').innerHTML = '';
    showTeacherError(getErrorMessage(err));
  }
}

async function exportToGoogleSheet() {
  console.log('[teacher] 내보내기 클릭됨 → exportToSheet 호출 시작');
  clearTeacherError();
  const btn = document.getElementById('exportBtn');
  const label = btn ? btn.textContent : '구글 시트로 내보내기';
  if (btn) { btn.disabled = true; btn.textContent = '내보내는 중...'; }
  try {
    const range = getSelectedRange();
    const res = await exportToSheet({
      classId: valueOf('dashClassId'), activityText: valueOf('dashActivity'),
      start: range.start, end: range.end
    });
    console.log('[teacher] 내보내기 성공:', res);
    if (btn) btn.textContent = `완료 (${res.count}건)`;
    showTeacherInfo(`구글 시트로 ${res.count}건을 내보냈습니다. (범위: ${range.label})`);
    if (btn) setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 2500);
  } catch (err) {
    console.log('[teacher] 내보내기 실패:', err);
    if (btn) { btn.textContent = label; btn.disabled = false; }
    showTeacherError(getErrorMessage(err));
  }
}

function renderTeacherDashboard(data) {
  lastDashboard = data;
  document.getElementById('dashboardResult').innerHTML = `
    <section class="card">
      <div class="stat-grid">
        <div class="stat-box"><div class="muted">총 제출 건수</div><div class="value">${escapeHtml(data.totalResponses)}</div></div>
        <div class="stat-box"><div class="muted">고유 학생 수</div><div class="value">${escapeHtml(data.uniqueStudentCount)}</div></div>
        <div class="stat-box"><div class="muted">주도성 평균</div><div class="value">${escapeHtml(data.agencyAverage || '-')}</div></div>
        <div class="stat-box"><div class="muted">참여 학급 수</div><div class="value">${escapeHtml((data.classStats || []).length)}</div></div>
      </div>
      <p class="muted" style="margin-top:8px;">조회 범위: <strong>${escapeHtml(data._rangeLabel || '전체')}</strong>${data.capped ? ` · ⚠️ 데이터가 많아 차트는 최근 ${escapeHtml(data.chartSampleSize)}건 표본만 반영했습니다. 기간을 좁혀 주세요.` : ''}</p>
    </section>
    <section class="card">
      <h2>차시별 주도성 추이</h2>
      <p class="muted">차시(기록 횟수)가 쌓일수록 평균 주도성(1~5)이 어떻게 변하는지 — 굵은 선은 전체, 가는 선은 학급별 추이입니다.</p>
      ${agencyTrendSection(data)}
    </section>
    <section class="card">
      <h2>학급별 비교</h2>
      ${classCompareSection(data)}
    </section>
    <section class="card">
      <h2>질문 주도성 지표</h2>
      <p class="muted">학생이 스스로 질문을 만들고(직접) 지난 질문을 이어가는(이어가기) 정도 — 탐구의 자기주도성·연속성을 봅니다.</p>
      ${questionAgencySection(data)}
    </section>
    <section class="card"><h2>SEL 역량 분포</h2>${countBars(data.selCounts, '#0891b2')}</section>
    <section class="card">
      <h2>활동 / 방법 분포</h2>
      <div class="chart-grid-2">
        <div><h3 class="chart-sub-title">오늘 활동</h3>${countBars(data.activityCounts, '#d97706')}</div>
        <div><h3 class="chart-sub-title">해본 방법</h3>${countBars(data.methodCounts, '#16a34a')}</div>
      </div>
    </section>
    <section class="card">
      <h2>학생별 상세 보기</h2>
      <p class="muted">학생을 선택하면 질문 타임라인(탐구 연결성)과 주도성 추이를 봅니다.</p>
      ${studentDrilldownSection(data)}
    </section>
    <section class="card">
      <h2>학생 이름 · 학급 관리</h2>
      <p class="muted">구글 계정 이름이 실명과 다르거나 학급이 잘못 입력된 학생을 여기서 바로잡으세요. 이름을 저장하면 지난 기록·새 기록·학생 화면에 모두 반영됩니다. 학급을 저장하면 학생 화면이 그 학급으로 자동 선택되고 새 기록에 반영됩니다. (지난 기록의 학급은 그대로 보존) <strong>기록 삭제</strong>는 테스트용 학생 정리에 쓰며, 그 학생의 기록을 휴지통으로 보내고 명단에서 빼냅니다. (구글 로그인 계정 자체는 지워지지 않음)</p>
      ${studentsTable(data.students || [], data.classOptions || [])}
    </section>
    <section class="card">
      <h2>세특 근거 정리판</h2>
      <p class="muted">학생별 탐구 기록을 정리합니다. 세특 문장은 선생님이 직접 작성하시고, 아래 자료를 근거로 활용하세요. (AI 자동 생성 없음)</p>
      ${setukSection(data)}
    </section>
    <section class="card"><h2>최근 누적 기록 (자동 차시 포함)</h2><div id="recentSection"></div></section>
    <section class="card">
      <h2>휴지통</h2>
      <p class="muted">삭제한 기록은 여기로 옮겨집니다. 통계에서 빠지지만 언제든 복원할 수 있고, 완전 삭제 전까지 보관됩니다.</p>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
        <button id="trashLoadBtn" type="button" class="btn primary">휴지통 불러오기</button>
        <button id="trashRestoreBtn" type="button" class="btn green" style="display:none;">선택 복원</button>
        <button id="trashPurgeBtn" type="button" class="btn ghost" style="display:none; color:var(--red); border-color:#fecaca;">선택 완전 삭제</button>
        <button id="trashEmptyBtn" type="button" class="btn ghost" style="display:none; color:var(--red); border-color:#fecaca;">휴지통 비우기</button>
        <span class="muted" id="trashSelCount" style="display:none;">0건 선택</span>
      </div>
      <div id="trashSection"></div>
    </section>
  `;
  recentShown = 100;
  bindStudentNameButtons();
  bindStudentClassButtons();
  bindStudentDeleteButtons();
  bindDrilldown();
  bindSetuk();
  renderRecentSection();
  bindTrashControls();
}

// ----- 휴지통 -----

function bindTrashControls() {
  const loadBtn = document.getElementById('trashLoadBtn');
  const restoreBtn = document.getElementById('trashRestoreBtn');
  const purgeBtn = document.getElementById('trashPurgeBtn');
  const emptyBtn = document.getElementById('trashEmptyBtn');
  if (loadBtn) loadBtn.onclick = loadTrash;
  if (restoreBtn) restoreBtn.onclick = async () => {
    const ids = getCheckedTrashIds();
    if (!ids.length) return showTeacherError('복원할 기록을 선택하세요.');
    try {
      const res = await restoreResponses(ids);
      showTeacherInfo(`${res.count}건을 복원했습니다. 대시보드를 새로고침합니다.`);
      await loadTeacherDashboard();
      await loadTrash();
    } catch (e) { showTeacherError(getErrorMessage(e)); }
  };
  if (purgeBtn) purgeBtn.onclick = async () => {
    const ids = getCheckedTrashIds();
    if (!ids.length) return showTeacherError('완전 삭제할 기록을 선택하세요.');
    if (!window.confirm(`${ids.length}건을 완전히 삭제할까요?\n\n이 작업은 되돌릴 수 없습니다.`)) return;
    try {
      const res = await purgeTrash(ids);
      showTeacherInfo(`${res.count}건을 완전히 삭제했습니다.`);
      await loadTrash();
    } catch (e) { showTeacherError(getErrorMessage(e)); }
  };
  if (emptyBtn) emptyBtn.onclick = async () => {
    if (!window.confirm('휴지통을 완전히 비울까요?\n\n모든 기록이 영구 삭제되며 되돌릴 수 없습니다.')) return;
    try {
      const res = await emptyTrash();
      showTeacherInfo(`휴지통을 비웠습니다. (${res.count}건 영구 삭제)`);
      await loadTrash();
    } catch (e) { showTeacherError(getErrorMessage(e)); }
  };
}

async function loadTrash() {
  const host = document.getElementById('trashSection');
  if (host) host.innerHTML = '<p class="muted">휴지통 불러오는 중...</p>';
  try {
    const res = await listTrash();
    lastTrash = res.rows || [];
    renderTrashSection();
  } catch (e) {
    if (host) host.innerHTML = '';
    showTeacherError(getErrorMessage(e));
  }
}

function getCheckedTrashIds() {
  return Array.from(document.querySelectorAll('.trashSelect'))
    .filter(c => c.checked).map(c => c.getAttribute('data-id')).filter(Boolean);
}

function updateTrashSelCount() {
  const el = document.getElementById('trashSelCount');
  if (el) el.textContent = getCheckedTrashIds().length + '건 선택';
}

function renderTrashSection() {
  const host = document.getElementById('trashSection');
  if (!host) return;
  const rows = lastTrash || [];
  const restoreBtn = document.getElementById('trashRestoreBtn');
  const purgeBtn = document.getElementById('trashPurgeBtn');
  const emptyBtn = document.getElementById('trashEmptyBtn');
  const selCount = document.getElementById('trashSelCount');
  const show = rows.length > 0;
  [restoreBtn, purgeBtn, emptyBtn, selCount].forEach(b => { if (b) b.style.display = show ? '' : 'none'; });

  if (!rows.length) { host.innerHTML = '<p class="muted">휴지통이 비어 있습니다.</p>'; return; }

  host.innerHTML = `<div class="table-wrap"><table style="min-width:920px;"><thead><tr>
      <th><input type="checkbox" id="trashSelectAll" title="모두 선택"></th>
      <th>삭제 시각</th><th>학급</th><th>이름</th><th>차시</th><th>활동</th><th>탐구 질문</th><th>주도성</th>
    </tr></thead><tbody>${rows.map(r => `<tr>
      <td align="center"><input type="checkbox" class="trashSelect" data-id="${escapeHtml(r.id)}"></td>
      <td>${escapeHtml(r.trashed_at)}</td>
      <td>${escapeHtml(r.class_id)}</td>
      <td>${escapeHtml(r.student_name)}</td>
      <td>${escapeHtml(r.record_no)}</td>
      <td>${escapeHtml(r.activity_today)}</td>
      <td>${escapeHtml(r.inquiry_question)}</td>
      <td align="center">${escapeHtml(r.agency_score)}</td>
    </tr>`).join('')}</tbody></table></div>`;

  const selAll = document.getElementById('trashSelectAll');
  if (selAll) selAll.onchange = function () {
    Array.from(document.querySelectorAll('.trashSelect')).forEach(c => { c.checked = selAll.checked; });
    updateTrashSelCount();
  };
  Array.from(document.querySelectorAll('.trashSelect')).forEach(c => { c.onchange = updateTrashSelCount; });
  updateTrashSelCount();
}

// "최근 기록" 표를 현재 보여줄 행 수(recentShown)까지 렌더하고, 더 있으면 "더 보기" 버튼을 단다.
function renderRecentSection() {
  const host = document.getElementById('recentSection');
  if (!host || !lastDashboard) return;
  const all = lastDashboard.recent || [];
  const shown = all.slice(0, recentShown);
  const bulkBar = all.length
    ? `<div style="display:flex; gap:8px; align-items:center; margin-bottom:8px; flex-wrap:wrap;">
        <button id="recentBulkTrashBtn" type="button" class="btn ghost" style="color:var(--red); border-color:#fecaca;">선택한 기록 휴지통으로</button>
        <span class="muted" id="recentSelCount">0건 선택</span>
       </div>`
    : '';
  host.innerHTML = bulkBar + recentTable(shown) + (all.length > recentShown
    ? `<div style="margin-top:10px;"><button id="recentMoreBtn" type="button" class="btn ghost">더 보기 (${shown.length}/${all.length}${all.length >= 1000 ? '+' : ''})</button></div>`
    : (all.length ? `<p class="muted" style="margin-top:8px;">전체 ${all.length}건 표시 중</p>` : ''));
  bindRecentDeleteButtons();
  const moreBtn = document.getElementById('recentMoreBtn');
  if (moreBtn) moreBtn.onclick = () => { recentShown += 100; renderRecentSection(); };
}

// ----- 차트 헬퍼 (순수 CSS/SVG) -----

// 가로 막대 그래프. items: [{ label, value, display? }]
function barChart(items, opts) {
  opts = opts || {};
  if (!items || !items.length) return '<p class="muted">데이터 없음</p>';
  const max = opts.max || Math.max.apply(null, items.map(i => Number(i.value) || 0).concat(1));
  const color = opts.color || 'var(--primary)';
  return `<div class="chart-bars">${items.map(i => {
    const v = Number(i.value) || 0;
    const pct = Math.max(0, Math.min(100, max ? (v / max) * 100 : 0));
    const shown = (i.display != null) ? i.display : v;
    return `<div class="chart-bar-row">
      <div class="chart-bar-label" title="${escapeHtml(i.label)}">${escapeHtml(i.label)}</div>
      <div class="chart-bar-track"><div class="chart-bar-fill" style="width:${pct}%; background:${color};"></div></div>
      <div class="chart-bar-value">${escapeHtml(shown)}</div>
    </div>`;
  }).join('')}</div>`;
}

// {label,count} 배열을 막대 그래프로
function countBars(rows, color) {
  return barChart((rows || []).map(r => ({ label: r.label, value: r.count })), { color });
}

// SVG 꺾은선 그래프. series: [{ label, color, width?, dot?, points:[{x,y}] }]
function lineChart(series, opts) {
  opts = opts || {};
  const W = opts.width || 640, H = opts.height || 230;
  const yMin = (opts.yMin != null) ? opts.yMin : 1;
  const yMax = (opts.yMax != null) ? opts.yMax : 5;
  const padL = 30, padR = 12, padT = 12, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  const xs = [];
  series.forEach(s => s.points.forEach(p => { if (xs.indexOf(p.x) === -1) xs.push(p.x); }));
  xs.sort((a, b) => a - b);
  if (!xs.length) return '<p class="muted">추이를 그릴 데이터가 없습니다.</p>';
  const xMin = xs[0], xMax = xs[xs.length - 1];
  const sx = x => padL + (xMax === xMin ? plotW / 2 : ((x - xMin) / (xMax - xMin)) * plotW);
  const sy = y => padT + ((yMax - y) / (yMax - yMin || 1)) * plotH;

  let grid = '';
  for (let y = yMin; y <= yMax; y++) {
    const yy = sy(y).toFixed(1);
    grid += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="#eef2f7"/>`;
    grid += `<text x="${padL - 6}" y="${(sy(y) + 3).toFixed(1)}" font-size="10" fill="#94a3b8" text-anchor="end">${y}</text>`;
  }
  let xlab = '';
  xs.forEach(x => {
    xlab += `<text x="${sx(x).toFixed(1)}" y="${H - 8}" font-size="10" fill="#94a3b8" text-anchor="middle">${escapeHtml(x)}</text>`;
  });

  let paths = '';
  series.forEach((s, idx) => {
    const color = s.color || CHART_COLORS[idx % CHART_COLORS.length];
    const pts = s.points.slice().sort((a, b) => a.x - b.x);
    if (!pts.length) return;
    const d = pts.map(p => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
    paths += `<polyline fill="none" stroke="${color}" stroke-width="${s.width || 2}" stroke-linejoin="round" stroke-linecap="round" points="${d}"/>`;
    paths += pts.map(p => `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="${s.dot || 3}" fill="${color}"/>`).join('');
  });

  const legend = series.length > 1
    ? `<div class="chart-legend">${series.map((s, idx) => `<span><i class="legend-dot" style="background:${s.color || CHART_COLORS[idx % CHART_COLORS.length]};"></i>${escapeHtml(s.label)}</span>`).join('')}</div>`
    : '';

  return `<div class="chart-svg-wrap"><svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="꺾은선 그래프">${grid}${xlab}${paths}</svg></div>${legend}`;
}

// ----- 차트 섹션 -----

function agencyTrendSection(data) {
  const overall = (data.agencyTrend || []).map(p => ({ x: p.record_no, y: p.avg }));
  if (!overall.length) return '<p class="muted">아직 차시 기록이 없습니다.</p>';
  const series = [{ label: '전체 평균', color: '#111827', width: 3, dot: 4, points: overall }];
  (data.agencyTrendByClass || []).forEach((c, i) => {
    series.push({
      label: c.class_id, color: CHART_COLORS[i % CHART_COLORS.length], width: 1.5, dot: 2.5,
      points: (c.points || []).map(p => ({ x: p.record_no, y: p.avg }))
    });
  });
  return lineChart(series, { height: 240, yMin: 1, yMax: 5 });
}

function classCompareSection(data) {
  const cs = data.classStats || [];
  if (!cs.length) return '<p class="muted">데이터 없음</p>';
  const agencyBars = barChart(cs.map(c => ({ label: c.class_id, value: c.agency_avg, display: c.agency_avg })), { color: '#2563eb', max: 5 });
  const countBarsHtml = barChart(cs.map(c => ({ label: c.class_id, value: c.count, display: c.count })), { color: '#16a34a' });
  return `<div class="chart-grid-2">
    <div><h3 class="chart-sub-title">학급별 평균 주도성 (1~5)</h3>${agencyBars}</div>
    <div><h3 class="chart-sub-title">학급별 제출 수</h3>${countBarsHtml}</div>
  </div>`;
}

function questionAgencySection(data) {
  const q = data.questionSourceStats || { bank: 0, direct: 0, previous: 0, total: 0, continuity_rate: 0, self_made_rate: 0 };
  const bars = barChart([
    { label: '추천 질문', value: q.bank },
    { label: '직접 질문', value: q.direct },
    { label: '이어가기', value: q.previous }
  ], { color: '#7c3aed', max: q.total || 1 });
  return `<div class="metric-row">
      <div class="metric-box"><div class="muted">탐구 연속성 (이어가기 비율)</div><div class="value">${escapeHtml(q.continuity_rate)}%</div></div>
      <div class="metric-box"><div class="muted">학생 주도 질문 (직접+이어가기)</div><div class="value">${escapeHtml(q.self_made_rate)}%</div></div>
      <div class="metric-box"><div class="muted">전체 질문 수</div><div class="value">${escapeHtml(q.total)}</div></div>
    </div>${bars}`;
}

function studentDrilldownSection(data) {
  const list = data.students || [];
  if (!list.length) return '<p class="muted">아직 제출한 학생이 없습니다.</p>';
  const opts = list.map(s => `<option value="${escapeHtml(s.uid)}">${escapeHtml(s.class_id)} · ${escapeHtml(s.display_name)} (${escapeHtml(s.count)}회)</option>`).join('');
  return `<div class="field"><label class="label">학생 선택</label>
      <select id="drilldownSelect"><option value="">학생을 선택하세요</option>${opts}</select>
    </div><div id="drilldownDetail"></div>`;
}

function bindDrilldown() {
  const sel = document.getElementById('drilldownSelect');
  if (sel) sel.onchange = function () { renderStudentDrilldown(this.value); };
}

function renderStudentDrilldown(uid) {
  const box = document.getElementById('drilldownDetail');
  if (!box) return;
  const tl = (lastDashboard && lastDashboard.studentTimelines) ? lastDashboard.studentTimelines[uid] : null;
  if (!uid || !tl) { box.innerHTML = ''; return; }

  const items = tl.items || [];
  const agencyPts = items.filter(i => i.record_no != null && i.agency != null).map(i => ({ x: i.record_no, y: i.agency }));
  const chart = agencyPts.length
    ? lineChart([{ label: tl.name, color: '#2563eb', width: 2.5, dot: 3.5, points: agencyPts }], { height: 200, yMin: 1, yMax: 5 })
    : '<p class="muted">주도성 추이를 그릴 기록이 없습니다.</p>';
  const rows = items.map(i => `<tr>
      <td>${escapeHtml(i.record_no != null ? i.record_no + '차시' : '-')}</td>
      <td>${escapeHtml(i.activity)}</td>
      <td>${escapeHtml(sourceLabel(i.source))}</td>
      <td>${escapeHtml(i.question)}</td>
      <td>${escapeHtml(i.next_try)}</td>
      <td align="center">${escapeHtml(i.agency != null ? i.agency : '-')}</td>
    </tr>`).join('');

  box.innerHTML = `
    <div class="selected-box" style="margin-top:6px;"><strong>${escapeHtml(tl.name)}</strong> · ${escapeHtml(tl.class_id)} · 총 ${escapeHtml(items.length)}회 기록</div>
    <h3 class="chart-sub-title" style="margin-top:10px;">주도성 추이</h3>
    ${chart}
    <h3 class="chart-sub-title" style="margin-top:14px;">질문 타임라인 (탐구 연결성)</h3>
    <div class="table-wrap"><table style="min-width:760px;"><thead><tr><th>차시</th><th>활동</th><th>질문출처</th><th>탐구 질문</th><th>다음 질문</th><th>주도성</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ----- 세특 근거 정리판 -----

function setukSection(data) {
  const list = data.students || [];
  if (!list.length) return '<p class="muted">아직 제출한 학생이 없습니다.</p>';
  const opts = list.map(s =>
    `<option value="${escapeHtml(s.uid)}">${escapeHtml(s.class_id)} · ${escapeHtml(s.display_name)} (${escapeHtml(s.count)}회)</option>`
  ).join('');
  return `<div class="field"><label class="label">학생 선택</label>
    <select id="setukSelect"><option value="">학생을 선택하세요</option>${opts}</select>
  </div>
  <div id="setukDetail"></div>`;
}

function bindSetuk() {
  const sel = document.getElementById('setukSelect');
  if (sel) sel.onchange = function () { renderSetukDetail(this.value); };
}

function renderSetukDetail(uid) {
  const box = document.getElementById('setukDetail');
  if (!box) return;
  const tl = (lastDashboard && lastDashboard.studentTimelines) ? lastDashboard.studentTimelines[uid] : null;
  if (!uid || !tl) { box.innerHTML = ''; return; }

  const items = tl.items || [];
  if (!items.length) { box.innerHTML = '<p class="muted">이 학생의 기록이 없습니다.</p>'; return; }

  // 집계
  const methodCounts = {}, selCounts = {};
  let agencySum = 0, agencyCount = 0, directCount = 0, previousCount = 0;
  items.forEach(i => {
    if (i.agency) { agencySum += i.agency; agencyCount++; }
    const src = str(i.source);
    if (src === 'direct') directCount++;
    else if (src === 'previous') previousCount++;
    (i.methods || []).forEach(m => { if (m) incCount(methodCounts, m); });
    const selList = i.sel ? i.sel.split(' / ').map(s => s.trim()).filter(Boolean) : [];
    selList.forEach(s => { if (s) incCount(selCounts, s); });
  });
  const agencyAvg = agencyCount ? Math.round((agencySum / agencyCount) * 10) / 10 : '-';
  const selfMadeRate = items.length ? Math.round(((directCount + previousCount) / items.length) * 100) : 0;
  const topMethods = countsToArray(methodCounts).slice(0, 5);
  const topSel = countsToArray(selCounts).slice(0, 5);

  // 탐구 질문 흐름
  const qFlow = items.filter(i => i.question).map(i =>
    `<li style="margin-bottom:8px;">
      <span style="color:#2563eb; font-weight:800;">${escapeHtml(i.record_no != null ? i.record_no + '차시' : '-')}</span>
      <span class="muted" style="margin-left:4px; font-size:12px;">[${escapeHtml(sourceLabel(i.source))}]</span>
      ${escapeHtml(i.question)}
      ${i.next_try ? `<br><span class="muted" style="font-size:12px; padding-left:14px;">→ 다음: ${escapeHtml(i.next_try)}</span>` : ''}
    </li>`
  ).join('');

  // 차시별 상세
  const detailRows = items.map(i => {
    const stars = i.agency ? '★'.repeat(i.agency) + '☆'.repeat(5 - i.agency) : '-';
    const methodStr = (i.methods || []).join(', ') || '-';
    const isDeep = i.source === '단원 포트폴리오';
    const qLabel = isDeep ? '질문 흐름' : '탐구 질문';
    const mLabel = isDeep ? '가장 효과적 방법' : '해본 방법';
    const evLabel = isDeep ? '단원 성장' : '결과/증거';
    const ntLabel = isDeep ? '다음 단원 목표' : '다음 질문';
    return `<div style="border:1px solid var(--line); border-radius:12px; padding:12px; margin-bottom:8px; background:#fff;">
      <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px; flex-wrap:wrap;">
        <strong style="color:#2563eb;">${escapeHtml(i.record_no != null ? i.record_no + '차시' : '-')}</strong>
        <span class="muted" style="font-size:12px;">${escapeHtml(i.date)}</span>
        <span style="font-weight:700;">${escapeHtml(i.activity)}</span>
        ${isDeep ? '<span class="step-tag step-after" style="font-size:11px; margin-bottom:0;">단원 포트폴리오</span>' : ''}
        <span style="margin-left:auto; color:#d97706; letter-spacing:-1px;">${escapeHtml(stars)}</span>
      </div>
      <div style="font-size:13px; display:flex; flex-direction:column; gap:4px;">
        <div><span class="muted">${escapeHtml(qLabel)}:</span> <strong>${escapeHtml(i.question)}</strong></div>
        <div><span class="muted">${escapeHtml(mLabel)}:</span> ${escapeHtml(methodStr)}</div>
        ${i.evidence ? `<div><span class="muted">${escapeHtml(evLabel)}:</span> ${escapeHtml(i.evidence)}</div>` : ''}
        ${i.peer_feedback ? `<div><span class="muted">친구 피드백:</span> ${escapeHtml(i.peer_feedback)}</div>` : ''}
        <div><span class="muted">${escapeHtml(ntLabel)}:</span> ${escapeHtml(i.next_try || '-')}</div>
        ${i.sel ? `<div><span class="muted">SEL 역량:</span> ${escapeHtml(i.sel)}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  const copyText = buildSetukCopyText(tl, items, agencyAvg, selfMadeRate, topMethods, topSel);

  box.innerHTML = `
    <div class="selected-box" style="margin-top:8px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
      <div>
        <strong>${escapeHtml(tl.name)}</strong> · ${escapeHtml(tl.class_id)} · 총 ${escapeHtml(items.length)}회 기록
        <span class="muted" style="margin-left:8px;">주도성 평균 ${escapeHtml(String(agencyAvg))} · 자기주도 질문 ${escapeHtml(String(selfMadeRate))}%</span>
      </div>
      <button id="setukCopyBtn" type="button" class="btn ghost" style="font-size:13px;">클립보드 복사</button>
    </div>
    <div style="margin-top:12px; display:grid; grid-template-columns:1fr 1fr; gap:10px;">
      <div class="info-box">
        <h3 style="font-size:13px; margin:0 0 6px; font-weight:800;">자주 쓴 방법</h3>
        ${topMethods.length ? topMethods.map(m => `<div style="font-size:13px;">${escapeHtml(m.label)} <span class="muted">×${escapeHtml(String(m.count))}</span></div>`).join('') : '<span class="muted" style="font-size:13px;">기록 없음</span>'}
      </div>
      <div class="info-box">
        <h3 style="font-size:13px; margin:0 0 6px; font-weight:800;">발휘한 SEL 역량 <span class="muted" style="font-weight:500;">(참고용, 순위화 아님)</span></h3>
        ${topSel.length ? topSel.map(s => `<div style="font-size:13px;">${escapeHtml(s.label)} <span class="muted">×${escapeHtml(String(s.count))}</span></div>`).join('') : '<span class="muted" style="font-size:13px;">기록 없음</span>'}
      </div>
    </div>
    <h3 style="font-size:14px; margin:14px 0 6px; font-weight:800;">탐구 질문 흐름</h3>
    <ol style="margin:0; padding-left:18px; display:flex; flex-direction:column; gap:2px;">${qFlow}</ol>
    <h3 style="font-size:14px; margin:14px 0 6px; font-weight:800;">차시별 기록 상세</h3>
    ${detailRows}
  `;

  const copyBtn = document.getElementById('setukCopyBtn');
  if (copyBtn) copyBtn.onclick = () => {
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = copyText;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    };
    (navigator.clipboard ? navigator.clipboard.writeText(copyText).catch(fallback) : Promise.resolve(fallback()))
      .then(() => {
        copyBtn.textContent = '복사됨 ✓';
        setTimeout(() => { copyBtn.textContent = '클립보드 복사'; }, 2000);
      });
  };
}

function buildSetukCopyText(tl, items, agencyAvg, selfMadeRate, topMethods, topSel) {
  const lines = [];
  lines.push(`[세특 근거 정리판] ${tl.name} · ${tl.class_id}`);
  lines.push(`총 ${items.length}회 기록 / 주도성 평균 ${agencyAvg} / 자기주도 질문 ${selfMadeRate}%`);
  lines.push('');
  if (topMethods.length) {
    lines.push('[자주 쓴 방법]');
    lines.push(topMethods.map(m => `${m.label} ×${m.count}`).join(' · '));
    lines.push('');
  }
  if (topSel.length) {
    lines.push('[발휘한 SEL 역량 — 참고용]');
    lines.push(topSel.map(s => `${s.label} ×${s.count}`).join(' · '));
    lines.push('');
  }
  lines.push('[탐구 질문 흐름]');
  items.filter(i => i.question).forEach(i => {
    lines.push(`  ${i.record_no != null ? i.record_no + '차시' : '-'} [${sourceLabel(i.source)}] ${i.question}`);
    if (i.next_try) lines.push(`    → 다음: ${i.next_try}`);
  });
  lines.push('');
  lines.push('[차시별 기록]');
  items.forEach(i => {
    const methodStr = (i.methods || []).join(', ') || '-';
    const isDeep = i.source === '단원 포트폴리오';
    const qLabel = isDeep ? '질문 흐름' : '탐구 질문';
    const mLabel = isDeep ? '가장 효과적 방법' : '해본 방법';
    const evLabel = isDeep ? '단원 성장' : '결과/증거';
    const ntLabel = isDeep ? '다음 단원 목표' : '다음 질문';
    const typeTag = isDeep ? ' [단원 포트폴리오]' : '';
    lines.push(`${i.record_no != null ? i.record_no + '차시' : '-'} · ${i.date} · ${i.activity}${typeTag} · 주도성 ${i.agency || '-'}`);
    lines.push(`  ${qLabel}: ${i.question}`);
    lines.push(`  ${mLabel}: ${methodStr}`);
    if (i.evidence) lines.push(`  ${evLabel}: ${i.evidence}`);
    if (i.peer_feedback) lines.push(`  친구 피드백: ${i.peer_feedback}`);
    lines.push(`  ${ntLabel}: ${i.next_try || '-'}`);
    if (i.sel) lines.push(`  SEL 역량: ${i.sel}`);
    lines.push('');
  });
  return lines.join('\n');
}

// 학생 이름·학급 관리 표.
//   - 실명을 입력해 저장 → setStudentName 으로 이름 보정값 기록
//   - 학급을 골라 저장   → setStudentClass 로 학급 보정값 기록 (학생 화면 자동 선택)
function studentsTable(students, classOptions) {
  if (!students.length) return '<p class="muted">아직 제출한 학생이 없습니다. 학생이 한 번 제출하면 여기에 나타납니다.</p>';
  const classSelect = (currentClassId) => `<select class="studentClassSelect" style="max-width:90px;">${
    (classOptions || []).map(c =>
      `<option value="${escapeHtml(c.session_id)}"${c.class_id === currentClassId ? ' selected' : ''}>${escapeHtml(c.class_id)}</option>`
    ).join('')
  }</select>`;
  return `<div class="table-wrap"><table style="min-width:920px;"><thead><tr>
      <th>현재 학급</th><th>현재 표시 이름</th><th>구글 계정 이름</th><th>기록 수</th><th>실명으로 수정</th><th>학급 수정</th><th>정리</th>
    </tr></thead><tbody>${students.map(s => `
    <tr data-uid="${escapeHtml(s.uid)}">
      <td>${escapeHtml(s.class_id)}${s.override_class ? ' <span class="muted" style="font-size:11px;">(보정됨)</span>' : ''}</td>
      <td><strong>${escapeHtml(s.display_name)}</strong>${s.override_name ? ' <span class="muted" style="font-size:11px;">(보정됨)</span>' : ''}</td>
      <td>${escapeHtml(s.response_name || '-')}</td>
      <td align="center">${escapeHtml(s.count)}</td>
      <td>
        <div style="display:flex; gap:6px; align-items:center;">
          <input type="text" class="studentNameInput" value="${escapeHtml(s.override_name || s.response_name)}" placeholder="실명" style="max-width:130px;">
          <button type="button" class="btn primary studentNameSaveBtn" style="padding:6px 10px;">저장</button>
        </div>
      </td>
      <td>
        <div style="display:flex; gap:6px; align-items:center;">
          ${classSelect(s.class_id)}
          <button type="button" class="btn primary studentClassSaveBtn" style="padding:6px 10px;">저장</button>
        </div>
      </td>
      <td align="center">
        <button type="button" class="btn ghost studentDeleteBtn" data-name="${escapeHtml(s.display_name)}" data-count="${escapeHtml(s.count)}" style="padding:6px 10px; color:var(--red); border-color:#fecaca;">기록 삭제</button>
      </td>
    </tr>`).join('')}</tbody></table></div>`;
}

function bindStudentNameButtons() {
  Array.from(document.querySelectorAll('.studentNameSaveBtn')).forEach(btn => {
    btn.onclick = async function () {
      const tr = btn.closest('tr');
      if (!tr) return;
      const uid = tr.getAttribute('data-uid');
      const input = tr.querySelector('.studentNameInput');
      const name = input ? input.value : '';
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = '저장 중...';
      try {
        const res = await setStudentName(uid, name);
        // 전체 재조회(문서 수백 건 읽기) 대신 화면 데이터만 메모리에서 갱신한다 → Firestore 읽기 절약.
        patchStudentNameLocally(uid, res.name);
        showTeacherInfo('이름을 저장했습니다. (지난 기록·학생 화면에도 반영됩니다)');
      } catch (e) {
        btn.disabled = false;
        btn.textContent = label;
        showTeacherError(getErrorMessage(e));
      }
    };
  });
}

// 학급 수정: 선택한 학급(세션)을 setStudentClass 로 저장한다.
function bindStudentClassButtons() {
  Array.from(document.querySelectorAll('.studentClassSaveBtn')).forEach(btn => {
    btn.onclick = async function () {
      const tr = btn.closest('tr');
      if (!tr) return;
      const uid = tr.getAttribute('data-uid');
      const sel = tr.querySelector('.studentClassSelect');
      const sessionId = sel ? sel.value : '';
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = '저장 중...';
      try {
        const res = await setStudentClass(uid, sessionId);
        // 학급 보정은 명단(roster)에만 반영되고 지난 기록의 학급은 그대로이므로 메모리 갱신으로 충분 → 재조회 안 함.
        patchStudentClassLocally(uid, res.session_id, res.class_id);
        showTeacherInfo('학급을 저장했습니다. 학생 화면과 새 기록에 반영됩니다. (지난 기록의 학급은 그대로 보존)');
      } catch (e) {
        btn.disabled = false;
        btn.textContent = label;
        showTeacherError(getErrorMessage(e));
      }
    };
  });
}

// 테스트용 학생 정리: 그 학생의 모든 기록을 휴지통으로 보내고 이름·학급 보정 문서를 삭제한다.
//   - 구글 로그인 계정 자체는 지워지지 않는다(브라우저 한계). 확인 다이얼로그에 명시한다.
//   - 성공 후 전체 재조회(읽기 비용) 대신 lastDashboard 를 메모리에서 갱신해 다시 그린다.
function bindStudentDeleteButtons() {
  Array.from(document.querySelectorAll('.studentDeleteBtn')).forEach(btn => {
    btn.onclick = async function () {
      const tr = btn.closest('tr');
      if (!tr) return;
      const uid = tr.getAttribute('data-uid');
      const name = btn.getAttribute('data-name') || '이 학생';
      const count = btn.getAttribute('data-count') || '0';
      if (!window.confirm(
        `[${name}] 학생의 기록 ${count}건을 휴지통으로 보내고, 이름·학급 보정 정보를 삭제할까요?\n\n` +
        `• 통계와 명단에서 빠집니다. (기록은 휴지통에서 복원 가능)\n` +
        `• 구글 로그인 계정 자체는 지워지지 않으며, 같은 계정으로 다시 제출하면 새로 나타납니다.`
      )) return;
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = '삭제 중...';
      try {
        const res = await deleteStudentData(uid);
        removeStudentLocally(uid, res.count);
        showTeacherInfo(`[${name}] 기록 ${res.count}건을 휴지통으로 옮기고 명단에서 정리했습니다. (휴지통에서 복원 가능)`);
        if (lastTrash) await loadTrash();   // 휴지통이 열려 있으면 갱신
      } catch (e) {
        btn.disabled = false;
        btn.textContent = label;
        showTeacherError(getErrorMessage(e));
      }
    };
  });
}

// 학생 정리 후 lastDashboard 에서 해당 학생을 빼고 헤드라인 숫자를 맞춘 뒤 다시 그린다(네트워크 읽기 0).
// (차시별 추이 등 차트는 다음 "대시보드 새로고침" 때 정확히 갱신된다.)
function removeStudentLocally(uid, removedCount) {
  if (!lastDashboard) return;
  lastDashboard.students = (lastDashboard.students || []).filter(s => s.uid !== uid);
  lastDashboard.recent = (lastDashboard.recent || []).filter(r => r.student_id !== uid);
  if (lastDashboard.studentTimelines) delete lastDashboard.studentTimelines[uid];
  const total = Number(lastDashboard.totalResponses);
  if (!isNaN(total)) lastDashboard.totalResponses = Math.max(0, total - (Number(removedCount) || 0));
  lastDashboard.uniqueStudentCount = lastDashboard.students.length;
  renderTeacherDashboard(lastDashboard);
}

// 이름 보정 후, 마지막 대시보드 데이터(lastDashboard)만 갱신해 다시 그린다(네트워크 읽기 0).
function patchStudentNameLocally(uid, name) {
  if (!lastDashboard) return;
  (lastDashboard.students || []).forEach(s => {
    if (s.uid === uid) { s.override_name = name; s.display_name = name; }
  });
  (lastDashboard.recent || []).forEach(r => {
    if (r.student_id === uid) r.student_name = name;
  });
  const tl = lastDashboard.studentTimelines && lastDashboard.studentTimelines[uid];
  if (tl) tl.name = name;
  renderTeacherDashboard(lastDashboard);
}

// 학급 보정 후, 명단의 해당 학생만 갱신해 다시 그린다(네트워크 읽기 0).
// 지난 기록(recent)의 학급은 보존되므로 건드리지 않는다.
function patchStudentClassLocally(uid, sessionId, classId) {
  if (!lastDashboard) return;
  (lastDashboard.students || []).forEach(s => {
    if (s.uid === uid) {
      s.override_session_id = sessionId;
      s.override_class = classId;
      s.class_id = classId;
    }
  });
  renderTeacherDashboard(lastDashboard);
}

function recentTable(rows) {
  return !rows.length
    ? '<p class="muted">응답 없음</p>'
    : `<div class="table-wrap"><table style="min-width:1300px;"><thead><tr><th><input type="checkbox" id="recentSelectAll" title="모두 선택"></th><th>시간</th><th>학급</th><th>이름</th><th>차시</th><th>활동</th><th>탐구 질문</th><th>방법</th><th>결과/피드백</th><th>다음 질문</th><th>주도성</th><th>SEL 역량</th><th>삭제</th></tr></thead><tbody>${rows.map(r => `<tr><td align="center">${r.id ? `<input type="checkbox" class="recentSelect" data-id="${escapeHtml(r.id)}">` : ''}</td><td>${escapeHtml(r.submitted_at)}</td><td>${escapeHtml(r.class_id)}</td><td>${escapeHtml(r.student_name)}</td><td style="color:#2563eb; font-weight:bold;">${escapeHtml(r.record_no)}</td><td>${escapeHtml(r.activity_today)}</td><td>${escapeHtml(r.inquiry_question)}</td><td>${escapeHtml(r.method_labels)}</td><td>${escapeHtml(r.evidence_result)}</td><td>${escapeHtml(r.next_try)}</td><td align="center">${escapeHtml(r.agency_score)}</td><td>${escapeHtml(r.sel_competency)}</td><td align="center">${r.id ? `<button type="button" class="btn ghost recentDeleteBtn" data-id="${escapeHtml(r.id)}" data-name="${escapeHtml(r.student_name)}" style="padding:5px 9px; color:var(--red); border-color:#fecaca;">휴지통</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}

// 선택된 최근 기록 체크박스의 id 목록
function getCheckedRecentIds() {
  return Array.from(document.querySelectorAll('.recentSelect'))
    .filter(c => c.checked).map(c => c.getAttribute('data-id')).filter(Boolean);
}

function updateRecentSelCount() {
  const el = document.getElementById('recentSelCount');
  if (el) el.textContent = getCheckedRecentIds().length + '건 선택';
}

// 휴지통으로 이동 공통 처리 후 대시보드 새로고침
async function trashRecentIds(ids) {
  if (!ids.length) return showTeacherError('선택된 기록이 없습니다.');
  if (!window.confirm(`${ids.length}건을 휴지통으로 보낼까요?\n\n통계에서 빠지며, 휴지통에서 다시 복원할 수 있습니다.`)) return;
  try {
    const res = await moveResponsesToTrash(ids);
    showTeacherInfo(`${res.count}건을 휴지통으로 옮겼습니다. 대시보드를 새로고침합니다.`);
    await loadTeacherDashboard();
    if (lastTrash) await loadTrash();   // 휴지통이 열려 있으면 갱신
  } catch (e) {
    showTeacherError(getErrorMessage(e));
  }
}

function bindRecentDeleteButtons() {
  // 개별 휴지통 버튼
  Array.from(document.querySelectorAll('.recentDeleteBtn')).forEach(btn => {
    btn.onclick = () => trashRecentIds([btn.getAttribute('data-id')].filter(Boolean));
  });
  // 모두 선택 + 개별 체크 → 선택 개수 갱신
  const selAll = document.getElementById('recentSelectAll');
  if (selAll) selAll.onchange = function () {
    Array.from(document.querySelectorAll('.recentSelect')).forEach(c => { c.checked = selAll.checked; });
    updateRecentSelCount();
  };
  Array.from(document.querySelectorAll('.recentSelect')).forEach(c => { c.onchange = updateRecentSelCount; });
  // 일괄 휴지통 버튼
  const bulkBtn = document.getElementById('recentBulkTrashBtn');
  if (bulkBtn) bulkBtn.onclick = () => trashRecentIds(getCheckedRecentIds());
  updateRecentSelCount();
}

function showTeacherError(msg) {
  const e = document.getElementById('teacherError');
  e.style.display = 'block';
  e.className = 'notice error';
  e.innerHTML = escapeHtml(msg);
  const info = document.getElementById('teacherInfo');
  if (info) info.style.display = 'none';
}
function showTeacherInfo(msg) {
  const i = document.getElementById('teacherInfo');
  if (!i) return;
  i.style.display = 'block';
  i.className = 'notice success';
  i.innerHTML = escapeHtml(msg);
}
function clearTeacherError() {
  const e = document.getElementById('teacherError');
  if (e) e.style.display = 'none';
  const i = document.getElementById('teacherInfo');
  if (i) i.style.display = 'none';
}

function valueOf(id) { const el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; }

// ===================== 학생 명단 관리 (student_roster) =====================

function showRosterCard() {
  const card = document.getElementById('rosterCard');
  if (!card) return;
  card.style.display = isTeacherUser(currentUser) ? 'block' : 'none';
  bindRosterButtons();
}

function bindRosterButtons() {
  const loadBtn = document.getElementById('rosterLoadBtn');
  const addToggle = document.getElementById('rosterAddToggleBtn');
  const addForm = document.getElementById('rosterAddForm');
  const submitBtn = document.getElementById('raSubmitBtn');
  const cancelBtn = document.getElementById('raCancelBtn');
  if (loadBtn) loadBtn.onclick = loadRoster;
  if (addToggle) addToggle.onclick = () => {
    if (addForm) addForm.style.display = addForm.style.display === 'none' ? 'block' : 'none';
  };
  if (cancelBtn) cancelBtn.onclick = () => { if (addForm) addForm.style.display = 'none'; };
  if (submitBtn) submitBtn.onclick = doAddStudent;

  // 학번 입력 시 학년·반·번호를 즉시 미리보기로 보여준다.
  const sidInput = document.getElementById('raStudentId');
  const hint = document.getElementById('raStudentIdHint');
  if (sidInput && hint) sidInput.oninput = () => {
    const p = parseStudentId(sidInput.value);
    hint.textContent = p
      ? `→ ${p.grade}학년 ${p.classNo}반 ${p.number}번`
      : '학년·반·번호가 자동으로 채워집니다.';
    hint.style.color = p ? '#16a34a' : '';
  };
}

async function loadRoster() {
  const body = document.getElementById('rosterBody');
  if (body) body.innerHTML = '<p class="muted">불러오는 중...</p>';
  try {
    const rows = await getStudentRoster();
    renderRosterTable(rows);
  } catch (e) {
    if (body) body.innerHTML = '';
    showTeacherError(getErrorMessage(e));
  }
}

function renderRosterTable(rows) {
  const body = document.getElementById('rosterBody');
  if (!body) return;
  if (!rows.length) {
    body.innerHTML = '<p class="muted">등록된 학생이 없습니다. 위에서 학생을 추가하세요.</p>';
    return;
  }
  body.innerHTML = `<div class="table-wrap"><table style="min-width:960px;"><thead><tr>
    <th>학번</th><th>반</th><th>번호</th><th>이름</th><th>자동연결 이메일</th><th>등록코드</th><th>연결 상태</th><th>연결된 계정</th><th>관리</th>
  </tr></thead><tbody>${rows.map(r => {
    const claimed = !!r.isClaimed;
    const statusHtml = claimed
      ? `<span style="color:#16a34a; font-weight:700;">✓ 연결됨</span>`
      : (r.email ? `<span style="color:#94a3b8;">로그인 대기</span>` : `<span style="color:#94a3b8;">미연결</span>`);
    const unclaimBtn = claimed
      ? `<button type="button" class="btn ghost rosterUnclaimBtn" data-id="${escapeHtml(r.studentId)}" data-name="${escapeHtml(r.name)}" style="padding:4px 8px; color:#d97706; border-color:#fef3c7;">연결 해제</button>`
      : '';
    const emailBtn = `<button type="button" class="btn ghost rosterEmailBtn" data-id="${escapeHtml(r.studentId)}" data-name="${escapeHtml(r.name)}" data-email="${escapeAttr(r.email || '')}" style="padding:4px 8px;">이메일 ${r.email ? '수정' : '등록'}</button>`;
    const deleteBtn = `<button type="button" class="btn ghost rosterDeleteBtn" data-id="${escapeHtml(r.studentId)}" data-name="${escapeHtml(r.name)}" style="padding:4px 8px; color:var(--red); border-color:#fecaca;">삭제</button>`;
    return `<tr>
      <td><code>${escapeHtml(r.studentId)}</code></td>
      <td>${escapeHtml(r.className || '-')}</td>
      <td align="center">${escapeHtml(r.studentNumber || '-')}</td>
      <td>${escapeHtml(r.name)}</td>
      <td style="font-size:12px;">${r.email ? escapeHtml(r.email) : '<span class="muted">없음</span>'}</td>
      <td align="center">${r.registrationCode ? `<code>${escapeHtml(r.registrationCode)}</code>` : '<span class="muted">없음</span>'}</td>
      <td>${statusHtml}</td>
      <td style="font-size:12px;">${escapeHtml(r.linkedEmail || '-')}</td>
      <td style="display:flex; gap:4px; flex-wrap:wrap; padding:4px;">${emailBtn}${unclaimBtn}${deleteBtn}</td>
    </tr>`;
  }).join('')}</tbody></table></div>
  <p class="muted" style="margin-top:6px; font-size:12px;">총 ${rows.length}명 등록 · 연결됨 ${rows.filter(r => r.isClaimed).length}명 · 자동연결 이메일 ${rows.filter(r => r.email).length}명</p>`;

  Array.from(body.querySelectorAll('.rosterEmailBtn')).forEach(btn => {
    btn.onclick = async () => {
      const sid = btn.getAttribute('data-id');
      const name = btn.getAttribute('data-name');
      const cur = btn.getAttribute('data-email') || '';
      const input = window.prompt(`[${name}] 학생의 자동 연결용 학교 구글 이메일을 입력하세요.\n(비우고 확인하면 이메일을 삭제합니다.)`, cur);
      if (input === null) return; // 취소
      btn.disabled = true; btn.textContent = '저장 중...';
      try {
        const res = await setStudentEmail(sid, input);
        showTeacherInfo(res.email ? `[${name}] 자동 연결 이메일을 ${res.email}(으)로 설정했습니다.` : `[${name}] 자동 연결 이메일을 삭제했습니다.`);
        await loadRoster();
      } catch (e) { btn.disabled = false; btn.textContent = '이메일'; showTeacherError(getErrorMessage(e)); }
    };
  });

  Array.from(body.querySelectorAll('.rosterUnclaimBtn')).forEach(btn => {
    btn.onclick = async () => {
      const sid = btn.getAttribute('data-id');
      const name = btn.getAttribute('data-name');
      if (!window.confirm(`[${name}] 학생의 구글 계정 연결을 해제할까요?\n\n학생이 다시 학번+이름을 입력해 재등록할 수 있습니다.`)) return;
      btn.disabled = true; btn.textContent = '해제 중...';
      try {
        await unclaimStudentProfile(sid);
        showTeacherInfo(`[${name}] 연결을 해제했습니다. 학생이 다시 등록할 수 있습니다.`);
        await loadRoster();
      } catch (e) { btn.disabled = false; btn.textContent = '연결 해제'; showTeacherError(getErrorMessage(e)); }
    };
  });

  Array.from(body.querySelectorAll('.rosterDeleteBtn')).forEach(btn => {
    btn.onclick = async () => {
      const sid = btn.getAttribute('data-id');
      const name = btn.getAttribute('data-name');
      if (!window.confirm(`[${name}] 학생을 명단에서 삭제할까요?\n\n기록은 그대로 남지만, 학생이 더 이상 등록할 수 없습니다.`)) return;
      btn.disabled = true; btn.textContent = '삭제 중...';
      try {
        await removeStudentFromRoster(sid);
        showTeacherInfo(`[${name}] 학번 ${sid}를 명단에서 삭제했습니다.`);
        await loadRoster();
      } catch (e) { btn.disabled = false; btn.textContent = '삭제'; showTeacherError(getErrorMessage(e)); }
    };
  });
}

async function doAddStudent() {
  const btn = document.getElementById('raSubmitBtn');
  clearTeacherError();
  const data = {
    studentId: valueOf('raStudentId'),
    name: valueOf('raName'),
    email: valueOf('raEmail') || null,
    registrationCode: valueOf('raCode') || null
  };
  if (!data.studentId || !data.name) return showTeacherError('학번과 이름은 필수입니다.');
  if (btn) { btn.disabled = true; btn.textContent = '추가 중...'; }
  try {
    await addStudentToRoster(data);
    showTeacherInfo(`학번 ${data.studentId} · ${data.name}을(를) 명단에 추가했습니다.`);
    ['raStudentId','raName','raEmail','raCode'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    const hint = document.getElementById('raStudentIdHint');
    if (hint) { hint.textContent = '학년·반·번호가 자동으로 채워집니다.'; hint.style.color = ''; }
    await loadRoster();
  } catch (e) {
    showTeacherError(getErrorMessage(e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '추가'; }
  }
}
