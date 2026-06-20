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
  - 로그인하면 하단 **"내 지난 기록"** 에서 본인 기록과 주도성 변화 그래프를 볼 수 있습니다. (버튼을 눌렀을 때만 본인 문서를 읽음)
- **교사**: `index.html?teacher=1` — 교사용 구글 계정 로그인 후 대시보드 조회

### 사이트 켜기 / 끄기 (학생 화면 활성화)

평상시 학생 화면은 **비활성(꺼짐)** 상태로, 학생에게는 간단한 안내 메시지만 보입니다.
교사가 **본인 구글 계정으로 로그인**하면 **켜기 / 끄기 토글**이 나타나며 **언제든** 켜고 끌 수 있습니다.

- **교사 대시보드**(`index.html?teacher=1`): 로그인하면 상단에 "사이트 상태 (학생 화면 켜기 / 끄기)" 카드가 나타납니다.
- **학생 메인 화면**(`index.html`): 비활성 화면 아래의 "선생님이신가요? 로그인" 에서 교사 계정으로 로그인하면 바로 "사이트 켜기/끄기" 토글이 나타납니다. (학생에게는 보이지 않음)

- 상태는 Firestore `app_config/site` 문서(`active: true/false`)에 저장되어 모든 학생 기기에 **실시간 반영**됩니다.
- 문서가 없거나 `active` 가 `true` 가 아니면 기본값은 **꺼짐**입니다.
- 이 기능을 쓰려면 `firestore.rules` 의 `app_config` 규칙(공개 읽기 + 교사만 쓰기)을 Firebase 콘솔에 **다시 게시**해야 합니다.

## 데이터 모델 (Firestore)

`simple_responses` 컬렉션. 한 문서 = 한 학생의 한 차시 기록.
주요 필드: `session_id, class_id, student_id, student_name, record_no, activity_today, inquiry_question, method_labels[], evidence_result, next_try, agency_score, sel_competency_label, submitted_at`.

- 학생 식별: `student_id = 구글 계정 uid` (로그인 기반이라 이름 오타·동명이인과 무관하게 본인 기록이 이어집니다)
- 차시(`record_no`): **학생별 제출 순서**로 셉니다(반과 무관). 제출 시엔 그 학생의 기존 기록 수 + 1 로 저장하고, **화면 표시 차시는 적재된 기록을 시간순으로 다시 계산**합니다. 그래서 학생이 반을 잘못 골랐다 바꿔도 차시가 끊기지 않고, 기존 기록의 저장값을 바꾸지 않아도 올바르게 보입니다. (교사 대시보드는 선택한 "조회 기간" 안의 기록만 불러오므로, 전체 차시를 정확히 보려면 기간을 "전체"로 두세요.)
- 기록 삭제(휴지통): 교사 대시보드 "최근 누적 기록" 표에서 행별 또는 체크박스로 **일괄 삭제**할 수 있고, 삭제된 기록은 `trash_responses` **휴지통**으로 이동합니다(통계에서 빠짐). 휴지통 카드에서 **복원 / 완전 삭제 / 비우기**가 가능합니다. 교사 계정만 가능하며 `firestore.rules`(삭제·교사 복원 권한·`trash_responses` 규칙)를 콘솔에 다시 게시해야 동작합니다.
- 학생 이메일(`student_email`)은 Firestore 에는 저장되지만 **대시보드 화면과 시트 내보내기에는 표시하지 않습니다.**

### 조회 성능 (기간별 조회 + 색인)

데이터가 누적돼도 빠르게 보도록, 교사 대시보드는 **선택한 기간만** 읽습니다.

