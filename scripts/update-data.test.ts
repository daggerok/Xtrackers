/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  annualizedToTotal, totalToAnnualized, indicatedYield, distributionFrequency,
  numberOrNull, toIsoDate, parseSharedStrings, parseWorksheetXml, readZipEntries, parseXlsxSheet,
  parseCatalogRows, parseSitemap, parseFundDetails, parseHoldingsRows, parseDistributionsRows,
  parseNavRows, parseChart, returnHeaderSlot, parseReturnRow, emptyReturns, navTotalReturnDays,
  deriveReturns, historySheet, pageManifest, exportUrl, detailsUrl, yahooSourceUrl,
  type Dividend, type ChartDay,
} from './update-data';

const fixture = (name: string) => Bun.file(new URL(`./fixtures/2026-10-01/${name}`, import.meta.url));
const workbook = async (name: string) => parseXlsxSheet(new Uint8Array(await fixture(name).arrayBuffer()));
const dividend = (exDate: string, amount = 1): Dividend => ({
  exDate, epoch: Date.parse(exDate + 'T00:00:00Z') / 1000, amount, recordDate: null, payDate: null,
});

describe('numeric/date parsing', () => {
  test('preserves zero, negatives, empty/null and currency precision', () => {
    expect([0, '0', '-1.25%', '($1,234.5)', ' $2,500.25 ', null, undefined, '', ' ', '—', '--', 'N/A', 'garbage'].map(numberOrNull))
      .toEqual([0, 0, -1.25, -1234.5, 2500.25, null, null, null, null, null, null, null, null]);
  });
  test('Excel dates and ordinary dates are UTC and validated', () => {
    expect(toIsoDate('46294')).toBe('2026-09-29');
    expect(toIsoDate('09/29/2026')).toBe('2026-09-29');
    expect(toIsoDate('Sep 29, 2026')).toBe('2026-09-29');
    expect(toIsoDate('2026-09-29T00:00:00')).toBe('2026-09-29');
    expect(toIsoDate('2026-02-30')).toBeNull();
    expect(toIsoDate('99/99/2026')).toBeNull();
    expect(toIsoDate('12')).toBeNull();
    expect(toIsoDate('')).toBeNull();
  });
});

describe('zero-dependency OpenXML reader', () => {
  test('shared rich strings, entities, inline strings, sparse columns, cached formula, formula errors', () => {
    const strings = parseSharedStrings('<sst><si><r><t>A &amp; </t></r><r><t>B</t></r></si><si/><si><t>&#x41;&#66;</t></si></sst>');
    expect(strings).toEqual(['A & B', '', 'AB']);
    const rows = parseWorksheetXml('<sheetData><row r="1"><c r="B1" t="s"><v>0</v></c><c r="D1" t="inlineStr"><is><t>001280</t></is></c><c r="F1"><f>1-1</f><v>0</v></c><c r="G1" t="e"><v>#N/A</v></c><c r="AA1"><v>-3</v></c></row><row/></sheetData>', strings);
    expect(rows[0][0]).toBe(''); expect(rows[0][1]).toBe('A & B');
    expect(rows[0][3]).toBe('001280'); expect(rows[0][5]).toBe('0'); expect(rows[0][6]).toBe('');
    expect(rows[0][26]).toBe('-3'); expect(rows[1]).toEqual([]);
  });
  test('rejects non-XLSX and truncated archives instead of pretending empty data', async () => {
    expect(() => readZipEntries(new TextEncoder().encode('<html>403</html>'))).toThrow('ZIP');
    const bytes = new Uint8Array(await fixture('ASHR-securities.xlsx').arrayBuffer());
    expect(() => readZipEntries(bytes.subarray(0, bytes.length - 30))).toThrow('ZIP');
    expect(readZipEntries(bytes).has('xl/sharedStrings.xml')).toBe(true);
  });
});

describe('catalog and typed return mapping', () => {
  test('empty live catalog is correctly recognized; official US sitemap yields exactly 42 funds', async () => {
    expect(parseCatalogRows(await workbook('catalog-empty.xlsx'))).toEqual([]);
    const funds = parseSitemap(await fixture('us-sitemap.xml').text());
    expect(funds).toHaveLength(42);
    expect(funds.map(f => f.ticker)).toContain('ASHR');
    expect(funds.map(f => f.ticker)).toContain('HYLB');
    expect(funds.map(f => f.ticker)).toContain('DBEF');
    expect(funds.every(f => f.name === null && f.terValue === null)).toBe(true);
    expect(new Set(funds.map(f => f.ticker)).size).toBe(42);
  });
  test('does not include European products, promotional routes, remote hosts or malformed tickers', () => {
    const xml = '<urlset><loc>https://etf.dws.com/en-us/ASHR-test-etf/</loc><loc>https://etf.dws.com/en-us/ASHR-test-etf/</loc><loc>https://etf.dws.com/en-gb/IE123-test-etf/</loc><loc>https://evil.test/en-us/ASHR-test-etf/</loc><loc>https://etf.dws.com/en-us/etf-products/</loc></urlset>';
    expect(parseSitemap(xml).map(f => f.ticker)).toEqual(['ASHR']);
  });
  test('all mapped tenors, reordered headers, zero, negative, null, missing and metadata', () => {
    expect(['YTD', '1Y (%)', '3Y', '5Y', '10Y', 'Since inception', 'Since launch', 'asOfDate', '2Y', 'Unknown'].map(h => returnHeaderSlot(h.replace(/\(%\)/g, ''))))
      .toEqual(['ytd', 'yr1', 'yr3', 'yr5', 'yr10', 'sinceInception', 'sinceInception', null, null, null]);
    expect(parseReturnRow(['10Y', 'YTD', '5Y', '1Y', 'Since inception', '3Y', 'Unknown'], [4.2, 0, -5, null, '6%', undefined, 999], '2026-08-31'))
      .toEqual({ asOfDate: '2026-08-31', ytd: 0, yr1: null, yr3: null, yr5: -5, yr10: 4.2, sinceInception: 6 });
    expect(parseReturnRow(['asOfDate', '1Y'], [123, ''], 'unchanged-string').asOfDate).toBe('unchanged-string');
  });
  test('catalog cells use percentages rather than fractions and preserve official fields', () => {
    const funds = parseCatalogRows([
      ['Product List'],
      ['Fund name', 'Ticker', 'Asset class', 'YTD (%)', '1Y (%)', '5Y (%)', '10Y (%)', 'Performance in % since Inception', 'Sub-fund launch', 'Gross expenses (%)', 'Net expenses (%)', 'Total net assets ($)'],
      ['Xtrackers Test ETF', 'TEST', 'Equities', '0', '-4.2', '5', '', '8', '09/01/2015', '0.4', '0.3', '1200000000'],
      ['© DWS'],
    ], '2026-08-31');
    expect(funds).toHaveLength(1);
    expect(funds[0].terValue).toBe(0.4);
    expect(funds[0].aumValue).toBe(1200000000);
    expect(funds[0].officialReturns).toEqual({ ...emptyReturns(), asOfDate: '2026-08-31', ytd: 0, yr1: -4.2, yr5: 5, sinceInception: 8 });
  });
});

