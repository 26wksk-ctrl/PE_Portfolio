# CLAUDE.md — 자기주도 체육탐구 포트폴리오

## 프로젝트
체육 수업용 자기주도 탐구 포트폴리오 웹앱. 학생이 수업 직후 2~3분 안에
그날 활동을 짧게 성찰·기록한다.
핵심 흐름: 질문으로 시작 → 방법으로 실행 → 피드백으로 수정 → 증거로 성찰.
- 호스팅: GitHub Pages (정적 사이트, 주로 Index.html + inline JS)
- 백엔드: Firebase / Firestore
- 부가: Google Sheets 내보내기용 Apps Script 웹훅
- 교사 화면: ?teacher=1, 인증 이메일 visionaryshl@gmail.com

## 절대 원칙 (가장 중요)
"학생에게 많이 쓰게 하지 말고, 좋은 생각을 짧게 남기게 하는 앱."
- 학생 입력은 2~3분 이내. 활동 중 기기 사용 안 함, 수업 마지막에만 짧게.
- 입력은 버튼/칩 선택 중심. 자유 서술은 최소(항상 선택, 강제 아님).
- 친구 피드백은 활동 중 '말로' 주고받고, 앱에는 결과 한 줄만 기록.

## 데이터 구조 (설정과 기록 분리)
교사가 코드 수정 없이 수업 설정만 바꾸면 학생 화면이 바뀌어야 한다.
모든 선택지는 코드 곳곳에 하드코딩하지 말고 설정 한 곳(config)에 모은다.

lessonSettings: lessonId, date, classId, unit, activity, coreQuestion,
  goalOptions[], methodOptions[], feedbackMode("received"|"given"),
  feedbackOptions[], resultOptions[], nextTryOptions[], selFocus,
  inputEnabled, shareDashboardEnabled, recordType("quick"|"deep")

records: recordId, lessonId, userId, studentName, classId, date,
  activity, goal, methods[], feedbackMode, peerFeedback,
  resultEvidence, nextTry, agencyScore(1~5), selCompetency,
  reflectionText(선택값으로 조립한 요약 문장), createdAt

## 화면 규칙
- 학생 개인 대시보드: 핵심 3개만 — 자기주도성 점수 변화 / 다음 시간 목표 /
  최근 성찰 몇 줄.
- 우리반 공유 대시보드: 익명·집계만(많이 고른 목표, 좋은 질문 예시 등).
  금지: 점수 순위, 개인 비교 그래프, 피드백 원문, 친구 이름 등 민감 정보.
- SEL은 점수화·순위화 금지. 성장 특성 참고용으로만.
- 교사 세특 자료: AI 문장 생성 없음. 학생별 기록을 '그냥 정리해 나열'(근거
  정리판). 문장은 교사가 직접 작성.

## Firestore 보안 규칙 (firestore.rules) — 매 작업 검토 필수
기능을 고치거나 추가할 때마다 firestore.rules 영향을 반드시 검토한다.
**GitHub Pages 배포(코드)와 Firestore 규칙 게시는 별개 작업이다.** 규칙은
Firebase 콘솔/CLI에서 따로 게시해야 적용된다. 코드만 push하면 규칙은 안 바뀐다.

규칙 검토가 필요한 경우(하나라도 해당 시):
- 새 컬렉션/문서 경로 추가, 기존 경로 변경
- 기록(response) 문서에 **필드 추가/이름 변경** (rules의 hasOnly 화이트리스트
  때문에 새 필드는 게시 전까지 "Missing or insufficient permissions"로 거부됨)
- 역할/권한 변경, 학생 본인 기록 제한, 교사 전체 조회, 공개(익명) 대시보드
- 생성/수정/삭제/복원 기능 변경, studentId/UID 연결 구조 변경
- 사이트 ON/OFF·입력기간·차시 제한을 보안으로 강제, 권한 오류 발생, 과도 허용

보안 원칙:
- 학생은 본인 기록만 읽고 쓴다. 친구 원본 기록은 못 본다. 교사만 전체 조회.
- 교사 화면은 URL 파라미터가 아니라 교사 계정 권한(이메일)으로 보호.
- 공유 대시보드는 원본이 아닌 익명·집계만. displayName을 식별 기준으로 쓰지 않음
  (기준은 auth.uid ↔ 내부 studentId/profile). 삭제/복원은 교사 권한.
- 광범위한 allow read, write 금지.

기능 수정 후 반드시 아래 형식으로 보고한다:
```
[Firestore Rules 영향 검토]
- 수정 필요 여부: 필요 / 불필요 / 추가 확인 필요
- 이유 / 영향 컬렉션 / 읽기·쓰기·수정·삭제 권한
- 학생 권한 / 교사 권한 / 공개 가능 데이터 / 공개 금지 데이터
- Firestore Index 필요 여부
- 테스트 계정: ①학생 ②다른 학생 ③교사 ④로그아웃
```
규칙 수정이 필요하면 코드 수정과 별도로 **게시 방법까지 안내**한다(아래).

규칙 게시 방법(둘 중 하나):
1. Firebase 콘솔 → Firestore Database → 규칙 탭 → firestore.rules 내용 붙여넣기 → 게시
2. CLI: `firebase deploy --only firestore:rules`

## 작업 방식
- 한국어로 설명.
- 기존 구조와 디자인은 최대한 유지하며 단계적으로 개선. 큰 변경 전 기존 코드를
  먼저 읽고 무엇을 유지/변경할지 한국어로 요약한 뒤 진행.
- 변경 후에는 수정한 파일과 변경 내용을 끝에 요약.
- 자동 성찰 '문장 생성(AI/API)'은 넣지 않는다. 제출 전 요약은 선택값을 끼워 넣는
  무료 템플릿으로만.

## 개발 로드맵 (순서대로, 한 단계씩)
1. 2분 기록 화면 개편 + 선택지를 config 객체로 (친구 피드백 칸 포함)
2. 교사 설정 화면 + config를 Firestore로 이동 (코드 수정 없이 수업 세팅)
3. 학생 개인 대시보드(핵심 3개) + 우리반 공유 대시보드(익명·집계)
4. 교사 통계 대시보드 + 학생별 세특 근거 정리판
5. 단원 deep 포트폴리오 모드
