// --- js/config.js ---
//
// 앱 설정 + Firebase 설정.
// 배포 전에 firebaseConfig 값을 본인의 Firebase 프로젝트 값으로 채워 주세요.
// (Firebase 콘솔 → 프로젝트 설정 → 일반 → "내 앱" → SDK 설정 및 구성 → 구성)
//
// firebaseConfig 의 apiKey 등은 "비밀"이 아니라 클라이언트 식별자입니다.
// 실제 데이터 보호는 firestore.rules (Firestore 보안 규칙) 로 합니다.

export const APP_VERSION = 'PE_INQUIRY_SIMPLE_v6_NAME_FIX_2026-06-19';

// Firestore 응답 컬렉션 이름
export const RESPONSES_COLLECTION = 'simple_responses';

// 학생 표시 이름 보정 컬렉션. 문서 ID = 구글 uid.
// 구글 계정 이름이 실명과 다를 때, 교사가 여기에 실명을 저장해 두면
// 지난 기록·새 기록·학생 화면 모두에서 이 이름이 우선 사용됩니다.
// 쓰기는 교사만 가능(firestore.rules), 학생은 본인 문서만 읽습니다.
export const STUDENTS_COLLECTION = 'students';

// 사이트 활성/비활성 상태를 저장하는 Firestore 문서 위치.
// 교사만 쓰기 가능(firestore.rules), 학생 화면은 읽기만 합니다.
// 문서가 없거나 active 가 아니면 기본값은 "비활성(꺼짐)" 입니다.
export const SITE_CONFIG_COLLECTION = 'app_config';
export const SITE_CONFIG_DOC = 'site';

// 교사 대시보드 접근을 허용할 구글 계정 이메일 목록.
// 여기에 적힌 이메일로 로그인한 사용자만 전체 데이터 조회 / 시트 내보내기가 가능합니다.
// ★ firestore.rules 의 isTeacher() 목록과 반드시 동일하게 유지하세요.
export const TEACHER_EMAILS = ['visionaryshl@gmail.com', 'simsy0924@gmail.com'];

// --- 구글 시트 내보내기 (Apps Script 웹앱 브리지) ---
// Apps Script 를 웹앱으로 배포한 뒤 발급된 URL 을 여기에 붙여넣으세요.
// 비어 있으면 교사 대시보드의 "구글 시트로 내보내기" 가 동작하지 않습니다.
export const SHEETS_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbyFLSdgs-ZJwtDiJWyV_pqBWITb5bmM5MIMEjgEcXaCwyc2zJP6jR-GAtn8WXIGWaag/exec';

// 시트 엔드포인트 보호용 간단 토큰. (Apps Script 의 EXPORT_TOKEN 과 동일하게 맞추세요)
// 주의: 클라이언트에 노출되므로 강한 보안은 아니며, 무작위 접근을 막는 최소 방어입니다.
export const SHEETS_TOKEN = '123412341234';

export const firebaseConfig = {
  apiKey: "AIzaSyADu5dnEraeQ0VP3hus9_dENO92I1QpGfI",
  authDomain: "pe-portfolio.firebaseapp.com",
  databaseURL: "https://pe-portfolio-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "pe-portfolio",
  storageBucket: "pe-portfolio.firebasestorage.app",
  messagingSenderId: "550685727825",
  appId: "1:550685727825:web:e0921a6a384c00ba80ec70",
  measurementId: "G-MRHLMS85WR"
};
