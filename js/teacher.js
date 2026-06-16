// --- js/teacher.js ---
// 교사용 대시보드: 통계 + SEL 분포 + 학급별 제출 수 + 최근 누적 기록 테이블

import { getTeacherDashboardData } from './db.js';
import { escapeHtml, getErrorMessage } from './utils.js';

export function initTeacher() {
  renderTeacherShell();
}

function renderTeacherShell() {
  document.getElementById('app').innerHTML = `
    <header><h1>교사용 대시보드</h1><p class="muted">학생들의 누적 자동 차시 기록 확인.</p></header>
    <div id="teacherError" style="display:none;"></div>
    <section class="card">
      <h2>조회 설정</h2>
      <div class="two-col">
        <div class="field"><label class="label">교사용 코드</label><input id="teacherCode" type="password" placeholder="교사용 코드"></div>
        <div class="field"><label class="label">학급 필터</label><input id="dashClassId" type="text" placeholder="예: 1반"></div>
      </div>
      <div class="field"><label class="label">활동 필터</label><input id="dashActivity" type="text" placeholder="예: 농구"></div>
      <button id="loadDashBtn" type="button" class="btn primary">대시보드 새로고침</button>
    </section>
    <div id="dashboardResult"></div>
  `;
  document.getElementById('loadDashBtn').addEventListener('click', loadTeacherDashboard);
}

async function loadTeacherDashboard() {
  const tc = valueOf('teacherCode');
  if (!tc) return showTeacherError('교사용 코드를 입력하세요.');
  document.getElementById('dashboardResult').innerHTML = '<section class="card">불러오는 중...</section>';
  try {
    const data = await getTeacherDashboardData({ teacherCode: tc, classId: valueOf('dashClassId'), activityText: valueOf('dashActivity') });
    renderTeacherDashboard(data);
  } catch (err) {
    document.getElementById('dashboardResult').innerHTML = '';
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
}

function valueOf(id) { const el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; }