describe('official PDP details fixtures', () => {
  test('ASHR: legal name, exact AUM, gross/net costs, NAV, date, frequency, identifiers, yields', async () => {
    const details = parseFundDetails(await fixture('ASHR-meta.json').json(), 'ASHR', 'https://etf.dws.com/en-us/ASHR-harvest-csi-300-china-a-shares-etf/');
    expect(details.name).toBe('Xtrackers Harvest CSI 300 China A-Shares ETF');
    expect(details.aumValue).toBe(1387217695);
    expect(details.terValue).toBe(0.65); expect(details.netTerValue).toBe(0.65);
    expect(details.navValue).toBe(32.56); expect(details.navAsOfDate).toBe('2026-09-29');
    expect(details.secYield).toBe(1.37); expect(details.distributionRate).toBe(2.33);
    expect(details.frequency).toBe('Annual'); expect(details.inceptionDate).toBe('2013-11-06');
    expect(details.cusip).toBe('233051879'); expect(details.isin).toBe('US2330518794');
    expect(details.midpoint).toBe(32.66);
    expect(details.officialReturns).toEqual(emptyReturns()); // Morningstar stars are NOT returns.
  });
  test('fixed income and multi-category currency-hedged paths', async () => {
    const bond = parseFundDetails(await fixture('HYLB-meta.json').json(), 'HYLB', 'https://etf.dws.com/en-us/');
    const hedge = parseFundDetails(await fixture('DBEF-meta.json').json(), 'DBEF', 'https://etf.dws.com/en-us/');
    expect(bond.category).toBe('Fixed Income'); expect(bond.secYield).toBe(8.1);
    expect(hedge.category).toBe('Currency-hedged / Equities / International');
  });
  test('rejects wrong fund and empty payload', async () => {
    expect(() => parseFundDetails({}, 'ASHR', '')).toThrow('PDP');
    expect(() => parseFundDetails(awaitedPayload, 'HYLB', '')).toThrow('PDP');
  });
});
const awaitedPayload = { pdpResult: { pageFrame: { productHeader: { identifier: [{ key: 'Ticker', value: 'ASHR' }] } } } };

describe('official holdings / distributions / daily NAV fixtures', () => {
  test('ASHR: 287 positions, source symbol and leading zeros, identifiers, cash, ~100% weights', async () => {
    const sheet = parseHoldingsRows(await workbook('ASHR-securities.xlsx'), 'ASHR');
    expect(sheet.asOfDate).toBe('2026-09-29'); expect(sheet.rows).toHaveLength(287);
    expect(sheet.rows[0]).toMatchObject({ Name: 'Zhongji Innolight Co Ltd - A', Ticker: '300308', Identifier: 'Y7685V101', Weight: '3.67969882' });
    expect(sheet.rows.find(row => row.Ticker === '001280')?.Identifier).toBe('CNE100007CS8');
    expect(sheet.rows.find(row => row.Name === 'Cash & Cash Equivalents')?.Ticker).toBe('-');
    expect(sheet.rows.reduce((total, row) => total + Number(row.Weight), 0)).toBeCloseTo(100, 5);
  });
  test('reordered holdings headers, negative positions and non-equity symbols', () => {
    const rows = [['Ticker:', 'BOND'], ['As of:', '09/29/2026'],
      ['Name', '$ Market Value', 'Weight %', 'Symbol', 'ISIN', 'CUSIP', 'SEDOL', 'Quantity', 'Asset Class'],
      ['Corporate bond', '200', '2', 'ISSUER', 'US1234567890', '012345678', '', '10', 'Fixed Income'],
      ['FX forward', '-50', '-0.5', 'EURUSD', '', '', '', '-2', 'Forward'],
      ['Subtotal', '', '', '', '', '', '', '', '']];
    const sheet = parseHoldingsRows(rows, 'BOND');
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0].Ticker).toBe('-'); expect(sheet.rows[0].Identifier).toBe('012345678');
    expect(sheet.rows[1].Weight).toBe('-0.5');
    expect(() => parseHoldingsRows(rows, 'WRONG')).toThrow('ticker mismatch');
  });
  test('distributions retain zero events but are chronological and latest positive amount is correct', async () => {
    const events = parseDistributionsRows(await workbook('ASHR-distributions.xlsx'), 'ASHR');
    expect(events).toHaveLength(23);
    expect(events.some(d => d.amount === 0)).toBe(true);
    expect(events.filter(d => d.amount > 0).at(-1)).toMatchObject({ exDate: '2025-12-19', amount: 0.75811, payDate: '2025-12-29' });
    expect(events.map(d => d.epoch)).toEqual(events.map(d => d.epoch).sort((a, b) => a - b));
  });
  test('whole-life daily NAV history includes AUM/shares and is not confused with a growth chart', async () => {
    const nav = parseNavRows(await workbook('ASHR-performance.xlsx'), 'ASHR');
    expect(nav).toHaveLength(3242);
    expect(nav[0]).toMatchObject({ date: '2013-11-05', nav: 25, aum: 108750025, shares: 4350001 });
    expect(nav.at(-1)).toMatchObject({ date: '2026-09-29', nav: 32.56, shares: 42600001 });
    expect(() => parseNavRows([['Ticker:', 'ASHR'], ['Date', 'Cumulative growth'], ['46294', '100']], 'ASHR')).toThrow('headers');
  });
  test('missing headers, empty data and wrong ticker fail explicitly', async () => {
    expect(() => parseDistributionsRows([['Ticker:', 'ASHR']], 'ASHR')).toThrow('headers');
    expect(() => parseNavRows([['Ticker:', 'ASHR'], ['Date', 'NAV'], ['2026-09-29', '']], 'ASHR')).toThrow('no daily');
    expect(() => parseHoldingsRows([['Ticker:', 'ASHR'], ['Name', 'Weight %', '$ Market Value']], 'ASHR')).toThrow('no usable');
  });
});

