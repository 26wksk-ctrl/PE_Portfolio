# 자기주도 체육탐구 포트폴리오 (웹 / Firebase 버전)

체육 수업에서 학생이 **자기 주도적으로 탐구 질문을 세우고 기록**하도록 돕는 웹앱입니다.
학생은 수업을 마치며 태블릿으로 그날의 탐구를 60초 안에 기록하고, 교사는 대시보드에서 누적 기록을 확인합니다.

원래 Google Apps Script(`Code.gs` + `Index.html`) 로 만든 앱을, **GitHub Pages 등 정적 호스팅 + Firebase Firestore** 구조로 변환한 버전입니다.

- **질문 주도성**: "지난 차시의 다음 질문 → 이번 차시의 오늘 질문"으로 차시 간 질문을 연결합니다.
- **측정 항목**: 오늘 활동 / 탐구 질문 / 해본 방법(복수) / 결과·과정 피드백 / 자기주도성 척도(1~5) / SEL 역량 1개 / 다음 질문.

## 기술 스택

- **프론트엔드**: 순수 HTML/CSS/JavaScript (ES Module). 빌드 도구 없음.
- **백엔드/DB**: Firebase Firestore (브라우저 SDK 직접 호출).
- **호스팅**: GitHub Pages (또는 Firebase Hosting / 임의 정적 호스팅).

## 파일 구조

```
index.html          학생 화면 + 교사 대시보드(?teacher=1) 진입점
css/styles.css      스타일
js/
  config.js         Firebase 설정 + 교사 코드 + 앱 버전  ← 배포 전 수정 필요
  seed-data.js      학급/옵션/추천질문 (앱 설정 데이터)
  utils.js          공통 유틸
  db.js             Firestore 데이터 계층 (옛 Code.gs 서버 함수 대체)
  student.js        학생 화면 UI
  teacher.js        교사 대시보드 UI
  app.js            진입점 (모드 분기)
firestore.rules     Firestore 보안 규칙
```

## 설정 및 배포

### 1. Firebase 프로젝트 만들기
1. [Firebase 콘솔](https://console.firebase.google.com/) 에서 프로젝트 생성
2. **Firestore Database** 생성 (프로덕션 모드)
3. 프로젝트 설정 → 일반 → "내 앱"에 **웹 앱** 추가 → 구성(config) 값 복사

### 2. 설정값 입력
`js/config.js` 의 `firebaseConfig` 를 복사한 값으로 교체하고,
`TEACHER_CODE`(교사 대시보드 진입 코드)를 원하는 값으로 바꿉니다.

### 3. 보안 규칙 적용
`firestore.rules` 내용을 Firebase 콘솔 → Firestore → 규칙에 붙여넣고 게시합니다.

### 4. GitHub Pages 배포
1. 이 저장소를 GitHub 에 푸시
2. 저장소 Settings → Pages → Branch 를 배포 브랜치 / `root` 로 지정
3. 발급된 URL 로 접속

> 빌드 단계가 없어 정적 파일을 그대로 서빙하면 됩니다.
> 로컬 확인: `python3 -m http.server` 후 `http://localhost:8000` (ES Module 은 `file://` 로 열면 안 됩니다).

## 사용

- **학생**: `index.html` — 학급 선택 → 이름 입력 → 지난 질문 회상 → 오늘 기록 → 제출
  - 특정 학급 고정 링크: `index.html?session_id=FREE_SIMPLE_CLASS1`
- **교사**: `index.html?teacher=1` — 교사용 코드 입력 후 대시보드 조회

## 데이터 모델 (Firestore)

`simple_responses` 컬렉션. 한 문서 = 한 학생의 한 차시 기록.
주요 필드: `session_id, class_id, student_id, student_name, record_no, activity_today, inquiry_question, method_labels[], evidence_result, next_try, agency_score, sel_competency_label, submitted_at`.

- 학생 식별: `student_id = class_id + '-' + 이름` (이름 오타 시 지난 기록 연결 끊김 → 화면에 주의 메시지 표시)
- 차시(`record_no`): 제출 시 해당 학생의 기존 기록 수 + 1 자동 계산

## 보안 참고

`firebaseConfig` 의 키 값은 비밀이 아니라 공개 식별자입니다. 데이터 보호는 `firestore.rules` 가 담당합니다.
`TEACHER_CODE` 는 클라이언트에 노출되므로 강한 보안이 아닙니다. 외부 공개·민감 데이터 환경이라면
**Firebase Authentication** 을 도입하고 `firestore.rules` 의 read 조건을 로그인 사용자로 좁히는 것을 권장합니다.

## 변경 이력 (Apps Script → 웹)

- Google Sheets DB → Firestore 컬렉션
- `google.script.run` 비동기 호출 → Firestore SDK (`async/await`)
- HtmlService 템플릿(`<?!= ... ?>`) → URL 쿼리 파라미터(`?session_id`, `?teacher=1`)
- 단일 `Index.html` 인라인 스크립트 → ES Module 분리(`js/*.js`) + CSS 분리
- 분석 보조용 `response_items` / `response_options` 시트는 단일 `simple_responses` 컬렉션으로 단순화
