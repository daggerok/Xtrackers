/// <reference types="bun" />
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import {
  CONTROL_NAMES, DEFAULT_SEC_UA, resolveControls, runtimeControls, readConfig, parseRange, parseAumRange, inRange,
  fundFilterReasons, mergeDetails, outputFundLine, outputConfigEntries, createSerialQueue, createRequestGate, fetchWithRetry,
  HttpError, samePublishedContent, writeJsonIfChanged, selectUpdateBatch, runUpdater, indexRowForCatalog, parseNport,
  parseFundTickerMap, parseCompanyTickerMap, parseNportAccessions, parseEdgarAtomFilings, matchesNportFund, fillNportTickers,
  reinvestmentCoverageStart, reportingPeriodEnds, coalesceReturns, annualizedOfficialReturns, renderUpdateSummary, writeSummary,
  historyWindowStartEpoch, yahooChartUrl, windowByHistoryRange, parseHistoryRange,
  annualizedToTotal, totalToAnnualized, indicatedYield, distributionFrequency,
  numberOrNull, toIsoDate, parseSharedStrings, parseWorksheetXml, readZipEntries, parseXlsxSheet,
  parseCatalogRows, parseSitemap, parseFundDetails, parseHoldingsRows, parseDistributionsRows,
  parseNavRows, parseChart, returnHeaderSlot, parseReturnRow, emptyReturns, navTotalReturnDays,
  deriveReturns, historySheet, pageManifest, exportUrl, detailsUrl, yahooSourceUrl, record, array,
  isCertError, installSystemCa, deriveCatalogMetrics, expenseFields, previousExpenses, latestSamePair, trailingYearYield, SOFT_DEADLINE_MS,
  type Dividend, type ChartDay, type Fetcher, type FundDetails, type JsonRecord,
} from './update-data';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const configFile = (): Record<string, string> => JSON.parse(read('scripts/update-data.config.json'));
const dividend = (exDate: string, amount = 1): Dividend => ({
  exDate, epoch: Date.parse(exDate + 'T00:00:00Z') / 1000, amount, recordDate: null, payDate: null,
});
const roundForTest = (value: number) => Math.round(value * 1000000) / 1000000;

// ---------------------------------------------------------------------------
// Small inline samples: no captured pages, no fixture files
// ---------------------------------------------------------------------------
function xmlEscape(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
// A literal stored-entry ZIP builder, intentionally not a runtime dependency.
function literalWorkbook(rows: string[][]): Uint8Array {
  const xml = '<worksheet><sheetData>' + rows.map((row, i) => `<row r="${i + 1}">` + row.map((cell, j) => `<c r="${String.fromCharCode(65 + j)}${i + 1}" t="inlineStr"><is><t>${xmlEscape(cell)}</t></is></c>`).join('') + '</row>').join('') + '</sheetData></worksheet>';
  const content = Buffer.from(xml), name = Buffer.from('xl/worksheets/sheet1.xml');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + content.length, 16);
  return new Uint8Array(Buffer.concat([local, name, content, central, name, end]));
}
const SITEMAP_TICKERS = ['ASHR', 'CHPS', 'DBEF', 'HYLB', 'KOKU', 'SNPG'];
const SITEMAP = '<urlset>' + SITEMAP_TICKERS.map(t => `<url><loc>https://etf.dws.com/en-us/${t}-xtrackers-test-etf/</loc></url>`).join('') + '</urlset>';
const EMPTY_CATALOG = literalWorkbook([['Product List'], ['Fund name', 'Ticker', 'Asset class', 'Gross expenses (%)']]);
const META_ROWS = (ticker: string) => [['Ticker:', ticker], ['As of:', '09/29/2026']];
const HOLDINGS_HEADER = ['Symbol', 'ISIN', 'CUSIP', 'SEDOL', 'Name', 'Weight %', '$ Market Value', '$ Notional Value', 'Quantity', 'Country', 'Sector', 'Asset Class'];
function syntheticWorkbook(ticker: string, kind: string): Uint8Array {
  const meta = META_ROWS(ticker);
  if (kind === 'Securities') return literalWorkbook([...meta, HOLDINGS_HEADER,
    ['001280', 'CNE100007CS8', '000000001', '', `${ticker} test position`, '99', '100', '', '10', 'CN', '', ticker === 'HYLB' ? 'Fixed Income' : 'Equity'],
    ['EURUSD', '', '', '', `${ticker} test forward`, '-1', '-1', '10', '-10', '', '', 'Forward']]);
  if (kind === 'Distributions') return literalWorkbook([...meta, ['Ex-Date', 'Record date', 'Pay date', 'US$ / Share'], ['09/01/2026', '09/01/2026', '09/07/2026', '0.2']]);
  return literalWorkbook([...meta, ['Date', 'NAV', 'AUM', 'Outstanding shares', 'Dividends paid'], ['08/31/2026', '35', '100', '10', ''], ['09/01/2026', '34.9', '100', '10', '0.2'], ['09/29/2026', '35.29', '100', '10', '']]);
}
function pdp(ticker: string, options: { name?: string; classes?: string[]; sec?: string; rate?: string } = {}): unknown {
  const item = (key: string, value: unknown) => ({ key, value });
  return {
    pdpResult: {
      pageFrame: { productHeader: {
        identifier: [item('Ticker', ticker)], texts: { title: options.name ?? `Xtrackers ${ticker} Test ETF` },
        tableValues: [
          { ...item('NAV', { price: '$32.56' }), date: 'As of: 09/29/2026' },
          item('Asset class', (options.classes ?? ['Equities']).map(text => ({ text }))),
          item('30-day SEC yield', options.sec ?? '1.37%'), item('Distribution rate', options.rate ?? '2.33%'),
        ],
      } },
      pageSections: {
        keyFacts: { accordionItems: [
          { id: 'fundinformation-fundprofile', list: { items: [item('CUSIP', '233051879'), item('ISIN', 'US2330518794'), item('Net assets', '$1,387,217,695'),
            item('Primary listing exchange', 'NYSE'), item('Listing date', '11/06/2013'), item('Distribution frequency', 'Annual')] } },
          { id: 'fundinformation-indexdetails', list: { items: [item('Index ticker', 'CSIN0301')] } },
          { id: 'pdp-morningstarratings', list: { items: [item('3Y', { value: 3 })] } },
          { id: 'fundinformation-feesandexpenses', list: { items: [item('Total operating expenses', '0.65%'), item('Net expense ratio', '0.60%')] } },
        ] },
        pricingDetails: { premiumDiscount: { premiumDiscountList: { items: [item('Mid-point', '$32.66'), item('Premium discount', '0.28%')] } } },
        performanceSection: { performanceTables: { asOfDate: '09/30/2026', tabs: [
          { header: 'Discrete', table: { columns: [{ key: 'c0', value: '' }, { key: 'c1', value: '1Y' }], values: [{ c0: { value: 'Total return (USD)' }, c1: { value: '99' } }] } },
          { header: 'Annualized', table: { columns: [{ key: 'c0', value: '' }, { key: 'c1', value: 'YTD' }, { key: 'c2', value: '1Y' }, { key: 'c3', value: '5Y' }],
            values: [{ c0: { value: 'Total return (USD)' }, c1: { value: '1.5' }, c2: { value: '-2' }, c3: { value: '0' } }] } },
        ] } },
      },
    },
    metaTags: { canonical: `https://etf.dws.com/en-us/${ticker}-xtrackers-test-etf/` },
  };
}
const NPORT = '<edgarSubmission><genInfo><regName>DBX ETF TRUST</regName><regCik>1503123</regCik><seriesName>Xtrackers USD High Yield Corporate Bond ETF</seriesName><seriesId>S000001</seriesId><repPdDate>2026-08-31</repPdDate></genInfo><fundInfo><netAssets>3000000000</netAssets></fundInfo><invstOrSec><name>ACME INC</name><cusip>012345678</cusip><pctVal>0</pctVal><valUSD>123.45</valUSD><balance>10</balance><assetCat>DB</assetCat></invstOrSec><invstOrSec><name>ACME INC</name><cusip>N/A</cusip><identifiers><isin value="US1234567890"/></identifiers><pctVal>-0.5</pctVal><curVal>-2</curVal><balance>-1</balance><assetCat>EC</assetCat></invstOrSec></edgarSubmission>';
const calls: string[] = [];
function fakeFetch(denied: string[] = [], secXml: string | null = null): Fetcher {
  return async (url: string) => {
    calls.push(url);
    if (denied.some(pattern => url.includes(pattern))) return new Response('test denial', { status: 403 });
    if (url.includes('downloadxls/')) return new Response(EMPTY_CATALOG);
    if (url.endsWith('/en-us/sitemap.xml')) return new Response(SITEMAP);
    const ticker = /\/etfus\/([A-Z]+)\/pdpMetaTagsTealium/.exec(url)?.[1];
    if (ticker) return Response.json(pdp(ticker, { classes: ticker === 'HYLB' ? ['Fixed Income'] : ['Equities'] }));
    const exportMatch = /\/(?:Export|export)\/etf\/([A-Z]+)\/(\w+)/.exec(url);
    if (exportMatch) return new Response(syntheticWorkbook(exportMatch[1], exportMatch[2]));
    if (url.includes('finance.yahoo.com')) return Response.json({ chart: { result: [{ meta: { exchangeName: 'NYSE' }, timestamp: [1790553600, 1790640000], indicators: { quote: [{ close: [35, 35.3], volume: [100, 110] }], adjclose: [{ adjclose: [34.123456, 35.234567] }] } }] } });
    if (secXml && url.endsWith('company_tickers_mf.json')) return Response.json({ fields: ['symbol', 'cik', 'seriesId', 'classId'], data: [['HYLB', 1503123, 'S000001', 'C000001']] });
    if (secXml && url.includes('browse-edgar')) return new Response('<feed><entry><filing-type>NPORT-P</filing-type><accession-number>0001503123-26-000001</accession-number><filing-date>2026-09-01</filing-date><filing-href>https://www.sec.gov/Archives/edgar/data/1503123/000150312326000001/x.html</filing-href></entry></feed>');
    if (secXml && url.endsWith('primary_doc.xml')) return new Response(secXml);
    if (secXml && url.endsWith('company_tickers.json')) return Response.json({ 0: { ticker: 'ACME', title: 'ACME INC' } });
    if (url.includes('sec.gov')) return new Response('test SEC denial', { status: 403 });
    throw new Error(`Unexpected offline request: ${url}`);
  };
}
async function tempRoot(): Promise<string> { return mkdtemp(join(tmpdir(), 'xtrackers-tests-')); }
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
async function quietRun(root: string, env: Record<string, string> = {}, fetcher: Fetcher = fakeFetch()) {
  const log = console.log, warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return await runUpdater(readConfig({ TICKERS: 'ASHR DBEF HYLB', REQUEST_SLEEP: '0', MAX_RETRIES: '1', ...env }), { root, fetcher }); }
  finally { console.log = log; console.warn = warn; }
}
async function seed(root: string): Promise<void> {
  const funds = parseSitemap(SITEMAP).map(indexRowForCatalog);
  // Delisted/old catalog entries and unselected files are never deleted.
  funds.push({ ...indexRowForCatalog({ ticker: 'RETD', name: 'Retired test fund', category: 'Equities', fundPage: 'https://etf.dws.com/en-us/RETD-test-etf/', inceptionDate: null, terValue: null, netTerValue: null, aumValue: null, officialReturns: emptyReturns() }), customSentinel: 'preserve byte-for-byte' });
  await writeJsonIfChanged(join(root, 'index.json'), { provider: 'Xtrackers (DWS)', generatedAt: '2026-09-01', source: {}, counts: { funds: funds.length, holdings: 0, history: 0 }, funds });
  await mkdir(join(root, 'funds', 'CHPS'), { recursive: true });
  await Bun.write(join(root, 'funds', 'CHPS', 'untouched.json'), '{"sentinel":true}\n');
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------
// main() may set process.exitCode when a run fails; a test must never leak that into the runner's exit code.
afterEach(() => { process.exitCode = 0; });

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
  test('rejects non-XLSX and truncated archives instead of pretending empty data', () => {
    expect(() => readZipEntries(new TextEncoder().encode('<html>403</html>'))).toThrow('ZIP');
    const bytes = syntheticWorkbook('ASHR', 'Securities');
    expect(() => readZipEntries(bytes.subarray(0, bytes.length - 30))).toThrow('ZIP');
    expect(readZipEntries(bytes).has('xl/worksheets/sheet1.xml')).toBe(true);
    expect(parseXlsxSheet(bytes)[0]).toEqual(['Ticker:', 'ASHR']);
  });
});

