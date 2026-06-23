// --- js/config.js ---
//
// 앱 설정 + Firebase 설정.
// 배포 전에 firebaseConfig 값을 본인의 Firebase 프로젝트 값으로 채워 주세요.
// (Firebase 콘솔 → 프로젝트 설정 → 일반 → "내 앱" → SDK 설정 및 구성 → 구성)
//
// firebaseConfig 의 apiKey 등은 "비밀"이 아니라 클라이언트 식별자입니다.
// 실제 데이터 보호는 firestore.rules (Firestore 보안 규칙) 로 합니다.

export const APP_VERSION = 'PE_INQUIRY_SIMPLE_v9_CLASS_SAVE_2026-06-19';

// Firestore 응답 컬렉션 이름
export const RESPONSES_COLLECTION = 'simple_responses';

// 학생 표시 이름 보정 컬렉션. 문서 ID = 구글 uid.
// 구글 계정 이름이 실명과 다를 때, 교사가 여기에 실명을 저장해 두면
// 지난 기록·새 기록·학생 화면 모두에서 이 이름이 우선 사용됩니다.
// 쓰기는 교사만 가능(firestore.rules), 학생은 본인 문서만 읽습니다.
export const STUDENTS_COLLECTION = 'students';

// 사전 등록 학생 명단. 문서 ID = 학번 5자리(studentId).
// 교사가 미리 학번+이름을 넣어 두면, 학생이 처음 로그인할 때 본인 항목을 연결(claim)한다.
// 한 번 연결된 항목은 isClaimed=true 가 되고, 다른 구글 계정으로 다시 등록할 수 없다.
export const STUDENT_ROSTER_COLLECTION = 'student_roster';

// 구글 uid → 학번 매핑. 문서 ID = 구글 Auth uid.
// 로그인한 사용자의 학번을 빠르게 찾기 위한 lookup 문서.
export const USERS_COLLECTION = 'users';

// 휴지통 컬렉션. 교사가 기록을 삭제하면 원본을 여기로 옮기고(simple_responses 에서는 제거),
// 복원하면 원래 컬렉션으로 되돌립니다. 통계는 simple_responses 만 보므로 휴지통은 통계에서 빠집니다.
export const TRASH_COLLECTION = 'trash_responses';

// 사이트 활성/비활성 상태를 저장하는 Firestore 문서 위치.
// 교사만 쓰기 가능(firestore.rules), 학생 화면은 읽기만 합니다.
// 문서가 없거나 active 가 아니면 기본값은 "비활성(꺼짐)" 입니다.
export const SITE_CONFIG_COLLECTION = 'app_config';
export const SITE_CONFIG_DOC = 'site';

// 수업 설정(lessonSettings)을 저장하는 Firestore 문서 위치. (app_config 컬렉션 재사용)
// 교사가 ?teacher=1 설정 화면에서 코드 수정 없이 학생 화면 구성을 바꿀 수 있게 한다.
// 규칙(firestore.rules)상 app_config 는 읽기 누구나 / 쓰기 교사만 → 그대로 적용된다.
// 문서가 없으면 lesson-config.js 의 기본값(LESSON_CONFIG)을 사용한다.
export const LESSON_SETTINGS_DOC = 'lesson';

// 우리반 공유 대시보드(익명·집계)를 저장하는 Firestore 문서 위치. (app_config 컬렉션 재사용)
// 교사가 ?teacher=1 대시보드를 열면 익명 집계가 이 문서에 자동 발행되고, 학생 화면이 읽어 보여 준다.
// 규칙(firestore.rules)상 읽기 누구나 / 쓰기 교사만. 개인 식별 정보(이름·피드백 원문·점수)는 담지 않는다.
export const SHARE_SETTINGS_DOC = 'share';

// 교사 대시보드 접근을 허용할 구글 계정 이메일 목록.
// 여기에 적힌 이메일로 로그인한 사용자만 전체 데이터 조회 / 시트 내보내기가 가능합니다.
// ★ firestore.rules 의 isTeacher() 목록과 반드시 동일하게 유지하세요.
export const TEACHER_EMAILS = ['visionaryshl@gmail.com', 'simsy0924@gmail.com'];

// --- 구글 시트 내보내기 (Apps Script 웹앱 브리지) ---
// Apps Script 를 웹앱으로 배포한 뒤 발급된 URL 을 여기에 붙여넣으세요.
// 비어 있으면 교사 대시보드의 "구글 시트로 내보내기" 가 동작하지 않습니다.
export const SHEETS_WEBAPP_URL = ''; // 보안 강화: 공개 Apps Script 쓰기 엔드포인트 비활성화

// 시트 엔드포인트 보호용 간단 토큰. (Apps Script 의 EXPORT_TOKEN 과 동일하게 맞추세요)
// 주의: 클라이언트에 노출되므로 강한 보안은 아니며, 무작위 접근을 막는 최소 방어입니다.
export const SHEETS_TOKEN = ''; // 클라이언트에 노출되는 토큰은 비밀이 아니므로 사용하지 않음

// App Check(reCAPTCHA Enterprise)를 Firebase 콘솔에서 설정한 뒤 사이트 키를 넣으세요.
// 비어 있으면 기존처럼 App Check 없이 동작합니다.
export const APP_CHECK_SITE_KEY = '';

export const firebaseConfig = {
  apiKey: "AIzaSyADu5dnEraeQ0VP3hus9_dENO92I1QpGfI",
  authDomain: "pe-portfolio.firebaseapp.com",
  // databaseURL은 Realtime Database를 쓰지 않으면 넣지 않는 편이 안전합니다.
  projectId: "pe-portfolio",
  storageBucket: "pe-portfolio.firebasestorage.app",
  messagingSenderId: "550685727825",
  appId: "1:550685727825:web:e0921a6a384c00ba80ec70",
  measurementId: "G-MRHLMS85WR"
};
