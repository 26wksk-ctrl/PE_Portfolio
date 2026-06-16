// --- js/config.js ---
//
// 앱 설정 + Firebase 설정.
// 배포 전에 firebaseConfig 값을 본인의 Firebase 프로젝트 값으로 채워 주세요.
// (Firebase 콘솔 → 프로젝트 설정 → 일반 → "내 앱" → SDK 설정 및 구성 → 구성)
//
// firebaseConfig 의 apiKey 등은 "비밀"이 아니라 클라이언트 식별자입니다.
// 실제 데이터 보호는 firestore.rules (Firestore 보안 규칙) 로 해야 합니다.

export const APP_VERSION = 'PE_INQUIRY_SIMPLE_v4_FIREBASE_2026-06-16';

// 교사 대시보드 진입 코드.
// 주의: 이 값은 클라이언트 코드에 노출되므로 "강한 보안"이 아닙니다.
// 진짜 보호가 필요하면 Firebase Authentication + firestore.rules 를 사용하세요.
export const TEACHER_CODE = '5689';

// Firestore 응답 컬렉션 이름
export const RESPONSES_COLLECTION = 'simple_responses';

export const firebaseConfig = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT.firebaseapp.com',
  projectId: 'YOUR_PROJECT_ID',
  storageBucket: 'YOUR_PROJECT.appspot.com',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId: 'YOUR_APP_ID'
};
