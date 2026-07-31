// 讀取「華勛國小測驗工具清冊＆庫存計算＿持續更新.xlsx」，轉換為 data.js 供網頁直接載入使用。
// 來源檔案每次更新後，重新執行： node scripts/parse_excel.js
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const SOURCE_FILE = '華勛國小測驗工具清冊＆庫存計算＿持續更新.xlsx';
const TEST_SHEETS = ['1-10', '11-20', '21-30'];
const BORROWER_SHEET = '工作表2';

const root = path.join(__dirname, '..');
const srcPath = path.join(root, SOURCE_FILE);

function toNumberOrNull(v) {
  if (v === '' || v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function parseSheet(ws, groupLabel) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  // row 0 = 標題/註記, row 1 = 欄位標頭, row 2+ = 資料
  const dataRows = rows.slice(2);

  const tests = [];
  let currentTest = null;

  for (const row of dataRows) {
    const [id, name, item, returnQty, borrowQty, stock, borrower, returner] = row;

    if (id === '' && item === '') continue; // 跳過空白填充列

    if (id !== '') {
      currentTest = {
        id: Number(id),
        name: String(name).trim(),
        group: groupLabel,
        items: [],
      };
      tests.push(currentTest);
    }

    if (!currentTest) continue; // 防呆：資料異常時略過

    const itemCode = String(item).trim();
    if (!itemCode) continue;

    currentTest.items.push({
      code: itemCode,
      isStarred: itemCode.includes('*'),
      returnPurchaseQty: toNumberOrNull(returnQty) ?? 0,
      borrowConsumeQty: toNumberOrNull(borrowQty) ?? 0,
      currentStock: toNumberOrNull(stock),
      borrower: String(borrower || '').trim(),
      returner: String(returner || '').trim(),
    });
  }

  return tests;
}

function main() {
  if (!fs.existsSync(srcPath)) {
    console.error('找不到來源檔案:', srcPath);
    process.exit(1);
  }

  const wb = XLSX.readFile(srcPath);
  let tests = [];
  for (const sheetName of TEST_SHEETS) {
    const ws = wb.Sheets[sheetName];
    if (!ws) {
      console.warn('找不到工作表，略過:', sheetName);
      continue;
    }
    tests = tests.concat(parseSheet(ws, sheetName));
  }

  let borrowers = [];
  const borrowerWs = wb.Sheets[BORROWER_SHEET];
  if (borrowerWs) {
    borrowers = XLSX.utils
      .sheet_to_json(borrowerWs, { header: 1, defval: '' })
      .map((r) => String(r[0] || '').trim())
      .filter(Boolean);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    sourceFile: SOURCE_FILE,
    borrowers,
    tests,
  };

  const outPath = path.join(root, 'data.js');
  const content =
    '// 此檔案由 scripts/parse_excel.js 自動產生，請勿手動修改。\n' +
    '// 若 Excel 來源檔案更新，請重新執行： node scripts/parse_excel.js\n' +
    'window.TEST_TOOL_DATA = ' +
    JSON.stringify(payload, null, 2) +
    ';\n';

  fs.writeFileSync(outPath, content, 'utf-8');

  const itemCount = tests.reduce((sum, t) => sum + t.items.length, 0);
  console.log(`完成！已解析 ${tests.length} 項測驗、共 ${itemCount} 個品項，輸出至 data.js`);
}

main();