describe('history and financial metrics', () => {
  test('Yahoo rounds adjusted closes to 2 decimals, retains daily prices, drops null close', () => {
    const result = parseChart({ chart: { result: [{ meta: {}, timestamp: [1767225600, 1767312000], indicators: { quote: [{ close: [12.12345678, null], volume: [0, 12] }], adjclose: [{ adjclose: [11.98765432, 12] }] }, events: { dividends: { first: { date: 1767225600, amount: 0.5 } } } }] } });
    expect(result.days).toEqual([{ date: '2026-01-01', close: 12.123457, adjClose: 11.99, volume: 0 }]);
    expect(result.dividends[0].amount).toBe(0.5);
    expect(yahooSourceUrl('ASHR')).not.toContain('?');
    expect(() => parseChart({ chart: { result: null, error: {} } })).toThrow('empty');
  });
  test('NAV reinvestment is date-matched, does not double count ordinary income/gains', () => {
    const nav = [{ date: '2026-01-01', nav: 10, aum: null, shares: null, dividend: null },
      { date: '2026-01-02', nav: 9, aum: null, shares: null, dividend: 1 },
      { date: '2026-01-03', nav: 9.9, aum: null, shares: null, dividend: null }];
    const days = navTotalReturnDays(nav, [dividend('2026-01-02')]);
    expect(days.map(d => roundForTest(d.adjClose))).toEqual([10, 10, 11]);
  });
  test('TR / CAGR inverses, true zero, negative returns and null', () => {
    expect(annualizedToTotal(0, 3)).toBe(0); expect(annualizedToTotal(10, 3)).toBe(33.1);
    expect(totalToAnnualized(33.1, 3)).toBe(10); expect(annualizedToTotal(-10, 3)).toBe(-27.1);
    expect(annualizedToTotal(null, 3)).toBeNull(); expect(totalToAnnualized(-101, 3)).toBeNull();
    expect(indicatedYield(0.5, 12, 100)).toBe(6); expect(indicatedYield(0, 12, 100)).toBeNull();
    expect(indicatedYield(1, 4, 0)).toBeNull();
  });
  test('frequency prioritizes official value; zero distributions do not create a cadence', () => {
    expect(distributionFrequency('Annual', [])).toEqual({ frequency: 'Annually', paymentsPerYear: 1 });
    expect(distributionFrequency(null, [dividend('2026-01-01', 0)])).toEqual({ frequency: 'None', paymentsPerYear: null });
    expect(distributionFrequency(null, [dividend('2026-01-15'), dividend('2026-02-15'), dividend('2026-03-15')])).toEqual({ frequency: 'Monthly', paymentsPerYear: 12 });
    expect(distributionFrequency(null, [dividend('2026-01-15'), dividend('2026-01-20'), dividend('2026-03-15')]).frequency).toBe('Irregular');
  });
  test('return windows use covered anchors; a young/range-limited fund cannot claim long history or SI', () => {
    const days: ChartDay[] = ['2025-12-31', '2026-01-02', '2026-08-31'].map((date, i) => ({ date, close: 10 + i, adjClose: 10 + i, volume: 0 }));
    const returns = deriveReturns(days, '2026-08-31', '2015-01-01');
    expect(returns.ytd).toBe(20); expect(returns.yr1).toBeNull(); expect(returns.yr3).toBeNull(); expect(returns.sinceInception).toBeNull();
    expect(deriveReturns([], '2026-08-31')).toEqual(emptyReturns());
  });
  test('history never computes premium/discount from unmatched dates', () => {
    const sheet = historySheet([{ date: '2026-09-28', nav: 10, aum: null, shares: null, dividend: null }],
      [{ date: '2026-09-29', close: 11, adjClose: 11, volume: 1 }]);
    expect(sheet.rows).toHaveLength(2); expect(sheet.rows.every(row => row['Premium/Discount'] === '')).toBe(true);
  });
});

describe('page manifests and source URLs', () => {
  test('pagination supports zero, exact page boundaries and stale-page-friendly paths', () => {
    const sheet = { headers: ['x'], asOfDate: null, rows: Array.from({ length: 501 }, () => ({ x: '' })) };
    expect(pageManifest('holdings', sheet, 250, 'official').pages).toEqual(['holdings/001.json', 'holdings/002.json', 'holdings/003.json']);
    expect(pageManifest('history', { ...sheet, rows: [] }, 1000, 'official').pages).toEqual([]);
    expect(() => pageManifest('holdings', sheet, 0, '')).toThrow('pageSize');
  });
  test('verified official namespaces remain case-correct', () => {
    expect(detailsUrl('HYLB')).toBe('https://etf.dws.com/api/pdp/en-us/etfus/HYLB/pdpMetaTagsTealium');
    expect(exportUrl('ASHR', 'Performance')).toBe('https://etf.dws.com/api/pdp/en-us/Export/etf/ASHR/Performance');
    expect(exportUrl('ASHR', 'Securities')).toBe('https://etf.dws.com/api/pdp/en-us/export/etf/ASHR/Securities');
  });
});
function roundForTest(value: number) { return Math.round(value * 1000000) / 1000000; }

