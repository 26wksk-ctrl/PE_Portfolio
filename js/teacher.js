// --- js/teacher.js ---
// 교사용 대시보드: 구글 로그인 → 통계 + SEL 분포 + 학급별 제출 수 + 최근 기록 + 구글 시트 내보내기
//
// (진단용) 내보내기 버튼이 "반응 없음"인 문제를 잡기 위해:
//   - 버튼 바인딩을 controlCard 가 보이는 시점(renderAuthState)에서 onclick 으로 다시 묶음
//   - 클릭/성공/실패 시 console.log 로 흐름을 찍음  → 해결되면 console.log 줄은 지워도 됩니다.

import {
  getTeacherDashboardData, exportToSheet, setStudentName, deleteResponse,
  signInWithGoogle, signOutUser, watchAuth, isTeacherUser,
  watchSiteStatus, setSiteActive
} from './db.js';
import { escapeHtml, getErrorMessage, sourceLabel } from './utils.js';
import { PATCH_NOTES } from './patch-notes.js';

let currentUser = null;
let siteActive = null;     // null=확인 전, true=켜짐, false=꺼짐
let siteUnsub = null;
let isTogglingSite = false;
let lastDashboard = null;  // 마지막 대시보드 데이터 (학생 드릴다운 재렌더용)
let recentShown = 100;     // "최근 기록" 표에서 현재 보여주는 행 수 (더 보기로 증가)

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

// 패치노트(변경 이력) 렌더링. 교사 대시보드 페이지에 항상 표시된다.
function renderPatchNotes() {
  const body = document.getElementById('patchNotesBody');
  if (!body) return;
  if (!PATCH_NOTES || !PATCH_NOTES.length) {
    body.innerHTML = '<p class="muted">등록된 변경 이력이 없습니다.</p>';
    return;
  }
  body.innerHTML = PATCH_NOTES.map(note => {
    const ver = note.version ? `<span class="step-tag step-after">${escapeHtml(note.version)}</span>` : '';
    const items = (note.items || []).map(it => `<li>${escapeHtml(it)}</li>`).join('');
    return `
      <div class="patch-note">
        <div class="patch-note-head">${ver}<strong>${escapeHtml(note.title)}</strong><span class="muted">${escapeHtml(note.date)}</span></div>
        <ul class="patch-note-list">${items}</ul>
      </div>`;
  }).join('');
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
      <h2>학생 이름 관리</h2>
      <p class="muted">구글 계정 이름이 실명과 다른 학생을 여기서 바로잡으세요. 한 번 저장하면 지난 기록·새 기록·학생 화면 모두에 같은 이름이 반영됩니다.</p>
      ${studentsTable(data.students || [])}
    </section>
    <section class="card"><h2>최근 누적 기록 (자동 차시 포함)</h2><div id="recentSection"></div></section>
  `;
  recentShown = 100;
  bindStudentNameButtons();
  bindDrilldown();
  renderRecentSection();
}

// "최근 기록" 표를 현재 보여줄 행 수(recentShown)까지 렌더하고, 더 있으면 "더 보기" 버튼을 단다.
function renderRecentSection() {
  const host = document.getElementById('recentSection');
  if (!host || !lastDashboard) return;
  const all = lastDashboard.recent || [];
  const shown = all.slice(0, recentShown);
  host.innerHTML = recentTable(shown) + (all.length > recentShown
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

// 학생 이름 관리 표. 각 행에서 실명을 입력해 저장하면 setStudentName 으로 보정값을 기록한다.
function studentsTable(students) {
  if (!students.length) return '<p class="muted">아직 제출한 학생이 없습니다. 학생이 한 번 제출하면 여기에 나타납니다.</p>';
  return `<div class="table-wrap"><table style="min-width:680px;"><thead><tr>
      <th>학급</th><th>현재 표시 이름</th><th>구글 계정 이름</th><th>기록 수</th><th>실명으로 수정</th>
    </tr></thead><tbody>${students.map(s => `
    <tr data-uid="${escapeHtml(s.uid)}">
      <td>${escapeHtml(s.class_id)}</td>
      <td><strong>${escapeHtml(s.display_name)}</strong>${s.override_name ? ' <span class="muted" style="font-size:11px;">(보정됨)</span>' : ''}</td>
      <td>${escapeHtml(s.response_name || '-')}</td>
      <td align="center">${escapeHtml(s.count)}</td>
      <td>
        <div style="display:flex; gap:6px; align-items:center;">
          <input type="text" class="studentNameInput" value="${escapeHtml(s.override_name || s.response_name)}" placeholder="실명" style="max-width:130px;">
          <button type="button" class="btn primary studentNameSaveBtn" style="padding:6px 10px;">저장</button>
        </div>
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
        await setStudentName(uid, name);
        showTeacherInfo('이름을 저장했습니다. 전체 기록에 반영하기 위해 대시보드를 새로고침합니다.');
        await loadTeacherDashboard();   // 표시 이름·최근 기록까지 한 번에 반영
      } catch (e) {
        btn.disabled = false;
        btn.textContent = label;
        showTeacherError(getErrorMessage(e));
      }
    };
  });
}

function recentTable(rows) {
  return !rows.length
    ? '<p class="muted">응답 없음</p>'
    : `<div class="table-wrap"><table style="min-width:1260px;"><thead><tr><th>시간</th><th>학급</th><th>이름</th><th>차시</th><th>활동</th><th>탐구 질문</th><th>방법</th><th>결과/피드백</th><th>다음 질문</th><th>주도성</th><th>SEL 역량</th><th>삭제</th></tr></thead><tbody>${rows.map(r => `<tr><td>${escapeHtml(r.submitted_at)}</td><td>${escapeHtml(r.class_id)}</td><td>${escapeHtml(r.student_name)}</td><td style="color:#2563eb; font-weight:bold;">${escapeHtml(r.record_no)}</td><td>${escapeHtml(r.activity_today)}</td><td>${escapeHtml(r.inquiry_question)}</td><td>${escapeHtml(r.method_labels)}</td><td>${escapeHtml(r.evidence_result)}</td><td>${escapeHtml(r.next_try)}</td><td align="center">${escapeHtml(r.agency_score)}</td><td>${escapeHtml(r.sel_competency)}</td><td align="center">${r.id ? `<button type="button" class="btn ghost recentDeleteBtn" data-id="${escapeHtml(r.id)}" data-name="${escapeHtml(r.student_name)}" style="padding:5px 9px; color:var(--red); border-color:#fecaca;">삭제</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}

function bindRecentDeleteButtons() {
  Array.from(document.querySelectorAll('.recentDeleteBtn')).forEach(btn => {
    btn.onclick = async function () {
      const id = btn.getAttribute('data-id');
      const name = btn.getAttribute('data-name') || '';
      if (!id) return;
      if (!window.confirm(`이 기록을 삭제할까요?\n(${name})\n\n삭제하면 되돌릴 수 없고, 통계에서도 빠집니다.`)) return;
      btn.disabled = true;
      btn.textContent = '삭제 중...';
      try {
        await deleteResponse(id);
        showTeacherInfo('기록을 삭제했습니다. 통계에 반영하기 위해 대시보드를 새로고침합니다.');
        await loadTeacherDashboard();
      } catch (e) {
        btn.disabled = false;
        btn.textContent = '삭제';
        showTeacherError(getErrorMessage(e));
      }
    };
  });
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
