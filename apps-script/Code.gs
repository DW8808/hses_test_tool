// 華勛國小測驗工具管理系統 —— Google Apps Script 後端
// 部署方式與呼叫方式請見 SETUP.md

var SHEET_ITEMS = 'Items';
var SHEET_HISTORY = 'History';
var SHEET_BORROWERS = 'Borrowers';

function checkPin_(pin) {
  var expected = PropertiesService.getScriptProperties().getProperty('PIN');
  return !!expected && pin === expected;
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// GET {WEB_APP_URL}?pin=xxxx  ->  { ok, generatedAt, borrowers, tests, history }
function doGet(e) {
  var pin = ((e && e.parameter && e.parameter.pin) || '').trim();
  if (!checkPin_(pin)) return jsonOutput_({ ok: false, error: 'PIN 錯誤' });

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var itemsSheet = ss.getSheetByName(SHEET_ITEMS);
    var historySheet = ss.getSheetByName(SHEET_HISTORY);
    var borrowersSheet = ss.getSheetByName(SHEET_BORROWERS);

    var itemsData = itemsSheet.getDataRange().getValues();
    var testsMap = {};
    var testOrder = [];
    for (var i = 1; i < itemsData.length; i++) {
      var testId = itemsData[i][0];
      var testName = itemsData[i][1];
      var group = itemsData[i][2];
      var itemCode = itemsData[i][3];
      var isStarredRaw = itemsData[i][4];
      var currentStockRaw = itemsData[i][5];
      var borrower = itemsData[i][6];
      var returner = itemsData[i][7];

      if (testId === '' || testId === null || testId === undefined) continue;
      // 來源清冊裡編號 18/19/20 在兩個分頁重複出現，只用 testId 分組會誤把兩筆合併成一筆，
      // 所以一律用 testId+group 當分組鍵值。
      var testKey = testId + '::' + group;
      if (!testsMap[testKey]) {
        testsMap[testKey] = { id: testId, name: testName, group: group, items: [] };
        testOrder.push(testKey);
      }
      if (itemCode === '' || itemCode === null || itemCode === undefined) continue;
      testsMap[testKey].items.push({
        code: itemCode,
        isStarred: isStarredRaw === true || String(isStarredRaw).toUpperCase() === 'TRUE',
        currentStock: currentStockRaw === '' ? null : Number(currentStockRaw),
        borrower: borrower || '',
        returner: returner || '',
      });
    }
    testOrder.sort(function (a, b) {
      return Number(testsMap[a].id) - Number(testsMap[b].id);
    });
    var tests = testOrder.map(function (key) { return testsMap[key]; });

    var historyData = historySheet.getDataRange().getValues();
    var history = {};
    for (var h = 1; h < historyData.length; h++) {
      var at = historyData[h][0];
      var hTestId = historyData[h][1];
      var hGroup = historyData[h][2];
      var hItemCode = historyData[h][3];
      var action = historyData[h][4];
      var qty = historyData[h][5];
      var person = historyData[h][6];
      if (hTestId === '' || hItemCode === '') continue;
      var key = hTestId + '::' + hGroup + '::' + hItemCode;
      if (!history[key]) history[key] = [];
      history[key].push({
        action: action,
        qty: Number(qty),
        person: person || '',
        at: at instanceof Date ? at.getTime() : new Date(at).getTime(),
      });
    }

    var borrowersData = borrowersSheet.getDataRange().getValues();
    var borrowers = [];
    for (var b = 1; b < borrowersData.length; b++) {
      if (borrowersData[b][0]) borrowers.push(borrowersData[b][0]);
    }

    return jsonOutput_({
      ok: true,
      generatedAt: new Date().toISOString(),
      borrowers: borrowers,
      tests: tests,
      history: history,
    });
  } catch (err) {
    return jsonOutput_({ ok: false, error: '伺服器錯誤：' + err.message });
  }
}

