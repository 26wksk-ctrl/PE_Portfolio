// --- js/app.js ---
// 진입점. ?teacher=1 (또는 ?mode=teacher) 이면 교사 대시보드, 아니면 학생 화면.

import { getQueryParam } from './utils.js';
import { initStudent } from './student.js';
import { initTeacher } from './teacher.js';

function start() {
  const isTeacher = getQueryParam('teacher') === '1' || getQueryParam('mode') === 'teacher';
  if (isTeacher) initTeacher();
  else initStudent();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
