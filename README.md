# 자기주도 체육탐구 포트폴리오

체육 수업에서 학생이 **자기 주도적으로 탐구 질문을 세우고 기록**하도록 돕는 Firebase 기반 웹앱입니다.  
학생은 수업 후 태블릿·휴대폰으로 기록을 남기고, 교사는 대시보드에서 누적 기록·학생별 성장 흐름·세특 근거 자료를 확인합니다.

현재 운영 기준 주소는 Firebase Hosting입니다.

```text
https://pe-portfolio.firebaseapp.com
```

GitHub 저장소는 코드 보관과 변경 이력 관리용이며, 실제 학생·교사 접속은 Firebase Hosting 주소를 기준으로 합니다.

## 핵심 기능

- **Google 로그인**: 학생·교사 모두 Google 계정으로 로그인합니다.
- **학생 명단 연결**: 교사가 등록한 학번·이름·이메일 정보를 바탕으로 학생 계정을 자동 또는 수동 연결합니다.
- **자기주도 기록**: 활동, 탐구 질문, 시도한 방법, 결과·성찰, 다음 시도, 자기주도성, SEL 역량을 기록합니다.
- **학생 개인 기록**: 학생은 본인 기록과 성장 흐름을 확인할 수 있습니다.
- **교사 대시보드**: 기간별 조회, 학생 이름·학급 보정, 세특 근거 정리, 휴지통/복원, Google Sheets 내보내기를 지원합니다.
- **수업 설정**: 교사가 활동·질문·선택지를 코드 수정 없이 대시보드에서 바꿀 수 있습니다.
- **사이트 켜기/끄기**: 교사가 학생 입력 화면을 실시간으로 활성/비활성화할 수 있습니다. `app_config/site.active === false`일 때만 닫히고, 문서 없음·필드 없음·꼬인 값은 기본적으로 열린 상태로 처리합니다.

## 기술 스택

- **프론트엔드**: 순수 HTML/CSS/JavaScript, ES Module
- **인증**: Firebase Authentication - Google 로그인
- **DB**: Firebase Firestore
- **호스팅**: Firebase Hosting
- **검사/자동화**: ESLint, GitHub Actions
- **런타임/CI**: Node 24 기준으로 lint와 자동 배포를 실행합니다.
- **Firebase Web SDK**: `index.html` import map에서 버전을 관리합니다.
- **빌드**: 없음. 정적 파일을 그대로 배포합니다.

## 파일 구조

```text
index.html                         학생 화면 + 교사 대시보드(?teacher=1) 진입점
css/styles.css                     스타일
js/
  config.js                        Firebase 설정, 컬렉션 이름, 교사 이메일 목록
  seed-data.js                     학급/옵션/추천 질문 기본값
  lesson-config.js                 수업 설정 기본값
  utils.js                         공통 유틸, 오류 메시지
  db.js                            Firestore/Auth 데이터 계층
  student.js                       학생 화면 UI
  teacher.js                       교사 대시보드 UI
  patch-notes.js                   교사 대시보드 패치노트
  app.js                           진입점
apps-script/                       Google Sheets 내보내기용 Apps Script
firestore.rules                    Firestore 보안 규칙
firestore.indexes.json             Firestore 복합 색인
firebase.json                      Firebase Hosting 설정
database.rules.json                Realtime Database deny-all 규칙
CLAUDE.md                          AI 작업 지침
security-hardening-notes.md        보안 운영 메모
.github/workflows/lint.yml         코드 검사 자동 실행
.github/workflows/firebase-hosting-live.yml  Firebase Hosting 자동 배포
```

## 운영 방식 요약

권장 운영 방식은 **GitHub 웹 수정 → Actions 자동 배포 → Firebase Hosting 반영**입니다.

```text
선생님이 GitHub 웹에서 파일 수정/업로드
→ Commit changes 클릭
→ GitHub Actions 실행
→ Firebase Hosting에 자동 배포
→ https://pe-portfolio.firebaseapp.com 반영
```

선생님은 터미널을 쓰지 않아도 됩니다. 단, 자동 배포 연결은 처음 한 번 개발자가 설정해야 합니다.

## 사이트 상태 운영 규칙

학생 제출 가능 여부는 Firestore의 `app_config/site` 문서와 `app_config/lesson` 문서를 함께 봅니다.

`app_config/site.active` 해석 기준:

```text
active === false  → 사이트 닫힘
그 외 모든 경우  → 사이트 열림
```

따라서 다음 경우는 모두 열린 상태로 봅니다.