// All orchestration tests use an injected literal/dated-fixture fetcher. No live requests.
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import {
  readConfig, CONTROL_DEFAULTS, parseRange, parseAumRange, inRange, fundFilterReasons, mergeDetails,
  outputFundLine, outputConfigEntries, createSerialQueue, createRequestGate, fetchWithRetry, HttpError,
  samePublishedContent, writeJsonIfChanged, selectUpdateBatch, runUpdater, indexRowForCatalog,
  parseNport, parseFundTickerMap, parseCompanyTickerMap, parseNportAccessions, parseEdgarAtomFilings,
  matchesNportFund, fillNportTickers, reinvestmentCoverageStart, reportingPeriodEnds,
  type Fetcher, type FundDetails, type JsonRecord,
} from './update-data';

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'xtrackers-tests-'));
}
async function hashes(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (dir: string, prefix = ''): Promise<void> => {
    for (const file of await readdir(dir, { withFileTypes: true })) {
      const path = prefix + file.name;
      if (file.isDirectory()) await walk(join(dir, file.name), path + '/');
      else files[path] = createHash('sha256').update(await readFile(join(dir, file.name))).digest('hex');
    }
  };
  await walk(root); return files;
}
async function quietRun(root: string, env: Record<string, string> = {}, fetcher: Fetcher = fixtureFetch()) {
  const log = console.log, warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return await runUpdater(readConfig({ TICKERS: 'ASHR DBEF HYLB', REQUEST_SLEEP: '0', MAX_RETRIES: '0', ...env }), { root, fetcher }); }
  finally { console.log = log; console.warn = warn; }
}
async function seed(root: string): Promise<void> {
  const funds = parseSitemap(await fixture('us-sitemap.xml').text()).map(indexRowForCatalog);
  // Delisted/old catalog entries and unselected files are never deleted.
  funds.push({ ...indexRowForCatalog({ ticker: 'RETD', name: 'Retired fixture fund', category: 'Equities', fundPage: 'https://etf.dws.com/en-us/RETD-test-etf/', inceptionDate: null, terValue: null, netTerValue: null, aumValue: null, officialReturns: emptyReturns() }), customSentinel: 'preserve byte-for-byte' });
  await writeJsonIfChanged(join(root, 'index.json'), { provider: 'Xtrackers (DWS)', generatedAt: '2026-09-01', source: {}, counts: { funds: 43, holdings: 0, history: 0 }, funds });
  await mkdir(join(root, 'funds', 'CHPS'), { recursive: true });
  await Bun.write(join(root, 'funds', 'CHPS', 'untouched.json'), '{"sentinel":true}\n');
}
function xmlEscape(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
// A literal stored-entry ZIP fixture builder, intentionally not a runtime dependency.
function literalWorkbook(rows: string[][]): Uint8Array {
  const xml = '<worksheet><sheetData>' + rows.map((row, i) => `<row r="${i + 1}">` + row.map((cell, j) => `<c r="${String.fromCharCode(65 + j)}${i + 1}" t="inlineStr"><is><t>${xmlEscape(cell)}</t></is></c>`).join('') + '</row>').join('') + '</sheetData></worksheet>';
  const content = Buffer.from(xml), name = Buffer.from('xl/worksheets/sheet1.xml');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + content.length, 16);
  return new Uint8Array(Buffer.concat([local, name, content, central, name, end]));
}
function syntheticWorkbook(ticker: string, kind: string): Uint8Array {
  const meta = [['Ticker:', ticker], ['As of:', '09/29/2026']];
  if (kind === 'Securities') return literalWorkbook([...meta, ['Symbol', 'ISIN', 'CUSIP', 'SEDOL', 'Name', 'Weight %', '$ Market Value', '$ Notional Value', 'Quantity', 'Country', 'Sector', 'Asset Class'],
    ['ACME', 'US0000000001', '000000001', '', `${ticker} fixture position`, '99', '100', '', '10', 'US', '', ticker === 'HYLB' ? 'Fixed Income' : 'Equity'],
    ['EURUSD', '', '', '', `${ticker} fixture forward`, '-1', '-1', '10', '-10', '', '', 'Forward']]);
  if (kind === 'Distributions') return literalWorkbook([...meta, ['Ex-Date', 'Record date', 'Pay date', 'US$ / Share'], ['09/01/2026', '09/01/2026', '09/07/2026', '0.2']]);
  return literalWorkbook([...meta, ['Date', 'NAV', 'AUM', 'Outstanding shares', 'Dividends paid'], ['08/31/2026', '35', '100', '10', ''], ['09/01/2026', '34.9', '100', '10', '0.2'], ['09/29/2026', '35.29', '100', '10', '']]);
}
const NPORT = '<edgarSubmission><genInfo><regName>DBX ETF TRUST</regName><regCik>1503123</regCik><seriesName>Xtrackers USD High Yield Corporate Bond ETF</seriesName><seriesId>S000001</seriesId><repPdDate>2026-08-31</repPdDate></genInfo><fundInfo><netAssets>3000000000</netAssets></fundInfo><invstOrSec><name>ACME INC</name><cusip>012345678</cusip><pctVal>0</pctVal><valUSD>123.45</valUSD><balance>10</balance><assetCat>DB</assetCat></invstOrSec><invstOrSec><name>ACME INC</name><cusip>N/A</cusip><identifiers><isin value="US1234567890"/></identifiers><pctVal>-0.5</pctVal><curVal>-2</curVal><balance>-1</balance><assetCat>EC</assetCat></invstOrSec></edgarSubmission>';
function fixtureFetch(denied: string[] = [], secXml: string | null = null): Fetcher {
  return async (url: string) => {
    if (denied.some(pattern => url.includes(pattern))) return new Response('fixture denial', { status: 403 });
    if (url.includes('downloadxls/')) return new Response(await fixture('catalog-empty.xlsx').arrayBuffer());
    if (url.endsWith('/en-us/sitemap.xml')) return new Response(await fixture('us-sitemap.xml').text());
    const ticker = /\/etfus\/([A-Z]+)\/pdpMetaTagsTealium/.exec(url)?.[1];
    if (ticker) return new Response(await fixture(`${ticker}-meta.json`).text(), { headers: { 'Content-Type': 'application/json' } });
    const exportMatch = /\/(?:Export|export)\/etf\/([A-Z]+)\/(\w+)/.exec(url);
    if (exportMatch) {
      const [, t, kind] = exportMatch;
      if (t === 'ASHR') return new Response(await fixture(`ASHR-${kind === 'Securities' ? 'securities' : kind === 'Distributions' ? 'distributions' : 'performance'}.xlsx`).arrayBuffer());
      return new Response(syntheticWorkbook(t, kind));
    }
    if (url.includes('finance.yahoo.com')) return Response.json({ chart: { result: [{ meta: { exchangeName: 'NYSE' }, timestamp: [1790553600, 1790640000], indicators: { quote: [{ close: [35, 35.3], volume: [100, 110] }], adjclose: [{ adjclose: [34.123456, 35.234567] }] } }] } });
    if (secXml && url.endsWith('company_tickers_mf.json')) return Response.json({ fields: ['symbol', 'cik', 'seriesId', 'classId'], data: [['HYLB', 1503123, 'S000001', 'C000001']] });
    if (secXml && url.includes('browse-edgar')) return new Response('<feed><entry><filing-type>NPORT-P</filing-type><accession-number>0001503123-26-000001</accession-number><filing-date>2026-09-01</filing-date><filing-href>https://www.sec.gov/Archives/edgar/data/1503123/000150312326000001/x.html</filing-href></entry></feed>');
    if (secXml && url.endsWith('primary_doc.xml')) return new Response(secXml);
    if (secXml && url.endsWith('company_tickers.json')) return Response.json({ 0: { ticker: 'ACME', title: 'ACME INC' } });
    if (url.includes('sec.gov')) return new Response('fixture SEC denial', { status: 403 });
    throw new Error(`Unexpected offline request: ${url}`);
  };
}

