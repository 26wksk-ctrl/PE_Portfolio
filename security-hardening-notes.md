# PE Portfolio 보안 강화 메모

이 문서는 현재 저장소 구조 기준의 보안 운영 메모입니다. 오래된 `*.hardened.*` 대체 파일 방식은 더 이상 기준으로 보지 않습니다. 현재 기준 파일은 실제 운영 파일인 `firestore.rules`, `database.rules.json`, `firebase.json`, `js/config.js`, `index.html`입니다.

## 현재 적용된 핵심 보안 구조

### 1. Firestore Rules가 최종 권한 판단
클라이언트 코드의 버튼 숨김, 교사 화면 분기, 입력 잠금 표시는 편의 기능입니다. 실제 데이터 접근은 `firestore.rules`가 막아야 합니다.

현재 학생 제출 생성은 다음 조건을 모두 만족해야 합니다.

```text
로그인 상태
student_id == request.auth.uid
submitted_at == request.time
허용 필드/타입/길이 검증 통과
app_config/site.active == true
app_config/lesson.inputEnabled != false
```

따라서 학생이 브라우저 콘솔이나 직접 SDK 호출을 사용하더라도 사이트가 꺼져 있거나 입력이 잠겨 있으면 새 제출을 만들 수 없어야 합니다.

### 2. 교사 권한은 Rules의 이메일 목록으로 보호
`js/config.js`의 `TEACHER_EMAILS`는 화면 표시와 흐름 제어용입니다. 실제 전체 조회/수정/삭제 권한은 `firestore.rules`의 `isTeacher()`가 최종 판단합니다.

교사 이메일을 바꿀 때는 반드시 두 파일을 같이 수정합니다.

```text
js/config.js
firestore.rules
```

### 3. app_config 공개 범위 제한
- `app_config/site`: 공개 읽기. 학생 로그인 전에도 사이트 상태를 보여 주기 위함.
- `app_config/lesson`: 공개 읽기. 학생 로그인 전에도 화면 구성이 필요하기 때문.
- `app_config/share`: 로그인 사용자만 읽기. 익명·집계 데이터만 저장.
- 기타 `app_config/{docId}`: 기본 거부.

`app_config`에 민감 값, Secret, 개인정보를 넣지 않습니다.

### 4. 학생 원본 기록 보호
- 학생은 `simple_responses`에서 본인 `student_id == uid` 기록만 읽습니다.
- 교사만 전체 기록을 읽습니다.
- 제출 기록 수정은 금지합니다.
- 삭제/휴지통/복원은 교사만 합니다.

### 5. Realtime Database 비활성 유지
현재 앱은 Firestore를 사용하고 Realtime Database를 사용하지 않습니다. `database.rules.json`은 읽기/쓰기를 모두 거부합니다.

```json
{
  "rules": {
    ".read": false,
    ".write": false
  }
}
```

Realtime Database 기능을 새로 쓰지 않는 한 이 상태를 유지합니다.

## 아직 선택 사항인 보안 조치

### App Check
`APP_CHECK_SITE_KEY`가 비어 있으면 App Check는 동작하지 않습니다. 편의성 때문에 끄는 선택은 가능하지만, 남용 방어를 더 강화하려면 충분히 테스트한 뒤 Firestore enforcement까지 켜야 합니다.

현재 판단:

```text
필수 아님
운영 편의성 우선이면 보류 가능
```

### Firebase Web API key 제한
Firebase 웹 `apiKey`는 비밀키가 아니지만, Google Cloud Console에서 HTTP referrer 제한을 걸면 오용 가능성을 줄일 수 있습니다.

현재 실제 Hosting 기준 도메인은 다음입니다.

```text
https://pe-portfolio.firebaseapp.com/*
```

추가 도메인을 쓰면 그 도메인도 함께 등록해야 합니다.

## 배포 시 주의

### Hosting 배포와 Rules 배포는 별개
GitHub Actions가 Firebase Hosting을 배포해도 Firestore Rules는 별도로 게시해야 할 수 있습니다.

Rules를 수정했다면 아래 중 하나로 반영합니다.

```bash
firebase deploy --only firestore:rules
```

또는:

```text
Firebase Console → Firestore Database → 규칙 → firestore.rules 내용 붙여넣기 → 게시
```

### Rules 변경 후 최소 테스트
- 로그아웃 상태에서 학생 제출 불가.
- 사이트 OFF 상태에서 학생 제출 불가.
- 입력 잠금 OFF/inputEnabled=false 상태에서 학생 제출 불가.
- 사이트 ON + 입력 가능 상태에서 학생 제출 성공.
- 학생 A가 학생 B 기록 읽기 실패.
- 교사 계정으로 전체 대시보드 조회 성공.
- 교사 아닌 계정으로 `?teacher=1` 전체 조회 실패.
- 휴지통 이동/복원은 교사만 성공.

## 저장소에 절대 올리지 말 것

```text
Firebase 서비스 계정 JSON
GitHub Secrets 값
학생 개인정보 원본 파일
Apps Script 배포용 민감 토큰
외부 API Secret
.env, *.key, *.pem, *service-account*.json
```

## 보안 판단 요약

현재 구조에서 가장 중요한 방어선은 다음 세 가지입니다.

```text
1. firestore.rules
2. 교사 이메일 목록 동기화
3. Secret을 저장소에 올리지 않기
```

App Check, API key referrer 제한, Emulator 기반 Rules 테스트는 추가 강화 수단입니다. 실사용 중 급한 우선순위는 Rules 정확성입니다.
