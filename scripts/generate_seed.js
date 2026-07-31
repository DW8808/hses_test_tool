// 把 data.js 轉成種子資料，寫回 apps-script/Code.gs 裡 SEED_DATA_START/END 標記之間。
const fs = require('fs');
const path = require('path');

global.window = {};
require(path.join(__dirname, '..', 'data.js'));
const data = window.TEST_TOOL_DATA;

const itemRows = [];
for (const test of data.tests) {
  if (test.items.length === 0) {
    // 保留沒有子項目的測驗本身也在 Items 表佔一列（itemCode 留空），避免統計數字對不上。
    itemRows.push([test.id, test.name, test.group, '', false, '', '', '']);
    continue;
  }
  for (const item of test.items) {
    itemRows.push([
      test.id,
      test.name,
      test.group,
      item.code,
      item.isStarred,
      item.currentStock === null ? '' : item.currentStock,
      item.borrower || '',
      item.returner || '',
    ]);
  }
}

const borrowers = data.borrowers || [];

const seedBlock =
  'const SEED_ITEMS = [\n' +
  itemRows.map((row) => '  ' + JSON.stringify(row) + ',').join('\n') +
  '\n];\n' +
  'const SEED_BORROWERS = ' +
  JSON.stringify(borrowers) +
  ';\n';

const codeGsPath = path.join(__dirname, '..', 'apps-script', 'Code.gs');
const codeGs = fs.readFileSync(codeGsPath, 'utf-8');

const startMarker = '// SEED_DATA_START\n';
const endMarker = '// SEED_DATA_END';
const startIdx = codeGs.indexOf(startMarker);
const endIdx = codeGs.indexOf(endMarker);
if (startIdx === -1 || endIdx === -1) {
  console.error('找不到 Code.gs 裡的 SEED_DATA_START/END 標記，請確認檔案完整。');
  process.exit(1);
}

const newCodeGs = codeGs.slice(0, startIdx + startMarker.length) + seedBlock + codeGs.slice(endIdx);
fs.writeFileSync(codeGsPath, newCodeGs, 'utf-8');

console.log(`已更新 apps-script/Code.gs 的種子資料：${itemRows.length} 筆品項、${borrowers.length} 位借用者。`);
