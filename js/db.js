// --- js/db.js ---
//
// Firestore 데이터 계층. 원래 Code.gs 의 서버 함수들을 클라이언트에서 동작하도록 옮긴 것.
//   getInitialData()         <- 학생 화면 초기 데이터 (세션·옵션·질문)
//   getLastNextTry()         <- 직전 차시의 "다음 질문" 불러오기
//   submitSimpleResponse()   <- 응답 제출 + 차시 자동 계산 + 중복 방어
//   getTeacherDashboardData()<- 교사 대시보드 집계
//
// 데이터 모델: simple_responses 컬렉션. 한 문서 = 한 학생의 한 차시 기록.
// (원래의 response_items / response_options 시트는 분석 보조용이라 단일 컬렉션으로 단순화)

import { initializeApp } from 'firebase/app';
import {
  getFirestore, collection, addDoc, getDocs, query, where, serverTimestamp, Timestamp
} from 'firebase/firestore';

import { firebaseConfig, APP_VERSION, TEACHER_CODE, RESPONSES_COLLECTION } from './config.js';
import {
  getActiveSessions, findSession, getActiveQuestions, getOptions, getOptionLabel
} from './seed-data.js';
import {
  str, sanitizeStudentName, makeStudentId, normalizeArray, formatDateTime,
  incCount, countsToArray, sourceLabel
} from './utils.js';

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

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

// --- 학생 화면 초기 데이터 ---
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
    // 화면 코드가 snake_case 키를 기대하므로 맞춰서 전달
    session: { session_id: session.sessionId, class_id: session.classId, title: session.title, question_focus: session.questionFocus },
    sessions: sessions.map(s => ({ session_id: s.sessionId, class_id: s.classId, title: s.title })),
    optionsBySet: getOptionsBySets(['activities', 'practice_methods', 'sel_competencies']),
    questions: getActiveQuestions(session.questionFocus).map(q => ({
      qid: q.qid, short_label: q.shortLabel, question_text: q.questionText,
      question_type: q.questionType, dimension: q.dimension, focus: q.focus
    }))
  };
}

// 한 학생의 모든 응답 문서 (equality 필터만 사용 → 복합 색인 불필요)
async function fetchStudentResponses(classId, studentId) {
  const q = query(responsesCol(), where('student_id', '==', studentId), where('class_id', '==', classId));
  const snap = await getDocs(q);
  const rows = [];
  snap.forEach(doc => rows.push(doc.data()));
  return rows;
}

// --- 직전 차시의 "다음 질문" 불러오기 ---
export async function getLastNextTry(params) {
  params = params || {};
  const session = findSession(params.sessionId);
  if (!session) return { ok: true, found: false, message: '세션을 찾지 못했습니다.' };

  const studentName = sanitizeStudentName(params.studentName);
  if (!studentName) return { ok: true, found: false, message: '이름을 먼저 입력하세요.' };

  const studentId = makeStudentId(session.classId, studentName);
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

  const session = findSession(payload.sessionId);
  if (!session) throw new Error('학급 세션을 찾을 수 없습니다.');
  if (String(session.status).toLowerCase() === 'closed') throw new Error('닫힌 세션입니다.');

  const studentNameRaw = str(payload.studentName);
  if (!studentNameRaw) throw new Error('이름을 입력해 주세요.');
  const studentName = sanitizeStudentName(studentNameRaw);
  if (!studentName) throw new Error('이름에 사용할 수 없는 문자가 포함되어 있습니다.');

  const classId = session.classId;
  const studentId = makeStudentId(classId, studentName);

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

// --- 교사 대시보드 ---
export async function getTeacherDashboardData(params) {
  params = params || {};
  if (str(params.teacherCode) !== String(TEACHER_CODE)) {
    throw new Error('교사용 코드가 올바르지 않습니다.');
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
