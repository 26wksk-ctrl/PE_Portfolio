/**
 * 자기주도 체육탐구 포트폴리오 - 구글 시트 내보내기 엔드포인트 (Apps Script)
 *
 * 사용 방법
 *  1. 데이터를 받을 구글 시트를 하나 만든다. (탭 이름은 자동으로 'responses' 가 사용됨)
 *  2. 그 시트에서 [확장 프로그램] → [Apps Script] 를 열고, 이 코드를 통째로 붙여넣는다.
 *  3. 아래 EXPORT_TOKEN 을 js/config.js 의 SHEETS_TOKEN 과 똑같은 값으로 바꾼다.
 *  4. [배포] → [새 배포] → 유형: '웹 앱'
 *       - 실행: 나(본인 계정)
 *       - 액세스 권한: '모든 사용자'  (브라우저에서 익명 호출이 가능해야 함)
 *     배포 후 나오는 '웹 앱 URL' 을 js/config.js 의 SHEETS_WEBAPP_URL 에 붙여넣는다.
 *
 *  ※ 학교 Workspace 정책상 '모든 사용자' 배포가 막히면, 관리자에게 외부 공유 허용을 요청하거나
 *    개인 구글 계정으로 시트를 만들어 배포하세요.
 *  ※ 이 엔드포인트는 받은 데이터로 시트를 통째로 덮어씁니다(전체 갱신). 중복 행이 생기지 않습니다.
 */

const EXPORT_TOKEN = 'change-this-token-1234'; // ★ config.js 의 SHEETS_TOKEN 과 동일하게

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    if (String(body.token) !== EXPORT_TOKEN) {
      return json({ ok: false, error: '토큰이 올바르지 않습니다.' });
    }

    const sheetName = body.sheetName || 'responses';
    const header = body.header || [];
    const rows = body.rows || [];

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) sheet = ss.insertSheet(sheetName);

    sheet.clearContents();

    const table = [header].concat(rows);
    if (table.length && table[0].length) {
      sheet.getRange(1, 1, table.length, table[0].length).setValues(table);
      sheet.setFrozenRows(1);
    }

    return json({ ok: true, count: rows.length });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function doGet() {
  // 배포 확인용 (브라우저에서 URL 을 직접 열면 이 응답이 보입니다)
  return json({ ok: true, message: 'PE inquiry export endpoint is live.' });
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