// POST {WEB_APP_URL}  body(text/plain, JSON字串): { pin, testId, group, code, action:'borrow'|'return', qty, person }
// 前端刻意用 text/plain 送出 JSON，避開瀏覽器對 application/json 的 CORS 預檢請求（Apps Script 不支援 OPTIONS）。
function doPost(e) {
  var payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOutput_({ ok: false, error: '請求格式錯誤' });
  }

  var pin = String(payload.pin || '').trim();
  if (!checkPin_(pin)) return jsonOutput_({ ok: false, error: 'PIN 錯誤' });

  var testId = payload.testId;
  var group = payload.group;
  var code = payload.code;
  var action = payload.action;
  var qty = Number(payload.qty);
  var person = String(payload.person || '').trim();

  if (!testId || !group || !code || (action !== 'borrow' && action !== 'return') || !qty || qty <= 0) {
    return jsonOutput_({ ok: false, error: '參數錯誤' });
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    return jsonOutput_({ ok: false, error: '系統忙碌中，請稍後再試一次' });
  }

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var itemsSheet = ss.getSheetByName(SHEET_ITEMS);
    var data = itemsSheet.getDataRange().getValues();

    var rowIndex = -1;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(testId) && data[i][2] === group && data[i][3] === code) {
        rowIndex = i;
        break;
      }
    }
    if (rowIndex === -1) return jsonOutput_({ ok: false, error: '找不到此品項' });

    var row = data[rowIndex];
    var isStarred = row[4] === true || String(row[4]).toUpperCase() === 'TRUE';
    var currentStock = row[5] === '' ? null : Number(row[5]);
    var borrower = row[6] || '';
    var returner = row[7] || '';

    if (!isStarred && action === 'borrow' && !person) {
      return jsonOutput_({ ok: false, error: '借還品需要輸入借用者姓名' });
    }
    if (action === 'borrow' && currentStock !== null && qty > currentStock) {
      return jsonOutput_({ ok: false, error: '數量超過目前庫存（剩 ' + currentStock + ' 件）' });
    }

    if (action === 'borrow') {
      if (currentStock !== null) currentStock -= qty;
      if (person) borrower = person;
    } else {
      if (currentStock !== null) currentStock += qty;
      if (person) returner = person;
      if (!isStarred) borrower = ''; // 借還品已歸還，清空目前借用中的狀態
    }

    var sheetRow = rowIndex + 1; // data[0] 是標題列，sheet 實際列號 = 陣列索引 + 1
    itemsSheet.getRange(sheetRow, 6, 1, 3).setValues([[currentStock === null ? '' : currentStock, borrower, returner]]);

    var historySheet = ss.getSheetByName(SHEET_HISTORY);
    historySheet.appendRow([new Date(), testId, group, code, action, qty, person]);

    return jsonOutput_({
      ok: true,
      item: { code: code, isStarred: isStarred, currentStock: currentStock, borrower: borrower, returner: returner },
    });
  } catch (err) {
    return jsonOutput_({ ok: false, error: '伺服器錯誤：' + err.message });
  } finally {
    lock.releaseLock();
  }
}

// ---------- 一次性設定：只需要在 Apps Script 編輯器裡執行這兩個函式各一次 ----------