```text
app_config/site 문서 없음
active 필드 없음
active가 boolean true
active가 false가 아닌 꼬인 값
```

이 기준은 학생 화면(`js/db.js`의 `watchSiteStatus`)과 Firestore Rules(`isSiteActiveForStudentSubmission`)가 동일하게 사용합니다. 예전처럼 상태 문서가 없거나 꼬였다는 이유만으로 학생 제출이 막히지 않도록 하기 위한 설계입니다.

교사 화면에 접속하는 것만으로는 `app_config/site.active` 값을 자동으로 바꾸지 않습니다. 사이트 상태는 교사가 대시보드에서 **사이트 켜기/끄기 버튼을 직접 눌렀을 때만** 저장됩니다.

수업 입력 잠금은 별도입니다. `app_config/lesson.inputEnabled === false`이면 사이트가 열려 있어도 학생 입력은 잠깁니다.


## 처음 설정할 것

### 1. Firebase 프로젝트 확인

Firebase 콘솔에서 다음 항목이 설정되어 있어야 합니다.

- Firestore Database
- Authentication → Sign-in method → Google 사용 설정
- Authentication → Settings → Authorized domains에 `pe-portfolio.firebaseapp.com` 포함
- Hosting 사이트 활성화

### 2. `js/config.js` 확인

`js/config.js`에서 다음 값을 실제 Firebase 프로젝트와 맞춥니다.

```js
export const TEACHER_EMAILS = ['visionaryshl@gmail.com', 'simsy0924@gmail.com'];
```

교사 대시보드 접근은 `TEACHER_EMAILS`와 `firestore.rules`의 교사 이메일 목록이 함께 맞아야 합니다. 둘 중 하나만 바꾸면 권한 오류가 날 수 있습니다.

### 3. Firestore 규칙과 색인 배포

보안 규칙 또는 색인을 수정했다면 Firebase에 다시 반영해야 합니다.

```bash
firebase deploy --only firestore:rules
firebase deploy --only firestore:indexes
```

중요: GitHub Actions의 Hosting 자동 배포와 Firestore Rules 게시는 별개입니다. `firestore.rules`를 고쳤다면 Firebase 콘솔 또는 CLI로 Rules를 다시 게시해야 합니다.

학생·교사 화면 코드만 수정한 경우에는 보통 Hosting 배포만 필요합니다.

```bash
firebase deploy --only hosting
```

## GitHub Actions 자동 배포 설정

이 저장소에는 Firebase Hosting 자동 배포용 workflow가 포함되어 있습니다.

```text
.github/workflows/firebase-hosting-live.yml
```

자동 배포를 실제로 사용하려면 GitHub 저장소에 Firebase 서비스 계정 secret을 추가해야 합니다.

```text
Repository Settings
→ Secrets and variables
→ Actions
→ New repository secret
```

Secret 이름:

```text
FIREBASE_SERVICE_ACCOUNT_PE_PORTFOLIO
```

Secret 값:

```text
Firebase 서비스 계정 JSON 전체
```

이 JSON은 절대 코드나 README에 붙여 넣으면 안 됩니다. 반드시 GitHub Secret에만 저장하세요.

secret이 없으면 workflow는 lint까지만 실행되고, Firebase 배포 단계는 건너뜁니다. secret이 등록되면 `main` 브랜치에 push될 때 자동으로 live 채널에 배포됩니다.

### 자동 배포 흐름

```text
main 브랜치 push
→ npm ci --no-audit --no-fund
→ npm run lint
→ Firebase Hosting live 배포
```

수동으로 다시 배포하고 싶을 때는 GitHub Actions 화면에서 `Deploy to Firebase Hosting` workflow를 선택한 뒤 `Run workflow`를 누르면 됩니다.

현재 workflow는 Node 24, `actions/checkout@v5`, `actions/setup-node@v6` 기준입니다. `FirebaseExtended/action-hosting-deploy@v0`는 Firebase Hosting 배포용으로 유지합니다.

## 선생님용 수정 방법

선생님이 간단한 문구나 수업 설정 파일을 바꾸는 경우:

```text
GitHub 저장소 접속
→ 수정할 파일 클릭
→ 연필 아이콘 클릭
→ 내용 수정
→ Commit changes 클릭
→ 몇 분 뒤 Firebase Hosting 자동 반영
```

운영 중 선생님이 직접 수정해도 비교적 안전한 파일:

```text
README.md
CLAUDE.md
security-hardening-notes.md
js/patch-notes.js
css/styles.css
js/lesson-config.js
js/seed-data.js
```

주의해서 수정해야 하는 파일:

```text
js/db.js
js/student.js
js/teacher.js
firestore.rules
firestore.indexes.json
firebase.json
.github/workflows/*.yml
```

특히 `firestore.rules`는 보안 규칙이므로 개발 담당자가 검토한 뒤 배포하는 것을 권장합니다.

## 로컬 테스트

ES Module을 사용하므로 `file://`로 직접 열지 말고 간단한 로컬 서버로 확인합니다.

```bash
python3 -m http.server 8000
```

브라우저에서 접속:

```text
http://localhost:8000
```

코드 검사:

```bash
npm ci
npm run lint
```

## 사용 주소

학생 화면:

```text
https://pe-portfolio.firebaseapp.com
```

교사 대시보드:

```text
https://pe-portfolio.firebaseapp.com?teacher=1
```

특정 학급 고정 링크:

```text
https://pe-portfolio.firebaseapp.com?session_id=FREE_SIMPLE_CLASS1
```

## Google 로그인 문제 점검

계정 선택 후 로그인 상태가 반영되지 않으면 아래를 확인합니다.

1. Firebase Authentication에서 Google 로그인 제공자가 켜져 있는지 확인
2. Authorized domains에 `pe-portfolio.firebaseapp.com`이 있는지 확인
3. `js/config.js`의 `authDomain`이 `pe-portfolio.firebaseapp.com`인지 확인
4. 모바일/인앱 브라우저에서는 redirect 방식으로 로그인되므로, 로그인 후 원래 주소로 돌아오는지 확인
5. 캐시가 남아 있으면 주소 뒤에 `?v=날짜` 같은 쿼리를 붙여 새로고침

예시:

```text
https://pe-portfolio.firebaseapp.com?v=20260625
```

## 데이터 모델

### `simple_responses`

학생의 한 차시 기록입니다.

주요 필드:

```text
session_id, class_id, student_id, student_name, record_no,
activity_today, inquiry_question, method_labels[], evidence_result,
next_try, agency_score, sel_competency_label, submitted_at
```

### `student_roster`

교사가 미리 등록한 학생 명단입니다. 문서 ID는 학번 5자리입니다.

### `users`

Google Auth UID와 학생 학번을 연결하는 lookup 문서입니다.

### `students`

교사 보정 이름·학급, 학생 본인 학급 기억 등을 저장합니다.

### `trash_responses`

삭제된 기록을 임시 보관하는 휴지통입니다.

### `app_config`

사이트 켜기/끄기(`site`), 수업 설정과 입력 잠금(`lesson`), 공유 대시보드 익명 집계(`share`)를 저장합니다.

## 보안 참고

`firebaseConfig.apiKey`는 비밀키가 아니라 Firebase 웹앱 식별자입니다. 데이터 보호는 Firestore 보안 규칙이 담당합니다.

다만 다음 값은 절대 저장소에 올리면 안 됩니다.

```text
Firebase 서비스 계정 JSON
GitHub Secrets 값
Apps Script 배포용 민감 토큰
개인정보 원본 파일
```

교사 권한은 클라이언트의 `TEACHER_EMAILS` 표시뿐 아니라 `firestore.rules`에서 반드시 한 번 더 검사해야 합니다.

현재 학생 제출은 Firestore Rules에서도 사이트 상태와 입력 잠금 상태를 확인합니다. 사이트는 `app_config/site.active === false`일 때만 닫힌 것으로 보고, 문서 없음·필드 없음·꼬인 값은 기본적으로 열린 상태로 봅니다. 단, `app_config/lesson.inputEnabled === false`이면 학생 입력은 잠깁니다. 이 규칙을 수정했다면 Rules를 반드시 다시 게시해야 합니다.

## 변경 이력 요약

- Google Apps Script/Sheets 기반 구조에서 Firebase Firestore 기반 웹앱으로 전환
- 학생 식별을 이름 입력 중심에서 Google 로그인 + 학생 명단 연결 구조로 변경
- 교사 대시보드, 기간별 조회, 휴지통, 세특 근거 정리판, 수업 설정 기능 추가
- 모바일 로그인 안정화를 위해 popup/redirect 로그인 흐름 보강
- GitHub Actions 기반 Firebase Hosting 자동 배포 구조 추가
- Firestore Rules에서 사이트 OFF/입력 잠금 상태의 학생 제출을 차단하도록 강화
- 사이트 상태 문서가 없거나 꼬인 경우 학생 제출이 막히지 않도록 `active === false`일 때만 닫힘으로 해석
- Firebase Web SDK와 GitHub Actions 버전 갱신
