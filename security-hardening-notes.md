# PE Portfolio 보안 강화 메모

## 가장 먼저 할 일

1. Firebase Console → Firestore Rules에 `firestore.hardened.rules` 내용을 적용한다.
2. Realtime Database를 쓰지 않는다면 `database.rules.json`처럼 읽기/쓰기를 모두 거부한다.
3. `config.js`의 `SHEETS_WEBAPP_URL`, `SHEETS_TOKEN`은 비운다. 현재 구조의 Apps Script 웹앱은 URL과 토큰이 공개 클라이언트 코드에 있으므로 시트가 임의로 덮어써질 수 있다.
4. Google Cloud Console → APIs & Services → Credentials에서 Firebase Web API key의 HTTP referrer를 실제 GitHub Pages 도메인으로 제한한다.
5. Firebase App Check(Web: reCAPTCHA Enterprise)를 등록한 뒤 `APP_CHECK_SITE_KEY`를 넣고, 충분히 테스트한 후 Firestore enforcement를 켠다.

## 내가 본 핵심 위험

### 1. 공개 Apps Script 쓰기 엔드포인트

`config.js`에 Apps Script URL과 `SHEETS_TOKEN`이 그대로 있다. GitHub Pages로 배포하면 누구나 JS 파일을 볼 수 있으므로, 이 토큰은 비밀이 아니다. 현재 `Code.gs`는 토큰만 맞으면 시트를 `clearContents()` 후 덮어쓴다. 즉, 공격자는 학생 데이터를 읽지 못해도 시트 내용을 망가뜨릴 수 있다.

권장: 이 기능은 일단 끄고, 필요하면 교사 브라우저에서 CSV 다운로드 방식 또는 Cloud Functions/Admin SDK 방식으로 바꾼다.

### 2. app_config 전체 공개 읽기

기존 규칙은 `match /app_config/{docId} { allow read: if true; }` 구조라, 나중에 실수로 app_config에 민감 설정을 넣으면 바로 공개된다. 강화 규칙은 `site`, `lesson`만 공개하고 나머지 app_config 문서는 차단한다.

### 3. 학생 응답 검증 부족

기존 규칙은 학생이 본인 uid로 쓰는지는 확인하지만, `student_email`, `submitted_at`, 허용 필드 목록, 배열 크기, record_no 범위 같은 부분이 느슨하다. 강화 규칙은 본인 uid/email, 서버 시각, 허용 필드 목록, 길이 제한을 확인한다.

### 4. Realtime Database URL 노출

`firebaseConfig`에 Realtime Database URL이 있는데 프로젝트에서는 Firestore만 쓰는 것으로 보인다. Firebase config 자체는 비밀은 아니지만, 쓰지 않는 제품은 꺼두거나 rules를 deny-all로 두는 편이 안전하다.

## 적용 파일

- `firestore.hardened.rules` → 기존 `firestore.rules` 대체 후보
- `database.rules.json` → Realtime Database deny-all
- `firebase.hardened.json` → database rules 경로 추가
- `config.hardened.js` → Sheets export 비활성화 + App Check site key 자리 추가 + databaseURL 제거
- `index.hardened.html` → App Check SDK import map 추가
- `db.hardened.js` → App Check 초기화 코드 추가
- `.gitignore.hardened` → env/service account류 비밀 파일 무시 항목 추가

## 주의

`firestore.hardened.rules`는 기존 앱 동작을 최대한 유지하도록 만들었지만, 실제 배포 전에는 Firebase Emulator 또는 콘솔 Rules Playground에서 최소 테스트가 필요하다.

테스트 시나리오:

- 학생 로그인 후 자기 기록 제출 성공
- 학생이 자기 기록 목록만 읽기 성공
- 학생이 다른 uid의 기록 읽기 실패
- 학생이 `student_id`를 다른 uid로 바꿔 제출 실패
- 학생이 `student_email`을 다른 값으로 바꿔 제출 실패
- 교사 계정으로 대시보드 전체 읽기 성공
- 교사 계정으로 사이트 켜기/끄기 성공
- 교사 계정으로 학생 이름/학급 보정 성공
- 교사 계정이 아닌 계정으로 `?teacher=1` 접근 시 대시보드 읽기 실패