// 建立 Items / History / Borrowers 三個分頁並匯入清冊資料。
// 重新執行只會清空並重新匯入 Items 和 Borrowers，History（借還紀錄）不會被清空。
function setupSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var itemsSheet = ss.getSheetByName(SHEET_ITEMS);
  if (!itemsSheet) itemsSheet = ss.insertSheet(SHEET_ITEMS);
  itemsSheet.clear();
  // group（C欄）和 itemCode（D欄）強制設成文字格式，避免像 "1-10" 這種值被 Google 試算表自動誤判成日期。
  itemsSheet.getRange('C:D').setNumberFormat('@');
  itemsSheet.appendRow(['testId', 'testName', 'group', 'itemCode', 'isStarred', 'currentStock', 'borrower', 'returner']);
  if (SEED_ITEMS.length) {
    itemsSheet.getRange(2, 1, SEED_ITEMS.length, SEED_ITEMS[0].length).setValues(SEED_ITEMS);
  }

  var historySheet = ss.getSheetByName(SHEET_HISTORY);
  if (!historySheet) {
    historySheet = ss.insertSheet(SHEET_HISTORY);
    historySheet.appendRow(['at', 'testId', 'group', 'itemCode', 'action', 'qty', 'person']);
  }
  historySheet.getRange('C:D').setNumberFormat('@'); // 同樣避免之後借還時 group 被誤判成日期

  var borrowersSheet = ss.getSheetByName(SHEET_BORROWERS);
  if (!borrowersSheet) borrowersSheet = ss.insertSheet(SHEET_BORROWERS);
  borrowersSheet.clear();
  borrowersSheet.appendRow(['name']);
  if (SEED_BORROWERS.length) {
    borrowersSheet.getRange(2, 1, SEED_BORROWERS.length, 1).setValues(SEED_BORROWERS.map(function (n) { return [n]; }));
  }

  SpreadsheetApp.flush();
  Logger.log('設定完成！共匯入 ' + SEED_ITEMS.length + ' 筆品項、' + SEED_BORROWERS.length + ' 位借用者。');
}

// 設定通關 PIN。預設是 test1234，想改成自己的密碼就改這裡再重新執行一次。
function setPin() {
  var pin = 'test1234';
  PropertiesService.getScriptProperties().setProperty('PIN', pin);
  Logger.log('PIN 已設定完成。');
}

