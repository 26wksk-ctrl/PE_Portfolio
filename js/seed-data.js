// --- js/seed-data.js ---
//
// 학급 세션 / 옵션 / 추천 질문 (원래 Google Sheets 시드 데이터를 정적 설정으로 변환).
// 교사가 학기/단원에 맞게 직접 수정하는 "앱 설정" 성격이라 DB가 아니라 코드에 둡니다.
//
// 변경 시 그대로 GitHub에 다시 올리면 반영됩니다.

// 1~4반은 가치(value) 중심, 5~8반은 전체(all) 노출. (운영 시 학기/단원에 맞게 조정)
export const SESSIONS = Array.from({ length: 8 }, (_, idx) => {
  const i = idx + 1;
  return {
    sessionId: 'FREE_SIMPLE_CLASS' + i,
    classId: i + '반',
    title: '자기주도 체육탐구 ' + i + '반',
    status: 'open',
    questionFocus: i <= 4 ? 'value' : 'all', // value | skill | all
    active: true
  };
});

// 옵션셋: set 별 { code, label, score, order } 배열
export const OPTION_SETS = {
  activities: [
    { code: 'soccer', label: '축구', score: '', order: 1 },
    { code: 'basketball', label: '농구', score: '', order: 2 },
    { code: 'catchball', label: '캐치볼', score: '', order: 3 },
    { code: 'fitness', label: '체력운동', score: '', order: 4 },
    { code: 'volleyball', label: '배구', score: '', order: 5 },
    { code: 'dribble', label: '농구 드리블(지그재그)', score: '', order: 6 },
    { code: 'layup', label: '농구 골밑슛', score: '', order: 7 },
    { code: 'pass', label: '농구 패스', score: '', order: 8 },
    { code: 'other', label: '기타', score: '', order: 99 }
  ],
  practice_methods: [
    { code: 'repeat', label: '반복해서 해봤다', score: '', order: 1 },
    { code: 'posture_change', label: '자세를 바꿔봤다', score: '', order: 2 },
    { code: 'control', label: '힘/속도/방향을 조절했다', score: '', order: 3 },
    { code: 'peer_feedback', label: '친구 피드백을 받았다', score: '', order: 4 },
    { code: 'measure', label: '기록이나 성공 횟수를 확인했다', score: '', order: 5 },
    { code: 'retry', label: '실패한 뒤 방법을 바꿔 다시 해봤다', score: '', order: 6 }
  ],
  sel_competencies: [
    { code: 'self_awareness', label: '나를 알기', score: '', order: 1 },
    { code: 'self_management', label: '나를 다스리기', score: '', order: 2 },
    { code: 'social_awareness', label: '친구 이해하기', score: '', order: 3 },
    { code: 'relationship', label: '함께하기', score: '', order: 4 },
    { code: 'responsible_decision', label: '스스로 결정하기', score: '', order: 5 }
  ]
};

// 추천 질문 뱅크. focus: value(가치/공동체) | skill(기능/기술)
export const QUESTIONS = [
  // 가치 중심 질문 (1학기 자유탐구 + 2학기 배경)
  { qid: 'Q_SAFE', shortLabel: '안전하게 하려면?', questionText: '모두가 안전하게 참여하려면 무엇을 지켜야 할까?', questionType: '공동체탐구', dimension: '공동체', focus: 'value', displayOrder: 1 },
  { qid: 'Q_COOP', shortLabel: '친구와 더 잘하려면?', questionText: '친구와 더 잘 협력하려면 나는 무엇을 해야 할까?', questionType: '관계탐구', dimension: '관계', focus: 'value', displayOrder: 2 },
  { qid: 'Q_MANNER', shortLabel: '매너를 지키려면?', questionText: '경기나 활동에서 좋은 매너를 보이려면 어떻게 해야 할까?', questionType: '공동체탐구', dimension: '공동체', focus: 'value', displayOrder: 3 },
  { qid: 'Q_ORDER', shortLabel: '질서를 지키려면?', questionText: '모두가 질서 있게 활동하려면 나는 무엇을 할 수 있을까?', questionType: '공동체탐구', dimension: '공동체', focus: 'value', displayOrder: 4 },
  { qid: 'Q_SELFCARE', shortLabel: '나를 관리하려면?', questionText: '지치지 않고 끝까지 참여하려면 내 몸과 마음을 어떻게 관리할까?', questionType: '자기관리탐구', dimension: '체력', focus: 'value', displayOrder: 5 },
  { qid: 'Q_BODY', shortLabel: '몸의 신호는?', questionText: '내 몸은 지금 어떤 신호(호흡, 근육 자극 등)를 보내고 있을까?', questionType: '자기인식탐구', dimension: '체력', focus: 'value', displayOrder: 6 },

  // 기능 중심 질문 (2학기 농구 등 기능 수업)
  { qid: 'Q_CHANGE', shortLabel: '무엇을 바꾸면 더 잘될까?', questionText: '자세, 힘, 속도, 방향 중 무엇을 바꾸면 더 잘될까?', questionType: '변인탐구', dimension: '기술', focus: 'skill', displayOrder: 7 },
  { qid: 'Q_FAIL', shortLabel: '왜 잘 안 될까?', questionText: '내가 오늘 활동에서 자주 실패하는 이유는 무엇일까?', questionType: '원인탐구', dimension: '기술', focus: 'skill', displayOrder: 8 },
  { qid: 'Q_SUCCESS_FAIL', shortLabel: '성공/실패 차이는?', questionText: '성공했을 때와 실패했을 때 무엇이 달랐을까?', questionType: '비교탐구', dimension: '기술', focus: 'skill', displayOrder: 9 },
  { qid: 'Q_NEXT', shortLabel: '다음 도전을 위해서는?', questionText: '다음 도전을 위해 내게 가장 필요한 연습은 무엇일까?', questionType: '성찰탐구', dimension: '성장', focus: 'skill', displayOrder: 10 }
];

// --- 조회 헬퍼 ---

export function getActiveSessions() {
  return SESSIONS
    .filter(s => s.active && String(s.status).toLowerCase() !== 'closed')
    .slice()
    .sort((a, b) => String(a.classId).localeCompare(String(b.classId), 'ko'));
}

export function findSession(sessionId) {
  return SESSIONS.find(s => s.sessionId === sessionId) || null;
}

export function getOptions(setId) {
  return (OPTION_SETS[setId] || []).slice().sort((a, b) => a.order - b.order);
}

export function getOption(setId, code) {
  return getOptions(setId).find(o => o.code === code) || null;
}

export function getOptionLabel(setId, code) {
  const opt = getOption(setId, code);
  return opt ? opt.label : code;
}

// focus 필터 (value | skill | all). all 이면 전체 노출.
export function getActiveQuestions(focus) {
  const f = focus || 'all';
  return QUESTIONS
    .filter(q => f === 'all' || (q.focus || 'all') === f)
    .slice()
    .sort((a, b) => a.displayOrder - b.displayOrder);
}
