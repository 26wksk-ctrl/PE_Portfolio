// --- js/lesson-config.js ---
//
// 수업 선택지를 "코드 한 곳"에 모은 설정 객체.
// 학생 '오늘 기록' 화면의 모든 칩(활동/목표질문/방법/피드백/결과/다음시도/SEL/주도성)은
// 마크업에 하드코딩하지 않고 전부 여기서 읽어 그린다. 교사가 이 파일만 고치면 화면이 바뀐다.
//
// (2단계에서 이 설정을 Firestore lessonSettings 로 옮겨 코드 수정 없이 세팅하도록 확장 예정)
//
// ※ 활동/방법/SEL 은 seed-data.js 의 코드를 그대로 재사용한다.
//   db.js 가 코드→라벨 변환(getOptionLabel)에 같은 코드를 쓰므로 저장·통계 호환이 유지된다.

import { OPTION_SETS, QUESTIONS } from './seed-data.js';

// 추천 질문(목표) 뱅크를 qid 로 빠르게 찾기 위한 색인
const Q_BY_ID = {};
QUESTIONS.forEach(q => {
  Q_BY_ID[q.qid] = { code: q.qid, label: q.shortLabel, text: q.questionText, focus: q.focus };
});

export const LESSON_CONFIG = {
  // 교사 설정 기본값 (2단계에서 Firestore lessonSettings 로 이동)
  defaults: {
    feedbackMode: 'received',   // 'received'(받은) | 'given'(해준)
    maxMethods: 2               // ③ 해본 방법 최대 선택 수
  },

  // ① 오늘 활동 (seed-data 코드 재사용)
  activities: OPTION_SETS.activities.map(o => ({ code: o.code, label: o.label })),

  // ③ 해본 방법 (seed-data 코드 재사용)
  methods: OPTION_SETS.practice_methods.map(o => ({ code: o.code, label: o.label })),

  // ⑧ SEL 역량 (seed-data 코드 재사용)
  sel: OPTION_SETS.sel_competencies.map(o => ({ code: o.code, label: o.label })),

  // ② 오늘 목표/질문 은행 — 활동별 추천 + 공통.
  //   byActivity 에 없는 활동은 common 을 보여준다. (값은 seed-data QUESTIONS 재사용)
  goalBank: {
    common: ['Q_CHANGE', 'Q_FAIL', 'Q_SUCCESS_FAIL', 'Q_COOP', 'Q_SAFE', 'Q_NEXT'],
    byActivity: {
      basketball: ['Q_CHANGE', 'Q_FAIL', 'Q_SUCCESS_FAIL', 'Q_NEXT'],
      dribble:    ['Q_CHANGE', 'Q_FAIL', 'Q_SUCCESS_FAIL', 'Q_NEXT'],
      layup:      ['Q_CHANGE', 'Q_FAIL', 'Q_SUCCESS_FAIL', 'Q_NEXT'],
      pass:       ['Q_COOP', 'Q_CHANGE', 'Q_SUCCESS_FAIL', 'Q_NEXT'],
      soccer:     ['Q_COOP', 'Q_CHANGE', 'Q_FAIL', 'Q_SAFE'],
      volleyball: ['Q_COOP', 'Q_CHANGE', 'Q_SUCCESS_FAIL', 'Q_NEXT'],
      catchball:  ['Q_COOP', 'Q_CHANGE', 'Q_SUCCESS_FAIL', 'Q_SAFE'],
      fitness:    ['Q_SELFCARE', 'Q_BODY', 'Q_NEXT', 'Q_FAIL']
    }
  },

  // ④ 친구 피드백 — feedbackMode 에 따라 문구/예시가 달라진다. 입력은 한 줄, 항상 선택(강제 아님).
  feedback: {
    received: {
      prompt: '친구가 나에게 해준 말 (한 줄, 선택)',
      placeholder: '예: 자세를 더 낮추라고 했다',
      options: ['자세를 칭찬받았다', '더 천천히 하라고 들었다', '팔/다리를 더 뻗으라고 들었다', '위치를 잘 잡았다고 들었다', '잘하고 있다고 응원받았다']
    },
    given: {
      prompt: '내가 친구에게 해준 말 (한 줄, 선택)',
      placeholder: '예: 천천히 하라고 알려줬다',
      options: ['자세를 칭찬해줬다', '천천히 하라고 알려줬다', '위치를 잡아줬다', '연습 방법을 알려줬다', '잘한다고 응원해줬다']
    }
  },

  // ⑤ 오늘 결과/증거
  results: [
    '성공 횟수가 늘었다', '자세가 더 안정됐다', '실패 원인을 찾았다',
    '친구와 호흡이 맞았다', '기록(시간/거리)이 좋아졌다', '아직 잘 안 됐지만 방법을 찾았다'
  ],

  // ⑥ 다음 시간에 바꿔볼 점
  nextTries: [
    '자세를 바꿔본다', '힘·속도·방향을 조절한다', '더 반복해서 연습한다',
    '친구와 더 협력한다', '다른 방법을 시도한다', '안전·규칙을 더 지킨다'
  ],

  // ⑦ 자기주도성 1~5
  agency: {
    min: 1,
    max: 5,
    labels: {
      1: '거의 참여하지 못했다.',
      2: '선생님이 지시하는 만큼만 수동적으로 했다.',
      3: '내 질문을 해결하기 위해 스스로 시도했다.',
      4: '실패 원인을 찾고 연습 방법을 바꿔보았다.',
      5: '포기하지 않고 끝까지 조정하며 도전했다.'
    }
  }
};

