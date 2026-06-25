# CLAUDE.md — 자기주도 체육탐구 포트폴리오

## 프로젝트 한 줄 요약
체육 수업 후 학생이 2~5분 안에 자기주도 탐구 기록을 남기고, 교사는 누적 기록·통계·세특 근거를 확인하는 Firebase 기반 정적 웹앱이다.

## 현재 운영 구조
- 실제 접속/배포: Firebase Hosting
  - 학생 화면: `https://pe-portfolio.firebaseapp.com`
  - 교사 대시보드: `https://pe-portfolio.firebaseapp.com?teacher=1`
- 저장소: GitHub는 코드 보관·리뷰·Actions 자동 배포용이다.
- 프론트엔드: 순수 HTML/CSS/JavaScript, ES Module 구조.
  - `index.html`은 import map과 루트 DOM만 담당한다.
  - 실제 로직은 `js/*.js`, 스타일은 `css/styles.css`에 분리되어 있다.
- 백엔드: Firebase Authentication + Cloud Firestore.
- 내보내기: `apps-script/Code.gs`는 Google Sheets 내보내기용 보조 코드다.
- 자동화: GitHub Actions에서 Node 24, ESLint, Firebase Hosting 배포를 수행한다.
- App Check: 자리만 있으며 `APP_CHECK_SITE_KEY`가 비어 있으면 사용하지 않는다.

## 절대 원칙
"학생에게 많이 쓰게 하지 말고, 좋은 생각을 짧게 남기게 하는 앱."

- 학생 입력은 수업 마지막에 짧게 한다.
- 입력은 버튼/칩 선택 중심으로 유지한다.
- 자유 서술은 선택 사항이며, 개인정보·친구 이름·민감 정보 입력을 유도하지 않는다.
- 친구 피드백은 활동 중 말로 주고받고, 앱에는 결과 한 줄만 기록한다.
- AI/API 자동 문장 생성은 넣지 않는다. 요약은 선택값 기반 무료 템플릿만 사용한다.

## 주요 파일
```text
index.html                         앱 HTML, Firebase SDK import map
css/styles.css                     전체 스타일
js/config.js                       Firebase 설정, 컬렉션명, 교사 이메일, 앱 버전
js/app.js                          학생/교사 화면 진입점
js/db.js                           Firebase Auth/Firestore 데이터 계층
js/student.js                      학생 화면
js/teacher.js                      교사 대시보드
js/lesson-config.js                기본 수업 설정
js/seed-data.js                    기본 활동/질문/선택지
js/patch-notes.js                  교사 화면 패치노트
firestore.rules                    Firestore 보안 규칙
firestore.indexes.json             Firestore 복합 색인
firebase.json                      Firebase Hosting 설정
database.rules.json                Realtime Database deny-all 규칙
apps-script/Code.gs                Google Sheets 내보내기 보조 코드
.github/workflows/lint.yml         lint 검사
.github/workflows/firebase-hosting-live.yml  Firebase Hosting 자동 배포
```

## 현재 데이터 구조

### Firestore 컬렉션/문서
- `simple_responses/{docId}`: 학생 제출 기록.
- `students/{uid}`: 교사 보정 이름/학급, 학생 본인 학급 기억.
- `student_roster/{studentId}`: 교사가 등록한 학번 5자리 명단.
- `users/{uid}`: Google Auth UID → 학번 lookup.
- `trash_responses/{docId}`: 교사 삭제 기록 휴지통.
- `app_config/site`: 사이트 켜기/끄기.
- `app_config/lesson`: 수업 설정, 입력 잠금, 기록 유형.
- `app_config/share`: 우리반 공유 대시보드 익명 집계.

### 학생 기록 핵심 필드
```text
submitted_at, session_id, class_id, student_id, student_name,
record_no, activity_code, activity_today, inquiry_question,
method_codes, method_labels, evidence_result, next_try,
agency_score, sel_competency_codes, sel_competency_labels,
record_type, feedback_mode, peer_feedback, reflection_text, app_version
```

단원 포트폴리오 모드(`record_type === 'deep'`)에서는 `deep_*` 필드를 추가로 사용한다.

## Firestore 보안 규칙 — 작업 때마다 확인
기능을 고치거나 추가할 때마다 `firestore.rules` 영향 여부를 반드시 검토한다.

중요: **Hosting 배포와 Firestore Rules 배포는 별개다.**
코드를 push해서 Firebase Hosting이 배포되어도 `firestore.rules`는 자동으로 바뀌지 않을 수 있다. 규칙을 수정했다면 Firebase 콘솔 또는 CLI로 Rules를 따로 게시해야 한다.

### 현재 보안 원칙
- 교사는 `firestore.rules`의 `isTeacher()` 이메일 목록으로 판별한다.
- `js/config.js`의 `TEACHER_EMAILS`는 UI 표시/흐름용이고, 실제 권한은 Rules가 최종 판단한다.
- 학생은 `simple_responses`에서 본인 `student_id == request.auth.uid` 기록만 읽을 수 있다.
- 학생 제출 생성은 다음 조건을 모두 통과해야 한다.
  - 로그인 상태.
  - `app_config/site.active == true`.
  - `app_config/lesson.inputEnabled`가 `false`가 아님.
  - `student_id == request.auth.uid`.
  - `submitted_at == request.time`.
  - 허용 필드 목록과 길이/타입 검증 통과.
