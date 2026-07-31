(function () {
  'use strict';

  // 關掉瀏覽器內建的「重新整理自動還原捲動位置」，改由我們自己在 restoreReloadState() 精準控制，
  // 避免瀏覽器原生還原（時機不固定，尤其雲端模式資料是非同步載入）跟我們自己的 scrollTo 互相打架。
  if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
  }

  const STORAGE_KEY = 'schoolTestTool.adjustments.v1';
  const CONNECTION_KEY = 'schoolTestTool.connection.v1';
  const PIN_PROMPT_SKIP_KEY = 'schoolTestTool.pinPromptSkipped';
  const RELOAD_STATE_KEY = 'schoolTestTool.reloadState.v1';
  const CUSTOM_KEY = 'schoolTestTool.customTests.v1';
  const ADMIN_MODE_KEY = 'schoolTestTool.adminMode.v1';
  const ADMIN_PIN_KEY = 'schoolTestTool.adminPin.v1';
  const DELETED_ITEMS_KEY = 'schoolTestTool.deletedItems.v1';
  const LOW_STOCK_DEFAULT = 5;

  /** @type {{generatedAt:string, sourceFile:string, borrowers:string[], tests:Array}} */
  let baseData = { generatedAt: '', sourceFile: '', borrowers: [], tests: [] };

  // 本機模式：本機異動紀錄： { "測驗id::項目code": { returnPurchaseQty, borrowConsumeQty, currentStock, borrower, returner, history: [...] } }
  let adjustments = {};

  // 本機模式：管理員手動新增的測驗／項目（雲端模式不用這個，直接寫進 Google 試算表）。
  // key："測驗編號::分頁" -> { id, group, name, items: [...] }。合併進 baseData.tests 時，
  // 對到既有測驗就把 items 併進去，對不到就整筆推一個新測驗進去。
  let customTests = {};

  // 本機模式：管理員刪除掉、或編輯搬走的「原始清冊」品項，用 keyFor(testId,group,code) 記下來，
  // 合併資料時要濾掉，因為 window.TEST_TOOL_DATA 本身是唯讀的、不能真的從裡面刪除。
  let deletedItemKeys = new Set();

  // 雲端模式：伺服器回傳的歷史紀錄： { "測驗id::項目code": [ {action, qty, person, at}, ... ] }
  let historyMap = {};

  // 是否顯示管理員專用功能（連線設定、新增測驗/項目、調整庫存、編輯異動紀錄）。
  // 要輸入管理員密碼驗證通過才會是 true，通過後記在這台裝置的 localStorage 裡，
  // 避免每次整頁重新整理（管理員操作送出後都會整頁重整）就要重新輸入一次。
  let isAdminMode = false;

  // 網址帶 ?admin=1 只是「這次載入要跳出管理員密碼輸入視窗」的訊號，不代表已經通過驗證。
  let pendingAdminPinRequest = false;

  // Google Apps Script 網址固定寫在 config.js 裡（見該檔案），不透過網址參數傳遞。
  const GAS_URL = (window.GAS_CONFIG && window.GAS_CONFIG.url) || '';

  // 雲端連線設定： { url, pin } 或 null（= 本機模式）
  let connection = loadConnection();

  let state = {
    search: '',
    group: 'all',
    lowStockOnly: false,
    starredOnly: false,
    borrowedOnly: false,
    threshold: LOW_STOCK_DEFAULT,
  };

  let activeItemRef = null; // { testId, code, isStarred }
  let activeAction = 'borrow'; // 'borrow' | 'return' | 'adjust'（'adjust' 僅管理員可選）

  // 管理員：原始異動紀錄目前正在編輯/確認刪除中的那一筆（用 at 時間戳記辨識），
  // 只會有一筆同時處在其中一種狀態，切換編輯目標或關掉 Modal 時要記得清空。
  let editingHistoryAt = null;
  let confirmingDeleteAt = null;

  // 管理員：「新增測驗/項目」Modal 目前是不是在編輯既有項目（而不是新增）。
  // null = 新增模式；{ testId, group, code } = 正在編輯這個項目。
  let editingItemRef = null;

  function isServerMode() {
    return !!(connection && connection.url && connection.pin);
  }

  // 有設定雲端網址、但這台裝置還沒成功連線時，畫面要完全鎖住不顯示任何庫存資料。
  // 如果根本沒設定 GAS_URL（config.js 是空的），代表就是要單純本機模式使用，不鎖。
  function isLocked() {
    return !isServerMode() && !!GAS_URL;
  }

  // ---------- 雲端連線設定持久化 ----------
  // 網址只用來開關管理員相關功能：加 ?admin=1 才會跳出管理員密碼輸入視窗，避免老師不小心誤按到。
  // Apps Script 網址固定在 config.js，不會出現在任何連結裡。
  //
  // 密碼驗證通過後才把這台裝置標記成管理員（存 localStorage），之後不用每次都重新輸入；
  // 這一步是必要的：管理員操作（新增測驗/調整庫存/編輯紀錄）送出後都會整頁重新整理，
  // 如果只看網址參數，第一次載入時 history.replaceState 就會把 ?admin=1 從網址列拿掉，
  // 導致下一次重整（也就是每次操作完）就要重新輸入一次密碼。
  function applyAdminFlagFromUrl() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('admin') === '1') {
      pendingAdminPinRequest = true;
    } else if (params.get('admin') === '0') {
      // 退出管理員模式用：這台裝置如果不小心點到 ?admin=1 的連結，用 ?admin=0 開一次就能取消標記。
      localStorage.removeItem(ADMIN_MODE_KEY);
      localStorage.removeItem(ADMIN_PIN_KEY);
    }
    isAdminMode = localStorage.getItem(ADMIN_MODE_KEY) === '1';
    if (params.toString()) {
      const url = new URL(window.location.href);
      url.search = '';
      window.history.replaceState({}, '', url.toString());
    }
  }

  function getAdminPin() {
    return localStorage.getItem(ADMIN_PIN_KEY) || '';
  }

  function loadConnection() {
    applyAdminFlagFromUrl();
    try {
      const raw = localStorage.getItem(CONNECTION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function saveConnection(conn) {
    connection = conn;
    if (conn) localStorage.setItem(CONNECTION_KEY, JSON.stringify(conn));
    else localStorage.removeItem(CONNECTION_KEY);
  }

  // ---------- 本機模式：儲存 / 讀取本機異動 ----------
  function loadAdjustments() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function saveAdjustments() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(adjustments));
  }

  // ---------- 本機模式：管理員新增的測驗／項目 ----------
  function loadCustomTests() {
    try {
      const raw = localStorage.getItem(CUSTOM_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function saveCustomTests() {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(customTests));
  }

  // 把管理員新增的測驗／項目合併進 baseData.tests。呼叫前 baseData.tests（跟每個 test 的
  // items）要先淺拷貝過，不能直接改到 window.TEST_TOOL_DATA 那個唯讀的原始資料物件。
  function applyCustomTests() {
    for (const key in customTests) {
      const custom = customTests[key];
      const existing = baseData.tests.find((t) => t.id === custom.id && t.group === custom.group);
      if (existing) {
        existing.items = existing.items.concat(custom.items);
      } else {
        baseData.tests.push({ id: custom.id, name: custom.name, group: custom.group, items: custom.items.slice() });
      }
    }
    // 跟雲端模式的 doGet() 一樣依編號、分頁排序，避免新增的測驗永遠被塞在清單最後面。
    baseData.tests.sort((a, b) => a.id - b.id || String(a.group).localeCompare(String(b.group)));
  }

  // ---------- 本機模式：管理員刪除／編輯搬移掉的原始清冊品項 ----------
  function loadDeletedItems() {
    try {
      const raw = localStorage.getItem(DELETED_ITEMS_KEY);
      return new Set(raw ? JSON.parse(raw) : []);
    } catch (e) {
      return new Set();
    }
  }

  function saveDeletedItems() {
    localStorage.setItem(DELETED_ITEMS_KEY, JSON.stringify(Array.from(deletedItemKeys)));
  }

  function applyDeletedItems() {
    if (deletedItemKeys.size === 0) return;
    for (const test of baseData.tests) {
      test.items = test.items.filter((it) => !deletedItemKeys.has(keyFor(test.id, test.group, it.code)));
    }
  }

  // 來源清冊裡編號 18/19/20 因為在兩個分頁（11-20、21-30）重複出現，
  // 單靠 testId+code 無法唯一辨識，所以一律加上 group 當第三個鍵值避免兩筆搞混。
  function keyFor(testId, group, code) {
    return testId + '::' + group + '::' + code;
  }

  function getEffectiveItem(test, item) {
    if (isServerMode()) return item; // 伺服器回傳的資料本身就是目前狀態
    const adj = adjustments[keyFor(test.id, test.group, item.code)];
    if (!adj) return item;
    return Object.assign({}, item, {
      returnPurchaseQty: adj.returnPurchaseQty,
      borrowConsumeQty: adj.borrowConsumeQty,
      currentStock: adj.currentStock,
      borrower: adj.borrower,
      returner: adj.returner,
    });
  }

  function getHistory(testId, group, code) {
    if (isServerMode()) return historyMap[keyFor(testId, group, code)] || [];
    const adj = adjustments[keyFor(testId, group, code)];
    return adj && adj.history ? adj.history : [];
  }

  // ---------- 雲端 API ----------
  async function apiGet() {
    const url = connection.url + '?pin=' + encodeURIComponent(connection.pin);
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // 用 text/plain 送 JSON 字串，避開瀏覽器對 application/json 的 CORS 預檢請求（Apps Script 不支援 OPTIONS）。
  async function apiPost(payload) {
    const res = await fetch(connection.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ pin: connection.pin }, payload)),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // ---------- 資料載入 ----------
  // 回傳 true/false 代表這次載入成功與否，讓呼叫端（例如首次輸入 PIN 的畫面）可以判斷要不要繼續往下走。
  async function loadData() {
    if (isServerMode()) {
      try {
        const result = await apiGet();
        if (!result.ok) {
          showToast('連線失敗：' + (result.error || '未知錯誤'));
          return false;
        }
        baseData = {
          generatedAt: result.generatedAt,
          sourceFile: '雲端試算表（多裝置共用）',
          borrowers: result.borrowers || [],
          tests: result.tests || [],
        };
        historyMap = result.history || {};
      } catch (err) {
        showToast('連線失敗，請確認網址與網路連線');
        return false;
      }
    } else {
      const raw = window.TEST_TOOL_DATA || { generatedAt: '', sourceFile: '', borrowers: [], tests: [] };
      // 淺拷貝 tests／每個 test 的 items，因為接下來 applyCustomTests() 會直接改這些陣列，
      // 不能動到 window.TEST_TOOL_DATA 本身（那是唯讀的原始解析資料，重整後應該要維持乾淨）。
      baseData = Object.assign({}, raw, {
        tests: raw.tests.map((t) => Object.assign({}, t, { items: t.items.slice() })),
      });
      adjustments = loadAdjustments();
      customTests = loadCustomTests();
      deletedItemKeys = loadDeletedItems();
      applyCustomTests();
      applyDeletedItems();
    }
    renderBorrowerList();
    render();
    return true;
  }

  // ---------- 計算與彙整 ----------
  function allEffectiveItems() {
    const out = [];
    for (const test of baseData.tests) {
      for (const item of test.items) {
        out.push({ test, item: getEffectiveItem(test, item) });
      }
    }
    return out;
  }

  function computeStats() {
    const all = allEffectiveItems();
    const testCount = baseData.tests.length;
    const itemCount = all.length;
    let totalStock = 0;
    let lowStockCount = 0;
    for (const { item } of all) {
      if (item.currentStock !== null) {
        totalStock += item.currentStock;
        if (item.currentStock <= state.threshold) lowStockCount++;
      }
    }
    return { testCount, itemCount, totalStock, lowStockCount };
  }

  function itemStatus(item) {
    if (item.currentStock === null) return { cls: 'status-unknown', label: '無庫存資料' };
    if (item.currentStock <= state.threshold) return { cls: 'status-low', label: '庫存緊張' };
    return { cls: 'status-ok', label: '庫存充足' };
  }

  function matchesFilters(test, item) {
    if (state.group !== 'all' && test.group !== state.group) return false;
    if (state.lowStockOnly && !(item.currentStock !== null && item.currentStock <= state.threshold)) return false;
    if (state.starredOnly && !item.isStarred) return false;
    if (state.borrowedOnly && !isCurrentlyBorrowed(test, item)) return false;
    if (state.search) {
      const q = state.search.toLowerCase();
      const haystack = (test.name + ' ' + item.code + ' ' + test.id).toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  }

  // ---------- 渲染 ----------
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderPersonInfo(test, item) {
    if (item.isStarred) {
      if (!item.borrower && !item.returner) return '<span class="borrow-info">—</span>';
      const parts = [];
      if (item.borrower) parts.push(`使用：${escapeHtml(item.borrower)}`);
      if (item.returner) parts.push(`補充：${escapeHtml(item.returner)}`);
      return `<span class="borrow-info">${parts.join(' ／ ')}</span>`;
    }

    // 借還品可能同時有多筆未歸還的借出（例如先借1件、又借2件、都還沒還），
    // 用 FIFO 未歸還清單列出所有目前借出中的人，而不是只顯示最後一次借的人。
    const outstanding = getOutstandingLoans(test.id, test.group, item.code, item);
    if (outstanding.length > 0) {
      const names = outstanding.map((l) => {
        const qtyLabel = l.remaining === null ? '' : `(${l.remaining})`;
        return escapeHtml(l.borrower || '未指定') + qtyLabel;
      });
      return `<span class="borrow-info">借出中：${names.join('、')}</span>`;
    }
    if (item.returner) return `<span class="borrow-info">已歸還：${escapeHtml(item.returner)}</span>`;
    return '<span class="borrow-info">—</span>';
  }

  function renderGroupTags() {
    const groups = Array.from(new Set(baseData.tests.map((t) => t.group)));
    const wrap = document.getElementById('groupTags');
    const buttons = ['<span class="filter-label">分頁：</span>'];
    buttons.push(
      `<button class="tag ${state.group === 'all' ? 'tag-active' : ''}" data-group="all">全部</button>`
    );
    for (const g of groups) {
      buttons.push(
        `<button class="tag ${state.group === g ? 'tag-active' : ''}" data-group="${escapeHtml(g)}">${escapeHtml(g)}</button>`
      );
    }
    wrap.innerHTML = buttons.join('');
    wrap.querySelectorAll('.tag').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.group = btn.dataset.group;
        render();
      });
    });
  }

  function renderStats() {
    if (isLocked()) return;
    const s = computeStats();
    document.getElementById('statTestCount').textContent = s.testCount;
    document.getElementById('statItemCount').textContent = s.itemCount;
    document.getElementById('statTotalStock').textContent = s.totalStock;
    document.getElementById('statLowStock').textContent = s.lowStockCount;
  }

  function renderTestList() {
    if (isLocked()) return;
    const container = document.getElementById('testList');
    const resultMeta = document.getElementById('resultMeta');
    const cards = [];
    let visibleItemCount = 0;
    let visibleTestCount = 0;

    for (const test of baseData.tests) {
      const effectiveItems = test.items.map((item) => getEffectiveItem(test, item));

      if (effectiveItems.length === 0) {
        // 來源資料中此測驗尚未登記任何品項（例：編號19「500個常用字」），仍顯示以避免與統計數字不一致。
        const anyItemFilterActive = state.lowStockOnly || state.starredOnly || state.borrowedOnly;
        if (anyItemFilterActive) continue;
        if (state.group !== 'all' && test.group !== state.group) continue;
        if (state.search) {
          const q = state.search.toLowerCase();
          if (!(test.name + ' ' + test.id).toLowerCase().includes(q)) continue;
        }
        visibleTestCount++;
        cards.push(`
          <div class="card test-card">
            <div class="test-card-header">
              <span class="test-id-badge">#${test.id}</span>
              <span class="test-name">${escapeHtml(test.name)}</span>
              <span class="test-group-badge">分頁 ${escapeHtml(test.group)}</span>
            </div>
            <div class="empty-state" style="padding: 0.75rem 0.2rem; text-align: left;">
              ⚠️ 此測驗尚未登記品項資料，請至清冊確認。
            </div>
          </div>
        `);
        continue;
      }

      const visibleItems = effectiveItems.filter((item) => matchesFilters(test, item));
      if (visibleItems.length === 0) continue;
      visibleTestCount++;
      visibleItemCount += visibleItems.length;

      const rows = visibleItems
        .map((item) => {
          const status = itemStatus(item);
          const stockDisplay = item.currentStock === null ? '—' : item.currentStock;

          const borrowInfo = renderPersonInfo(test, item);

          const codeDisplay = escapeHtml(item.code.replace('*', ''));
          const star = item.isStarred ? '<span class="star-mark" title="消耗品：借用數量需累計加總，請見清冊備註">*</span>' : '';

          const actionBtns = item.isStarred
            ? `<button class="icon-btn" title="登記消耗" data-test="${test.id}" data-group="${escapeHtml(test.group)}" data-code="${escapeHtml(item.code)}" data-quick="borrow">耗</button>
               <button class="icon-btn" title="補充庫存" data-test="${test.id}" data-group="${escapeHtml(test.group)}" data-code="${escapeHtml(item.code)}" data-quick="return">補</button>`
            : `<button class="icon-btn" title="借出" data-test="${test.id}" data-group="${escapeHtml(test.group)}" data-code="${escapeHtml(item.code)}" data-quick="borrow">借</button>
               <button class="icon-btn" title="歸還" data-test="${test.id}" data-group="${escapeHtml(test.group)}" data-code="${escapeHtml(item.code)}" data-quick="return">還</button>`;

          return `
            <tr>
              <td class="item-code">${codeDisplay}${star}</td>
              <td>${stockDisplay}</td>
              <td><span class="status-chip ${status.cls}">${status.label}</span></td>
              <td class="borrow-info">${borrowInfo}</td>
              <td>
                <div class="row-actions">${actionBtns}</div>
              </td>
            </tr>`;
        })
        .join('');

      cards.push(`
        <div class="card test-card">
          <div class="test-card-header">
            <span class="test-id-badge">#${test.id}</span>
            <span class="test-name">${escapeHtml(test.name)}</span>
            <span class="test-group-badge">分頁 ${escapeHtml(test.group)}</span>
          </div>
          <div class="item-table-wrap">
            <table class="item-table">
              <thead>
                <tr>
                  <th>項目</th>
                  <th>目前庫存</th>
                  <th>狀態</th>
                  <th>借用狀態</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      `);
    }

    resultMeta.textContent = `顯示 ${visibleTestCount} 項測驗、${visibleItemCount} 個品項`;

    container.innerHTML = cards.length
      ? cards.join('')
      : `<div class="card empty-state">找不到符合條件的測驗工具，請調整搜尋或篩選條件。</div>`;

    container.querySelectorAll('.icon-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        openModal(Number(btn.dataset.test), btn.dataset.group, btn.dataset.code, btn.dataset.quick);
      });
    });
  }

  function renderDataMeta() {
    const el = document.getElementById('dataMeta');
    if (isLocked()) {
      el.textContent = '';
      return;
    }
    const time = baseData.generatedAt ? new Date(baseData.generatedAt).toLocaleString('zh-TW') : '未知';
    if (isServerMode()) {
      el.textContent = `資料來源：${baseData.sourceFile} ｜ 最後同步：${time} ｜ 所有裝置共用同一份資料`;
    } else {
      el.textContent = `資料來源：${baseData.sourceFile || '（尚未載入）'} ｜ 解析時間：${time} ｜ 借還異動僅保存於本機瀏覽器（未連線雲端）`;
    }
  }

  function updateModeUI() {
    const serverMode = isServerMode();
    const locked = isLocked();

    document.getElementById('refreshBtn').classList.toggle('hidden', !serverMode);
    document.getElementById('importFileLabel').classList.toggle('hidden', serverMode || locked);
    // 連線設定、新增測驗/項目按鈕只在網址帶 ?admin=1 時顯示，避免一般使用者誤按到。
    document.getElementById('connectionBtn').classList.toggle('hidden', !isAdminMode);
    document.getElementById('addItemBtn').classList.toggle('hidden', !isAdminMode || locked);
    // 還沒連線（例如剛剛按了「稍後再說」）的話，一般使用者也能看到這顆按鈕，隨時點回去輸入 PIN。
    document.getElementById('connectNowBtn').classList.toggle('hidden', serverMode || !GAS_URL);

    // 設定了雲端網址但還沒連線時，畫面完全鎖住，不顯示任何庫存資料、不能匯出。
    document.getElementById('lockedState').classList.toggle('hidden', !locked);
    document.getElementById('dashboard').classList.toggle('hidden', locked);
    document.getElementById('filterBar').classList.toggle('hidden', locked);
    document.getElementById('resultMeta').classList.toggle('hidden', locked);
    document.getElementById('testList').classList.toggle('hidden', locked);
    document.getElementById('searchWrap').classList.toggle('hidden', locked);
    document.getElementById('exportBtn').classList.toggle('hidden', locked);
    document.getElementById('exportOutstandingBtn').classList.toggle('hidden', locked);
  }

  function render() {
    updateModeUI();
    if (isLocked()) {
      renderDataMeta();
      return;
    }
    renderGroupTags();
    renderStats();
    renderTestList();
    renderDataMeta();
  }

  // ---------- Modal ----------
  function findTestAndItem(testId, group, code) {
    const test = baseData.tests.find((t) => t.id === testId && t.group === group);
    if (!test) return null;
    const item = test.items.find((it) => it.code === code);
    if (!item) return null;
    return { test, item: getEffectiveItem(test, item) };
  }

  const OTHER_OPTION = '__other__';

  function renderBorrowerList() {
    const select = document.getElementById('modalPerson');
    const options = ['<option value="">請選擇人員</option>'];
    for (const b of baseData.borrowers || []) {
      options.push(`<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`);
    }
    options.push(`<option value="${OTHER_OPTION}">其他（自行輸入）...</option>`);
    select.innerHTML = options.join('');
  }

  function setPersonValue(name) {
    const select = document.getElementById('modalPerson');
    const otherInput = document.getElementById('modalPersonOther');
    if (!name) {
      select.value = '';
      otherInput.style.display = 'none';
      otherInput.value = '';
      return;
    }
    const knownNames = Array.from(select.options).map((o) => o.value);
    if (knownNames.includes(name)) {
      select.value = name;
      otherInput.style.display = 'none';
      otherInput.value = '';
    } else {
      select.value = OTHER_OPTION;
      otherInput.style.display = 'block';
      otherInput.value = name;
    }
  }

  function getPersonValue() {
    const select = document.getElementById('modalPerson');
    if (select.value === OTHER_OPTION) {
      return document.getElementById('modalPersonOther').value.trim();
    }
    return select.value.trim();
  }

  function formatTime(at) {
    return new Date(at).toLocaleString('zh-TW');
  }

  // 單一異動紀錄對「目前庫存」造成的影響：+ 表示庫存增加、- 表示減少。
  // borrow/return 的 qty 一定是正數（數量），adjust 的 qty 本身已經是有正負號的異動量。
  // 編輯或刪除某一筆舊紀錄時，用這個函式先反向沖銷舊值、再套用新值，
  // 就不需要知道這個品項「最初」的庫存基準值（雲端試算表其實也沒有保留這個值）。
  function historyEntryDelta(entry) {
    if (entry.action === 'borrow') return -entry.qty;
    if (entry.action === 'return') return entry.qty;
    if (entry.action === 'adjust') return entry.qty;
    return 0;
  }

  // 本機模式：管理員刪除/編輯某一品項 history 陣列裡的一筆舊紀錄，用 at（毫秒時間戳記）辨識是哪一筆
  // ——同一品項不可能有兩筆時間完全相同（毫秒級）的紀錄，不需要額外的 id 欄位。
  function deleteHistoryEntryLocal(testId, group, code, at) {
    const k = keyFor(testId, group, code);
    const current = adjustments[k];
    if (!current) return;
    const idx = current.history.findIndex((h) => h.at === at);
    if (idx === -1) return;
    const removed = current.history[idx];
    if (current.currentStock !== null) current.currentStock -= historyEntryDelta(removed);
    current.history.splice(idx, 1);
    saveAdjustments();
  }

  function editHistoryEntryLocal(testId, group, code, at, newAction, newQty, newPerson) {
    const k = keyFor(testId, group, code);
    const current = adjustments[k];
    if (!current) return;
    const idx = current.history.findIndex((h) => h.at === at);
    if (idx === -1) return;
    const old = current.history[idx];
    if (current.currentStock !== null) current.currentStock -= historyEntryDelta(old);
    const updated = { action: newAction, qty: newQty, person: newPerson, at: old.at };
    if (current.currentStock !== null) current.currentStock += historyEntryDelta(updated);
    current.history[idx] = updated;
    saveAdjustments();
  }

  // 本機模式：把一個項目（連同它的借還異動紀錄）從舊位置搬到新位置。測驗編號/分頁/代碼只要有任何一項
  // 不同，key 就不一樣；「編輯測驗名稱/編號/分頁」跟「編輯項目代碼/消耗品」底層都是靠這個函式做搬移，
  // 不直接改 window.TEST_TOOL_DATA 裡的原始物件（那份要維持唯讀），一律透過 customTests 覆蓋、
  // deletedItemKeys 標記原始清冊裡的舊位置已經搬走。呼叫完要記得自己存檔（saveAdjustments 等）。
  function moveItemLocal(oldTestId, oldGroup, oldCode, newTestId, newGroup, newTestName, newItem) {
    const oldTestKey = oldTestId + '::' + oldGroup;
    const newTestKey = newTestId + '::' + newGroup;
    const oldAdjKey = keyFor(oldTestId, oldGroup, oldCode);
    const newAdjKey = keyFor(newTestId, newGroup, newItem.code);

    if (oldAdjKey !== newAdjKey && adjustments[oldAdjKey]) {
      adjustments[newAdjKey] = adjustments[oldAdjKey];
      delete adjustments[oldAdjKey];
    }

    // 同一個測驗底下可能同時混著「原始清冊項目」跟「之前已經搬進 customTests 的項目」，
    // 不能只看 customTests[oldTestKey] 存不存在，要實際找這個代碼是不是真的在裡面，
    // 不然原始清冊項目會被誤判成「已經在 customTests 裡」，變成沒被標記刪除、留在舊位置。
    const oldCustomIdx = customTests[oldTestKey] ? customTests[oldTestKey].items.findIndex((it) => it.code === oldCode) : -1;
    if (oldCustomIdx !== -1) {
      customTests[oldTestKey].items.splice(oldCustomIdx, 1);
      if (customTests[oldTestKey].items.length === 0) delete customTests[oldTestKey];
    } else {
      deletedItemKeys.add(keyFor(oldTestId, oldGroup, oldCode));
    }

    if (!customTests[newTestKey]) customTests[newTestKey] = { id: newTestId, group: newGroup, name: newTestName, items: [] };
    customTests[newTestKey].name = newTestName;
    customTests[newTestKey].items.push(newItem);
  }

  // 編輯測驗資訊（編號/分頁/名稱）：這三個欄位在資料裡是每個項目都重複存一份，所以要把這個測驗
  // 底下「所有」項目一起搬到新位置，不能只搬正在編輯的那一個，不然其他項目會變成孤兒/屬於舊測驗。
  function editTestLocal(oldTestId, oldGroup, newTestId, newGroup, newTestName) {
    const test = baseData.tests.find((t) => t.id === oldTestId && t.group === oldGroup);
    if (!test) return;
    for (const item of test.items.slice()) {
      moveItemLocal(oldTestId, oldGroup, item.code, newTestId, newGroup, newTestName, item);
    }
    saveAdjustments();
    saveCustomTests();
    saveDeletedItems();
  }

  // 編輯單一項目的代碼／是否為消耗品，測驗本身的編號/分頁/名稱不變。
  function editItemLocal(testId, group, oldCode, newCode, newIsStarred) {
    const test = baseData.tests.find((t) => t.id === testId && t.group === group);
    if (!test) return;
    const item = test.items.find((it) => it.code === oldCode);
    if (!item) return;
    const updatedItem = Object.assign({}, item, { code: newCode, isStarred: newIsStarred });
    moveItemLocal(testId, group, oldCode, testId, group, test.name, updatedItem);
    saveAdjustments();
    saveCustomTests();
    saveDeletedItems();
  }

  function deleteItemLocal(testId, group, code) {
    const testKey = testId + '::' + group;
    if (customTests[testKey]) {
      const idx = customTests[testKey].items.findIndex((it) => it.code === code);
      if (idx !== -1) customTests[testKey].items.splice(idx, 1);
      if (customTests[testKey].items.length === 0) delete customTests[testKey];
      saveCustomTests();
    } else {
      deletedItemKeys.add(keyFor(testId, group, code));
      saveDeletedItems();
    }
    delete adjustments[keyFor(testId, group, code)];
    saveAdjustments();
  }

  // 借還品專用：把「借出/歸還」事件依時間序配對成一筆筆借出批次（FIFO）。
  // 例：先借1件、再借2件 => 兩筆未歸還批次；之後一次歸還3件 => 依序沖銷，兩筆都標記為已歸還。
  // 歸還時優先沖銷「同一位借用者」自己名下尚未歸還的批次（同樣依借出時間 FIFO）；
  // 只有在歸還者沒填、或名下已無未歸還批次時（例如代還、或忘記填名字），才退回全體 FIFO，
  // 避免 A、B 兩人各自借出未還時，A 拿去還的數量被誤記到 B 更早的那筆借出上。
  function buildLoanCycles(history) {
    const loans = [];
    for (const h of history) {
      // 管理員的庫存調整（action:'adjust'）不是一次借出/歸還事件，跳過，
      // 不然會被下面的 else 分支誤當成「歸還」去沖銷別人的借出批次。
      if (h.action !== 'borrow' && h.action !== 'return') continue;
      if (h.action === 'borrow') {
        loans.push({ qty: h.qty, remaining: h.qty, borrower: h.person, borrowedAt: h.at, returnedAt: null, returners: [] });
        continue;
      }
      let remainingToApply = h.qty;
      const ownLoans = h.person ? loans.filter((l) => l.remaining > 0 && l.borrower === h.person) : [];
      const targets = ownLoans.length > 0 ? ownLoans : loans;
      for (const loan of targets) {
        if (remainingToApply <= 0) break;
        if (loan.remaining <= 0) continue;
        const amt = Math.min(remainingToApply, loan.remaining);
        loan.remaining -= amt;
        remainingToApply -= amt;
        if (h.person && !loan.returners.includes(h.person)) loan.returners.push(h.person);
        if (loan.remaining === 0) loan.returnedAt = h.at;
      }
    }
    return loans;
  }

  function historyActionLabel(action) {
    if (action === 'borrow') return '借出/消耗';
    if (action === 'return') return '歸還/補充';
    return '管理員調整';
  }

  // 管理員專用：把「原始」異動紀錄（不分 starred，一筆一筆，不像上面那樣分組彙整）列出來，
  // 每筆都能編輯／刪除。一般使用者看到的分組畫面沒辦法對應回單一一筆，所以另外做這個區塊。
  function renderAdminHistorySection(history) {
    if (!isAdminMode) return '';
    const rows = history
      .slice()
      .reverse()
      .map((h) => {
        if (editingHistoryAt === h.at) {
          return `
            <div class="admin-history-row admin-history-editing" data-at="${h.at}">
              <select class="admin-edit-action">
                <option value="borrow" ${h.action === 'borrow' ? 'selected' : ''}>借出/消耗</option>
                <option value="return" ${h.action === 'return' ? 'selected' : ''}>歸還/補充</option>
                <option value="adjust" ${h.action === 'adjust' ? 'selected' : ''}>管理員調整</option>
              </select>
              <input type="number" class="admin-edit-qty" value="${h.qty}" />
              <input type="text" class="admin-edit-person" value="${escapeHtml(h.person || '')}" placeholder="人員" />
              <div class="admin-history-actions">
                <button class="btn-sm btn-sm-primary admin-save-btn" data-at="${h.at}">儲存</button>
                <button class="btn-sm admin-cancel-edit-btn">取消</button>
              </div>
            </div>`;
        }
        if (confirmingDeleteAt === h.at) {
          return `
            <div class="admin-history-row">
              <span>確定要刪除這筆紀錄嗎？</span>
              <div class="admin-history-actions">
                <button class="btn-sm btn-sm-danger admin-confirm-delete-btn" data-at="${h.at}">是，刪除</button>
                <button class="btn-sm admin-cancel-delete-btn">否</button>
              </div>
            </div>`;
        }
        const qtyLabel = h.action === 'adjust' && h.qty > 0 ? `+${h.qty}` : h.qty;
        return `
          <div class="admin-history-row">
            <span>${historyActionLabel(h.action)} ${qtyLabel} 件${h.person ? '（' + escapeHtml(h.person) + '）' : ''} ／ ${formatTime(h.at)}</span>
            <div class="admin-history-actions">
              <button class="icon-btn-sm admin-edit-btn" data-at="${h.at}" title="編輯">✏️</button>
              <button class="icon-btn-sm admin-delete-btn" data-at="${h.at}" title="刪除">🗑️</button>
            </div>
          </div>`;
      })
      .join('');
    return `<div class="admin-history"><h4>⚙️ 原始異動紀錄（管理員）</h4>${rows}</div>`;
  }

  function bindAdminHistoryEvents() {
    if (!isAdminMode) return;
    const wrap = document.getElementById('modalHistory');
    wrap.querySelectorAll('.admin-edit-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        editingHistoryAt = Number(btn.dataset.at);
        confirmingDeleteAt = null;
        renderModalHistory();
      });
    });
    wrap.querySelectorAll('.admin-delete-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        confirmingDeleteAt = Number(btn.dataset.at);
        editingHistoryAt = null;
        renderModalHistory();
      });
    });
    wrap.querySelectorAll('.admin-cancel-edit-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        editingHistoryAt = null;
        renderModalHistory();
      });
    });
    wrap.querySelectorAll('.admin-cancel-delete-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        confirmingDeleteAt = null;
        renderModalHistory();
      });
    });
    wrap.querySelectorAll('.admin-save-btn').forEach((btn) => {
      btn.addEventListener('click', () => submitHistoryEdit(Number(btn.dataset.at)));
    });
    wrap.querySelectorAll('.admin-confirm-delete-btn').forEach((btn) => {
      btn.addEventListener('click', () => submitHistoryDelete(Number(btn.dataset.at)));
    });
  }

  function renderModalHistory() {
    const wrap = document.getElementById('modalHistory');
    if (!activeItemRef) return;
    const history = getHistory(activeItemRef.testId, activeItemRef.group, activeItemRef.code);
    const adminSection = renderAdminHistorySection(history);
    if (!history.length) {
      wrap.innerHTML = `<h4>異動紀錄</h4><div class="history-empty">尚無異動紀錄</div>${adminSection}`;
      bindAdminHistoryEvents();
      return;
    }
    const isStarred = activeItemRef.isStarred;

    if (isStarred) {
      const rows = history
        .slice()
        .reverse()
        .map((h) => {
          const label = h.action === 'borrow' ? '消耗' : h.action === 'adjust' ? '管理員調整' : '補充庫存';
          const qtyLabel = h.action === 'adjust' ? (h.qty > 0 ? `+${h.qty}` : h.qty) : h.qty;
          return `<div class="history-item"><span>${label} ${qtyLabel} 件${h.person ? '（' + escapeHtml(h.person) + '）' : ''}</span><span>${formatTime(h.at)}</span></div>`;
        })
        .join('');
      wrap.innerHTML = `<h4>異動紀錄</h4>${rows}${adminSection}`;
      bindAdminHistoryEvents();
      return;
    }

    const loans = buildLoanCycles(history).reverse();
    const rows = loans
      .map((loan) => {
        const statusLine =
          loan.remaining === 0
            ? `歸還：${escapeHtml(loan.returners.join('、'))} ／ ${formatTime(loan.returnedAt)}`
            : loan.remaining < loan.qty
            ? `已歸還 ${loan.qty - loan.remaining}／${loan.qty}件，尚未歸還`
            : '尚未歸還';
        return `
          <div class="history-item history-cycle">
            <div class="history-main">借出 ${loan.qty} 件（${escapeHtml(loan.borrower || '未指定')}）</div>
            <div class="history-times">
              <span>借：${formatTime(loan.borrowedAt)}</span>
              <span>${statusLine}</span>
            </div>
          </div>`;
      })
      .join('');
    wrap.innerHTML = `<h4>異動紀錄</h4>${rows}${adminSection}`;
    bindAdminHistoryEvents();
  }

  function updateModalFieldsForAction() {
    const isStarred = activeItemRef && activeItemRef.isStarred;
    const personField = document.getElementById('borrowerField');
    const personLabel = personField.querySelector('label');
    const qtyInput = document.getElementById('modalQty');
    const qtyLabel = qtyInput.closest('.modal-field').querySelector('label');

    document.querySelectorAll('.seg-btn').forEach((btn) => {
      btn.classList.toggle('seg-active', btn.dataset.action === activeAction);
      if (btn.dataset.action === 'adjust') {
        btn.textContent = '🔧 調整庫存';
        return;
      }
      btn.textContent = isStarred
        ? btn.dataset.action === 'borrow'
          ? '➖ 消耗'
          : '➕ 補充庫存'
        : btn.dataset.action === 'borrow'
        ? '📤 借出'
        : '📥 歸還';
    });

    if (activeAction === 'adjust') {
      qtyLabel.textContent = '新的庫存數量';
      personLabel.textContent = '調整者';
      const found = activeItemRef && findTestAndItem(activeItemRef.testId, activeItemRef.group, activeItemRef.code);
      if (found) qtyInput.value = found.item.currentStock === null ? 0 : found.item.currentStock;
      return;
    }

    qtyLabel.textContent = '數量';
    personLabel.textContent = isStarred
      ? activeAction === 'borrow'
        ? '使用/消耗者'
        : '補充者'
      : activeAction === 'borrow'
      ? '借用者'
      : '歸還者';
  }

  function openModal(testId, group, code, quickAction) {
    const found = findTestAndItem(testId, group, code);
    if (!found) return;
    activeItemRef = { testId, group, code, isStarred: found.item.isStarred };
    activeAction = quickAction === 'return' ? 'return' : 'borrow';

    document.getElementById('segAdjustBtn').classList.toggle('hidden', !isAdminMode);
    document.getElementById('editItemBtn').classList.toggle('hidden', !isAdminMode);
    document.getElementById('deleteItemBtn').classList.toggle('hidden', !isAdminMode);
    document.getElementById('deleteItemConfirm').classList.add('hidden');

    document.getElementById('modalTitle').textContent = found.test.name;
    document.getElementById('modalSubtitle').textContent = code.replace('*', '');
    document.getElementById('modalQty').value = 1;
    setPersonValue(activeAction === 'return' ? found.item.borrower : '');
    document.getElementById('modalCurrentStock').textContent =
      found.item.currentStock === null ? '無資料' : found.item.currentStock + ' 件';

    updateModalFieldsForAction();

    renderModalHistory();
    document.getElementById('modalSubmit').disabled = false;
    document.getElementById('modalOverlay').classList.remove('hidden');
  }

  function closeModal() {
    document.getElementById('modalOverlay').classList.add('hidden');
    document.getElementById('deleteItemConfirm').classList.add('hidden');
    activeItemRef = null;
    editingHistoryAt = null;
    confirmingDeleteAt = null;
  }

  function actionSuccessMessage(isStarred, action) {
    if (isStarred) return action === 'borrow' ? '已登記消耗' : '已登記補充庫存';
    return action === 'borrow' ? '已登記借出' : '已登記歸還';
  }

  // 管理員「調整庫存」：欄位裡填的是目標庫存數字本身（可以是 0），不是要加減的量，
  // 所以跳過借出/歸還那些「不可小於等於0」「不可超過庫存」的檢查，另外算出 delta 記進異動紀錄。
  async function submitAdjustStock(found, person) {
    const { testId, group, code } = activeItemRef;
    const newStockRaw = document.getElementById('modalQty').value;
    const newStock = Number(newStockRaw);
    if (newStockRaw === '' || Number.isNaN(newStock) || newStock < 0) {
      showToast('請輸入正確的庫存數量（不能小於 0）');
      return;
    }

    const submitBtn = document.getElementById('modalSubmit');
    submitBtn.disabled = true;

    if (isServerMode()) {
      try {
        const result = await apiPost({ testId, group, code, action: 'adjust', newStock, person, adminPin: getAdminPin() });
        if (!result.ok) {
          showToast(result.error || '調整失敗');
          submitBtn.disabled = false;
          return;
        }
        showToast('已調整庫存');
        closeModal();
        reloadPageAfterSubmit();
      } catch (err) {
        showToast('連線失敗，請確認網路連線');
        submitBtn.disabled = false;
      }
      return;
    }

    // ---------- 本機模式 ----------
    const k = keyFor(testId, group, code);
    const current = adjustments[k] || {
      returnPurchaseQty: found.item.returnPurchaseQty,
      borrowConsumeQty: found.item.borrowConsumeQty,
      currentStock: found.item.currentStock,
      borrower: found.item.borrower,
      returner: found.item.returner,
      history: [],
    };
    const delta = newStock - (current.currentStock ?? 0);
    current.currentStock = newStock;
    current.history.push({ action: 'adjust', qty: delta, person, at: Date.now() });
    adjustments[k] = current;
    saveAdjustments();

    showToast('已調整庫存');
    closeModal();
    reloadPageAfterSubmit();
  }

  async function submitModal() {
    if (!activeItemRef) return;
    const { testId, group, code, isStarred } = activeItemRef;
    const found = findTestAndItem(testId, group, code);
    if (!found) return;

    const person = getPersonValue();
    if (!person) {
      showToast('請選擇或輸入人員姓名');
      return;
    }

    if (activeAction === 'adjust') {
      await submitAdjustStock(found, person);
      return;
    }

    const qty = Number(document.getElementById('modalQty').value);
    if (!qty || qty <= 0) {
      showToast('請輸入大於 0 的數量');
      return;
    }

    if (activeAction === 'borrow' && found.item.currentStock !== null && qty > found.item.currentStock) {
      showToast(`數量超過目前庫存（剩 ${found.item.currentStock} 件）`);
      return;
    }

    if (!isStarred && activeAction === 'return') {
      const personOutstandingQty = getOutstandingQtyForPerson(found.test, found.item, person);
      if (personOutstandingQty === 0) {
        showToast(`${person} 目前沒有借出中的這個項目，不能歸還`);
        return;
      }
      if (personOutstandingQty !== null && qty > personOutstandingQty) {
        showToast(`歸還數量超過 ${person} 借出中的數量（借出中共 ${personOutstandingQty} 件）`);
        return;
      }
    }

    const submitBtn = document.getElementById('modalSubmit');
    submitBtn.disabled = true;

    if (isServerMode()) {
      try {
        const result = await apiPost({ testId, group, code, action: activeAction, qty, person });
        if (!result.ok) {
          showToast(result.error || '送出失敗');
          submitBtn.disabled = false;
          return;
        }
        showToast(actionSuccessMessage(isStarred, activeAction));
        closeModal();
        reloadPageAfterSubmit();
      } catch (err) {
        showToast('連線失敗，請確認網路連線');
        submitBtn.disabled = false;
      }
      return;
    }

    // ---------- 本機模式 ----------
    const k = keyFor(testId, group, code);
    const current = adjustments[k] || {
      returnPurchaseQty: found.item.returnPurchaseQty,
      borrowConsumeQty: found.item.borrowConsumeQty,
      currentStock: found.item.currentStock,
      borrower: found.item.borrower,
      returner: found.item.returner,
      history: [],
    };

    if (activeAction === 'borrow') {
      current.borrowConsumeQty += qty;
      if (current.currentStock !== null) current.currentStock -= qty;
      if (person) current.borrower = person;
    } else {
      current.returnPurchaseQty += qty;
      if (current.currentStock !== null) current.currentStock += qty;
      if (person) current.returner = person;
      if (!isStarred) current.borrower = ''; // 借還品已歸還，清空目前借用中的狀態
    }

    current.history.push({ action: activeAction, qty, person, at: Date.now() });
    adjustments[k] = current;
    saveAdjustments();

    showToast(actionSuccessMessage(isStarred, activeAction));
    closeModal();
    reloadPageAfterSubmit();
  }

  // 管理員：儲存「原始異動紀錄」裡某一筆的編輯。
  async function submitHistoryEdit(at) {
    if (!activeItemRef) return;
    const { testId, group, code } = activeItemRef;
    const wrap = document.getElementById('modalHistory');
    const row = wrap.querySelector(`.admin-history-editing[data-at="${at}"]`);
    if (!row) return;

    const newAction = row.querySelector('.admin-edit-action').value;
    const newQty = Number(row.querySelector('.admin-edit-qty').value);
    const newPerson = row.querySelector('.admin-edit-person').value.trim();

    if (Number.isNaN(newQty)) {
      showToast('數量格式錯誤');
      return;
    }
    if ((newAction === 'borrow' || newAction === 'return') && newQty <= 0) {
      showToast('借出/歸還的數量必須大於 0');
      return;
    }
    if (!newPerson) {
      showToast('請輸入人員姓名');
      return;
    }

    if (isServerMode()) {
      try {
        const result = await apiPost({ testId, group, code, action: 'editHistory', at, newAction, newQty, newPerson, adminPin: getAdminPin() });
        if (!result.ok) {
          showToast(result.error || '更新失敗');
          return;
        }
        showToast('已更新異動紀錄');
        reloadPageAfterSubmit();
      } catch (err) {
        showToast('連線失敗，請確認網路連線');
      }
      return;
    }

    editHistoryEntryLocal(testId, group, code, at, newAction, newQty, newPerson);
    showToast('已更新異動紀錄');
    reloadPageAfterSubmit();
  }

  // 管理員：確認刪除「原始異動紀錄」裡的某一筆。
  async function submitHistoryDelete(at) {
    if (!activeItemRef) return;
    const { testId, group, code } = activeItemRef;

    if (isServerMode()) {
      try {
        const result = await apiPost({ testId, group, code, action: 'editHistory', at, delete: true, adminPin: getAdminPin() });
        if (!result.ok) {
          showToast(result.error || '刪除失敗');
          return;
        }
        showToast('已刪除異動紀錄');
        reloadPageAfterSubmit();
      } catch (err) {
        showToast('連線失敗，請確認網路連線');
      }
      return;
    }

    deleteHistoryEntryLocal(testId, group, code, at);
    showToast('已刪除異動紀錄');
    reloadPageAfterSubmit();
  }

  // 確認送出成功後一律重新整理整頁（而不是只用 JS 重新渲染），確保畫面狀態完全乾淨。
  // 延遲一下才重整，讓上面的成功提示（toast）至少能被看到一瞬間。
  // 重整前先把目前的搜尋／篩選條件和捲動位置存起來，重整後還原，
  // 這樣才不會每次送出都跳回頁面最上方、還要重新搜尋一次剛剛在看的品項。
  function reloadPageAfterSubmit() {
    const snapshot = {
      search: state.search,
      group: state.group,
      lowStockOnly: state.lowStockOnly,
      starredOnly: state.starredOnly,
      borrowedOnly: state.borrowedOnly,
      threshold: state.threshold,
      scrollY: window.scrollY,
      savedAt: Date.now(),
    };
    // 用 localStorage 而不是 sessionStorage：某些瀏覽器環境（例如某些 App 內建瀏覽器）的
    // 「重新整理」實際上是開一個新的瀏覽階段，sessionStorage 會直接消失；localStorage 綁在
    // 網域本身，不受瀏覽階段影響，還原後會自己清掉，不會一直殘留。
    try {
      localStorage.setItem(RELOAD_STATE_KEY, JSON.stringify(snapshot));
      console.log('[schoolTestTool] 已儲存重整前的畫面狀態', snapshot);
    } catch (err) {
      console.error('[schoolTestTool] 儲存重整前的畫面狀態失敗：', err);
    }
    setTimeout(() => window.location.reload(), 600);
  }

  // 只有在剛剛送出後觸發的這次重整才會還原（讀取後立刻清掉），
  // 使用者自己手動整理網頁（F5）不會被硬拉回舊的捲動位置。
  function restoreReloadState() {
    const raw = localStorage.getItem(RELOAD_STATE_KEY);
    if (!raw) {
      console.log('[schoolTestTool] 沒有找到需要還原的畫面狀態（正常的一般載入）');
      return;
    }
    localStorage.removeItem(RELOAD_STATE_KEY);
    let snapshot;
    try {
      snapshot = JSON.parse(raw);
    } catch (e) {
      console.error('[schoolTestTool] 還原畫面狀態的資料解析失敗：', e);
      return;
    }

    // 超過 30 秒還沒被還原掉，代表上次那次重整沒有正常跑完 restoreReloadState()
    // （例如中途又整理了一次網頁），這種舊資料不要拿來套用到現在這次不相關的載入。
    if (typeof snapshot.savedAt === 'number' && Date.now() - snapshot.savedAt > 30000) {
      console.log('[schoolTestTool] 找到的畫面狀態已經過期（超過 30 秒），略過還原');
      return;
    }
    console.log('[schoolTestTool] 還原畫面狀態', snapshot);

    // 還原篩選條件、重新渲染這段包在 try 裡：就算這裡發生非預期錯誤，
    // 下面還原捲動位置的部分還是要執行，不能因為前面出錯就整個放棄捲回原位。
    try {
      state.search = snapshot.search || '';
      state.group = snapshot.group || 'all';
      state.lowStockOnly = !!snapshot.lowStockOnly;
      state.starredOnly = !!snapshot.starredOnly;
      state.borrowedOnly = !!snapshot.borrowedOnly;
      state.threshold = typeof snapshot.threshold === 'number' ? snapshot.threshold : LOW_STOCK_DEFAULT;

      document.getElementById('searchInput').value = state.search;
      document.getElementById('thresholdInput').value = state.threshold;
      document.getElementById('lowStockOnly').checked = state.lowStockOnly;
      document.getElementById('starredOnly').checked = state.starredOnly;
      document.getElementById('borrowedOnly').checked = state.borrowedOnly;

      render();
    } catch (err) {
      console.error('[schoolTestTool] 還原搜尋／篩選條件時發生錯誤：', err);
    }

    if (typeof snapshot.scrollY !== 'number') return;

    // 雲端模式資料是非同步從 Apps Script 抓回來的，畫面撐開的時間點比本機模式晚也較不固定，
    // 只捲一次可能太早（清單那時還沒撐開，捲動會被瀏覽器夾在目前的頁面高度）。
    // 用同一個 rAF 內連續嘗試幾次、間隔拉長，確保清單完全撐開後至少還會再捲一次。
    let attempts = 0;
    function attemptScroll() {
      attempts++;
      window.scrollTo(0, snapshot.scrollY);
      console.log(
        `[schoolTestTool] 第 ${attempts} 次嘗試捲動到 ${snapshot.scrollY}，目前實際位置：${window.scrollY}，頁面總高度：${document.body.scrollHeight}`
      );
      if (attempts < 5) setTimeout(() => requestAnimationFrame(attemptScroll), attempts * 150);
    }
    requestAnimationFrame(attemptScroll);
  }

  function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.add('hidden'), 2200);
  }

  // ---------- 匯出 Excel ----------
  function exportCurrentStock() {
    const rows = [['編號', '測驗名稱', '分頁', '項目', '目前庫存', '借用者', '歸還者']];
    for (const test of baseData.tests) {
      for (const item of test.items) {
        const eff = getEffectiveItem(test, item);
        rows.push([
          test.id,
          test.name,
          test.group,
          item.code,
          eff.currentStock === null ? '' : eff.currentStock,
          eff.borrower,
          eff.returner,
        ]);
      }
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '目前庫存');
    const stamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `華勛國小測驗工具庫存_匯出_${stamp}.xlsx`);
  }

  // 借還品（非消耗品）專用：找出目前尚未歸還的借出批次。
  // 若此品項有異動紀錄，依 FIFO 批次還原「誰借了幾件、何時借的」；
  // 若尚未透過本系統操作過（僅來自來源資料的借用者欄位），則列出目前借用者但無法得知數量／時間。
  function getOutstandingLoans(testId, group, code, effItem) {
    const history = getHistory(testId, group, code);
    if (history.length > 0) {
      return buildLoanCycles(history).filter((l) => l.remaining > 0);
    }
    if (effItem.borrower) {
      return [{ qty: null, remaining: null, borrower: effItem.borrower, borrowedAt: null }];
    }
    return [];
  }

  // 「只顯示已借出」篩選用：消耗品用 item.borrower 當作目前使用者的簡易標記；
  // 借還品不能直接看 item.borrower，因為歸還後（即使只還一部分）該欄位就會被清空，
  // 必須改用 getOutstandingLoans 還原實際尚未歸還的批次，否則部分歸還後這個品項會從清單消失。
  function isCurrentlyBorrowed(test, item) {
    if (item.isStarred) return !!item.borrower;
    return getOutstandingLoans(test.id, test.group, item.code, item).length > 0;
  }

  // 借還品專用：算出「這個人」目前借出中尚未歸還的件數——誰借誰還，沒借的人不能還，
  // 有借的人也不能還超過自己借的數量。回傳 0 代表這個人名下沒有任何未歸還批次（該擋）；
  // 若舊資料只知道有人借走、沒有異動紀錄可還原出確切件數，回傳 null 代表無法判斷數量上限、不擋。
  function getOutstandingQtyForPerson(test, item, person) {
    const loans = getOutstandingLoans(test.id, test.group, item.code, item).filter((l) => l.borrower === person);
    if (loans.length === 0) return 0;
    if (loans.some((l) => l.remaining === null)) return null;
    return loans.reduce((sum, l) => sum + l.remaining, 0);
  }

  function exportOutstandingBorrows() {
    const rows = [['編號', '測驗名稱', '分頁', '項目', '借用者', '借出數量', '借出時間']];
    for (const test of baseData.tests) {
      for (const item of test.items) {
        if (item.isStarred) continue;
        const eff = getEffectiveItem(test, item);
        const loans = getOutstandingLoans(test.id, test.group, item.code, eff);
        for (const loan of loans) {
          rows.push([
            test.id,
            test.name,
            test.group,
            item.code,
            loan.borrower || '',
            loan.remaining === null ? '未記錄（來自原始清冊）' : loan.remaining,
            loan.borrowedAt ? new Date(loan.borrowedAt).toLocaleString('zh-TW') : '未記錄（來自原始清冊）',
          ]);
        }
      }
    }

    if (rows.length === 1) {
      showToast('目前沒有尚未歸還的借還品');
      return;
    }

    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '尚未歸還清單');
    const stamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `華勛國小測驗工具_尚未歸還清單_${stamp}.xlsx`);
  }

  // ---------- 匯入 Excel（僅本機模式：取代目前本機資料） ----------
  function parseWorkbookToData(wb) {
    const TEST_SHEETS = ['1-10', '11-20', '21-30'];
    const BORROWER_SHEET = '工作表2';

    function toNumberOrNull(v) {
      if (v === '' || v === undefined || v === null) return null;
      const n = Number(v);
      return Number.isNaN(n) ? null : n;
    }

    function parseSheet(ws, groupLabel) {
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      const dataRows = rows.slice(2);
      const tests = [];
      let currentTest = null;
      for (const row of dataRows) {
        const [id, name, item, returnQty, borrowQty, stock, borrower, returner] = row;
        if (id === '' && item === '') continue;
        if (id !== '') {
          currentTest = { id: Number(id), name: String(name).trim(), group: groupLabel, items: [] };
          tests.push(currentTest);
        }
        if (!currentTest) continue;
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

    let tests = [];
    for (const sheetName of TEST_SHEETS) {
      const ws = wb.Sheets[sheetName];
      if (ws) tests = tests.concat(parseSheet(ws, sheetName));
    }

    let borrowers = [];
    const borrowerWs = wb.Sheets[BORROWER_SHEET];
    if (borrowerWs) {
      borrowers = XLSX.utils
        .sheet_to_json(borrowerWs, { header: 1, defval: '' })
        .map((r) => String(r[0] || '').trim())
        .filter(Boolean);
    }

    return { generatedAt: new Date().toISOString(), sourceFile: '（本機匯入）', borrowers, tests };
  }

  function handleImportFile(file) {
    if (isServerMode()) {
      showToast('已連線雲端資料庫，請直接在 Google 試算表更新資料');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const parsed = parseWorkbookToData(wb);
        if (!parsed.tests.length) {
          showToast('匯入失敗：找不到符合格式的工作表');
          return;
        }
        baseData = parsed;
        adjustments = {}; // 換了資料來源，本機異動歸零，避免對錯資料
        saveAdjustments();
        customTests = {}; // 舊清冊裡管理員新增的測驗／項目編號可能對不上新清冊，一併歸零
        saveCustomTests();
        deletedItemKeys = new Set();
        saveDeletedItems();
        renderBorrowerList();
        render();
        showToast(`匯入成功，共 ${parsed.tests.length} 項測驗`);
      } catch (err) {
        console.error(err);
        showToast('匯入失敗，請確認檔案格式');
      }
    };
    reader.readAsArrayBuffer(file);
  }

  // ---------- 管理員：新增測驗/項目 Modal ----------
  const GROUP_OTHER_OPTION = '__other_group__';

  function renderAddGroupOptions() {
    const select = document.getElementById('addGroupSelect');
    const groups = Array.from(new Set(baseData.tests.map((t) => t.group)));
    const options = groups.map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`);
    options.push(`<option value="${GROUP_OTHER_OPTION}">其他（自行輸入）...</option>`);
    select.innerHTML = options.join('');
  }

  function getAddGroupValue() {
    const select = document.getElementById('addGroupSelect');
    if (select.value === GROUP_OTHER_OPTION) {
      return document.getElementById('addGroupOther').value.trim();
    }
    return select.value;
  }

  // 測驗編號＋分頁如果對到既有測驗，測驗名稱欄位自動帶入並鎖住，避免同一個測驗被打成兩個不同名字。
  // 用 addTestNameAutoFilled 記住目前欄位裡的值是不是我們自動填的：使用者一邊打編號、一邊還沒打完
  // 分頁的時候，中間可能會短暫對到別的測驗（例如打「31」的過程中先打了「3」對到 #3），
  // 對到又對不到時，只清掉「我們自動填的」內容，不要動到使用者自己手動打的測驗名稱。
  let addTestNameAutoFilled = false;

  function syncAddItemTestName() {
    const testId = Number(document.getElementById('addTestId').value);
    const group = getAddGroupValue();
    const nameInput = document.getElementById('addTestName');
    const existing = testId && group ? baseData.tests.find((t) => t.id === testId && t.group === group) : null;
    if (existing) {
      nameInput.value = existing.name;
      nameInput.readOnly = true;
      addTestNameAutoFilled = true;
    } else {
      nameInput.readOnly = false;
      if (addTestNameAutoFilled) {
        nameInput.value = '';
        addTestNameAutoFilled = false;
      }
    }
  }

  function openAddItemModal() {
    editingItemRef = null;
    renderAddGroupOptions();
    document.getElementById('addItemModalTitle').textContent = '➕ 新增測驗/項目';
    document.getElementById('addItemModalSubtitle').textContent =
      '測驗編號＋分頁如果對到已經存在的測驗，會把這個項目加進該測驗底下；對不到的話會建立一筆全新的測驗。';
    document.getElementById('addItemSubmit').textContent = '確認新增';
    document.getElementById('addItemStockField').classList.remove('hidden');
    document.getElementById('addTestId').value = '';
    document.getElementById('addTestName').value = '';
    document.getElementById('addTestName').readOnly = false;
    addTestNameAutoFilled = false;
    document.getElementById('addItemCode').value = '';
    document.getElementById('addItemStarred').checked = false;
    document.getElementById('addItemStock').value = '';
    document.getElementById('addGroupOther').style.display = 'none';
    document.getElementById('addGroupOther').value = '';
    document.getElementById('addItemModalOverlay').classList.remove('hidden');
  }

  // 管理員：從借還 Modal 點「編輯項目」，用同一個 Modal 表單改成編輯模式，預先帶入目前的值。
  // 庫存不在這裡改（已經有專門的「調整庫存」，會留異動紀錄），所以隱藏庫存欄位。
  function openEditItemModal(testId, group, code) {
    const found = findTestAndItem(testId, group, code);
    if (!found) return;
    editingItemRef = { testId, group, code };
    renderAddGroupOptions();

    document.getElementById('addItemModalTitle').textContent = '✏️ 編輯測驗/項目';
    document.getElementById('addItemModalSubtitle').textContent =
      '修改測驗編號/分頁/名稱，這個測驗底下所有項目都會一起搬過去，請小心使用。';
    document.getElementById('addItemSubmit').textContent = '儲存修改';
    document.getElementById('addItemStockField').classList.add('hidden');

    document.getElementById('addTestId').value = testId;
    const groupSelect = document.getElementById('addGroupSelect');
    const otherInput = document.getElementById('addGroupOther');
    const knownGroups = Array.from(groupSelect.options).map((o) => o.value);
    if (knownGroups.includes(group)) {
      groupSelect.value = group;
      otherInput.style.display = 'none';
      otherInput.value = '';
    } else {
      groupSelect.value = GROUP_OTHER_OPTION;
      otherInput.style.display = 'block';
      otherInput.value = group;
    }
    document.getElementById('addTestName').value = found.test.name;
    document.getElementById('addTestName').readOnly = true;
    addTestNameAutoFilled = true;
    document.getElementById('addItemCode').value = code.replace('*', '');
    document.getElementById('addItemStarred').checked = found.item.isStarred;

    document.getElementById('addItemModalOverlay').classList.remove('hidden');
  }

  function closeAddItemModal() {
    document.getElementById('addItemModalOverlay').classList.add('hidden');
    editingItemRef = null;
  }

  async function submitAddItem() {
    const testIdRaw = document.getElementById('addTestId').value.trim();
    const testId = Number(testIdRaw);
    const group = getAddGroupValue();
    const codeRaw = document.getElementById('addItemCode').value.trim();
    const isStarred = document.getElementById('addItemStarred').checked;

    if (!testIdRaw || !Number.isInteger(testId) || testId <= 0) {
      showToast('請輸入正確的測驗編號（正整數）');
      return;
    }
    if (!group) {
      showToast('請選擇或輸入分頁');
      return;
    }
    if (!codeRaw) {
      showToast('請輸入項目代碼');
      return;
    }

    const existingTest = baseData.tests.find((t) => t.id === testId && t.group === group);
    const testName = existingTest ? existingTest.name : document.getElementById('addTestName').value.trim();
    if (!testName) {
      showToast('請輸入測驗名稱');
      return;
    }

    const code = isStarred ? (codeRaw.endsWith('*') ? codeRaw : codeRaw + '*') : codeRaw.replace(/\*+$/, '');

    if (editingItemRef) {
      await submitEditItem(testId, group, testName, code, isStarred);
      return;
    }

    const stockRaw = document.getElementById('addItemStock').value.trim();
    const currentStock = stockRaw === '' ? null : Number(stockRaw);
    if (stockRaw !== '' && (Number.isNaN(currentStock) || currentStock < 0)) {
      showToast('庫存數量格式錯誤');
      return;
    }
    if (existingTest && existingTest.items.some((it) => it.code === code)) {
      showToast('這個測驗底下已經有相同的項目代碼了');
      return;
    }

    const submitBtn = document.getElementById('addItemSubmit');
    submitBtn.disabled = true;

    if (isServerMode()) {
      try {
        const result = await apiPost({ action: 'addItem', testId, group, testName, code, isStarred, currentStock, adminPin: getAdminPin() });
        if (!result.ok) {
          showToast(result.error || '新增失敗');
          submitBtn.disabled = false;
          return;
        }
        showToast('已新增');
        closeAddItemModal();
        reloadPageAfterSubmit();
      } catch (err) {
        showToast('連線失敗，請確認網路連線');
        submitBtn.disabled = false;
      }
      return;
    }

    // ---------- 本機模式 ----------
    const key = testId + '::' + group;
    const newItem = {
      code,
      isStarred,
      returnPurchaseQty: 0,
      borrowConsumeQty: 0,
      currentStock,
      borrower: '',
      returner: '',
    };
    if (!customTests[key]) customTests[key] = { id: testId, group, name: testName, items: [] };
    customTests[key].items.push(newItem);
    saveCustomTests();

    showToast('已新增');
    closeAddItemModal();
    reloadPageAfterSubmit();
  }

  // 管理員：儲存「編輯測驗/項目」的修改。newTestId/newGroup/newTestName 如果跟原本不同，
  // 這個測驗底下所有項目都會一起搬到新位置（見 editTestLocal/moveItemLocal 的說明）。
  async function submitEditItem(newTestId, newGroup, newTestName, newCode, newIsStarred) {
    const { testId: oldTestId, group: oldGroup, code: oldCode } = editingItemRef;

    const targetTest = baseData.tests.find((t) => t.id === newTestId && t.group === newGroup);
    const isSameSpot = newTestId === oldTestId && newGroup === oldGroup;
    if (targetTest) {
      const collide = targetTest.items.some((it) => it.code === newCode && !(isSameSpot && it.code === oldCode));
      if (collide) {
        showToast('這個測驗底下已經有相同的項目代碼了');
        return;
      }
    }

    const submitBtn = document.getElementById('addItemSubmit');
    submitBtn.disabled = true;

    if (isServerMode()) {
      try {
        const result = await apiPost({
          action: 'editItem',
          testId: oldTestId,
          group: oldGroup,
          code: oldCode,
          newTestId,
          newGroup,
          newTestName,
          newCode,
          newIsStarred,
          adminPin: getAdminPin(),
        });
        if (!result.ok) {
          showToast(result.error || '更新失敗');
          submitBtn.disabled = false;
          return;
        }
        showToast('已更新');
        closeAddItemModal();
        closeModal();
        reloadPageAfterSubmit();
      } catch (err) {
        showToast('連線失敗，請確認網路連線');
        submitBtn.disabled = false;
      }
      return;
    }

    // ---------- 本機模式 ----------
    const oldTest = baseData.tests.find((t) => t.id === oldTestId && t.group === oldGroup);
    const identityChanged = !isSameSpot || (oldTest && oldTest.name !== newTestName);

    if (identityChanged && oldTest) {
      for (const sibling of oldTest.items.slice()) {
        if (sibling.code === oldCode) continue; // 正在編輯的這個項目下面連新代碼/消耗品一起處理
        moveItemLocal(oldTestId, oldGroup, sibling.code, newTestId, newGroup, newTestName, sibling);
      }
    }
    const found = findTestAndItem(oldTestId, oldGroup, oldCode);
    const baseItem = found
      ? found.item
      : { code: oldCode, isStarred: false, currentStock: null, borrower: '', returner: '', returnPurchaseQty: 0, borrowConsumeQty: 0 };
    const updatedItem = Object.assign({}, baseItem, { code: newCode, isStarred: newIsStarred });
    moveItemLocal(oldTestId, oldGroup, oldCode, newTestId, newGroup, newTestName, updatedItem);

    saveAdjustments();
    saveCustomTests();
    saveDeletedItems();

    showToast('已更新');
    closeAddItemModal();
    closeModal();
    reloadPageAfterSubmit();
  }

  // 管理員：刪除目前 Modal 裡這個項目。
  async function submitDeleteItem() {
    if (!activeItemRef) return;
    const { testId, group, code } = activeItemRef;

    if (isServerMode()) {
      try {
        const result = await apiPost({ testId, group, code, action: 'deleteItem', adminPin: getAdminPin() });
        if (!result.ok) {
          showToast(result.error || '刪除失敗');
          return;
        }
        showToast('已刪除項目');
        closeModal();
        reloadPageAfterSubmit();
      } catch (err) {
        showToast('連線失敗，請確認網路連線');
      }
      return;
    }

    deleteItemLocal(testId, group, code);
    showToast('已刪除項目');
    closeModal();
    reloadPageAfterSubmit();
  }

  // ---------- 連線設定 Modal ----------
  function openConnectionModal() {
    document.getElementById('connUrl').value = connection ? connection.url : '';
    document.getElementById('connPin').value = connection ? connection.pin : '';
    document.getElementById('connectionStatus').textContent = isServerMode()
      ? '目前狀態：已連線雲端資料庫'
      : '目前狀態：本機模式（尚未連線雲端）';
    document.getElementById('connectionModalOverlay').classList.remove('hidden');
  }

  function closeConnectionModal() {
    document.getElementById('connectionModalOverlay').classList.add('hidden');
  }

  async function saveConnectionFromModal() {
    const url = document.getElementById('connUrl').value.trim();
    const pin = document.getElementById('connPin').value.trim();
    if (!url || !pin) {
      showToast('請輸入網址與 PIN');
      return;
    }
    saveConnection({ url, pin });
    closeConnectionModal();
    showToast('連線設定已儲存，載入中...');
    await loadData();
  }

  async function disconnectFromModal() {
    saveConnection(null);
    closeConnectionModal();
    showToast('已取消連線，退回本機模式');
    await loadData();
  }

  // ---------- 首次啟用 PIN 輸入（網址固定用 config.js 裡的 GAS_URL，使用者只需要輸入 PIN） ----------
  function openPinPrompt() {
    document.getElementById('pinPromptUrl').value = GAS_URL;
    document.getElementById('pinPromptInput').value = '';
    document.getElementById('pinPromptError').textContent = '';
    document.getElementById('pinPromptOverlay').classList.remove('hidden');
    document.getElementById('pinPromptInput').focus();
  }

  function closePinPrompt() {
    document.getElementById('pinPromptOverlay').classList.add('hidden');
  }

  async function submitPinPrompt() {
    const pin = document.getElementById('pinPromptInput').value.trim();
    if (!pin) {
      document.getElementById('pinPromptError').textContent = '請輸入 PIN';
      return;
    }
    const submitBtn = document.getElementById('pinPromptSubmit');
    submitBtn.disabled = true;
    saveConnection({ url: GAS_URL, pin });
    const ok = await loadData();
    submitBtn.disabled = false;
    if (ok) {
      closePinPrompt();
    } else {
      saveConnection(null); // PIN 錯誤，不要留著壞掉的連線設定
      document.getElementById('pinPromptError').textContent = 'PIN 不正確，請確認後再試一次';
    }
  }

  // ---------- 管理員密碼輸入（跟上面的連線 PIN 是分開的兩組密碼） ----------
  function openAdminPinPrompt() {
    document.getElementById('adminPinInput').value = '';
    document.getElementById('adminPinError').textContent = '';
    document.getElementById('adminPinPromptOverlay').classList.remove('hidden');
    document.getElementById('adminPinInput').focus();
  }

  function closeAdminPinPrompt() {
    document.getElementById('adminPinPromptOverlay').classList.add('hidden');
    pendingAdminPinRequest = false;
  }

  function grantAdminMode(pin) {
    localStorage.setItem(ADMIN_MODE_KEY, '1');
    localStorage.setItem(ADMIN_PIN_KEY, pin);
    isAdminMode = true;
    closeAdminPinPrompt();
    showToast('管理員模式已啟用');
    render();
  }

  async function submitAdminPin() {
    const pin = document.getElementById('adminPinInput').value.trim();
    if (!pin) {
      document.getElementById('adminPinError').textContent = '請輸入密碼';
      return;
    }
    if (!GAS_URL) {
      // 本機／離線模式沒有雲端可以驗證密碼：這種情況就是你自己在本機測試或使用，不需要密碼保護。
      grantAdminMode(pin);
      return;
    }
    const submitBtn = document.getElementById('adminPinSubmit');
    submitBtn.disabled = true;
    try {
      const res = await fetch(GAS_URL + '?action=checkAdmin&adminPin=' + encodeURIComponent(pin));
      const result = await res.json();
      if (result.ok) {
        grantAdminMode(pin);
      } else {
        document.getElementById('adminPinError').textContent = '密碼不正確，請確認後再試一次';
      }
    } catch (err) {
      document.getElementById('adminPinError').textContent = '連線失敗，請確認網路連線';
    }
    submitBtn.disabled = false;
  }

  // ---------- 事件綁定 ----------
  function bindEvents() {
    document.getElementById('searchInput').addEventListener('input', (e) => {
      state.search = e.target.value.trim();
      renderTestList();
    });

    document.getElementById('thresholdInput').addEventListener('input', (e) => {
      const v = Number(e.target.value);
      state.threshold = Number.isNaN(v) ? LOW_STOCK_DEFAULT : v;
      renderStats();
      renderTestList();
    });

    document.getElementById('lowStockOnly').addEventListener('change', (e) => {
      state.lowStockOnly = e.target.checked;
      renderTestList();
    });
    document.getElementById('starredOnly').addEventListener('change', (e) => {
      state.starredOnly = e.target.checked;
      renderTestList();
    });
    document.getElementById('borrowedOnly').addEventListener('change', (e) => {
      state.borrowedOnly = e.target.checked;
      renderTestList();
    });

    document.getElementById('modalClose').addEventListener('click', closeModal);
    document.getElementById('modalOverlay').addEventListener('click', (e) => {
      if (e.target.id === 'modalOverlay') closeModal();
    });
    document.querySelectorAll('.seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeAction = btn.dataset.action;
        if (activeItemRef && !activeItemRef.isStarred) {
          const found = findTestAndItem(activeItemRef.testId, activeItemRef.group, activeItemRef.code);
          setPersonValue(activeAction === 'return' && found ? found.item.borrower : '');
        } else {
          setPersonValue('');
        }
        updateModalFieldsForAction();
      });
    });

    document.getElementById('modalPerson').addEventListener('change', (e) => {
      const otherInput = document.getElementById('modalPersonOther');
      if (e.target.value === OTHER_OPTION) {
        otherInput.style.display = 'block';
        otherInput.focus();
      } else {
        otherInput.style.display = 'none';
        otherInput.value = '';
      }
    });
    document.getElementById('modalSubmit').addEventListener('click', submitModal);

    document.getElementById('editItemBtn').addEventListener('click', () => {
      if (!activeItemRef) return;
      openEditItemModal(activeItemRef.testId, activeItemRef.group, activeItemRef.code);
    });
    document.getElementById('deleteItemBtn').addEventListener('click', () => {
      document.getElementById('deleteItemConfirm').classList.remove('hidden');
    });
    document.getElementById('deleteItemConfirmNo').addEventListener('click', () => {
      document.getElementById('deleteItemConfirm').classList.add('hidden');
    });
    document.getElementById('deleteItemConfirmYes').addEventListener('click', submitDeleteItem);

    document.getElementById('exportBtn').addEventListener('click', exportCurrentStock);
    document.getElementById('exportOutstandingBtn').addEventListener('click', exportOutstandingBorrows);
    document.getElementById('importFile').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) handleImportFile(file);
      e.target.value = '';
    });

    document.getElementById('refreshBtn').addEventListener('click', async () => {
      showToast('重新載入中...');
      await loadData();
    });

    document.getElementById('connectNowBtn').addEventListener('click', openPinPrompt);
    document.getElementById('connectionBtn').addEventListener('click', openConnectionModal);
    document.getElementById('connectionModalClose').addEventListener('click', closeConnectionModal);
    document.getElementById('connectionModalOverlay').addEventListener('click', (e) => {
      if (e.target.id === 'connectionModalOverlay') closeConnectionModal();
    });
    document.getElementById('connectionSaveBtn').addEventListener('click', saveConnectionFromModal);
    document.getElementById('connectionDisconnectBtn').addEventListener('click', disconnectFromModal);

    document.getElementById('pinPromptSubmit').addEventListener('click', submitPinPrompt);
    document.getElementById('pinPromptInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitPinPrompt();
    });
    document.getElementById('pinPromptSkip').addEventListener('click', () => {
      sessionStorage.setItem(PIN_PROMPT_SKIP_KEY, '1');
      closePinPrompt();
    });

    document.getElementById('addItemBtn').addEventListener('click', openAddItemModal);
    document.getElementById('addItemModalClose').addEventListener('click', closeAddItemModal);
    document.getElementById('addItemModalOverlay').addEventListener('click', (e) => {
      if (e.target.id === 'addItemModalOverlay') closeAddItemModal();
    });
    document.getElementById('addItemSubmit').addEventListener('click', submitAddItem);
    document.getElementById('addTestId').addEventListener('input', syncAddItemTestName);
    document.getElementById('addGroupOther').addEventListener('input', syncAddItemTestName);
    document.getElementById('addGroupSelect').addEventListener('change', (e) => {
      const otherInput = document.getElementById('addGroupOther');
      if (e.target.value === GROUP_OTHER_OPTION) {
        otherInput.style.display = 'block';
        otherInput.focus();
      } else {
        otherInput.style.display = 'none';
        otherInput.value = '';
      }
      syncAddItemTestName();
    });

    document.getElementById('adminPinSubmit').addEventListener('click', submitAdminPin);
    document.getElementById('adminPinInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitAdminPin();
    });
    document.getElementById('adminPinPromptClose').addEventListener('click', closeAdminPinPrompt);
  }

  // ---------- 初始化 ----------
  async function init() {
    bindEvents();
    await loadData();
    restoreReloadState();
    // 網址帶 ?admin=1、而且這台裝置還沒通過管理員密碼驗證的話，跳出管理員密碼輸入視窗。
    if (pendingAdminPinRequest && !isAdminMode) {
      openAdminPinPrompt();
    }
    // 還沒連上雲端、且這次瀏覽階段沒按過「稍後再說」的話，跳出 PIN 輸入視窗。
    if (!isServerMode() && GAS_URL && sessionStorage.getItem(PIN_PROMPT_SKIP_KEY) !== '1') {
      openPinPrompt();
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
