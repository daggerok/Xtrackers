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
