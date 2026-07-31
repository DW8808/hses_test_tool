const puppeteer = require('puppeteer-core');

const SITE = 'https://dw8808.github.io/hses_test_tool/';
const GAS_URL = 'https://script.google.com/macros/s/AKfycbzx9dP7GFYHukni0CzmGxM3MShDcRzrl68nY0E9CEViwrpdqfjWvwazl0hzubVnbpgHog/exec';
const PIN = 'ABC999TEST';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));

  // Simulate a teacher clicking the one-click connect link
  const oneClickUrl = `${SITE}?gasUrl=${encodeURIComponent(GAS_URL)}&pin=${encodeURIComponent(PIN)}`;
  await page.goto(oneClickUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('#statTestCount');
  await new Promise((r) => setTimeout(r, 15000));

  const state = await page.evaluate(() => ({
    testCount: document.getElementById('statTestCount').textContent,
    dataMeta: document.getElementById('dataMeta').textContent,
    connectionBtnHidden: document.getElementById('connectionBtn').classList.contains('hidden'),
    urlAfter: window.location.search,
  }));
  console.log('LIVE_SITE_ONE_CLICK_CONNECT', JSON.stringify(state, null, 1));

  console.log('CONSOLE_ERRORS', JSON.stringify(errors));
  await browser.close();
})().catch((err) => { console.error('TEST_FAILED', err); process.exit(1); });
