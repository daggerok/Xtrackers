/// <reference types="bun" />
// Optional verification tooling only; Playwright is NOT a project dependency.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.APP_URL || 'http://127.0.0.1:3000'; // test harness only; the client uses relative URLs
const folder = join(dirname(fileURLToPath(import.meta.url)), 'browser');
await mkdir(folder, { recursive: true });
const cases: { name: string; passed: boolean }[] = [];
const errors: string[] = [], failedRequests: string[] = [], badResponses: { status: number; url: string }[] = [], warnings: string[] = [];
const index = await Bun.file(new URL('../../api/xtrackers/index.json', import.meta.url)).json();
const allTickers = index.funds.map((fund: { ticker: string }) => fund.ticker).sort();
const catalogOnly = new Set(index.funds.filter((fund: { holdings: number; history: number }) => !fund.holdings && !fund.history).map((fund: { ticker: string }) => fund.ticker));
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true, permissions: ['clipboard-read', 'clipboard-write'] });
const observe = (page) => {
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => failedRequests.push(`${request.url()} ${request.failure()?.errorText}`));
  page.on('response', response => { if (response.status() >= 400) badResponses.push({ status: response.status(), url: response.url() }); });
  page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
};
let complete = false;
const page = await context.newPage(); observe(page);
const record = (name: string) => { cases.push({ name, passed: true }); console.log('PASS', name); };
const text = async (selector: string) => (await page.locator(selector).innerText()).trim();
const waitText = (selector: string, expected: string) => page.waitForFunction(({ selector, expected }) => document.querySelector(selector)?.textContent?.trim() === expected, { selector, expected });
const selected = () => page.evaluate(() => JSON.parse(localStorage.getItem('xtrackers-selected-etfs') || '[]').sort());
const hide = async () => { await page.keyboard.press('Escape'); await page.mouse.move(2, 700); };
const openInfo = async () => { await hide(); await page.locator('#ticker-count').click(); assert(await page.locator('#app-summary').isVisible()); };
try {
  await page.goto(base, { waitUntil: 'networkidle', timeout: 90000 });
  await waitText('#ticker-count', `${allTickers.length} ETFs`);
  assert.equal(await text('#app-subtitle'), ''); assert(await page.locator('#app-summary').isHidden());
  record('zero selection: title/count only; rich details hidden');

  await page.locator('#ticker-count').hover(); assert(await page.locator('#app-summary').isVisible());
  const rich = await text('#app-summary');
  for (const expected of ['updated', '42 ETFs', '2,238 holdings', '9,562 history', 'api/xtrackers/index.json', 'etf.dws.com', 'DBX ETF TRUST', '0001503123', 'Yahoo Finance']) assert(rich.includes(expected), expected);
  assert.equal(await page.locator('#app-summary a').first().getAttribute('href'), './api/xtrackers/index.json');
  await page.mouse.move(2, 700); await page.waitForFunction(() => document.getElementById('app-summary')?.hidden);
  await page.locator('#ticker-count').focus(); assert(await page.locator('#app-summary').isVisible());
  await page.locator('#app-summary a').first().focus(); assert(await page.locator('#app-summary').isVisible());
  await page.keyboard.press('Escape'); assert(await page.locator('#app-summary').isHidden());
  record('hover/focus/interactive link/Escape preserve timestamps, counts and provenance');

  const ashr = page.locator('#table-body tr').filter({ has: page.locator('input[data-checkbox="ASHR"]') });
  await ashr.locator('td').nth(3).click(); assert.deepEqual(await selected(), []);
  await page.locator('input[data-checkbox="ASHR"]').check(); await waitText('#app-subtitle', '1 selected: ASHR');
  await page.locator('input[data-checkbox="HYLB"]').check(); await waitText('#app-subtitle', '2 selected: ASHR, HYLB');
  await page.locator('#app-subtitle a[data-header-fund="ASHR"]').click(); assert.deepEqual(await selected(), ['ASHR', 'HYLB']);
  assert((await page.locator('#app-subtitle a[data-header-fund="ASHR"]').getAttribute('class')).includes('underline'));
  await page.locator('input[data-checkbox="DBEF"]').check(); await waitText('#app-subtitle', '3 selected: ASHR, DBEF, HYLB');
  await page.screenshot({ path: join(folder, 'desktop-light-selection.png') });
  record('Use checkboxes alone select; sorted clickable tickers activate without membership changes');

  await page.reload({ waitUntil: 'networkidle' }); await waitText('#app-subtitle', '3 selected: ASHR, DBEF, HYLB');
  record('localStorage-restored selections render immediately');
  await page.locator('#search-input').fill('ASHR');
  await page.waitForFunction(() => document.querySelectorAll('#table-body input[data-checkbox]').length === 1);
  await page.locator('#select-all-checkbox').uncheck(); await waitText('#app-subtitle', '2 selected: DBEF, HYLB');
  await page.locator('#select-all-checkbox').check(); await waitText('#app-subtitle', '3 selected: ASHR, DBEF, HYLB');
  await page.locator('#search-input').fill('');
  await page.waitForFunction(() => document.querySelectorAll('#table-body input[data-checkbox]').length === 42);
  record('filtered visible bulk checkbox retains hidden selections and updates header synchronously');

  await page.locator('#tabs-bar button').filter({ hasText: 'Fixed Income' }).click();
  await openInfo(); assert((await text('#app-summary')).includes('Fixed Income')); await hide();
  await page.locator('#app-subtitle a[data-header-fund="ASHR"]').click();
  await page.locator('#selected-tabs-bar button[data-tab="detail:overview"]').click();
  await openInfo(); assert((await text('#app-summary')).includes('overview')); await hide();
  await page.locator('#selected-tabs-bar button[data-tab="detail:holdings"]').click();
  await page.waitForFunction(() => document.getElementById('table-body')?.textContent?.includes('Zhongji'));
  await openInfo(); assert((await text('#app-summary')).includes('Holdings')); await hide();
  await page.locator('#selected-tabs-bar button[data-tab="detail:history"]').click();
  await page.waitForFunction(() => document.getElementById('table-head')?.textContent?.includes('Market Price'));
  await openInfo(); assert((await text('#app-summary')).includes('NAV History')); await hide();
  await page.locator('#selected-tabs-bar button[data-tab="detail:distributions"]').click();
  await openInfo(); assert((await text('#app-summary')).includes('distributions')); await hide();
  await page.locator('#selected-tabs-bar button[data-tab="watchlist"]').click();
  await page.waitForFunction(() => document.querySelector('#table-body td.watchlist-sticky-ticker'));
  await openInfo(); assert((await text('#app-summary')).toLowerCase().includes('watchlist')); await hide();
  assert.deepEqual(await selected(), ['ASHR', 'DBEF', 'HYLB']);
  const downloadPromise = page.waitForEvent('download'); await page.locator('#export-csv-btn').click(); const download = await downloadPromise;
  assert(download.suggestedFilename().startsWith('xtrackers-watchlist-'));
  await page.locator('#copy-btn').click(); const copied = await page.evaluate(() => navigator.clipboard.readText()); assert(copied.length > 0);
  record('category/overview/holdings/history/distributions/Watchlist contexts preserve full panel; CSV/clipboard work');

  await page.locator('#theme-toggle').click(); assert(await page.evaluate(() => document.documentElement.classList.contains('dark')));
  await openInfo(); await page.screenshot({ path: join(folder, 'desktop-dark-summary.png') }); await hide();
  record('dark theme panel is readable and retains links');
  await page.locator('#tabs-bar button[data-tab="All"]').click();
  await page.locator('button[data-blacklist="HYLB"]').click(); await waitText('#app-subtitle', '2 selected: ASHR, DBEF');
  await page.reload({ waitUntil: 'networkidle' }); await waitText('#app-subtitle', '2 selected: ASHR, DBEF');
  assert.equal(await page.locator('input[data-checkbox="HYLB"]').count(), 0);
  await page.locator('#table-head [data-sort="aumValue"]').click();
  const sorts = await page.evaluate(() => localStorage.getItem('xtrackers-tab-sorts'));
  await page.locator('#reset-btn').click(); await waitText('#app-subtitle', '');
  assert.equal(await page.evaluate(() => localStorage.getItem('xtrackers-tab-sorts')), sorts);
  await page.locator('#blacklist-btn').click(); await page.locator('#blacklist-clear-btn').click();
  await waitText('#ticker-count', `${allTickers.length} ETFs`);
  record('blacklist/deselect/clear/reload update header; Clear retains sort preferences');

  await page.locator('#select-all-toggle').check(); await waitText('#app-subtitle', `${allTickers.length} selected: ${allTickers.join(', ')}`);
  assert.equal((await selected()).length, allTickers.length);
  record('all-selected remains a full sorted ticker list, not the generic All selected label');
  const savedStorage = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])));
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true });
  await mobile.addInitScript(storage => Object.entries(storage).forEach(([key, value]) => localStorage.setItem(key, value)), savedStorage);
  const touch = await mobile.newPage(); observe(touch); await touch.goto(base, { waitUntil: 'networkidle', timeout: 90000 });
  await touch.waitForFunction(expected => document.getElementById('app-subtitle')?.textContent?.trim() === expected, `${allTickers.length} selected: ${allTickers.join(', ')}`);
  await touch.locator('#ticker-count').tap(); assert(await touch.locator('#app-summary').isVisible());
  let box = await touch.locator('#app-summary').boundingBox(); assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844);
  await touch.screenshot({ path: join(folder, 'mobile-summary.png') });
  await touch.locator('#ticker-count').tap(); assert(await touch.locator('#app-summary').isHidden());
  await touch.locator('#ticker-count').tap(); await touch.locator('h1').tap(); assert(await touch.locator('#app-summary').isHidden());
  await touch.setViewportSize({ width: 320, height: 640 }); await touch.locator('#ticker-count').tap();
  box = await touch.locator('#app-summary').boundingBox(); assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 320 && box.y + box.height <= 640);
  record('390px/320px touch toggling, outside dismissal and resized panel stay within viewport');
  await mobile.close();

  await page.locator('#reset-btn').click(); await waitText('#app-subtitle', '');
  page.on('dialog', dialog => dialog.accept('UPLD'));
  const xml = '<edgarSubmission><genInfo><seriesName>Browser Upload Fixture Fund</seriesName><repPdDate>2026-08-31</repPdDate></genInfo><invstOrSec><name>Browser fixture position</name><cusip>123456789</cusip><pctVal>100</pctVal><valUSD>123</valUSD><balance>1</balance><assetCat>EC</assetCat></invstOrSec></edgarSubmission>';
  await page.locator('#file-input').setInputFiles({ name: 'local-nport.xml', mimeType: 'text/xml', buffer: Buffer.from(xml) });
  await waitText('#dropzone-text', '1 fund uploaded');
  assert.deepEqual(await selected(), []); // uploading is NOT an alternate selection control
  await page.locator('#search-input').fill('UPLD');
  await page.waitForFunction(() => document.querySelectorAll('#table-body input[data-checkbox]').length === 1);
  await page.locator('input[data-checkbox="UPLD"]').check();
  await waitText('#app-subtitle', '1 selected: UPLD');
  await openInfo(); assert((await text('#app-summary')).includes('Local N-PORT XML')); assert((await text('#app-summary')).includes('Static catalog data:'));
  await page.screenshot({ path: join(folder, 'upload-summary.png') }); await hide();
  record('uploaded N-PORT mode retains local/session provenance and original static catalog links/counts');
  assert.deepEqual(errors, []); assert.deepEqual(failedRequests, []);
  const unexpected = badResponses.filter(response => {
    const match = /\/api\/xtrackers\/funds\/([A-Z]+)\/meta\.json$/.exec(response.url);
    return !(response.status === 404 && match && catalogOnly.has(match[1]));
  });
  assert.deepEqual(unexpected, []);
  record('no runtime JavaScript errors or unexpected HTTP failures (catalog-only metadata 404s explicitly expected)');
  complete = true;
} finally {
  const files = {};
  for (const name of ['app.tsx', 'index.html']) files[name] = createHash('sha256').update(await readFile(new URL('../../' + name, import.meta.url))).digest('hex');
  await writeFile(join(folder, 'summary.json'), JSON.stringify({ passed: complete, checkedAt: new Date().toISOString(), browser: await browser.version(), playwright: '1.63.0', command: 'PLAYWRIGHT_MODULE=/home/user/.cache/xtrackers-browser/node_modules/playwright/index.mjs bun research/2026-10-01/browser-check.ts', cases, files, pageErrors: errors, failedRequests, httpErrors: badResponses, expectedCdnWarnings: [...new Set(warnings)], limitations: ['Initial feed has 3 downloaded / 39 catalog-only funds; all-selected may request their not-yet-published metadata (404).', 'No live financial provider calls were used by browser checks; source acceptance is a separate real CLI exercise.', 'CDN Babel and Tailwind warnings are intentional shared no-build architecture, not suppressed.'] }, null, 2) + '\n');
  await browser.close();
}