// 활동 코드에 맞는 목표/질문 칩 목록을 돌려준다. (없으면 공통)
export function getGoalsForActivity(activityCode) {
  const bank = LESSON_CONFIG.goalBank;
  const ids = (activityCode && bank.byActivity[activityCode]) || bank.common;
  return ids.map(id => Q_BY_ID[id]).filter(Boolean);
}

// 피드백 모드(received|given) 설정 묶음을 돌려준다.
export function getFeedbackConfig(mode) {
  return LESSON_CONFIG.feedback[mode] || LESSON_CONFIG.feedback.received;
}

// ===================== 단원 deep 포트폴리오 선택지 =====================
export const DEEP_CONFIG = {
  // ② 이 단원에서 내 탐구 질문은 어떻게 바뀌었나?
  questionEvolution: [
    { code: 'ev_much_changed', label: '처음과 많이 달라졌다',     sub: '탐구할수록 새로운 방향을 찾았다' },
    { code: 'ev_more_specific', label: '비슷하지만 더 구체해졌다', sub: '같은 방향이지만 더 세밀해졌다' },
    { code: 'ev_kept',          label: '처음 생각을 유지했다',     sub: '처음 질문이 계속 맞는 것 같았다' },
    { code: 'ev_various',       label: '여러 방향을 탐구했다',     sub: '한 가지에 집중하기보다 다양하게' },
  ],
  // ④ 이 단원을 통해 나는...
  unitGrowth: [
    { code: 'gr_skill',      label: '자세·기술이 좋아졌다' },
    { code: 'gr_learn_fail', label: '실패에서 배우는 법을 알게 됐다' },
    { code: 'gr_coop',       label: '친구와 협력하는 게 늘었다' },
    { code: 'gr_self_plan',  label: '스스로 계획하고 바꿔보는 게 익숙해졌다' },
    { code: 'gr_persist',    label: '포기하지 않고 끝까지 하는 힘이 생겼다' },
  ],
  // ⑤ 다음 단원에서 도전하고 싶은 것
  nextUnit: [
    { code: 'nu_harder',    label: '더 어려운 기술에 도전한다' },
    { code: 'nu_transfer',  label: '이 방법을 다른 운동에서도 써본다' },
    { code: 'nu_help',      label: '친구를 더 적극적으로 도와본다' },
    { code: 'nu_self_goal', label: '스스로 목표를 세우고 끝까지 해본다' },
  ],
};

// ===================== lessonSettings (Firestore 이동용) =====================
//
// CLAUDE.md 의 lessonSettings 구조를 그대로 따른다.
// 교사가 ?teacher=1 설정 화면에서 편집 → Firestore(app_config/lesson)에 저장 →
// 학생 화면이 이 설정을 읽어 칩을 그린다. 저장된 값이 없으면 아래 기본값을 쓴다.
//
// 각 선택지 옵션은 { code, label } 형태로 통일한다.
//  - 통계(교사 대시보드)는 라벨 기준으로 집계하므로 교사가 자유롭게 옵션을 추가해도 호환된다.

const S = v => (v == null ? '' : String(v).trim());

// ① 오늘 활동: 항상 고정으로 표시되는 기본 활동(교사가 지우거나 바꿀 수 없음).
// 나머지 활동은 교사가 설정 화면에서 추가/삭제한다(lessonSettings.activityOptions).
export const FIXED_ACTIVITIES = [
  { code: 'fitness', label: '체력운동' },
  { code: 'soccer', label: '축구' },
  { code: 'basketball', label: '농구' },
  { code: 'volleyball', label: '배구' },
  { code: 'kickball', label: '발야구' }
];
// '직접 입력'(기타)은 항상 목록 맨 끝에 둔다. 선택하면 학생이 활동명을 직접 적는다.
export const OTHER_ACTIVITY = { code: 'other', label: '직접 입력' };