// ---------- 種子資料（自動產生，請勿手動修改；來源請見 scripts/generate_seed.js） ----------
// SEED_DATA_START
const SEED_ITEMS = [
  [1,"魏氏兒童智力量表第四版(WISC-IV)中文版","1-10","1-1測驗卷*",true,"","",""],
  [1,"魏氏兒童智力量表第四版(WISC-IV)中文版","1-10","1-2紀錄本*",true,"","",""],
  [2,"魏氏兒童智力量表第三版(WISC-III)中文版","1-10","2-1紀錄本*",true,"","",""],
  [2,"魏氏兒童智力量表第三版(WISC-III)中文版","1-10","2-2符號尋照測驗卷*",true,"","",""],
  [2,"魏氏兒童智力量表第三版(WISC-III)中文版","1-10","2-3迷津測驗卷*",true,"","",""],
  [3,"國民中小學學習行為特徵檢核表","1-10","3-1題本",false,"","",""],
  [3,"國民中小學學習行為特徵檢核表","1-10","3-2答案紙*",true,"","",""],
  [3,"國民中小學學習行為特徵檢核表","1-10","3-3初選表*",true,"","",""],
  [3,"國民中小學學習行為特徵檢核表","1-10","3-4指導手冊",false,"","",""],
  [4,"國小注音符號能力診斷測驗","1-10","4-1題本",false,23,"",""],
  [4,"國小注音符號能力診斷測驗","1-10","4-2答案紙*",true,12,"",""],
  [4,"國小注音符號能力診斷測驗","1-10","4-3計分及錯誤類型分析紙*",true,71,"",""],
  [4,"國小注音符號能力診斷測驗","1-10","4-4指導手冊",false,1,"",""],
  [5,"中文閱讀障礙診斷測驗-識字量評估測驗(師大)","1-10","5-1測驗紙 A39*",true,68,"",""],
  [5,"中文閱讀障礙診斷測驗-識字量評估測驗(師大)","1-10","5-2測驗紙 A12*",true,75,"",""],
  [5,"中文閱讀障礙診斷測驗-識字量評估測驗(師大)","1-10","5-3使用手冊",false,0,"",""],
  [6,"國小二~六年級閱讀理解篩選測驗(A)","1-10","6-1二年級*",true,24,"",""],
  [6,"國小二~六年級閱讀理解篩選測驗(A)","1-10","6-2三年級*",true,49,"",""],
  [6,"國小二~六年級閱讀理解篩選測驗(A)","1-10","6-3四年級*",true,47,"",""],
  [6,"國小二~六年級閱讀理解篩選測驗(A)","1-10","6-4五年級*",true,36,"",""],
  [6,"國小二~六年級閱讀理解篩選測驗(A)","1-10","6-5六年級*",true,7,"",""],
  [6,"國小二~六年級閱讀理解篩選測驗(A)","1-10","6-6使用手冊",false,1,"",""],
  [7,"基礎數學概念評量(可影印)","1-10","7-1二年級題本*",true,12,"",""],
  [7,"基礎數學概念評量(可影印)","1-10","7-2三年級題本*",true,9,"",""],
  [7,"基礎數學概念評量(可影印)","1-10","7-3四、五、六年級題本*",true,2,"",""],
  [8,"基礎讀寫字綜合測驗(心理)","1-10","8-1測驗紙(甲)*",true,19,"",""],
  [8,"基礎讀寫字綜合測驗(心理)","1-10","8-2測驗紙(乙)*",true,15,"",""],
  [8,"基礎讀寫字綜合測驗(心理)","1-10","8-3測驗紙(丙)*",true,39,"",""],
  [8,"基礎讀寫字綜合測驗(心理)","1-10","8-4紀錄暨摘要表*",true,19,"",""],
  [8,"基礎讀寫字綜合測驗(心理)","1-10","8-5指導手冊",false,1,"",""],
  [8,"基礎讀寫字綜合測驗(心理)","1-10","8-6標準答案卡",false,1,"",""],
  [8,"基礎讀寫字綜合測驗(心理)","1-10","8-7看字讀音造詞題本",false,5,"",""],
  [8,"基礎讀寫字綜合測驗(心理)","1-10","8-8遠端抄寫掛布(綠)",false,2,"",""],
  [9,"國小學童書寫語言測驗(師大)","1-10","9-1紀錄紙*",true,48,"",""],
  [9,"國小學童書寫語言測驗(師大)","1-10","9-2指導手冊",false,1,"",""],
  [9,"國小學童書寫語言測驗(師大)","1-10","9-3題本",false,102,"",""],
  [10,"情緒障礙量表","1-10","10-1紀錄紙*",true,9,"",""],
  [10,"情緒障礙量表","1-10","10-2指導手冊",false,3,"",""],
  [11,"問題行為篩選量表國小版(師大)","11-20","11-1家長版評量*",true,30,"",""],
  [11,"問題行為篩選量表國小版(師大)","11-20","11-2教師版評量*",true,30,"",""],
  [11,"問題行為篩選量表國小版(師大)","11-20","11-3-1計分卡(家長版):1-3年級【第一部分】",false,2,"王晨安","鄭媛文"],
  [11,"問題行為篩選量表國小版(師大)","11-20","11-3-2計分卡(家長版):1-3年級【第二部分】",false,3,"",""],
  [11,"問題行為篩選量表國小版(師大)","11-20","11-3-3計分卡(家長版):1-3年級【第三部分】",false,3,"",""],
  [11,"問題行為篩選量表國小版(師大)","11-20","11-4-1計分卡(家長版):4-6年級【第一部分】",false,6,"",""],
  [11,"問題行為篩選量表國小版(師大)","11-20","11-4-2計分卡(家長版):4-6年級【第二部分】",false,3,"",""],
  [11,"問題行為篩選量表國小版(師大)","11-20","11-4-3計分卡(家長版):4-6年級【第三部分】",false,3,"",""],
  [11,"問題行為篩選量表國小版(師大)","11-20","11-5-1計分卡(教師版):1-3年級【第一部分】",false,4,"",""],
  [11,"問題行為篩選量表國小版(師大)","11-20","11-5-2計分卡(教師版):1-3年級【第二部分】",false,3,"",""],
  [11,"問題行為篩選量表國小版(師大)","11-20","11-5-3計分卡(教師版):1-3年級【第三部分】",false,3,"",""],
  [11,"問題行為篩選量表國小版(師大)","11-20","11-6-1計分卡(教師版):4-6年級【第一部分】",false,18,"",""],
  [11,"問題行為篩選量表國小版(師大)","11-20","11-6-2計分卡(教師版):4-6年級【第二部分】",false,3,"",""],
  [11,"問題行為篩選量表國小版(師大)","11-20","11-6-3計分卡(教師版):4-6年級【第三部分】",false,3,"",""],
  [11,"問題行為篩選量表國小版(師大)","11-20","11-7指導手冊",false,4,"",""],
  [12,"社會適應檢核表(0022.0243列校內財產)","11-20","12-1指導手冊",false,2,"",""],
  [12,"社會適應檢核表(0022.0243列校內財產)","11-20","12-2檢核表*",true,42,"",""],
  [12,"社會適應檢核表(0022.0243列校內財產)","11-20","12-3指導手冊(第二版)",false,1,"",""],
  [12,"社會適應檢核表(0022.0243列校內財產)","11-20","12-4檢核表(第二版)*",true,2,"",""],
  [13,"中文年級認字量表","11-20","13-1題本",false,1,"",""],
  [13,"中文年級認字量表","11-20","13-2標準答案紙*",true,71,"",""],
  [13,"中文年級認字量表","11-20","13-3題目卡",false,0,"",""],
  [13,"中文年級認字量表","11-20","13-4指導手冊",false,1,"",""],
  [14,"簡易個別智力量表","11-20","14-1紀錄紙*",true,53,"",""],
  [14,"簡易個別智力量表","11-20","14-2測驗工具",false,0,"",""],
  [15,"修訂畢保德圖畫詞彙測驗(甲式)","11-20","15-1測驗題本",false,7,"",""],
  [15,"修訂畢保德圖畫詞彙測驗(甲式)","11-20","15-2個別測驗計分紙*",true,52,"",""],
  [15,"修訂畢保德圖畫詞彙測驗(甲式)","11-20","15-3指導手冊",false,6,"",""],
  [16,"托尼非語文智力測驗","11-20","16-1測驗紙*",true,"","",""],
  [16,"托尼非語文智力測驗","11-20","16-2答案紙(再版)",false,"","",""],
  [16,"托尼非語文智力測驗","11-20","16-3 TONI-2甲式題本",false,"","",""],
  [16,"托尼非語文智力測驗","11-20","16-4指導手冊",false,"","",""],
  [17,"閱讀理解困難篩選測驗(可影印)","11-20","17-1二、三年級*",true,"","",""],
  [17,"閱讀理解困難篩選測驗(可影印)","11-20","17-2四、五、六年級*",true,"","",""],
  [17,"閱讀理解困難篩選測驗(可影印)","11-20","17-3施測說明",false,"","",""],
  [17,"閱讀理解困難篩選測驗(可影印)","11-20","17-4使用手冊",false,"","",""],
  [18,"中文閱讀理解測驗(師大)","11-20","18-1紀錄紙*",true,"","",""],
  [18,"中文閱讀理解測驗(師大)","11-20","18-2指導手冊",false,"","",""],
  [19,"500個常用字","11-20","",false,"","",""],
  [20,"國小兒童書寫語文能力診斷測驗(心理)","11-20","20-1登錄表",false,"","",""],
  [20,"國小兒童書寫語文能力診斷測驗(心理)","11-20","20-2分析表",false,"","",""],
  [20,"國小兒童書寫語文能力診斷測驗(心理)","11-20","20-3彩色刺激圖",false,"","",""],
  [20,"國小兒童書寫語文能力診斷測驗(心理)","11-20","20-4指導手冊",false,"","",""],
  [20,"國小兒童書寫語文能力診斷測驗(心理)","11-20","20-5低年級用稿",false,"","",""],
  [20,"國小兒童書寫語文能力診斷測驗(心理)","11-20","20-6中年級用稿",false,"","",""],
  [20,"國小兒童書寫語文能力診斷測驗(心理)","11-20","20-7高年級用稿",false,"","",""],
  [21,"兒童口語表達能力測驗","21-30","21-1紀錄表*",true,0,"",""],
  [21,"兒童口語表達能力測驗","21-30","21-2指導手冊",false,0,"",""],
  [21,"兒童口語表達能力測驗","21-30","21-3能力測驗本",false,0,"",""],
  [22,"兒童口語理解測驗(師大)","21-30","22-1紀錄本",false,0,"",""],
  [22,"兒童口語理解測驗(師大)","21-30","22-2聽覺記憶圖卡",false,0,"",""],
  [22,"兒童口語理解測驗(師大)","21-30","22-3指導手冊",false,0,"",""],
  [23,"國民小學一至二年級數學診斷測驗(心理)","21-30","23-1甲式題本",false,0,"",""],
  [23,"國民小學一至二年級數學診斷測驗(心理)","21-30","23-2指導手冊",false,0,"",""],
  [24,"國民小學三至四年級數學診斷測驗(心理)","21-30","24-1甲式題本",false,0,"",""],
  [24,"國民小學三至四年級數學診斷測驗(心理)","21-30","24-2指導手冊",false,0,"",""],
  [25,"國民小學五至六年級數學診斷測驗(心理)","21-30","25-1甲式題本",false,0,"",""],
  [25,"國民小學五至六年級數學診斷測驗(心理)","21-30","25-2指導手冊",false,0,"",""],
  [26,"國民小學一至三年級書寫表達/寫作診斷測驗(心理)","21-30","26-1甲式題本",false,0,"",""],
  [26,"國民小學一至三年級書寫表達/寫作診斷測驗(心理)","21-30","26-2指導手冊",false,0,"",""],
  [26,"國民小學一至三年級書寫表達/寫作診斷測驗(心理)","21-30","26-3遠距抄寫題目海報甲式",false,0,"",""],
  [27,"國民小學四至六年級書寫表達/寫作診斷測驗(心理)","21-30","27--1甲式題本",false,"","",""],
  [27,"國民小學四至六年級書寫表達/寫作診斷測驗(心理)","21-30","17-2四、五、六年級*",true,"","",""],
  [27,"國民小學四至六年級書寫表達/寫作診斷測驗(心理)","21-30","17-3施測說明",false,"","",""],
  [18,"中文閱讀理解測驗(師大)","21-30","18-1紀錄紙*",true,"","",""],
  [18,"中文閱讀理解測驗(師大)","21-30","18-2指導手冊",false,"","",""],
  [19,"500個常用字","21-30","",false,"","",""],
  [20,"國小兒童書寫語文能力診斷測驗(心理)","21-30","20-1登錄表",false,"","",""],
  [20,"國小兒童書寫語文能力診斷測驗(心理)","21-30","20-2分析表",false,"","",""],
  [20,"國小兒童書寫語文能力診斷測驗(心理)","21-30","20-3彩色刺激圖",false,"","",""],
  [20,"國小兒童書寫語文能力診斷測驗(心理)","21-30","20-4指導手冊",false,"","",""],
  [20,"國小兒童書寫語文能力診斷測驗(心理)","21-30","20-5低年級用稿",false,"","",""],
  [20,"國小兒童書寫語文能力診斷測驗(心理)","21-30","20-6中年級用稿",false,"","",""],
  [20,"國小兒童書寫語文能力診斷測驗(心理)","21-30","20-7高年級用稿",false,"","",""],
];
const SEED_BORROWERS = ["王晨安","劉義翔","鄭媛文","何聿涵","謝佳妙","黃鈴雅","詹玉菱","查輔安"];
// SEED_DATA_END
