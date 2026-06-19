// ESLint 설정 (flat config)
//
// 목적: 배포 전에 "정의되지 않은 함수/변수 호출" 같은 런타임 오류를 미리 잡는다.
//   - 예: function 헤더가 빠져 toDate 가 정의되지 않은 채 호출되던 사고를 no-undef 가 잡아낸다.
//   - 빌드 도구는 도입하지 않고, 검사(lint)만 한다.
//
// 로컬 검사:  npm run lint
// (브라우저 전역 document/window/localStorage 등과 ES Module import 를 인식하도록 설정함)

import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser, // document, window, localStorage, console, alert, location ...
      },
    },
    rules: {
      // 핵심: 정의되지 않은 식별자 사용을 오류로 (toDate 누락 같은 사고 방지)
      'no-undef': 'error',
      // 안 쓰는 변수는 경고만 (배포를 막지는 않음). _ 로 시작하면 무시.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // 아래는 "버그는 아닌" 스타일/모범사례 지적이라 경고로 낮춰 배포를 막지 않게 한다.
      // (no-undef, no-dupe-keys, no-unreachable 등 진짜 버그 규칙은 recommended 의 error 로 유지)
      'no-useless-assignment': 'warn',
      'preserve-caught-error': 'warn',
    },
  },
];
