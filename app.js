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
  const LOW_STOCK_DEFAULT = 5;

  /** @type {{generatedAt:string, sourceFile:string, borrowers:string[], tests:Array}} */
  let baseData = { generatedAt: '', sourceFile: '', borrowers: [], tests: [] };

  // 本機模式：本機異動紀錄： { "測驗id::項目code": { returnPurchaseQty, borrowConsumeQty, currentStock, borrower, returner, history: [...] } }
  let adjustments = {};

  // 雲端模式：伺服器回傳的歷史紀錄： { "測驗id::項目code": [ {action, qty, person, at}, ... ] }
  let historyMap = {};

  // 是否顯示「連線設定」按鈕：只有網址帶 ?admin=1 時才顯示，避免老師不小心誤按到連線設定或取消連線。
  let isAdminMode = false;

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
  let activeAction = 'borrow';

  function isServerMode() {
    return !!(connection && connection.url && connection.pin);
  }

  // 有設定雲端網址、但這台裝置還沒成功連線時，畫面要完全鎖住不顯示任何庫存資料。
  // 如果根本沒設定 GAS_URL（config.js 是空的），代表就是要單純本機模式使用，不鎖。
  function isLocked() {
    return !isServerMode() && !!GAS_URL;
  }

  // ---------- 雲端連線設定持久化 ----------
  // 網址只用來開關「⚙️ 連線設定」按鈕：加 ?admin=1 才會顯示，避免老師不小心誤按到取消連線。
  // Apps Script 網址固定在 config.js，不會出現在任何連結裡。
  function applyAdminFlagFromUrl() {
    const params = new URLSearchParams(window.location.search);
    isAdminMode = params.get('admin') === '1';
    if (params.toString()) {
      const url = new URL(window.location.href);
      url.search = '';
      window.history.replaceState({}, '', url.toString());
    }
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
      baseData = window.TEST_TOOL_DATA || { generatedAt: '', sourceFile: '', borrowers: [], tests: [] };
      adjustments = loadAdjustments();
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
    // 連線設定按鈕只在網址帶 ?admin=1 時顯示，避免一般使用者誤按到取消連線。
    document.getElementById('connectionBtn').classList.toggle('hidden', !isAdminMode);
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

  // 借還品專用：把「借出/歸還」事件依時間序配對成一筆筆借出批次（FIFO）。
  // 例：先借1件、再借2件 => 兩筆未歸還批次；之後一次歸還3件 => 依序沖銷，兩筆都標記為已歸還。
  // 歸還時優先沖銷「同一位借用者」自己名下尚未歸還的批次（同樣依借出時間 FIFO）；
  // 只有在歸還者沒填、或名下已無未歸還批次時（例如代還、或忘記填名字），才退回全體 FIFO，
  // 避免 A、B 兩人各自借出未還時，A 拿去還的數量被誤記到 B 更早的那筆借出上。
  function buildLoanCycles(history) {
    const loans = [];
    for (const h of history) {
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

  function renderModalHistory() {
    const wrap = document.getElementById('modalHistory');
    if (!activeItemRef) return;
    const history = getHistory(activeItemRef.testId, activeItemRef.group, activeItemRef.code);
    if (!history.length) {
      wrap.innerHTML = `<h4>異動紀錄</h4><div class="history-empty">尚無異動紀錄</div>`;
      return;
    }
    const isStarred = activeItemRef.isStarred;

    if (isStarred) {
      const rows = history
        .slice()
        .reverse()
        .map((h) => {
          const label = h.action === 'borrow' ? '消耗' : '補充庫存';
          return `<div class="history-item"><span>${label} ${h.qty} 件${h.person ? '（' + escapeHtml(h.person) + '）' : ''}</span><span>${formatTime(h.at)}</span></div>`;
        })
        .join('');
      wrap.innerHTML = `<h4>異動紀錄</h4>${rows}`;
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
    wrap.innerHTML = `<h4>異動紀錄</h4>${rows}`;
  }

  function updateModalFieldsForAction() {
    const isStarred = activeItemRef && activeItemRef.isStarred;
    const personField = document.getElementById('borrowerField');
    const personLabel = personField.querySelector('label');

    document.querySelectorAll('.seg-btn').forEach((btn) => {
      btn.classList.toggle('seg-active', btn.dataset.action === activeAction);
      btn.textContent = isStarred
        ? btn.dataset.action === 'borrow'
          ? '➖ 消耗'
          : '➕ 補充庫存'
        : btn.dataset.action === 'borrow'
        ? '📤 借出'
        : '📥 歸還';
    });

    personLabel.textContent = isStarred
      ? activeAction === 'borrow'
        ? '使用/消耗者（選填）'
        : '補充者（選填）'
      : activeAction === 'borrow'
      ? '借用者'
      : '歸還者';
  }

  function openModal(testId, group, code, quickAction) {
    const found = findTestAndItem(testId, group, code);
    if (!found) return;
    activeItemRef = { testId, group, code, isStarred: found.item.isStarred };
    activeAction = quickAction === 'return' ? 'return' : 'borrow';

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
    activeItemRef = null;
  }

  function actionSuccessMessage(isStarred, action) {
    if (isStarred) return action === 'borrow' ? '已登記消耗' : '已登記補充庫存';
    return action === 'borrow' ? '已登記借出' : '已登記歸還';
  }

  async function submitModal() {
    if (!activeItemRef) return;
    const { testId, group, code, isStarred } = activeItemRef;
    const found = findTestAndItem(testId, group, code);
    if (!found) return;

    const qty = Number(document.getElementById('modalQty').value);
    if (!qty || qty <= 0) {
      showToast('請輸入大於 0 的數量');
      return;
    }
    const person = getPersonValue();
    if (!isStarred && activeAction === 'borrow' && !person) {
      showToast('借還品需要輸入借用者姓名');
      return;
    }

    if (activeAction === 'borrow' && found.item.currentStock !== null && qty > found.item.currentStock) {
      showToast(`數量超過目前庫存（剩 ${found.item.currentStock} 件）`);
      return;
    }

    if (!isStarred && activeAction === 'return') {
      const outstandingQty = getOutstandingQty(found.test, found.item);
      if (outstandingQty !== null && qty > outstandingQty) {
        showToast(`歸還數量超過借出中的數量（借出中共 ${outstandingQty} 件）`);
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
    };
    sessionStorage.setItem(RELOAD_STATE_KEY, JSON.stringify(snapshot));
    setTimeout(() => window.location.reload(), 600);
  }

  // 只有在剛剛送出後觸發的這次重整才會還原（讀取後立刻清掉），
  // 使用者自己手動整理網頁（F5）不會被硬拉回舊的捲動位置。
  function restoreReloadState() {
    const raw = sessionStorage.getItem(RELOAD_STATE_KEY);
    if (!raw) return;
    sessionStorage.removeItem(RELOAD_STATE_KEY);
    let snapshot;
    try {
      snapshot = JSON.parse(raw);
    } catch (e) {
      return;
    }

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

  // 借還品專用：算出目前實際「借出中尚未歸還」的件數，擋掉一次歸還超過這個數量的操作。
  // 若舊資料只知道有人借走、但沒有異動紀錄可還原出確切件數，回傳 null 代表無法判斷、不擋。
  function getOutstandingQty(test, item) {
    const loans = getOutstandingLoans(test.id, test.group, item.code, item);
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
  }

  // ---------- 初始化 ----------
  async function init() {
    bindEvents();
    await loadData();
    restoreReloadState();
    // 還沒連上雲端、且這次瀏覽階段沒按過「稍後再說」的話，跳出 PIN 輸入視窗。
    if (!isServerMode() && GAS_URL && sessionStorage.getItem(PIN_PROMPT_SKIP_KEY) !== '1') {
      openPinPrompt();
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