- 조회 기간: **이번 달(기본) · 최근 3개월 · 올해 · 전체 · 사용자 지정(월 범위)**. `submitted_at` 범위 쿼리라 **기존 기록은 그대로 보존**되고, "전체"를 고르면 모두 다시 보입니다.
- 헤드라인 숫자(총 건수·주도성 평균)는 Firestore **집계 쿼리**(`count()`/`average()`)로 서버에서 계산해 문서를 읽지 않습니다.
- **편집 시 재조회 안 함**: 학생 이름·학급을 저장하거나 테스트 학생을 정리할 때 대시보드 전체를 다시 읽지 않고 화면 데이터만 메모리에서 갱신합니다. (여러 명을 연속 수정해도 읽기가 늘지 않음)
- **보정 컬렉션 세션 캐시**: 이름·학급 보정(`students` 컬렉션)을 대시보드 새로고침마다 다시 읽지 않고 **세션 동안 한 번만** 읽습니다. 교사가 이름·학급을 보정하거나 학생을 정리하면 캐시를 그 자리에서 갱신하므로 추가 읽기가 없습니다. (반복 새로고침 시 읽기 대폭 절감) 단, 응답 기록 자체는 새 제출을 반영하려면 새로고침마다 읽으므로, **조회 기간을 좁히고 불필요한 새로고침을 줄이는 것**이 읽기 비용을 가장 크게 아낍니다.
- 차트 표본은 과도한 비용을 막기 위해 최대 4,000건으로 제한하며, 초과 시 화면에 안내가 표시됩니다. (기간을 좁히면 정확)
- **복합 색인**: 학급 필터와 기간을 함께 쓰면 `firestore.indexes.json` 의 색인(`class_id` + `submitted_at`)이 필요합니다. Firestore 콘솔에서 쿼리 실패 시 안내되는 링크로 만들거나, `firebase deploy --only firestore:indexes` 로 배포하세요. (기본 "이번 달" 조회는 색인 없이도 동작)

### 학생 이름·학급 보정 (`students/{uid}`)

구글 계정 이름(`displayName`)이 실명과 다르거나 학급이 잘못 입력된 경우를 위해, 교사 보정값과 학생 본인의 반 기억을 함께 저장하는 컬렉션입니다. 문서 형태: `{ name, session_id, class_id, self_session_id, self_class_id }`.

- **이름**: 교사 대시보드의 **"학생 이름·학급 관리"** 표에서 실명을 입력해 저장하면 `students/{uid}.name` 에 기록됩니다. 표시 이름은 **`students/{uid}.name`(보정값) → 응답의 `student_name`** 순으로 해석되어 **지난 기록·새 기록·학생 화면·시트 내보내기 모두에 한 번에 반영**됩니다.
- **반 오입력 방지**: 학생 화면은 반을 **기본 선택해 두지 않습니다**. 본인 반을 직접 골라야 하며, 고르기 전에는 제출이 막힙니다(그냥 제출해서 1반으로 들어가는 오입력 차단). 한 번 반을 고르면 **"현재 반"만 표시**하고, 바꿀 때만 **"반 변경"** 버튼으로 다시 고릅니다(수업 중 실수로 반이 바뀌는 것 방지).
- **테스트 학생 정리**: "학생 이름·학급 관리" 표의 **"기록 삭제"** 로 테스트용 학생의 기록을 **휴지통으로 보내고** 이름·학급 보정 문서(`students/{uid}`)를 삭제해 명단에서 정리합니다. 기록은 휴지통에서 복원할 수 있고, **구글 로그인 계정 자체는 브라우저에서 지울 수 없습니다**(같은 계정으로 다시 제출하면 새로 나타남). 교사 계정만 가능하며 `firestore.rules` 의 `students` 삭제 규칙을 콘솔에 다시 게시해야 동작합니다.
- **반 기억(서버)**: 학생이 반을 골라 제출하면 그 반이 `students/{uid}.self_session_id`·`self_class_id` 에 저장되어, **어느 기기(공용 태블릿 포함)에서 로그인해도 자동으로 선택**됩니다. 교사는 같은 표의 **"학급 수정"** 에서 학생 반을 바로잡을 수 있습니다(`session_id`·`class_id`).
  - 학급 자동 선택 해석 순서: **교사 보정(`session_id`) → 학생 본인 기억(`self_session_id`) → 기기 캐시(`localStorage`)**. 모두 로그인 때 읽는 본인 문서 한 건에 담겨 **추가 읽기 0**, 교사 보정이 항상 우선합니다.
  - **지난 기록의 `class_id` 는 그대로 보존**됩니다(통계 일관성 + 데이터 보존). 즉 반 보정·기억은 학생 화면과 앞으로의 기록에만 적용됩니다.
- 교사는 `name`·`session_id`·`class_id` 를, **학생 본인은 자기 문서의 `self_*` 칸만** 쓸 수 있습니다(교사 보정 필드는 못 건드림). 이 기능을 쓰려면 `firestore.rules` 의 `students` 규칙을 Firebase 콘솔에 **다시 게시**해야 합니다.

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