- 제출 기록 수정은 금지한다. 삭제/복원은 교사만 한다.
- `app_config/site`, `app_config/lesson`만 공개 읽기이고, `app_config/share`는 로그인 사용자만 읽는다.
- 새 `app_config` 문서를 만들 때는 실수로 민감 값이 공개되지 않게 Rules를 먼저 검토한다.
- Realtime Database는 사용하지 않으며 deny-all 상태를 유지한다.

### Rules 검토가 필요한 작업
- 새 컬렉션/문서 경로 추가.
- 제출 기록 필드 추가/이름 변경.
- 교사/학생 권한 변경.
- 사이트 ON/OFF, 입력 잠금, 수업 설정, 공유 대시보드 변경.
- 학생 명단 연결, 이메일 자동 연결, UID/studentId 구조 변경.
- 휴지통/복원/삭제 흐름 변경.
- Firestore 쿼리 조건 변경.

### 기능 수정 후 보고 형식
```text
[Firestore Rules 영향 검토]
- 수정 필요 여부: 필요 / 불필요 / 추가 확인 필요
- 이유:
- 영향 컬렉션:
- 학생 권한:
- 교사 권한:
- 공개 가능 데이터:
- 공개 금지 데이터:
- Firestore Index 필요 여부:
- 테스트 계정: ①학생 ②다른 학생 ③교사 ④로그아웃
```

### Rules 게시 방법
```bash
firebase deploy --only firestore:rules
firebase deploy --only firestore:indexes
firebase deploy --only hosting
```

콘솔에서 게시할 수도 있다.
```text
Firebase Console → Firestore Database → 규칙 탭 → firestore.rules 붙여넣기 → 게시
```

## 배포/자동화
- 권장 흐름: GitHub 웹 수정 → commit → GitHub Actions → Firebase Hosting 자동 배포.
- Actions는 Node 24를 사용한다.
- 현재 주요 Actions:
  - `actions/checkout@v5`
  - `actions/setup-node@v6`
  - `FirebaseExtended/action-hosting-deploy@v0`
- `FIREBASE_SERVICE_ACCOUNT_PE_PORTFOLIO` GitHub Secret이 있어야 live 배포가 된다.
- Secret 값은 Firebase 서비스 계정 JSON 전체이며, 절대 코드/README/채팅에 공개하지 않는다.

## 의존성/SDK 관리
- 브라우저 Firebase SDK 버전은 `index.html`의 import map에서 관리한다.
- npm 패키지는 lint용 개발 의존성만 있다.
- Firebase SDK 메이저 버전을 올리면 최소 테스트를 한다.
  - 학생 로그인.
  - 학생 제출.
  - 교사 로그인.
  - 교사 대시보드 조회.
  - 수업 설정 저장.
  - 사이트 켜기/끄기.
  - 휴지통/복원.
  - Sheets 내보내기.
- 패키지 변경 시 `package.json`과 `package-lock.json`을 함께 커밋한다.

## 작업 방식
- 한국어로 설명한다.
- 큰 변경 전 기존 구조를 먼저 읽고, 유지/변경할 점을 짧게 정리한다.
- 기존 디자인과 운영 흐름을 최대한 유지한다.
- 선생님이 GitHub 웹으로 수정할 수 있어야 하므로, 불필요한 빌드 단계는 추가하지 않는다.
- 변경 후에는 수정한 파일과 이유를 끝에 요약한다.
- 사용자에게 줄 때는 수정본 ZIP과 함께, 실제로 바뀐 파일 목록을 알려준다.

## 패치노트/버전 규칙
- 사용자에게 보이는 변경은 `js/patch-notes.js` 맨 위에 최신순으로 추가한다.
- 의미 있는 앱 변경은 `js/config.js`의 `APP_VERSION`도 올린다.
- 패치노트 시간은 KST 기준으로 적는다.
- 보안 규칙 수정이 포함되면 패치노트에 “firestore.rules 재게시 필요”를 명확히 적는다.

## 개인정보/보안 주의
- 저장소에 올리면 안 되는 것:
  - Firebase 서비스 계정 JSON.
  - GitHub Secrets 값.
  - 학생 개인정보 원본 파일.
  - Apps Script/외부 API 민감 토큰.
- Firebase `apiKey`는 비밀키가 아니지만, Firestore Rules가 느슨하면 데이터가 노출될 수 있다.
- 공유 대시보드는 익명·집계만 허용한다. 이름, 점수 순위, 피드백 원문, 친구 이름은 넣지 않는다.
- 질문 예시/직접 입력 문장은 개인정보가 섞일 수 있으므로 화면 안내와 집계 방식을 보수적으로 유지한다.