// 학생 화면/교사 설정에 보여줄 전체 활동 목록 = 고정 5종 + 교사 추가분 + '직접 입력'(맨 끝).
// 교사 추가분 중 고정 활동과 코드/라벨이 겹치는 항목은 제외해 중복을 막는다.
export function getActivityOptions(settings) {
  const extras = (settings && Array.isArray(settings.activityOptions)) ? settings.activityOptions : [];
  const fixedCodes = new Set(FIXED_ACTIVITIES.map(a => a.code).concat([OTHER_ACTIVITY.code]));
  const fixedLabels = new Set(FIXED_ACTIVITIES.map(a => a.label).concat([OTHER_ACTIVITY.label]));
  const clean = extras
    .map(o => ({ code: S(o.code || o.label), label: S(o.label || o.code) }))
    .filter(o => o.label && !fixedCodes.has(o.code) && !fixedLabels.has(o.label));
  return FIXED_ACTIVITIES.concat(clean).concat([OTHER_ACTIVITY]);
}

// 문자열/객체가 섞인 옵션 배열을 [{code,label}] 로 정규화. 비거나 잘못되면 fallback 사용.
function normOptions(arr, fallback) {
  if (!Array.isArray(arr) || !arr.length) return (fallback || []).slice();
  const out = arr
    .map(o => (typeof o === 'string')
      ? { code: S(o), label: S(o) }
      : { code: S(o.code || o.label), label: S(o.label || o.code) })
    .filter(o => o.label);
  return out.length ? out : (fallback || []).slice();
}

// LESSON_CONFIG → lessonSettings 기본값(시드). Firestore 에 아무것도 없을 때 사용한다.
export function getDefaultLessonSettings() {
  const toOpts = arr => arr.map(s => ({ code: s, label: s }));
  return {
    lessonId: '',
    date: '',
    classId: '',
    unit: '',
    activity: '',                 // 오늘 활동 기본값(빈 값=학생이 직접 선택)
    activityOptions: [],          // 고정 활동 외에 교사가 추가한 활동 [{code,label}]
    coreQuestion: '',             // 오늘 핵심 질문(있으면 ②에 강조 표시)
    goalOptions: getGoalsForActivity('').map(g => ({ code: g.code, label: g.text })),
    methodOptions: LESSON_CONFIG.methods.map(m => ({ code: m.code, label: m.label })),
    feedbackMode: LESSON_CONFIG.defaults.feedbackMode,
    feedbackOptions: toOpts(LESSON_CONFIG.feedback[LESSON_CONFIG.defaults.feedbackMode].options),
    resultOptions: toOpts(LESSON_CONFIG.results),
    nextTryOptions: toOpts(LESSON_CONFIG.nextTries),
    selFocus: LESSON_CONFIG.sel.map(s => ({ code: s.code, label: s.label })),
    inputEnabled: true,           // 학생 입력 허용 여부(사이트 켜기와 별개의 소프트 스위치)
    shareDashboardEnabled: false, // 우리반 공유 대시보드(3단계 예정)
    recordType: 'quick'           // 'quick' | 'deep'(5단계 예정)
  };
}

// Firestore 에서 읽은 부분 설정(raw)을 기본값과 병합해 완전한 lessonSettings 로 만든다.
export function normalizeLessonSettings(raw) {
  const d = getDefaultLessonSettings();
  if (!raw || typeof raw !== 'object') return d;
  return {
    lessonId: S(raw.lessonId),
    date: S(raw.date),
    classId: S(raw.classId),
    unit: S(raw.unit),
    activity: S(raw.activity),
    activityOptions: normOptions(raw.activityOptions, d.activityOptions),
    coreQuestion: S(raw.coreQuestion),
    goalOptions: normOptions(raw.goalOptions, d.goalOptions),
    methodOptions: normOptions(raw.methodOptions, d.methodOptions),
    feedbackMode: (raw.feedbackMode === 'given') ? 'given' : 'received',
    feedbackOptions: normOptions(raw.feedbackOptions, d.feedbackOptions),
    resultOptions: normOptions(raw.resultOptions, d.resultOptions),
    nextTryOptions: normOptions(raw.nextTryOptions, d.nextTryOptions),
    selFocus: normOptions(raw.selFocus, d.selFocus),
    inputEnabled: raw.inputEnabled !== false,
    shareDashboardEnabled: raw.shareDashboardEnabled === true,
    recordType: (raw.recordType === 'deep') ? 'deep' : 'quick'
  };
}