describe('catalog and typed return mapping', () => {
  test('empty catalog workbook is recognized; the official US sitemap yields every valid fund', () => {
    expect(parseCatalogRows(parseXlsxSheet(EMPTY_CATALOG))).toEqual([]);
    const funds = parseSitemap(SITEMAP);
    expect(funds.map(f => f.ticker)).toEqual(SITEMAP_TICKERS);
    expect(funds.every(f => f.name === null && f.terValue === null)).toBe(true);
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

describe('official PDP details', () => {
  test('legal name, exact AUM, gross/net costs, NAV, date, frequency, identifiers, yields and annualized returns', () => {
    const details = parseFundDetails(pdp('ASHR', { name: 'Xtrackers Harvest CSI 300 China A-Shares ETF' }), 'ASHR', 'https://etf.dws.com/en-us/');
    expect(details.name).toBe('Xtrackers Harvest CSI 300 China A-Shares ETF');
    expect(details.aumValue).toBe(1387217695);
    expect(details.terValue).toBe(0.65); expect(details.netTerValue).toBe(0.6);
    expect(details.navValue).toBe(32.56); expect(details.navAsOfDate).toBe('2026-09-29');
    expect(details.secYield).toBe(1.37); expect(details.distributionRate).toBe(2.33);
    expect(details.frequency).toBe('Annual'); expect(details.inceptionDate).toBe('2013-11-06');
    expect(details.cusip).toBe('233051879'); expect(details.isin).toBe('US2330518794'); expect(details.indexTicker).toBe('CSIN0301');
    expect(details.midpoint).toBe(32.66); expect(details.fundPage).toBe('https://etf.dws.com/en-us/ASHR-xtrackers-test-etf/');
    // Only the named annualized table supplies returns; Morningstar stars and the discrete table are ignored.
    expect(details.officialReturns).toEqual({ ...emptyReturns(), asOfDate: '2026-09-30', ytd: 1.5, yr1: -2, yr5: 0 });
  });
  test('multi-category funds join their asset classes', () => {
    const hedge = parseFundDetails(pdp('DBEF', { classes: ['Currency-hedged', 'Equities', 'International'] }), 'DBEF', 'https://etf.dws.com/en-us/');
    expect(hedge.category).toBe('Currency-hedged / Equities / International');
  });
  test('rejects wrong fund and empty payload', () => {
    expect(() => parseFundDetails({}, 'ASHR', '')).toThrow('PDP');
    expect(() => parseFundDetails(pdp('ASHR'), 'HYLB', '')).toThrow('PDP');
  });
});

describe('official holdings / distributions / daily NAV', () => {
  test('holdings keep source symbols with leading zeros, identifiers, non-equity placeholders and cash', () => {
    const sheet = parseHoldingsRows(parseXlsxSheet(syntheticWorkbook('ASHR', 'Securities')), 'ASHR');
    expect(sheet.asOfDate).toBe('2026-09-29'); expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0]).toMatchObject({ Name: 'ASHR test position', Ticker: '001280', Identifier: '000000001', Weight: '99' });
    expect(sheet.rows[1]).toMatchObject({ Ticker: '-', Weight: '-1' });
    const cash = parseHoldingsRows([...META_ROWS('ASHR'), ['Name', 'Weight %', '$ Market Value'], ['Cash & Cash Equivalents', '1', '5']], 'ASHR');
    expect(cash.rows[0]).toMatchObject({ Ticker: '-', 'Asset Category': 'Cash' });
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
  test('distributions retain zero events, are chronological and the latest positive amount is correct', () => {
    const events = parseDistributionsRows([...META_ROWS('ASHR'), ['Ex-Date', 'Record date', 'Pay date', 'US$ / Share'],
      ['12/19/2025', '12/19/2025', '12/29/2025', '0.75811'], ['06/20/2025', '', '', '0'], ['12/19/2025', '12/19/2025', '12/29/2025', '0.75811']], 'ASHR');
    expect(events).toHaveLength(2);
    expect(events.some(d => d.amount === 0)).toBe(true);
    expect(events.filter(d => d.amount > 0).at(-1)).toMatchObject({ exDate: '2025-12-19', amount: 0.75811, payDate: '2025-12-29' });
    expect(events.map(d => d.epoch)).toEqual(events.map(d => d.epoch).sort((a, b) => a - b));
    expect(() => parseDistributionsRows([...META_ROWS('ASHR'), ['Ex-Date', 'US$ / Share'], ['12/19/2025', '1'], ['12/19/2025', '2']], 'ASHR')).toThrow('ambiguous');
  });
  test('daily NAV history includes AUM/shares and is not confused with a growth chart', () => {
    const nav = parseNavRows(parseXlsxSheet(syntheticWorkbook('ASHR', 'Performance')), 'ASHR');
    expect(nav).toHaveLength(3);
    expect(nav[0]).toMatchObject({ date: '2026-08-31', nav: 35, aum: 100, shares: 10 });
    expect(nav.at(-1)).toMatchObject({ date: '2026-09-29', nav: 35.29 });
    expect(() => parseNavRows([['Ticker:', 'ASHR'], ['Date', 'Cumulative growth'], ['46294', '100']], 'ASHR')).toThrow('headers');
  });
  test('missing headers, empty data and wrong ticker fail explicitly', () => {
    expect(() => parseDistributionsRows([['Ticker:', 'ASHR']], 'ASHR')).toThrow('headers');
    expect(() => parseNavRows([['Ticker:', 'ASHR'], ['Date', 'NAV'], ['2026-09-29', '']], 'ASHR')).toThrow('no daily');
    expect(() => parseHoldingsRows([['Ticker:', 'ASHR'], ['Name', 'Weight %', '$ Market Value']], 'ASHR')).toThrow('no usable');
  });
});

describe('history and financial metrics', () => {
  test('metrics end with returnsBasis then performanceAsOf, catalog-only rows included', () => {
    const stub = indexRowForCatalog({ ticker: 'NEWF', name: 'New', category: null, fundPage: 'https://etf.dws.com/en-us/NEWF/', inceptionDate: null, terValue: null, netTerValue: null, aumValue: null, officialReturns: emptyReturns() });
    const keys = Object.keys(record(stub.metrics));
    expect(keys.slice(-2)).toEqual(['returnsBasis', 'performanceAsOf']);
    expect(String(record(stub.metrics).returnsBasis)).toContain('unavailable'); expect(record(stub.metrics).performanceAsOf).toBeNull();
    expect(record(stub.metrics).ytd).toBeNull();
    const dated = indexRowForCatalog({ ticker: 'NEWF', name: 'New', category: null, fundPage: 'x', inceptionDate: null, terValue: null, netTerValue: null, aumValue: null,
      officialReturns: { ...emptyReturns(), asOfDate: '2026-09-30', ytd: 1.5 } });
    expect(record(dated.metrics).performanceAsOf).toBe('2026-09-30'); expect(record(dated.metrics).ytd).toBe(1.5);
    expect(String(record(dated.metrics).returnsBasis)).toContain('official DWS');
  });
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
  test('official history schema preserves NAV/price and is independent of Yahoo half-cent adjusted noise', () => {
    const points = [{ date: '2022-09-09', nav: 34.71, aum: null, shares: null, dividend: null }];
    const first = [{ date: '2022-09-09', close: 34.709999, adjClose: 27.07, volume: 1867900 }];
    const second = [{ ...first[0], adjClose: 27.08 }];
    expect(historySheet(points, first).headers).toEqual(['Date', 'NAV', 'Market Price', 'Premium/Discount']);
    expect(historySheet(points, first)).toEqual(historySheet(points, second));
    expect(historySheet(points, first).rows[0]).toEqual({ Date: '2022-09-09', NAV: '34.71', 'Market Price': '34.709999', 'Premium/Discount': '0' });
    expect(historySheet(points, first)).not.toEqual(historySheet(points, [{ ...first[0], close: 35 }]));
  });
  test('Yahoo-only fallback retains rounded adjusted closes; real corrections are not suppressed', () => {
    const first = [{ date: '2022-09-09', close: 34.709999, adjClose: 27.07, volume: 1867900 }];
    expect(historySheet([], first).headers).toEqual(['Date', 'Close', 'Adj Close', 'Volume']);
    expect(historySheet([], first).rows[0]['Adj Close']).toBe('27.07');
    expect(historySheet([], first)).not.toEqual(historySheet([], [{ ...first[0], adjClose: 27.08 }]));
  });
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

// ---------------------------------------------------------------------------
// Resolver, validation, filters
// ---------------------------------------------------------------------------
describe('resolveControls precedence and strict validation', () => {
  test('file < advanced < nonblank input < explicitly set environment', () => {
    const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'ASHR' }, { CONCURRENCY: 3, TICKERS: 'HYLB' }, { CONCURRENCY: '4', TICKERS: '' }, { CONCURRENCY: '6' });
    expect(c.CONCURRENCY).toBe('6'); expect(c.TICKERS).toBe('HYLB');
    expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
    expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }).CONCURRENCY).toBe('3');
    expect(resolveControls({ VERBOSE: true }, {}, {}, { VERBOSE: 'false' }).VERBOSE).toBe('false');
    expect(resolveControls({ MAX_FETCHES: 5 }, {}, {}, { MAX_FETCHES: '0' }).MAX_FETCHES).toBe('0');
    expect(readConfig(resolveControls({ AUM: '1B:' })).aumRange).toMatchObject({ min: 1e9 });
  });
  test('blank input inherits; advanced may set an empty string deliberately; unset environment inherits', () => {
    expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '' }).CONCURRENCY).toBe('2');
    expect(resolveControls({ TICKERS: 'ASHR' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
    expect(resolveControls({ CONCURRENCY: 2 }, {}, {}, { CONCURRENCY: undefined }).CONCURRENCY).toBe('2');
  });
  test('an explicitly set empty environment variable wins and clears the control to its built-in default', () => {
    const cleared = resolveControls({ TICKERS: 'ASHR', CONCURRENCY: 5, SEC_UA: 'file ua' }, {}, {}, { TICKERS: '', CONCURRENCY: '  ', SEC_UA: '' });
    expect(cleared.TICKERS).toBe(''); expect(cleared.CONCURRENCY).toBe(''); expect(cleared.SEC_UA).toBe('');
    const config = readConfig(cleared);
    expect(config.tickers.size).toBe(0); expect(config.concurrency).toBe(2); expect(config.secUa).toBe(DEFAULT_SEC_UA);
  });
  test('scheduled path (empty inputs and advanced) equals the config defaults', () => {
    const file = configFile();
    expect(resolveControls(file, {}, {}, {})).toEqual(file);
    const config = readConfig(resolveControls(file));
    expect(config.tickers.size).toBe(0); expect(config.maxFetches).toBe(0); expect(config.requestSleepSeconds).toBe(1.5); expect(config.concurrency).toBe(2);
    expect(config.holdingsPageSize).toBe(250); expect(config.historyPageSize).toBe(1000); expect(config.maxRetries).toBe(2);
    expect(config.historyRange).toBe('max'); expect(config.skipYahoo).toBe(false); expect(config.edgarFallback).toBe(true); expect(config.verbose).toBe(false);
    expect(config.secUa).toBe('daggerok ETF feed daggerok@gmail.com');
  });
  test('rejects unknown keys, invalid values, non-objects and injection', () => {
    for (const value of [{ UNKNOWN: 1 }, { OUTPUT_DIR: '/tmp' }, { SEC_UA: 'x\nEVIL=yes' }, { CONCURRENCY: 0 }, { MAX_RETRIES: 0 }, { MAX_RETRIES: -1 }, { MAX_FETCHES: 1.5 },
      { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' }, { SKIP_YAHOO: 'maybe' }, { EDGAR_FALLBACK: 'x' }, { HISTORY_RANGE: '5' }, { HISTORY_RANGE: '0y' },
      { AUM: '1:2:3' }, { TER: '5:1' }, { TICKERS: ['ASHR'] }, { TICKERS: '../ASHR' }, { PERFORMANCE_1Y: 'x:y' }, null, []]) {
      expect(() => resolveControls(value)).toThrow();
    }
    expect(() => resolveControls({}, { SEC_UA: 'x\rfoo' })).toThrow();
    expect(() => resolveControls({}, {}, {}, { SEC_UA: 'x\0bad' })).toThrow();
    expect(() => resolveControls({}, {}, { TICKERS: { a: 1 } })).toThrow();
    expect(() => resolveControls({}, 'x')).toThrow();
    expect(() => readConfig({ CONCURRENCY: '0' })).toThrow('CONCURRENCY');
    expect(() => readConfig({ MAX_RETRIES: '0' })).toThrow('MAX_RETRIES');
    expect(() => readConfig({ MAX_FETCHES: '-1' })).toThrow('MAX_FETCHES');
    expect(() => readConfig({ REQUEST_SLEEP: 'NaN' })).toThrow('REQUEST_SLEEP');
    expect(() => readConfig({ TICKERS: '../ASHR' })).toThrow('TICKERS');
    expect(() => readConfig({ SEC_UA: 'contact\nx-test: bad' })).toThrow('SEC_UA');
    expect(() => readConfig({ VERBOSE: 'maybe' })).toThrow('VERBOSE');
    expect(() => readConfig({ HISTORY_RANGE: 'forever' })).toThrow('HISTORY_RANGE');
  });
  test('controls parse into the config; booleans accept the documented spellings', () => {
    expect(readConfig({ TICKERS: 'ashr, HYLB; DBEF' }).tickers).toEqual(new Set(['ASHR', 'HYLB', 'DBEF']));
    const config = readConfig({ MAX_RETRIES: '1', REQUEST_SLEEP: '0', VERBOSE: 'yes', SKIP_YAHOO: 'on', EDGAR_FALLBACK: 'off', HISTORY_RANGE: '5Y' });
    expect(config.verbose).toBe(true); expect(config.skipYahoo).toBe(true); expect(config.edgarFallback).toBe(false); expect(config.historyRange).toBe('5y');
    expect(parseHistoryRange('max')).toBe('max');
  });
  test('runtimeControls reads the checked-in file; an explicitly set environment value wins', async () => {
    expect(await runtimeControls({})).toEqual(configFile());
    expect((await runtimeControls({ CONCURRENCY: '1', REQUEST_SLEEP: '0', TICKERS: 'ASHR' })).CONCURRENCY).toBe('1');
    expect((await runtimeControls({ SEC_UA: 'protected contact' })).SEC_UA).toBe('protected contact');
    await expect(runtimeControls({ CONCURRENCY: '0' })).rejects.toThrow('CONCURRENCY');
    await expect(runtimeControls({ MAX_RETRIES: '0' })).rejects.toThrow('MAX_RETRIES');
  });
  test('protected SEC_UA variable wins only when nonblank (the workflow passes nonblank values only)', () => {
    const file = configFile();
    expect(resolveControls(file, { SEC_UA: 'adv' }, { SEC_UA: 'in' }, { SEC_UA: 'protected' }).SEC_UA).toBe('protected');
    expect(resolveControls(file, { SEC_UA: 'adv' }, { SEC_UA: 'in' }, {}).SEC_UA).toBe('in');
    expect(resolveControls(file, { SEC_UA: 'adv' }, {}, {}).SEC_UA).toBe('adv');
  });
  test('edited adjacent JSON is used by a real bootstrap; ENOENT keeps built-in defaults; malformed JSON fails', async () => {
    const root = await tempRoot();
    try {
      const script = join(root, 'scripts', 'update-data.ts'), file = join(root, 'scripts', 'update-data.config.json');
      await Bun.write(script, await Bun.file(new URL('./update-data.ts', import.meta.url)).text());
      await Bun.write(file, JSON.stringify({ ...configFile(), REQUEST_SLEEP: '2.5', CONCURRENCY: '3', TICKERS: 'HYLB', HISTORY_RANGE: '5y' }));
      const evaluate = async (env: Record<string, string | undefined>, help = false) => {
        const code = `const m=await import(${JSON.stringify(script)});const c=m.readConfig(await m.runtimeControls());console.log(JSON.stringify({sleep:c.requestSleepSeconds,lanes:c.concurrency,tickers:[...c.tickers],range:c.historyRange}));`;
        const child = Bun.spawn(help ? [process.execPath, script, '--help'] : [process.execPath, '-e', code], { cwd: tmpdir(), env: { ...process.env, ...Object.fromEntries(CONTROL_NAMES.map(key => [key, undefined])), GITHUB_STEP_SUMMARY: '', ...env } as Record<string, string>, stdout: 'pipe', stderr: 'pipe' });
        const text = await new Response(child.stdout).text(), error = await new Response(child.stderr).text();
        return { text, error, status: await child.exited };
      };
      const defaults = await evaluate({}); expect(defaults.status).toBe(0); expect(defaults.error).toBe('');
      expect(JSON.parse(defaults.text)).toEqual({ sleep: 2.5, lanes: 3, tickers: ['HYLB'], range: '5y' });
      const env = await evaluate({ REQUEST_SLEEP: '0', CONCURRENCY: '1', TICKERS: 'ASHR DBEF', HISTORY_RANGE: 'max' });
      expect(JSON.parse(env.text)).toEqual({ sleep: 0, lanes: 1, tickers: ['ASHR', 'DBEF'], range: 'max' });
      const cleared = await evaluate({ TICKERS: '', CONCURRENCY: '' });
      expect(JSON.parse(cleared.text)).toEqual({ sleep: 2.5, lanes: 2, tickers: [], range: '5y' });
      const help = await evaluate({}, true); expect(help.status).toBe(0); expect(help.text).toContain('REQUEST_SLEEP=2.5'); expect(help.text).toContain('CONCURRENCY=3');
      await rm(file); const missing = await evaluate({}); expect(missing.status).toBe(0);
      expect(JSON.parse(missing.text)).toEqual({ sleep: 1.5, lanes: 2, tickers: [], range: 'max' });
      await Bun.write(file, '{ invalid'); const malformed = await evaluate({}); expect(malformed.status).not.toBe(0); expect(malformed.text).toBe('');
      await Bun.write(file, '{"UNKNOWN":"1"}'); expect((await evaluate({})).status).not.toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('filters, history window and console contract', () => {
  test('ranges are ANDed; true zero and missing data differ; AUM presets respect boundaries', () => {
    expect(parseRange('-5:0')).toMatchObject({ min: -5, max: 0 });
    expect(() => parseRange('5')).toThrow('min:max'); expect(() => parseRange('5:4')).toThrow('bounds');
    expect(inRange(0, parseRange(':0'))).toBe(true); expect(inRange(null, parseRange(':0'))).toBe(false);
    expect(parseAumRange('1B:2B')).toMatchObject({ min: 1e9, max: 2e9 });
    expect(inRange(10e6, parseAumRange('nano'))).toBe(false); expect(inRange(10e6, parseAumRange('micro'))).toBe(true);
    expect(inRange(300e6, parseAumRange('small'))).toBe(true); expect(inRange(2e9, parseAumRange('mid'))).toBe(true);
    expect(inRange(10e9, parseAumRange('large'))).toBe(true);
    expect(() => parseAumRange('unknown')).toThrow('AUM');
    const details = parseFundDetails(pdp('ASHR'), 'ASHR', 'https://etf.dws.com/en-us/');
    const config = readConfig({ TICKERS: 'ASHR', AUM: '2B:', TER: ':0.5', DIVIDEND_YIELD: '3:', SEC_YIELD: '2:', PERFORMANCE_1Y: '1:', TOTAL_RETURN_3Y: '2:' });
    expect(fundFilterReasons(details, { dividendYield: 2.33, secYield: 1.37, tr1y: 0, tr3y: 0 }, config))
      .toEqual(['AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD', 'PERFORMANCE_1Y', 'TOTAL_RETURN_3Y']);
  });
  test('missing current facts retain published ones; a current real zero wins', () => {
    const old = parseFundDetails(pdp('ASHR'), 'ASHR', 'https://etf.dws.com/en-us/');
    const merged = mergeDetails({ ...old, aumValue: null, terValue: 0, secYield: null, frequency: null } as FundDetails, old);
    expect(merged.aumValue).toBe(old.aumValue); expect(merged.terValue).toBe(0); expect(merged.secYield).toBe(1.37);
  });
  test('HISTORY_RANGE maps to the Yahoo request window and to published history rows', () => {
    const now = Date.parse('2026-10-01T00:00:00Z') / 1000;
    expect(historyWindowStartEpoch('max', now)).toBe(0);
    expect(historyWindowStartEpoch('5y', now)).toBe(Math.floor(now - 5 * 365.25 * 86400));
    expect(yahooChartUrl('ASHR', now)).toContain('period1=0&period2=' + now);
    expect(yahooChartUrl('ASHR', now, '1y')).toContain(`period1=${Math.floor(now - 365.25 * 86400)}&period2=${now}`);
    const items = ['2020-01-01', '2025-10-02', '2026-09-30'].map(date => ({ date }));
    expect(windowByHistoryRange(items, 'max', now)).toEqual(items);
    expect(windowByHistoryRange(items, '1y', now).map(i => i.date)).toEqual(['2025-10-02', '2026-09-30']);
    expect(windowByHistoryRange(items, '1y', Date.parse('2040-01-01T00:00:00Z') / 1000)).toEqual(items);
  });
  test('console uses shared padding, omits null fields, preserves zero/false and lists every control', () => {
    const line = outputFundLine(1, 3, 'ASHR', 'updated', { history: 0, holdings: 0, netAssets: null, portId: null, secYield: 0, workplaceRaw: false });
    expect(line).toContain('history=0'); expect(line).toContain('holdings=0'); expect(line).toContain('sec=0'); expect(line).toContain('wp=false');
    expect(line).not.toContain('null'); expect(line).not.toContain('netAssets='); expect(line).not.toContain('port=');
    const entries = outputConfigEntries(readConfig({}));
    expect(entries.slice(0, 3).map(([key]) => key)).toEqual(['MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY']);
    expect(entries.map(([key]) => key).sort()).toEqual([...CONTROL_NAMES].sort());
    expect(entries.find(([key]) => key === 'VERBOSE')?.[1]).toBe('false');
  });
});

// ---------------------------------------------------------------------------
// Pacing, retries, writers
// ---------------------------------------------------------------------------
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
    const response = await fetchWithRetry('https://example.test', cfg, async () => { gates++; }, async () => {
      requests++; return requests === 1 ? new Response('throttle', { status: 429, headers: { 'Retry-After': '2' } }) : requests === 2 ? new Response('server', { status: 500 }) : new Response('ok');
    }, {}, async ms => { waits.push(ms); });
    expect(response.status).toBe(200); expect(requests).toBe(3); expect(gates).toBe(3); expect(waits).toEqual([2000, 2000]);
    requests = 0;
    await expect(fetchWithRetry('https://example.test', cfg, async () => {}, async () => { requests++; return new Response('blocked', { status: 403 }); }, {}, async () => {})).rejects.toBeInstanceOf(HttpError);
    expect(requests).toBe(1);
    requests = 0;
    await fetchWithRetry('https://example.test', cfg, async () => {}, async () => { if (++requests === 1) throw new Error('network'); return new Response('ok'); }, {}, async () => {});
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
    expect(parseNport(NPORT.replace(/(<\/?)([a-zA-Z])/g, '$1n:$2')).holdings).toEqual(parsed.holdings);
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

// ---------------------------------------------------------------------------
// Real orchestrator against an injected offline fetcher (no live requests)
// ---------------------------------------------------------------------------
describe('offline real-orchestrator scope / retention / repeat runs', () => {
  test('requested funds only; catalog and unrequested entries/files preserved; exact repeat bytes', async () => {
    const root = await tempRoot();
    try {
      await seed(root);
      const beforeIndex = await Bun.file(join(root, 'index.json')).json();
      const result = await quietRun(root);
      expect(result.selected).toEqual(['ASHR', 'DBEF', 'HYLB']); expect(result.failures).toBe(0); expect(result.outcomes.every(r => r.freshSources.length === 5)).toBe(true);
      const afterIndex = await Bun.file(join(root, 'index.json')).json();
      expect(afterIndex.funds).toHaveLength(SITEMAP_TICKERS.length + 1);
      for (const ticker of result.selected) {
        const metrics = record(record(afterIndex.funds.find((fund: JsonRecord) => fund.ticker === ticker)).metrics), keys = Object.keys(metrics);
        expect(keys.slice(-2)).toEqual(['returnsBasis', 'performanceAsOf']);
        expect(String(metrics.returnsBasis).trim()).not.toMatch(/^(-|—)?$/);
        expect(metrics.performanceAsOf === null || /^\d{4}-\d{2}-\d{2}$/.test(String(metrics.performanceAsOf))).toBe(true);
      }
      const selected = new Set(result.selected);
      for (const row of beforeIndex.funds) if (!selected.has(row.ticker)) expect(afterIndex.funds.find((fund: JsonRecord) => fund.ticker === row.ticker)).toEqual(row);
      expect(await Bun.file(join(root, 'funds', 'CHPS', 'untouched.json')).text()).toBe('{"sentinel":true}\n');
      const before = await hashes(root), second = await quietRun(root);
      expect(second.failures).toBe(0); expect(second.updated).toBe(0); expect(second.outcomes.every(r => r.status === 'unchanged')).toBe(true);
      expect(await hashes(root)).toEqual(before);
      const meta = await Bun.file(join(root, 'funds', 'ASHR', 'meta.json')).json();
      expect(meta.holdings.totalRows).toBe(2); expect(meta.history.totalRows).toBe(4);
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
      const result = await quietRun(root, {}, async () => new Response('offline test denial', { status: 403 }));
      expect(result.failures).toBe(0); expect(result.updated).toBe(0); expect(result.outcomes.every(row => row.freshSources.length === 0)).toBe(true);
      expect(result.outcomes.every(row => row.reason?.includes('retained published data'))).toBe(true); expect(await hashes(root)).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test('one failed fund does not abort healthy funds and the bounded cursor still moves past it', async () => {
    const root = await tempRoot();
    try {
      await seed(root);
      const result = await quietRun(root, { MAX_FETCHES: '3' }, fakeFetch(['/HYLB/Securities']));
      expect(result.failures).toBe(1); expect(result.outcomes.find(r => r.ticker === 'HYLB')?.status).toBe('failed');
      expect(result.outcomes.find(r => r.ticker === 'ASHR')?.status).toBe('updated');
      expect(result.outcomes.find(r => r.ticker === 'DBEF')?.status).toBe('updated');
      expect(await Bun.file(join(root, 'funds', 'HYLB', 'meta.json')).exists()).toBe(false);
      const cursors = Object.values((await Bun.file(join(root, 'update-state.json')).json()).cursors);
      expect(cursors).toEqual(['HYLB']); // the failing fund no longer pins the batch
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test('exact-series SEC fallback is reachable in the worker; the wrong series is rejected', async () => {
    const root = await tempRoot(), secondRoot = await tempRoot();
    try {
      await seed(root);
      const result = await quietRun(root, { TICKERS: 'HYLB' }, fakeFetch(['/HYLB/Securities'], NPORT));
      expect(result.failures).toBe(0); expect(result.outcomes[0].freshSources).toContain('SEC N-PORT');
      const meta = await Bun.file(join(root, 'funds', 'HYLB', 'meta.json')).json();
      expect(meta.holdings.totalRows).toBe(2); expect(meta.source.holdingsSource).toContain('primary_doc.xml');
      await seed(secondRoot);
      const wrong = await quietRun(secondRoot, { TICKERS: 'HYLB' }, fakeFetch(['/HYLB/Securities'], NPORT.replace('S000001', 'S000002')));
      expect(wrong.failures).toBe(1); expect(await Bun.file(join(secondRoot, 'funds', 'HYLB', 'meta.json')).exists()).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); await rm(secondRoot, { recursive: true, force: true }); }
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
      expect(Object.values((await Bun.file(join(root, 'update-state.json')).json()).cursors)).toEqual(['HYLB']); // only the full pass's own scope was cleared
      expect(await Bun.file(join(root, 'funds', 'ASHR', 'holdings', '003.json')).exists()).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test('worker switches to Yahoo-only history when official NAV is unavailable, without inventing NAV', async () => {
    const root = await tempRoot();
    try {
      await seed(root);
      const result = await quietRun(root, { TICKERS: 'HYLB' }, fakeFetch(['/HYLB/Performance']));
      expect(result.failures).toBe(0);
      const page = await Bun.file(join(root, 'funds', 'HYLB', 'history', '001.json')).json();
      expect(page.headers).toEqual(['Date', 'Close', 'Adj Close', 'Volume']);
      expect(page.rows.every((row: JsonRecord) => row.NAV === undefined)).toBe(true);
      const meta = await Bun.file(join(root, 'funds', 'HYLB', 'meta.json')).json();
      expect(meta.source.historySource).toContain('finance.yahoo.com'); expect(meta.source.historySource).not.toContain('Performance');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test('HISTORY_RANGE narrows the real Yahoo request; max requests the whole history', async () => {
    const root = await tempRoot(), other = await tempRoot();
    try {
      await seed(root); await seed(other);
      calls.length = 0;
      await quietRun(root, { TICKERS: 'HYLB', HISTORY_RANGE: '1y' });
      const limited = /period1=(\d+)&period2=(\d+)/.exec(calls.find(url => url.includes('finance.yahoo.com')) ?? '');
      expect(limited).not.toBeNull();
      expect(Number(limited![2]) - Number(limited![1])).toBe(Math.floor(365.25 * 86400));
      calls.length = 0;
      await quietRun(other, { TICKERS: 'HYLB', HISTORY_RANGE: 'max' });
      expect(calls.find(url => url.includes('finance.yahoo.com'))).toContain('period1=0&');
    } finally { await rm(root, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); }
  });
  test('SKIP_YAHOO never calls Yahoo and publishes official NAV history only', async () => {
    const root = await tempRoot();
    try {
      await seed(root); calls.length = 0;
      const result = await quietRun(root, { TICKERS: 'HYLB', SKIP_YAHOO: 'true' });
      expect(result.failures).toBe(0); expect(calls.some(url => url.includes('finance.yahoo.com'))).toBe(false);
      expect(result.outcomes[0].freshSources).not.toContain('Yahoo');
      const page = await Bun.file(join(root, 'funds', 'HYLB', 'history', '001.json')).json();
      expect(page.headers).toEqual(['Date', 'NAV', 'Market Price', 'Premium/Discount']);
      expect(page.rows.every((row: JsonRecord) => row['Market Price'] === '')).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test('EDGAR_FALLBACK=false never calls SEC; the true default does when official holdings fail', async () => {
    const root = await tempRoot(), other = await tempRoot();
    try {
      await seed(root); await seed(other);
      calls.length = 0;
      const off = await quietRun(root, { TICKERS: 'HYLB', EDGAR_FALLBACK: 'false' }, fakeFetch(['/HYLB/Securities'], NPORT));
      expect(off.failures).toBe(1); expect(calls.some(url => url.includes('sec.gov'))).toBe(false);
      calls.length = 0;
      const on = await quietRun(other, { TICKERS: 'HYLB' }, fakeFetch(['/HYLB/Securities'], NPORT));
      expect(on.failures).toBe(0); expect(calls.some(url => url.includes('sec.gov'))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); }
  });
});

describe('automatic GitHub step summary (offline actual updater)', () => {
  test('summary has all effective controls, outcomes, counts and failures, redacts SEC_UA, without changing feed bytes', async () => {
    const root = await tempRoot(), summaryRoot = await tempRoot();
    try {
      await seed(root);
      const config = readConfig({ TICKERS: 'ASHR HYLB DBEF', REQUEST_SLEEP: '0', MAX_FETCHES: '3' });
      const result = await quietRun(root, { MAX_FETCHES: '3' }, fakeFetch(['/HYLB/Securities']));
      expect(result.manifestChanged).toBe(true); expect(result.progressChanged).toBe(true); expect(result.processedThrough).toBe('HYLB');
      const before = await hashes(root), path = join(summaryRoot, 'step-summary.md');
      await writeSummary(config, result, path);
      const text = await Bun.file(path).text();
      expect(text).toContain('## Xtrackers updater'); expect(text).toContain(`| Catalog funds | ${SITEMAP_TICKERS.length + 1} |`);
      expect(text).toContain('| Fund update attempts | 3 |'); expect(text).toContain('| Failed | 1 |'); expect(text).toContain('### Failures'); expect(text).toContain('**HYLB**');
      expect(text).toContain('REQUEST_SLEEP=0'); expect(text).toContain('VERBOSE=false'); expect(text).toContain('SEC_UA=<redacted>');
      expect(text).not.toContain('daggerok@gmail.com');
      for (const key of CONTROL_NAMES) expect(text).toContain(key + '=');
      await writeSummary(config, result, path); expect(await Bun.file(path).text()).toBe(text + text);
      await writeSummary(config, result, ''); expect(await hashes(root)).toEqual(before);
      expect(renderUpdateSummary(config, result)).toBe(text);
    } finally { await rm(root, { recursive: true, force: true }); await rm(summaryRoot, { recursive: true, force: true }); }
  });
  test('filtered and cached source diagnostics, repeat manifest and cursor-state flags are truthful', async () => {
    const root = await tempRoot();
    try {
      await seed(root);
      const filteredConfig = readConfig({ TICKERS: 'ASHR', AUM: '2B:' });
      const filtered = await quietRun(root, { TICKERS: 'ASHR', AUM: '2B:' });
      expect(renderUpdateSummary(filteredConfig, filtered)).toContain('### Filtered funds');
      expect(renderUpdateSummary(filteredConfig, filtered)).toContain('AUM');
      const batch = await quietRun(root, { MAX_FETCHES: '1' }); expect(batch.progressChanged).toBe(true); expect(batch.processedThrough).toBe('ASHR');
      const full = await quietRun(root); expect(full.progressChanged).toBe(true); expect(full.processedThrough).toBeNull();
      const cached = await quietRun(root, {}, async () => new Response('denied', { status: 403 }));
      expect(cached.manifestChanged).toBe(false); expect(cached.progressChanged).toBe(false);
      const text = renderUpdateSummary(readConfig({}), cached);
      expect(text).toContain('| Updated | 0 |'); expect(text).toContain('### Retained published data'); expect(text).toContain('retained published data');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
// Parity: config file == CONTROL_NAMES == --help == README rows; workflow and README shape
// ---------------------------------------------------------------------------
function headings(text: string): string[] {
  let fenced = false;
  return text.split('\n').flatMap(line => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return []; }
    return !fenced && /^#{2,3} /.test(line) ? [line] : [];
  });
}

describe('config / help / README parity', () => {
  test('config keys == CONTROL_NAMES == help == README rows; all values are strings', async () => {
    const file = configFile();
    expect(Object.keys(file).sort()).toEqual([...CONTROL_NAMES].sort());
    expect(Object.values(file).every(value => typeof value === 'string')).toBe(true);
    const doc = read('README.md');
    // README lists each PERFORMANCE_* / TOTAL_RETURN_* tenor as its own row; every control name must have a row.
    const documented = [...doc.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|/gm)].map(match => match[1]);
    expect(documented.sort()).toEqual([...CONTROL_NAMES].sort());
    expect(doc).toContain('scripts/update-data.config.json');
    const command = Bun.spawn([process.execPath, 'scripts/update-data.ts', '--help'], { cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe' });
    const help = await new Response(command.stdout).text(); expect(await command.exited).toBe(0);
    for (const name of CONTROL_NAMES) expect(help).toContain(`${name}=`);
    expect(help).toContain('MAX_RETRIES: retries after the initial request, integer >= 1');
  });
  test('no personal contact other than the owner-approved SEC_UA default appears in the config', () => {
    const file = configFile();
    expect(file.SEC_UA).toBe('daggerok ETF feed daggerok@gmail.com');
    expect(DEFAULT_SEC_UA).toBe(file.SEC_UA);
    expect(Object.entries(file).filter(([key, value]) => key !== 'SEC_UA' && /@/.test(value))).toEqual([]);
  });
});

describe('workflow shape and hardening', () => {
  const source = read('.github/workflows/update-data.yml');
  const workflow = Bun.YAML.parse(source) as any;
  test('<= 25 inputs, advanced JSON, blank defaults, every input is a control, schedule, fixed api/xtrackers output', () => {
    const inputs = record(record(workflow.on).workflow_dispatch).inputs as Record<string, any>;
    const names = Object.keys(inputs);
    expect(names.length).toBeLessThanOrEqual(25); expect(names).toContain('advanced');
    expect(inputs.advanced.default).toBe('{}');
    for (const name of names.filter(n => n !== 'advanced')) { expect(CONTROL_NAMES).toContain(name.toUpperCase() as never); expect(inputs[name].default).toBe(''); expect(inputs[name].type).toBe('string'); }
    expect(workflow.on.schedule[0].cron).toBe('0 0 * * 0');
    expect(source).not.toMatch(/OUTPUT_DIR|output_dir/i);
    expect(source.match(/git add (\S+)/g)).toEqual(['git add api/xtrackers']);
    expect(source.match(/api\/[\w-]+/g)!.every(path => path === 'api/xtrackers')).toBe(true);
  });
  test('shared resolver, protected SEC_UA, no direct input interpolation, hardened checkout and runtime-only push', () => {
    expect(source).toContain('resolveControls(file, advanced, individual, protectedVars)');
    expect(source).toContain('PROTECTED_SEC_UA: ${{ vars.SEC_UA }}');
    expect(source).toContain('toJSON(inputs)');
    expect(source).not.toMatch(/\$\{\{\s*(github\.event\.)?inputs\./);
    expect(source).not.toContain('--force'); expect(source).not.toContain('git add .');
    expect(source).toContain('if: ${{ !cancelled() }}'); expect(source).toContain('git diff --cached --quiet -- api/xtrackers');
    const job = record(record(workflow.jobs)['update-data']);
    expect(job.env).toBeUndefined(); expect(job['timeout-minutes']).toBe(30);
    const steps = array(job.steps).map(record);
    expect(steps.map(step => step.uses || step.name)).toEqual([
      'actions/checkout@v7', 'oven-sh/setup-bun@v2', 'Install dependencies', 'Run updater unit tests', 'Resolve file defaults and manual overrides',
      'Generate api/xtrackers static data', 'Commit updated data',
    ]);
    expect(record(steps[0].with)['persist-credentials']).toBe(false);
    expect(steps[2].run).toBe('bun install --frozen-lockfile'); expect(steps[3].run).toBe('bun test'); expect(steps[5].run).toBe('bun ./scripts/update-data.ts');
    expect(record(workflow.permissions).contents).toBe('write');
    expect(record(workflow.concurrency)).toEqual({ group: 'update-data', 'cancel-in-progress': false });
  });
  test('only the update-data workflow exists; Dependabot is monthly for bun and github-actions', async () => {
    expect((await readdir(new URL('../.github/workflows/', import.meta.url))).sort()).toEqual(['update-data.yml']);
    const dependabot = Bun.YAML.parse(read('.github/dependabot.yml')) as any;
    expect(array(dependabot.updates).map(item => record(item)['package-ecosystem']).sort()).toEqual(['bun', 'github-actions']);
    expect(array(dependabot.updates).every(item => record(record(item).schedule).interval === 'monthly')).toBe(true);
  });
  test('Bun-only package: zero runtime deps, no tsconfig, scripts folder holds exactly three files', async () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.dependencies).toEqual({});
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(['@types/bun', '@types/node']);
    expect(await Bun.file(new URL('../tsconfig.json', import.meta.url)).exists()).toBe(false);
    expect(pkg.scripts.test).toBe('bun test'); expect(pkg.scripts.update).toBe('bun scripts/update-data.ts');
    expect((await readdir(new URL('.', import.meta.url).pathname)).sort()).toEqual(['update-data.config.json', 'update-data.test.ts', 'update-data.ts']);
  });
});

describe('README structure and shared tables', () => {
  test('standard sections in order; retained caveats present; no work-log references', () => {
    const text = read('README.md');
    expect(text.startsWith('# Xtrackers\n')).toBe(true);
    const order = ['## Using Bun', '## Updating the static Xtrackers data', '### Data sources', '### Metrics and caveats', '### Update controls', '### Examples', '## TypeScript and verification', '## Brands table', '## Sibling applications', '## License'];
    const found = headings(text);
    expect(order.every(heading => found.includes(heading))).toBe(true);
    expect(order.map(heading => found.indexOf(heading))).toEqual([...order.map(heading => found.indexOf(heading))].sort((a, b) => a - b));
    expect(text).toContain('not published standardized NAV returns'); expect(text).toContain('SEC EDGAR');
    expect(text).toContain('file defaults < `advanced` JSON < nonblank workflow inputs < environment variable < protected Actions variable');
    for (const word of ['worklog', 'evidence', 'fixtures', 'research/', 'config-docs']) expect(text).not.toContain(word);
  });
  test('shared brand and sibling tables have equal row counts and an Xtrackers row', () => {
    const text = read('README.md');
    const brands = text.split('## Brands table')[1].split('## Sibling applications')[0].split('\n').filter(line => line.startsWith('| **'));
    const siblings = text.split('## Sibling applications')[1].split('## License')[0].split('\n').filter(line => line.startsWith('| ') && !line.startsWith('| Application') && !line.startsWith('| ---'));
    expect(brands.length).toBe(siblings.length); expect(brands.length).toBeGreaterThanOrEqual(21);
    expect(brands.some(row => row.includes('**Xtrackers**'))).toBe(true); expect(siblings.some(row => row.startsWith('| Xtrackers |'))).toBe(true);
  });
});

describe('published feed structure (offline, tolerates legitimate refreshes)', () => {
  test('index counts agree with fund rows; every manifest, page and file listing agrees', async () => {
    const root = new URL('../api/xtrackers/', import.meta.url).pathname;
    const json = async (path: string) => record(JSON.parse(await readFile(join(root, path), 'utf8')));
    const index = await json('index.json'), funds = array(index.funds).map(record);
    expect(index.provider).toBe('Xtrackers (DWS)');
    expect(new Set(funds.map(fund => fund.ticker)).size).toBe(funds.length);
    const counts = record(index.counts);
    expect(counts.funds).toBe(funds.length);
    expect(counts.holdings).toBe(funds.reduce((sum, fund) => sum + (numberOrNull(fund.holdings) ?? 0), 0));
    expect(counts.history).toBe(funds.reduce((sum, fund) => sum + (numberOrNull(fund.history) ?? 0), 0));
    for (const fund of funds) {
      const ticker = String(fund.ticker);
      expect(ticker).toMatch(/^[A-Z][A-Z0-9.-]{0,9}$/);
      expect([null, `funds/${ticker}/meta.json`, `./funds/${ticker}/meta.json`]).toContain(fund.dataFile);
      const fundMetrics = record(fund.metrics);
      expect(Object.keys(fundMetrics).slice(-2)).toEqual(['returnsBasis', 'performanceAsOf']);
      expect(String(fundMetrics.returnsBasis).trim()).not.toMatch(/^(-|—)?$/);
      expect(fundMetrics.performanceAsOf === null || /^\d{4}-\d{2}-\d{2}$/.test(String(fundMetrics.performanceAsOf))).toBe(true);
      if (!fund.holdings && !fund.history) continue; // catalog-only until a real update
      const meta = await json(`funds/${ticker}/meta.json`);
      expect(meta.ticker).toBe(ticker);
      const source = record(meta.source);
      expect(source.trustCik).toBe('0001503123'); expect(String(source.historySource)).not.toContain('period');
      for (const kind of ['holdings', 'history'] as const) {
        const manifest = record(meta[kind]), pages = array(manifest.pages).map(String);
        expect(pages.length).toBe(Math.ceil(Number(manifest.totalRows) / Number(manifest.pageSize)));
        let rowCount = 0;
        for (const [i, path] of pages.entries()) {
          expect(path).toMatch(new RegExp(`^${kind}/\\d{3,}\\.json$`));
          const page = await json(`funds/${ticker}/${path}`), rows = array(page.rows).map(record);
          expect(page.ticker).toBe(ticker); expect(page.page).toBe(i + 1); expect(page.totalRows).toBe(manifest.totalRows);
          expect(rows.length).toBeLessThanOrEqual(Number(manifest.pageSize));
          rowCount += rows.length;
        }
        expect(rowCount).toBe(manifest.totalRows); expect(rowCount).toBe(fund[kind]);
        const actual = (await readdir(join(root, `funds/${ticker}/${kind}`))).filter(name => /^\d+\.json$/.test(name)).sort();
        expect(actual).toEqual(pages.map(path => path.split('/')[1]).sort());
      }
    }
  });
});

describe('system CA support', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const reexecSpy = () => { const calls: number[] = []; return { calls, reexec: ((): never => { calls.push(1); throw new Error('reexec'); }) as () => never }; };

  test('USE_SYSTEM_CA resolver accepts auto/true/false case-insensitively, rejects others, defaults to auto', () => {
    expect(configFile().USE_SYSTEM_CA).toBe('auto');
    expect(readConfig({}).useSystemCa).toBe('auto');
    for (const mode of ['auto', 'true', 'false', 'AUTO', 'True', 'FALSE']) expect(readConfig({ USE_SYSTEM_CA: mode }).useSystemCa).toBe(mode.toLowerCase());
    expect(() => readConfig({ USE_SYSTEM_CA: 'maybe' })).toThrow('USE_SYSTEM_CA');
    expect(() => resolveControls({}, { USE_SYSTEM_CA: 'maybe' })).toThrow('USE_SYSTEM_CA');
    expect(resolveControls({}, {}, {}, { USE_SYSTEM_CA: 'true' }).USE_SYSTEM_CA).toBe('true');
  });

  test('isCertError recognizes certificate failures, including nested causes', () => {
    expect(isCertError({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' })).toBe(true);
    expect(isCertError(new Error('unable to get local issuer certificate'))).toBe(true);
    expect(isCertError(Object.assign(new Error('fetch failed'), { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } }))).toBe(true);
    expect(isCertError({ code: 'ECONNRESET' })).toBe(false);
    expect(isCertError(new Error('HTTP 403 Forbidden'))).toBe(false);
    expect(isCertError(null)).toBe(false);
  });

  test('installSystemCa: false and active leave fetch alone, true restarts now', () => {
    const off = reexecSpy();
    installSystemCa('false', off.reexec, false); expect(globalThis.fetch).toBe(realFetch);
    installSystemCa('auto', off.reexec, true); expect(globalThis.fetch).toBe(realFetch);
    installSystemCa('true', off.reexec, true); expect(globalThis.fetch).toBe(realFetch);
    expect(off.calls.length).toBe(0);
    const on = reexecSpy();
    expect(() => installSystemCa('true', on.reexec, false)).toThrow('reexec');
    expect(on.calls.length).toBe(1);
  });

  test('installSystemCa auto: cert error restarts once, other errors rethrow, success passes through', async () => {
    const spy = reexecSpy();
    const responses: Array<() => Promise<Response>> = [
      async () => new Response('ok'),
      async () => { throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }); },
      async () => { throw Object.assign(new Error('x'), { cause: new Error('unable to get local issuer certificate') }); },
    ];
    let index = 0;
    globalThis.fetch = (async () => responses[index++]()) as unknown as typeof fetch;
    installSystemCa('auto', spy.reexec, false);
    expect(globalThis.fetch).not.toBe(realFetch);
    expect(await (await fetch('https://example.test/')).text()).toBe('ok');
    await expect(fetch('https://example.test/')).rejects.toThrow('fetch failed');
    expect(spy.calls.length).toBe(0);
    const quiet = console.error; console.error = () => {};
    try { await expect(fetch('https://example.test/')).rejects.toThrow('reexec'); } finally { console.error = quiet; }
    expect(spy.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Data-contract fixes: cursor, premium/discount, expense ratio, yields, notices
// ---------------------------------------------------------------------------
const override = (base: Fetcher, match: (url: string) => boolean, make: (url: string) => Response): Fetcher => (url, init) => match(url) ? Promise.resolve(make(url)) : base(url, init);
const indexOf = async (root: string): Promise<JsonRecord[]> => array((await Bun.file(join(root, 'index.json')).json()).funds).map(record);
const rowOf = async (root: string, ticker: string): Promise<JsonRecord> => (await indexOf(root)).find(row => row.ticker === ticker)!;

describe('cursor and state', () => {
  test('a fund that fails on every run cannot pin a bounded batch', async () => {
    const root = await tempRoot();
    try {
      await seed(root);
      const denied = fakeFetch(['/ASHR/Securities']);
      const first = await quietRun(root, { MAX_FETCHES: '1' }, denied);
      expect(first.failures).toBe(1); expect(first.processedThrough).toBe('ASHR');
      const second = await quietRun(root, { MAX_FETCHES: '1' }, denied);
      expect(second.selected).toEqual(['DBEF']); expect(second.failures).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('a TICKERS run never deletes or moves the cursor of another scope', async () => {
    const root = await tempRoot();
    try {
      await seed(root);
      await quietRun(root, { MAX_FETCHES: '1', TICKERS: '' });
      const state = await readFile(join(root, 'update-state.json'), 'utf8');
      await quietRun(root, { TICKERS: 'HYLB' }); // full pass over a ticker list
      expect(await readFile(join(root, 'update-state.json'), 'utf8')).toBe(state);
      const next = await quietRun(root, { MAX_FETCHES: '1', TICKERS: '' });
      expect(next.selected).not.toEqual(first(state)); // resumes after the saved cursor
    } finally { await rm(root, { recursive: true, force: true }); }
    function first(text: string): string[] { return [Object.values(JSON.parse(text).cursors)[0] as string]; }
  });

  test('the run stops taking funds at the soft deadline and still writes the index', async () => {
    const root = await tempRoot();
    try {
      await seed(root);
      const log = console.warn; console.warn = () => {};
      const logLine = console.log; console.log = () => {};
      let result; try { result = await runUpdater(readConfig({ TICKERS: 'ASHR DBEF', REQUEST_SLEEP: '0' }), { root, fetcher: fakeFetch(), deadlineMs: 0 }); } finally { console.warn = log; console.log = logLine; }
      expect(SOFT_DEADLINE_MS).toBe(25 * 60_000);
      expect(result.outcomes).toHaveLength(0); expect(result.deadlineReached).toBe(true);
      expect(renderUpdateSummary(readConfig({}), result)).toContain('Soft deadline reached');
      expect((await indexOf(root)).length).toBeGreaterThan(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('premium/discount, performanceAsOf, expense ratio and yield', () => {
  const nav = (date: string, value: number) => ({ date, nav: value, aum: null, shares: null, dividend: null });
  const day = (date: string, close: number): ChartDay => ({ date, close, adjClose: close, volume: 1 });

  test('premium/discount uses the latest date that has both a NAV and a close', () => {
    // NAV dated 09-30, newest close dated 10-01: the old same-date test against the NAV date gave null for most funds
    const pair = latestSamePair([nav('2026-09-29', 50), nav('2026-09-30', 50.1)], [day('2026-09-29', 50.5), day('2026-09-30', 50.2), day('2026-10-01', 50.3)]);
    expect(pair).toMatchObject({ date: '2026-09-30', premium: 0.1996 });
    expect(latestSamePair([nav('2026-09-01', 50)], [day('2026-09-30', 50)])).toBeNull(); // no pair within 7 days: null, not a mixed-date number
    expect(latestSamePair([], [day('2026-09-30', 50)])).toBeNull();
  });

  test('the worker publishes the same-date premium with its date', async () => {
    const root = await tempRoot();
    try {
      await seed(root);
      await quietRun(root, { TICKERS: 'ASHR' });
      const row = await rowOf(root, 'ASHR');
      expect(row.premiumDiscountValue).not.toBeNull();
      expect(row.premiumDiscountAsOfDate).toBe('2026-09-29');
      expect(row.premiumDiscount).not.toBe('—');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('performanceAsOf is null when no return figure exists', () => {
    const none = { ...emptyReturns(), asOfDate: '2026-09-30' };
    expect(deriveCatalogMetrics(none, null, null, 'x').performanceAsOf).toBeNull();
    expect(deriveCatalogMetrics({ ...none, yr1: 4.2 }, null, null, 'x').performanceAsOf).toBe('2026-09-30');
  });

  test('terValue is the net ratio, terGrossValue the gross one; legacy rows are mapped', async () => {
    expect(expenseFields(0.65, 0.6)).toEqual({ ter: '0.60%', terValue: 0.6, terGross: '0.65%', terGrossValue: 0.65 });
    expect(expenseFields(0.65, null)).toMatchObject({ terValue: 0.65, terGrossValue: 0.65 });
    expect(expenseFields(null, null)).toMatchObject({ terValue: null, terGrossValue: null, ter: '—' });
    expect(previousExpenses({ terValue: 0.65 }, { netTerValue: 0.6 })).toEqual({ gross: 0.65, net: 0.6 }); // published before the split
    expect(previousExpenses({ terValue: 0.6, terGrossValue: 0.65 }, {})).toEqual({ gross: 0.65, net: 0.6 });
    const root = await tempRoot();
    try {
      await seed(root);
      await quietRun(root, { TICKERS: 'ASHR' });
      const row = await rowOf(root, 'ASHR');
      expect(row).toMatchObject({ terValue: 0.6, terGrossValue: 0.65, dataFile: './funds/ASHR/meta.json' });
      // PDP down on the next run: the retained row keeps the same net and gross numbers
      await quietRun(root, { TICKERS: 'ASHR' }, fakeFetch(['/pdpMetaTagsTealium']));
      expect(await rowOf(root, 'ASHR')).toMatchObject({ terValue: 0.6, terGrossValue: 0.65 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('an official distribution rate of 0 with payments in the last 12 months falls back to trailing distributions', async () => {
    expect(trailingYearYield([dividend('2025-12-19', 1.25), dividend('2024-01-01', 9)], '2026-09-30', 50)).toBe(2.5);
    expect(trailingYearYield([dividend('2024-01-01', 9)], '2026-09-30', 50)).toBeNull();
    const root = await tempRoot();
    try {
      await seed(root);
      const zeroRate = override(fakeFetch(), url => url.includes('/pdpMetaTagsTealium'), url => Response.json(pdp(/\/etfus\/([A-Z]+)\//.exec(url)![1], { rate: '0%' })));
      await quietRun(root, { TICKERS: 'ASHR' }, zeroRate);
      const paid = await rowOf(root, 'ASHR');
      expect(Number(record(paid.metrics).dividendYield)).toBeGreaterThan(0); // 0.2 paid on 09/01/2026 over NAV 32.56
      expect(record((await Bun.file(join(root, 'funds', 'ASHR', 'meta.json')).json()).yields).dividendYieldKind).toContain('trailing 12-month');
      const noPayments = override(zeroRate, url => url.includes('/Distributions'), url => new Response(literalWorkbook([...META_ROWS(/etf\/([A-Z]+)\//.exec(url)![1]), ['Ex-Date', 'Record date', 'Pay date', 'US$ / Share']])));
      const rootTwo = await tempRoot();
      try {
        await seed(rootTwo);
        await quietRun(rootTwo, { TICKERS: 'DBEF' }, noPayments);
        expect(record((await rowOf(rootTwo, 'DBEF')).metrics).dividendYield).toBe(0); // a published 0.00% with no payments stays and says so
        expect(record((await Bun.file(join(rootTwo, 'funds', 'DBEF', 'meta.json')).json()).yields).dividendYieldKind).toContain('no distributions in the last 12 months');
      } finally { await rm(rootTwo, { recursive: true, force: true }); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('quarterEnd is the last completed quarter-end, and equals monthEnd only when the data ends on a quarter-end', () => {
    expect(reportingPeriodEnds('2026-08-15')).toEqual({ monthEnd: '2026-07-31', quarterEnd: '2026-06-30' });
    expect(reportingPeriodEnds('2026-09-30')).toEqual({ monthEnd: '2026-09-30', quarterEnd: '2026-09-30' });
    expect(reportingPeriodEnds('2026-10-02')).toEqual({ monthEnd: '2026-09-30', quarterEnd: '2026-09-30' });
  });
});

describe('index integrity and notices', () => {
  test('an all-providers outage never writes an empty {} row into index.json', async () => {
    const root = await tempRoot();
    try {
      await seed(root);
      await quietRun(root, { TICKERS: 'ASHR' });
      // the published row vanished but the fund files remain: with every provider down nothing may replace the catalog stub by {}
      const index = await Bun.file(join(root, 'index.json')).json();
      index.funds = index.funds.filter((row: JsonRecord) => row.ticker !== 'ASHR');
      await Bun.write(join(root, 'index.json'), JSON.stringify(index));
      await quietRun(root, { TICKERS: 'ASHR' }, async url => url.endsWith('/en-us/sitemap.xml') ? new Response(SITEMAP) : url.includes('downloadxls/') ? new Response(EMPTY_CATALOG) : new Response('down', { status: 403 }));
      const rows = await indexOf(root);
      expect(rows.every(row => typeof row.ticker === 'string' && row.ticker.length > 0)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('rows without meta.json have dataFile null and a full metrics object; rows with it use the ./ prefix', async () => {
    const root = await tempRoot();
    try {
      await seed(root);
      await quietRun(root, { TICKERS: 'ASHR' });
      const stub = await rowOf(root, 'CHPS');
      expect(stub.dataFile).toBeNull();
      expect(Object.keys(record(stub.metrics))).toEqual(expect.arrayContaining(['ytd', 'tr1y', 'tr3y', 'tr5y', 'tr10y', 'cagr3y', 'cagr5y', 'cagr10y', 'siAnn', 'dividendYield', 'dividendYieldText', 'secYield', 'secYieldText', 'returnsBasis', 'performanceAsOf']));
      expect((await rowOf(root, 'ASHR')).dataFile).toBe('./funds/ASHR/meta.json');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('NEW FUNDS are printed and listed in the step summary', async () => {
    const root = await tempRoot();
    try {
      await seed(root);
      const withNew = override(fakeFetch(), url => url.endsWith('/en-us/sitemap.xml'), () => new Response(SITEMAP.replace('</urlset>', '<url><loc>https://etf.dws.com/en-us/NEWX-xtrackers-test-etf/</loc></url></urlset>')));
      const lines: string[] = [];
      const log = console.log, warn = console.warn; console.log = (...args: unknown[]) => { lines.push(args.join(' ')); }; console.warn = () => {};
      let result; try { result = await runUpdater(readConfig({ TICKERS: 'ASHR', REQUEST_SLEEP: '0' }), { root, fetcher: withNew }); } finally { console.log = log; console.warn = warn; }
      expect(result.newFunds).toEqual(['NEWX']);
      expect(lines.some(line => line.includes('NEW FUNDS: NEWX'))).toBe(true);
      expect(renderUpdateSummary(readConfig({}), result)).toContain('NEW FUNDS: NEWX');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('an older SEC filing never replaces fresher published holdings', async () => {
    const root = await tempRoot();
    try {
      await seed(root);
      await quietRun(root, { TICKERS: 'HYLB' }); // published holdings dated 2026-09-29
      await quietRun(root, { TICKERS: 'HYLB' }, fakeFetch(['/HYLB/Securities'], NPORT)); // filing report date 2026-08-31
      const meta = await Bun.file(join(root, 'funds', 'HYLB', 'meta.json')).json();
      expect(record(meta.source).holdingsSource).not.toContain('primary_doc.xml');
      expect(record(meta.holdings).asOfDate).toBe('2026-09-29');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
