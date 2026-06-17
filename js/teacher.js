// --- js/teacher.js ---
// 교사용 대시보드: 구글 로그인 → 통계 + SEL 분포 + 학급별 제출 수 + 최근 기록 + 구글 시트 내보내기
//
// (진단용) 내보내기 버튼이 "반응 없음"인 문제를 잡기 위해:
//   - 버튼 바인딩을 controlCard 가 보이는 시점(renderAuthState)에서 onclick 으로 다시 묶음
//   - 클릭/성공/실패 시 console.log 로 흐름을 찍음  → 해결되면 console.log 줄은 지워도 됩니다.

import {
  getTeacherDashboardData, exportToSheet,
  signInWithGoogle, signOutUser, watchAuth, isTeacherUser,
  watchSiteStatus, setSiteActive, setSiteActiveByCode
} from './db.js';
import { escapeHtml, getErrorMessage } from './utils.js';

let currentUser = null;
let siteActive = null;     // null=확인 전, true=켜짐, false=꺼짐
let siteUnsub = null;
let isTogglingSite = false;

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
    <section id="siteControlCard" class="card" style="display:none;"></section>
    <section id="controlCard" class="card" style="display:none;">
      <h2>조회 설정</h2>
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
  `;
  // 1차 바인딩 (셸 생성 시점)
  bindControlButtons();
}

// 버튼을 확실하게 묶는다. onclick 이라 여러 번 호출해도 중복 등록되지 않음.
function bindControlButtons() {
  const loadBtn = document.getElementById('loadDashBtn');
  const expBtn = document.getElementById('exportBtn');
  if (loadBtn) loadBtn.onclick = loadTeacherDashboard;
  if (expBtn) expBtn.onclick = exportToGoogleSheet;
}

// 사이트 켜기/끄기 카드 렌더링.
//   - 구글 교사 로그인: 코드 없이 바로 토글
//   - 비로그인:        비밀코드로 토글
function renderSiteControl() {
  const card = document.getElementById('siteControlCard');
  if (!card) return;
  card.style.display = 'block';

  const loading = siteActive === null;
  const on = siteActive === true;
  const toggleLabel = loading ? '상태 확인 중...' : (isTogglingSite ? '변경 중...' : (on ? '사이트 끄기' : '사이트 켜기'));
  const toggleClass = on ? 'ghost' : 'primary';
  const disabledAttr = (loading || isTogglingSite) ? 'disabled' : '';
  const statusHtml = loading
    ? '<div class="selected-box">상태 확인 중...</div>'
    : `<div class="selected-box">현재 상태: <strong style="color:${on ? '#16a34a' : '#dc2626'};">${on ? '켜짐 — 학생이 기록할 수 있습니다.' : '꺼짐 — 학생에게는 안내 메시지만 보입니다.'}</strong></div>`;

  // (A) 구글 교사 로그인 → 코드 없이 토글
  if (currentUser && isTeacherUser(currentUser)) {
    card.innerHTML = `
      <h2>사이트 상태 (학생 화면 켜기 / 끄기)</h2>
      <p class="muted">꺼 두면 학생에게는 안내 메시지만, 켜면 기록 화면이 보입니다. 언제든 바꿀 수 있습니다.</p>
      ${statusHtml}
      <button id="siteToggleBtn" type="button" class="btn ${toggleClass}" ${disabledAttr}>${toggleLabel}</button>
    `;
    const btn = document.getElementById('siteToggleBtn');
    if (btn) btn.onclick = () => toggleSite('auth');
    return;
  }

  // (B) 비로그인 → 비밀코드로 토글
  card.innerHTML = `
    <h2>사이트 상태 (학생 화면 켜기 / 끄기)</h2>
    <p class="muted">비밀코드를 입력하면 구글 로그인 없이도 학생 화면을 켜고 끌 수 있습니다.</p>
    ${statusHtml}
    <div class="field"><label class="label" for="siteCodeInput">비밀코드</label><input id="siteCodeInput" type="password" placeholder="비밀코드 입력" autocomplete="off"></div>
    <button id="siteToggleBtn" type="button" class="btn ${toggleClass}" ${disabledAttr}>${toggleLabel}</button>
  `;
  const btn = document.getElementById('siteToggleBtn');
  const codeInput = document.getElementById('siteCodeInput');
  if (btn) btn.onclick = () => toggleSite('code');
  if (codeInput) codeInput.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); toggleSite('code'); } };
}

// method: 'code'(비밀코드) | 'auth'(구글 교사 로그인)
async function toggleSite(method) {
  if (isTogglingSite || siteActive === null) return;
  clearTeacherError();
  const target = !siteActive;

  let code = '';
  if (method === 'code') {
    const input = document.getElementById('siteCodeInput');
    code = input ? String(input.value || '').trim() : '';
    if (!code) return showTeacherError('비밀코드를 입력해 주세요.');
  }

  isTogglingSite = true;
  renderSiteControl();   // 버튼 비활성/'변경 중...' (입력값은 위에서 이미 읽음)
  try {
    if (method === 'code') await setSiteActiveByCode(target, code);
    else await setSiteActive(target);
    showTeacherInfo(target ? '사이트를 켰습니다. 학생 화면이 활성화됩니다.' : '사이트를 껐습니다. 학생 화면이 비활성화됩니다.');
  } catch (err) {
    isTogglingSite = false;
    renderSiteControl();
    showTeacherError(getErrorMessage(err));
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
    renderSiteControl();   // 로그아웃 상태에서는 비밀코드 입력형으로 표시
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
  } else {
    controlCard.style.display = 'none';
    document.getElementById('dashboardResult').innerHTML = '';
    showTeacherError('이 계정은 교사 권한이 없습니다. config.js 와 firestore.rules 의 교사 이메일 목록을 확인하세요.');
  }
  renderSiteControl();   // 교사일 때만 사이트 켜기/끄기 카드 표시
}

async function loadTeacherDashboard() {
  console.log('[teacher] 대시보드 새로고침 클릭됨');
  document.getElementById('dashboardResult').innerHTML = '<section class="card">불러오는 중...</section>';
  try {
    const data = await getTeacherDashboardData({ classId: valueOf('dashClassId'), activityText: valueOf('dashActivity') });
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
    const res = await exportToSheet();
    console.log('[teacher] 내보내기 성공:', res);
    if (btn) btn.textContent = `완료 (${res.count}건)`;
    showTeacherInfo(`구글 시트로 ${res.count}건을 내보냈습니다.`);
    if (btn) setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 2500);
  } catch (err) {
    console.log('[teacher] 내보내기 실패:', err);
    if (btn) { btn.textContent = label; btn.disabled = false; }
    showTeacherError(getErrorMessage(err));
  }
}

function renderTeacherDashboard(data) {
  document.getElementById('dashboardResult').innerHTML = `
    <section class="card">
      <div class="stat-grid">
        <div class="stat-box"><div class="muted">총 제출 건수</div><div class="value">${escapeHtml(data.totalResponses)}</div></div>
        <div class="stat-box"><div class="muted">고유 학생 수</div><div class="value">${escapeHtml(data.uniqueStudentCount)}</div></div>
        <div class="stat-box"><div class="muted">주도성 평균</div><div class="value">${escapeHtml(data.agencyAverage || '-')}</div></div>
      </div>
    </section>
    <section class="card"><h2>SEL 역량 분포</h2>${countTable(data.selCounts)}</section>
    <section class="card"><h2>학급별 제출 수</h2>${countTable(data.classCounts)}</section>
    <section class="card"><h2>최근 누적 기록 (자동 차시 포함)</h2>${recentTable(data.recent || [])}</section>
  `;
}

function countTable(rows) {
  return !rows || !rows.length
    ? '<p class="muted">데이터 없음</p>'
    : `<div class="table-wrap"><table><thead><tr><th>항목</th><th style="text-align:right;">수</th></tr></thead><tbody>${rows.map(r => `<tr><td>${escapeHtml(r.label)}</td><td style="text-align:right;">${escapeHtml(r.count)}</td></tr>`).join('')}</tbody></table></div>`;
}

function recentTable(rows) {
  return !rows.length
    ? '<p class="muted">응답 없음</p>'
    : `<div class="table-wrap"><table style="min-width:1200px;"><thead><tr><th>시간</th><th>학급</th><th>이름</th><th>차시</th><th>활동</th><th>탐구 질문</th><th>방법</th><th>결과/피드백</th><th>다음 질문</th><th>주도성</th><th>SEL 역량</th></tr></thead><tbody>${rows.map(r => `<tr><td>${escapeHtml(r.submitted_at)}</td><td>${escapeHtml(r.class_id)}</td><td>${escapeHtml(r.student_name)}</td><td style="color:#2563eb; font-weight:bold;">${escapeHtml(r.record_no)}</td><td>${escapeHtml(r.activity_today)}</td><td>${escapeHtml(r.inquiry_question)}</td><td>${escapeHtml(r.method_labels)}</td><td>${escapeHtml(r.evidence_result)}</td><td>${escapeHtml(r.next_try)}</td><td align="center">${escapeHtml(r.agency_score)}</td><td>${escapeHtml(r.sel_competency)}</td></tr>`).join('')}</tbody></table></div>`;
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