describe('configuration, filters, console contract', () => {
  test('23 canonical controls, conservative defaults and strict invalid-value rejection', () => {
    const config = readConfig({});
    expect(Object.keys(CONTROL_DEFAULTS)).toHaveLength(23);
    expect(config.requestSleepSeconds).toBe(1.5); expect(config.concurrency).toBe(2); expect(config.maxFetches).toBe(0);
    expect(config.holdingsPageSize).toBe(250); expect(config.historyPageSize).toBe(1000); expect(config.maxRetries).toBe(2);
    expect(readConfig({ TICKERS: 'ashr, HYLB; DBEF' }).tickers).toEqual(new Set(['ASHR', 'HYLB', 'DBEF']));
    expect(() => readConfig({ CONCURRENCY: '0' })).toThrow('CONCURRENCY');
    expect(() => readConfig({ MAX_FETCHES: '-1' })).toThrow('MAX_FETCHES');
    expect(() => readConfig({ REQUEST_SLEEP: 'NaN' })).toThrow('REQUEST_SLEEP');
    expect(() => readConfig({ TICKERS: '../ASHR' })).toThrow('TICKERS');
    expect(() => readConfig({ SEC_UA: 'contact\nx-test: bad' })).toThrow('SEC_UA');
    expect(() => readConfig({ VERBOSE: 'maybe' })).toThrow('VERBOSE');
    expect(readConfig({ MAX_RETRIES: '0', REQUEST_SLEEP: '0', VERBOSE: 'yes' }).verbose).toBe(true);
  });
  test('ranges are ANDed; true zero and missing data differ; AUM presets respect boundaries', async () => {
    expect(parseRange('-5:0')).toMatchObject({ min: -5, max: 0 });
    expect(() => parseRange('5')).toThrow('min:max'); expect(() => parseRange('5:4')).toThrow('bounds');
    expect(inRange(0, parseRange(':0'))).toBe(true); expect(inRange(null, parseRange(':0'))).toBe(false);
    expect(parseAumRange('1B:2B')).toMatchObject({ min: 1e9, max: 2e9 });
    expect(inRange(10e6, parseAumRange('nano'))).toBe(false); expect(inRange(10e6, parseAumRange('micro'))).toBe(true);
    expect(inRange(300e6, parseAumRange('small'))).toBe(true); expect(inRange(2e9, parseAumRange('mid'))).toBe(true);
    expect(inRange(10e9, parseAumRange('large'))).toBe(true);
    expect(() => parseAumRange('unknown')).toThrow('AUM');
    const details = parseFundDetails(await fixture('ASHR-meta.json').json(), 'ASHR', 'https://etf.dws.com/en-us/');
    const config = readConfig({ TICKERS: 'ASHR', AUM: '2B:', TER: ':0.5', DIVIDEND_YIELD: '3:', SEC_YIELD: '2:', PERFORMANCE_1Y: '1:', TOTAL_RETURN_3Y: '2:' });
    expect(fundFilterReasons(details, { dividendYield: 2.33, secYield: 1.37, tr1y: 0, tr3y: 0 }, config))
      .toEqual(['AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD', 'PERFORMANCE_1Y', 'TOTAL_RETURN_3Y']);
  });
  test('missing current facts retain published ones; a current real zero wins', async () => {
    const old = parseFundDetails(await fixture('ASHR-meta.json').json(), 'ASHR', 'https://etf.dws.com/en-us/');
    const current: FundDetails = { ...old, aumValue: null, terValue: 0, secYield: null, frequency: null };
    const merged = mergeDetails(current, old);
    expect(merged.aumValue).toBe(old.aumValue); expect(merged.terValue).toBe(0); expect(merged.secYield).toBe(1.37);
  });
  test('console uses shared padding, omits null fields and preserves zero/false', () => {
    const line = outputFundLine(1, 3, 'ASHR', 'updated', { history: 0, holdings: 0, netAssets: null, portId: null, secYield: 0, workplaceRaw: false });
    expect(line).toContain('history=0'); expect(line).toContain('holdings=0'); expect(line).toContain('sec=0'); expect(line).toContain('wp=false');
    expect(line).not.toContain('null'); expect(line).not.toContain('netAssets='); expect(line).not.toContain('port=');
    const entries = outputConfigEntries(readConfig({}));
    expect(entries.slice(0, 3).map(([key]) => key)).toEqual(['MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY']);
    expect(new Set(entries.map(([key]) => key)).size).toBe(23);
    expect(entries.find(([key]) => key === 'VERBOSE')?.[1]).toBe('false');
  });
});

describe('queues, pacing, bounded retries and idempotent writers', () => {
  test('generic serial work preserves its result/rejection, ordering and recovery', async () => {
    const queue = createSerialQueue(), order: string[] = [];
    const first = queue(async () => { order.push('first'); return 123; });
    const second = queue(async () => { order.push('second'); throw new Error('expected'); });
    const third = queue(async () => { order.push('third'); return 'done'; });
    expect(await first).toBe(123); await expect(second).rejects.toThrow('expected'); expect(await third).toBe('done');
    expect(order).toEqual(['first', 'second', 'third']);
  });
  test('two independent request lanes start two requests immediately, not one shared bottleneck', async () => {
    const waits: number[] = [];
    const gate = createRequestGate(1.5, 2, () => 0, async ms => { waits.push(ms); });
    await Promise.all([gate(), gate(), gate(), gate()]);
    expect(waits).toEqual([1500, 1500]);
  });
  test('429/5xx/network errors retry; permanent 403 does not; retry-after is respected', async () => {
    let requests = 0, gates = 0; const waits: number[] = [];
    const cfg = readConfig({ MAX_RETRIES: '2' });
    const response = await fetchWithRetry('https://fixture.test', cfg, async () => { gates++; }, async () => {
      requests++; return requests === 1 ? new Response('throttle', { status: 429, headers: { 'Retry-After': '2' } }) : requests === 2 ? new Response('server', { status: 500 }) : new Response('ok');
    }, {}, async ms => { waits.push(ms); });
    expect(response.status).toBe(200); expect(requests).toBe(3); expect(gates).toBe(3); expect(waits).toEqual([2000, 2000]);
    requests = 0;
    await expect(fetchWithRetry('https://fixture.test', cfg, async () => {}, async () => { requests++; return new Response('blocked', { status: 403 }); }, {}, async () => {})).rejects.toBeInstanceOf(HttpError);
    expect(requests).toBe(1);
    requests = 0;
    await fetchWithRetry('https://fixture.test', cfg, async () => {}, async () => { if (++requests === 1) throw new Error('network'); return new Response('ok'); }, {}, async () => {});
    expect(requests).toBe(2);
  });
  test('recursive run timestamps never cause byte churn; material changes do', async () => {
    const root = await tempRoot(), path = join(root, 'nested.json');
    try {
      const first = { generatedAt: 'one', source: { catalogReadAt: 'one', rows: [{ generatedAt: 'one', value: 0 }] } };
      const second = { source: { rows: [{ value: 0, generatedAt: 'two' }], catalogReadAt: 'two' }, generatedAt: 'two' };
      expect(samePublishedContent(JSON.stringify(first), second)).toBe(true);
      expect(await writeJsonIfChanged(path, first)).toBe(true);
      const before = await Bun.file(path).text();
      expect(await writeJsonIfChanged(path, second)).toBe(false); expect(await Bun.file(path).text()).toBe(before);
      expect(await writeJsonIfChanged(path, { ...second, value: 1 })).toBe(true);
      expect(samePublishedContent('invalid', {})).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test('bounded cursor rotates only a deterministic selected universe; full pass ignores cursor', () => {
    const funds = ['HYLB', 'ASHR', 'DBEF'].map(ticker => ({ ticker }));
    expect(selectUpdateBatch(funds, 2, 'DBEF').map(f => f.ticker)).toEqual(['HYLB', 'ASHR']);
    expect(selectUpdateBatch(funds, 0, 'DBEF').map(f => f.ticker)).toEqual(['ASHR', 'DBEF', 'HYLB']);
    expect(selectUpdateBatch(funds, 1, 'missing').map(f => f.ticker)).toEqual(['ASHR']);
  });
});

describe('SEC fallback: exact trust/series, not unrelated registrant holdings', () => {
  test('N-PORT handles identifiers, negative and zero weights; company mapping never gives bonds an equity ticker', () => {
    const parsed = parseNport(NPORT), names = parseCompanyTickerMap({ 0: { ticker: 'ACME', title: 'ACME INC' } });
    expect(parsed.repPdDate).toBe('2026-08-31'); expect(parsed.netAssets).toBe(3e9); expect(parsed.holdings).toHaveLength(2);
    expect(parsed.holdings[0].Weight).toBe('0'); expect(parsed.holdings[1].Identifier).toBe('US1234567890'); expect(parsed.holdings[1].Weight).toBe('-0.5');
    const filled = fillNportTickers(parsed.holdings, names);
    expect(filled[0].Ticker).toBe('-'); expect(filled[1].Ticker).toBe('ACME');
    const prefixed = NPORT.replace(/(<\/?)([a-zA-Z])/g, '$1n:$2');
    expect(parseNport(prefixed).holdings).toEqual(parsed.holdings);
  });
  test('SEC ticker table, Atom, submissions and wrong-series rejection', () => {
    const map = parseFundTickerMap({ fields: ['symbol', 'classId', 'cik', 'seriesId'], data: [['HYLB', 'C000001', 1503123, 'S000001']] });
    expect(map.get('HYLB')).toEqual({ cik: '0001503123', seriesId: 'S000001', classId: 'C000001' });
    const catalogFund = { ticker: 'HYLB', name: 'Xtrackers USD High Yield Corporate Bond ETF', category: null, fundPage: '', inceptionDate: null, terValue: null, netTerValue: null, aumValue: null, officialReturns: emptyReturns() };
    expect(matchesNportFund(parseNport(NPORT), catalogFund, map.get('HYLB') || null)).toBe(true);
    expect(matchesNportFund(parseNport(NPORT.replace('S000001', 'S000002')), catalogFund, map.get('HYLB') || null)).toBe(false);
    expect(matchesNportFund(parseNport(NPORT.replace('<regCik>1503123', '<regCik>999999')), catalogFund, map.get('HYLB') || null)).toBe(false);
    expect(matchesNportFund(parseNport(NPORT), catalogFund, null)).toBe(true);
    expect(matchesNportFund(parseNport(NPORT), { ...catalogFund, name: 'Another fund' }, null)).toBe(false);
    const accession = '0001503123-26-000001';
    expect(parseNportAccessions({ cik: 1503123, filings: { recent: { form: ['NPORT-P', '10-K'], accessionNumber: [accession, accession], filingDate: ['2026-09-01'], reportDate: ['2026-08-31'] } } })).toHaveLength(1);
    expect(parseEdgarAtomFilings(`<feed><entry><filing-type>NPORT-P</filing-type><accession-number>${accession}</accession-number><filing-href>https://www.sec.gov/Archives/edgar/data/1503123/x</filing-href></entry></feed>`)[0].url).toContain('/1503123/000150312326000001/primary_doc.xml');
  });
});

describe('covered reporting dates and distribution reinvestment', () => {
  test('source dates, rather than fetch timestamps, determine completed month/quarter', () => {
    expect(reportingPeriodEnds('2026-09-29')).toEqual({ monthEnd: '2026-08-31', quarterEnd: '2026-06-30' });
    expect(reportingPeriodEnds('2026-09-30')).toEqual({ monthEnd: '2026-09-30', quarterEnd: '2026-09-30' });
  });
  test('missing NAV at a payout limits usable return coverage; stale anchors are not valid', () => {
    const points = ['2025-12-31', '2026-01-02', '2026-01-05'].map(date => ({ date, nav: 10, aum: null, shares: null, dividend: null }));
    expect(reinvestmentCoverageStart(points, [dividend('2026-01-01')])).toBe('2026-01-02');
    const days = ['2024-12-01', '2026-08-31'].map(date => ({ date, close: 10, adjClose: 10, volume: 0 }));
    expect(deriveReturns(days, '2026-08-31').yr1).toBeNull(); expect(deriveReturns(days, '2026-08-31').ytd).toBeNull();
  });
});

describe('offline real-orchestrator scope / retention / repeat runs', () => {
  test('three requested funds only; catalog and unrequested entries/files preserved; exact repeat bytes', async () => {
    const root = await tempRoot();
    try {
      await seed(root);
      const beforeIndex = await Bun.file(join(root, 'index.json')).json();
      const result = await quietRun(root);
      expect(result.selected).toEqual(['ASHR', 'DBEF', 'HYLB']); expect(result.failures).toBe(0); expect(result.outcomes.every(r => r.freshSources.length === 5)).toBe(true);
      const afterIndex = await Bun.file(join(root, 'index.json')).json();
      expect(afterIndex.funds).toHaveLength(43);
      const selected = new Set(result.selected);
      for (const row of beforeIndex.funds) if (!selected.has(row.ticker)) expect(afterIndex.funds.find((fund: JsonRecord) => fund.ticker === row.ticker)).toEqual(row);
      expect(await Bun.file(join(root, 'funds', 'CHPS', 'untouched.json')).text()).toBe('{"sentinel":true}\n');
      const before = await hashes(root), second = await quietRun(root);
      expect(second.failures).toBe(0); expect(second.updated).toBe(0); expect(second.outcomes.every(r => r.status === 'unchanged')).toBe(true);
      expect(await hashes(root)).toEqual(before);
      const meta = await Bun.file(join(root, 'funds', 'ASHR', 'meta.json')).json();
      expect(meta.holdings.totalRows).toBe(287); expect(meta.history.totalRows).toBe(3242);
      expect(meta.source.yahoo).not.toContain('?'); expect(meta.source.historySource).not.toContain('period2=');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test('unknown requested ticker fails before any writes; TICKERS does not bypass financial filters', async () => {
    const root = await tempRoot();
    try {
      await seed(root); const before = await hashes(root);
      await expect(quietRun(root, { TICKERS: 'NOTREAL' })).rejects.toThrow('absent from catalog'); expect(await hashes(root)).toEqual(before);
      const result = await quietRun(root, { TICKERS: 'ASHR', AUM: '2B:' });
      expect(result.selected).toEqual(['ASHR']); expect(result.outcomes[0].status).toBe('skipped');
      expect(await Bun.file(join(root, 'funds', 'ASHR', 'meta.json')).exists()).toBe(false);
      const after = await Bun.file(join(root, 'index.json')).json();
      expect(after.funds.find((row: JsonRecord) => row.ticker === 'ASHR').holdings).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test('all-provider failures retain every published byte and are reported as cached, not fresh', async () => {
    const root = await tempRoot();
    try {
      await seed(root); await quietRun(root); const before = await hashes(root);
      const result = await quietRun(root, {}, async () => new Response('offline fixture denial', { status: 403 }));
      expect(result.failures).toBe(0); expect(result.updated).toBe(0); expect(result.outcomes.every(row => row.freshSources.length === 0)).toBe(true);
      expect(result.outcomes.every(row => row.reason?.includes('retained published data'))).toBe(true); expect(await hashes(root)).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test('one failed fund does not abort healthy funds and does not advance a bounded cursor', async () => {
    const root = await tempRoot();
    try {
      await seed(root);
      const result = await quietRun(root, { MAX_FETCHES: '3' }, fixtureFetch(['/HYLB/Securities']));
      expect(result.failures).toBe(1); expect(result.outcomes.find(r => r.ticker === 'HYLB')?.status).toBe('failed');
      expect(result.outcomes.find(r => r.ticker === 'ASHR')?.status).toBe('updated');
      expect(result.outcomes.find(r => r.ticker === 'DBEF')?.status).toBe('updated');
      expect(await Bun.file(join(root, 'funds', 'HYLB', 'meta.json')).exists()).toBe(false);
      expect(await Bun.file(join(root, 'update-state.json')).exists()).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test('exact-series SEC fallback is reachable in the actual worker, not only pure parser tests', async () => {
    const root = await tempRoot();
    try {
      await seed(root);
      const result = await quietRun(root, { TICKERS: 'HYLB' }, fixtureFetch(['/HYLB/Securities'], NPORT));
      expect(result.failures).toBe(0); expect(result.outcomes[0].freshSources).toContain('SEC N-PORT');
      const meta = await Bun.file(join(root, 'funds', 'HYLB', 'meta.json')).json();
      expect(meta.holdings.totalRows).toBe(2); expect(meta.source.holdingsSource).toContain('primary_doc.xml');
      const secondRoot = await tempRoot();
      try {
        await seed(secondRoot);
        const wrong = await quietRun(secondRoot, { TICKERS: 'HYLB' }, fixtureFetch(['/HYLB/Securities'], NPORT.replace('S000001', 'S000002')));
        expect(wrong.failures).toBe(1); expect(await Bun.file(join(secondRoot, 'funds', 'HYLB', 'meta.json')).exists()).toBe(false);
      } finally { await rm(secondRoot, { recursive: true, force: true }); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test('bounded cursor resumes, scope changes reset it, successful full runs clear it; stale pages removed', async () => {
    const root = await tempRoot();
    try {
      await seed(root);
      const first = await quietRun(root, { MAX_FETCHES: '1' }); expect(first.selected).toEqual(['ASHR']);
      const second = await quietRun(root, { MAX_FETCHES: '1' }); expect(second.selected).toEqual(['DBEF']);
      const third = await quietRun(root, { MAX_FETCHES: '1', TICKERS: 'HYLB' }); expect(third.selected).toEqual(['HYLB']);
      await Bun.write(join(root, 'funds', 'ASHR', 'holdings', '003.json'), '{"old":true}\n');
      const full = await quietRun(root); expect(full.selected).toEqual(['ASHR', 'DBEF', 'HYLB']); expect(full.failures).toBe(0);
      expect(await Bun.file(join(root, 'update-state.json')).exists()).toBe(false);
      expect(await Bun.file(join(root, 'funds', 'ASHR', 'holdings', '003.json')).exists()).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('live finding regression: official NAV vs optional Yahoo adjusted series', () => {
  test('official history schema preserves NAV/price and is independent of Yahoo half-cent adjusted noise', () => {
    const points = [{ date: '2022-09-09', nav: 34.71, aum: null, shares: null, dividend: null }];
    const first = [{ date: '2022-09-09', close: 34.709999, adjClose: 27.07, volume: 1867900 }];
    const second = [{ ...first[0], adjClose: 27.08 }];
    expect(historySheet(points, first).headers).toEqual(['Date', 'NAV', 'Market Price', 'Premium/Discount']);
    expect(historySheet(points, first)).toEqual(historySheet(points, second));
    expect(historySheet(points, first).rows[0]).toEqual({ Date: '2022-09-09', NAV: '34.71', 'Market Price': '34.709999', 'Premium/Discount': '0' });
    const realPriceChange = [{ ...first[0], close: 35 }];
    expect(historySheet(points, first)).not.toEqual(historySheet(points, realPriceChange));
  });
  test('Yahoo-only fallback retains rounded adjusted closes; real corrections are not suppressed', () => {
    const first = [{ date: '2022-09-09', close: 34.709999, adjClose: 27.07, volume: 1867900 }];
    const second = [{ ...first[0], adjClose: 27.08 }];
    expect(historySheet([], first).headers).toEqual(['Date', 'Close', 'Adj Close', 'Volume']);
    expect(historySheet([], first).rows[0]['Adj Close']).toBe('27.07');
    expect(historySheet([], first)).not.toEqual(historySheet([], second));
  });
  test('actual worker switches to Yahoo-only history when official NAV unavailable, without inventing NAV', async () => {
    const root = await tempRoot();
    try {
      await seed(root);
      const result = await quietRun(root, { TICKERS: 'HYLB' }, fixtureFetch(['/HYLB/Performance']));
      expect(result.failures).toBe(0);
      const page = await Bun.file(join(root, 'funds', 'HYLB', 'history', '001.json')).json();
      expect(page.headers).toEqual(['Date', 'Close', 'Adj Close', 'Volume']);
      expect(page.rows.every((row: JsonRecord) => row.NAV === undefined)).toBe(true);
      const meta = await Bun.file(join(root, 'funds', 'HYLB', 'meta.json')).json();
      expect(meta.source.historySource).toContain('finance.yahoo.com'); expect(meta.source.historySource).not.toContain('Performance');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

import { coalesceReturns, annualizedOfficialReturns } from './update-data';
describe('final source-safety audit: dated returns and annualized SI', () => {
  test('undated official zero/negative values stay undated and never absorb unrelated derived values', () => {
    const primary = { ...emptyReturns(), ytd: 0, yr1: -2 };
    const derived = { ...emptyReturns(), asOfDate: '2026-08-31', ytd: 99, yr1: 99, yr3: 5, sinceInception: 7 };
    const combined = coalesceReturns(primary, derived);
    expect(combined.asOfDate).toBeNull(); expect(combined.ytd).toBe(0); expect(combined.yr1).toBe(-2);
    expect(combined.yr3).toBeNull(); expect(combined.sinceInception).toBeNull();
    expect(coalesceReturns(emptyReturns(), derived)).toEqual(derived);
    expect(coalesceReturns({ ...primary, asOfDate: '2026-08-31' }, derived).yr3).toBe(5);
    expect(coalesceReturns({ ...primary, asOfDate: '2026-07-31' }, derived).yr3).toBeNull();
  });
  test('published cumulative SI of young/undated funds is not labelled annualized; mature zero/negative SI preserved', () => {
    const source = { ...emptyReturns(), asOfDate: '2026-08-31', sinceInception: 0, yr1: -1 };
    expect(annualizedOfficialReturns(source, '2026-01-01').sinceInception).toBeNull();
    expect(annualizedOfficialReturns(source, '2024-01-01').sinceInception).toBe(0);
    expect(annualizedOfficialReturns({ ...source, sinceInception: -5 }, '2024-01-01').sinceInception).toBe(-5);
    expect(annualizedOfficialReturns({ ...source, asOfDate: null }, '2024-01-01').sinceInception).toBeNull();
    expect(annualizedOfficialReturns(source, null).sinceInception).toBeNull();
    expect(source.sinceInception).toBe(0); expect(annualizedOfficialReturns(source, '2026-01-01').yr1).toBe(-1);
    expect(annualizedToTotal(-101, 3)).toBeNull(); expect(annualizedToTotal(-100, 3)).toBe(-100);
  });
});

import { loadUpdaterDefaults, applyUpdaterDefaults } from './update-data';
describe('iShares-style checked-in default config and nonblank ENV priority', () => {
  test('checked-in flat JSON defines every supported default and matches runtime config/help', () => {
    const defaults = loadUpdaterDefaults();
    expect(defaults).toEqual(CONTROL_DEFAULTS); expect(Object.keys(defaults)).toHaveLength(23);
    expect(defaults.REQUEST_SLEEP).toBe('1.5'); expect(defaults.CONCURRENCY).toBe('2');
    expect(readConfig({}).requestSleepSeconds).toBe(1.5); expect(readConfig({}).concurrency).toBe(2);
  });
  test('only absent/blank ENV inherits JSON; zero/false/ranges/tickers/contact override', () => {
    const env: Record<string, string | undefined> = {
      MAX_FETCHES: '0', REQUEST_SLEEP: ' 0 ', CONCURRENCY: '1', MAX_RETRIES: '0', VERBOSE: 'false',
      AUM: '2B:', TER: ':0.35', SEC_YIELD: '0:', DIVIDEND_YIELD: ':0', TICKERS: 'ASHR HYLB', SEC_UA: 'project contact',
      HOLDINGS_PAGE_SIZE: '', HISTORY_PAGE_SIZE: '   ', PERFORMANCE_1Y: '-5:0', TOTAL_RETURN_3Y: '0:',
    };
    applyUpdaterDefaults(env, { ...CONTROL_DEFAULTS, MAX_FETCHES: '9', REQUEST_SLEEP: '7', VERBOSE: 'true' });
    expect(env.MAX_FETCHES).toBe('0'); expect(env.REQUEST_SLEEP).toBe(' 0 '); expect(env.VERBOSE).toBe('false');
    expect(env.HOLDINGS_PAGE_SIZE).toBe('250'); expect(env.HISTORY_PAGE_SIZE).toBe('1000');
    const config = readConfig(env);
    expect(config.maxFetches).toBe(0); expect(config.requestSleepSeconds).toBe(0); expect(config.maxRetries).toBe(0);
    expect(config.tickers).toEqual(new Set(['ASHR', 'HYLB'])); expect(config.secUa).toBe('project contact');
    expect(config.secYieldRange).toMatchObject({ min: 0 }); expect(config.dividendYieldRange).toMatchObject({ max: 0 });
    expect(config.performanceRanges['1Y']).toMatchObject({ min: -5, max: 0 }); expect(config.totalReturnRanges['3Y']).toMatchObject({ min: 0 });
  });
  test('scalar values convert as iShares does; null is skipped; valid JSON edits reach parser', async () => {
    const root = await tempRoot();
    try {
      const path = join(root, 'update-data.config.json');
      await Bun.write(path, JSON.stringify({ CONCURRENCY: 3, REQUEST_SLEEP: 2.5, MAX_FETCHES: 0, VERBOSE: false, TICKERS: null, AUM: '1B:', PERFORMANCE_1Y: '15:' }));
      const file = loadUpdaterDefaults(path); expect(file.VERBOSE).toBe('false'); expect(file.MAX_FETCHES).toBe('0'); expect(file.TICKERS).toBeUndefined();
      const env: Record<string, string | undefined> = {}; applyUpdaterDefaults(env, file);
      const config = readConfig(env); expect(config.concurrency).toBe(3); expect(config.requestSleepSeconds).toBe(2.5);
      expect(config.aumRange).toMatchObject({ min: 1e9 }); expect(config.performanceRanges['1Y']).toMatchObject({ min: 15 });
      expect(file.CONCURRENCY).toBe('3'); expect(env.CONCURRENCY).toBe('3');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test('ENOENT falls back; malformed/unreadable/nonflat JSON is not silently swallowed', async () => {
    const root = await tempRoot();
    try {
      expect(loadUpdaterDefaults(join(root, 'absent.json'))).toEqual({});
      const path = join(root, 'update-data.config.json');
      await Bun.write(path, '{ invalid'); expect(() => loadUpdaterDefaults(path)).toThrow();
      await Bun.write(path, '[]'); expect(() => loadUpdaterDefaults(path)).toThrow('flat object');
      await Bun.write(path, '{"CONCURRENCY": {"value": 2}}'); expect(() => loadUpdaterDefaults(path)).toThrow('scalar');
      expect(() => loadUpdaterDefaults(root)).toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test('default file resolution is module-relative when CLI cwd is elsewhere', async () => {
    const command = Bun.spawn([process.execPath, new URL('./update-data.ts', import.meta.url).pathname, '--help'], { cwd: tmpdir(), stdout: 'pipe', stderr: 'pipe' });
    const text = await new Response(command.stdout).text(); const error = await new Response(command.stderr).text();
    expect(await command.exited).toBe(0); expect(error).toBe(''); expect(text).toContain('scripts/update-data.config.json');
    expect(text).toContain('REQUEST_SLEEP=1.5'); expect(text).toContain('CONCURRENCY=2');
  });
});
