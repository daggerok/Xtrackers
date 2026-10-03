/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { readFileSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import {
  CONTROL_NAMES, DEFAULT_SEC_UA, SOFT_DEADLINE_MS, resolveControls, runtimeControls, readConfig, parseRange, parseAumRange, inRange,
  fundFilterReasons, mergeDetails, outputConfigEntries, createRequestGate, fetchWithRetry,
  HttpError, samePublishedContent, writeJsonIfChanged, selectUpdateBatch, runUpdater, indexRowForCatalog, parseNport,
  parseFundTickerMap, parseCompanyTickerMap, parseNportAccessions, parseEdgarAtomFilings, matchesNportFund, fillNportTickers,
  reinvestmentCoverageStart, reportingPeriodEnds, coalesceReturns, annualizedOfficialReturns, renderUpdateSummary, writeSummary,
  historyWindowStartEpoch, yahooChartUrl, windowByHistoryRange, parseHistoryRange,
  annualizedToTotal, totalToAnnualized, indicatedYield, distributionFrequency,
  numberOrNull, toIsoDate, parseSharedStrings, parseWorksheetXml, readZipEntries, parseXlsxSheet,
  parseCatalogRows, parseSitemap, parseFundDetails, parseHoldingsRows, parseDistributionsRows,
  parseNavRows, parseChart, returnHeaderSlot, parseReturnRow, emptyReturns, navTotalReturnDays,
  deriveReturns, historySheet, pageManifest, exportUrl, detailsUrl, yahooSourceUrl, record, array,
  isCertError, installSystemCa, deriveCatalogMetrics, expenseFields, previousExpenses, latestSamePair, trailingYearYield,
  type Dividend, type ChartDay, type Fetcher, type FundDetails, type JsonRecord,
} from './update-data';

// ---------------------------------------------------------------------------
// Shared setup: clean environment, pinned TZ, restored fetch / exit code / console / AbortSignal
// ---------------------------------------------------------------------------
const scriptsDir = new URL('.', import.meta.url).pathname;
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const configFile = (): Record<string, string> => JSON.parse(read('scripts/update-data.config.json'));
const realFetch = globalThis.fetch;
const realExitCode = process.exitCode;
const realConsole = { log: console.log, warn: console.warn, error: console.error };
const realAbortTimeout = AbortSignal.timeout;
const savedEnv = { ...process.env };
const tempDirs: string[] = [];
const isControlVar = (key: string): boolean =>
  (CONTROL_NAMES as readonly string[]).includes(key) || ['NODE_USE_SYSTEM_CA', 'ETF_UPDATER_SYSTEM_CA', 'GITHUB_STEP_SUMMARY'].includes(key);

beforeEach(() => {
  for (const key of Object.keys(process.env)) if (isControlVar(key)) delete process.env[key];
  process.env.TZ = 'UTC';
});
afterEach(() => {
  globalThis.fetch = realFetch;
  AbortSignal.timeout = realAbortTimeout;
  process.exitCode = realExitCode ?? 0;
  Object.assign(console, realConsole);
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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
const override = (base: Fetcher, match: (url: string) => boolean, make: (url: string) => Response): Fetcher => (url, init) => match(url) ? Promise.resolve(make(url)) : base(url, init);
async function tempRoot(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), 'xtrackers-tests-')); tempDirs.push(dir); return dir; }
async function hashes(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (dir: string, prefix = ''): Promise<void> => {
    for (const file of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix + file.name;
      if (file.isDirectory()) await walk(join(dir, file.name), path + '/');
      else files[path] = createHash('sha256').update(await readFile(join(dir, file.name))).digest('hex');
    }
  };
  await walk(root); return files;
}
const backdate = (root: string): void => { for (const path of Object.keys(readTree(root))) utimesSync(join(root, path), 1_000_000_000, 1_000_000_000); };
const touched = (root: string): string[] => Object.keys(readTree(root)).filter(path => statSync(join(root, path)).mtimeMs !== 1_000_000_000_000);
function readTree(root: string, prefix = ''): Record<string, true> {
  const out: Record<string, true> = {};
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, readTree(root, path)); else out[path] = true;
  }
  return out;
}
async function quietRun(root: string, env: Record<string, string> = {}, fetcher: Fetcher = fakeFetch()) {
  console.log = () => {}; console.warn = () => {};
  try { return await runUpdater(readConfig({ TICKERS: 'ASHR DBEF HYLB', REQUEST_SLEEP: '0', MAX_RETRIES: '1', ...env }), { root, fetcher }); }
  finally { Object.assign(console, realConsole); }
}
async function seed(root: string): Promise<void> {
  const funds = parseSitemap(SITEMAP).map(indexRowForCatalog);
  // Delisted/old catalog entries and unselected files are never deleted.
  funds.push({ ...indexRowForCatalog({ ticker: 'RETD', name: 'Retired test fund', category: 'Equities', fundPage: 'https://etf.dws.com/en-us/RETD-test-etf/', inceptionDate: null, terValue: null, netTerValue: null, aumValue: null, officialReturns: emptyReturns() }), customSentinel: 'preserve byte-for-byte' });
  await writeJsonIfChanged(join(root, 'index.json'), { provider: 'Xtrackers (DWS)', generatedAt: '2026-09-01', source: {}, counts: { funds: funds.length, holdings: 0, history: 0 }, funds });
  await mkdir(join(root, 'funds', 'CHPS'), { recursive: true });
  await Bun.write(join(root, 'funds', 'CHPS', 'untouched.json'), '{"sentinel":true}\n');
}
async function seeded(): Promise<string> { const root = await tempRoot(); await seed(root); return root; }
const indexOf = async (root: string): Promise<JsonRecord[]> => array((await Bun.file(join(root, 'index.json')).json()).funds).map(record);
const rowOf = async (root: string, ticker: string): Promise<JsonRecord> => (await indexOf(root)).find(row => row.ticker === ticker)!;
const metaOf = async (root: string, ticker: string): Promise<JsonRecord> => Bun.file(join(root, 'funds', ticker, 'meta.json')).json();

// ===========================================================================
describe('controls', () => {
  test('precedence: file < advanced < nonblank input < explicitly set env; blank input inherits, advanced and an empty env var clear', () => {
    const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'ASHR' }, { CONCURRENCY: 3, TICKERS: 'HYLB' }, { CONCURRENCY: '4', TICKERS: '' }, { CONCURRENCY: '6' });
    expect([c.CONCURRENCY, c.TICKERS]).toEqual(['6', 'HYLB']);
    expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
    expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }).CONCURRENCY).toBe('3');
    expect(resolveControls({ VERBOSE: true }, {}, {}, { VERBOSE: 'false' }).VERBOSE).toBe('false');
    expect(resolveControls({ MAX_FETCHES: 5 }, {}, {}, { MAX_FETCHES: '0' }).MAX_FETCHES).toBe('0');
    expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '' }).CONCURRENCY).toBe('2');
    expect(resolveControls({ TICKERS: 'ASHR' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
    expect(resolveControls({ CONCURRENCY: 2 }, {}, {}, { CONCURRENCY: undefined }).CONCURRENCY).toBe('2');
    const cleared = resolveControls({ TICKERS: 'ASHR', CONCURRENCY: 5, SEC_UA: 'file ua' }, {}, {}, { TICKERS: '', CONCURRENCY: '  ', SEC_UA: '' });
    expect([cleared.TICKERS, cleared.CONCURRENCY, cleared.SEC_UA]).toEqual(['', '', '']);
    const config = readConfig(cleared);
    expect([config.tickers.size, config.concurrency, config.secUa]).toEqual([0, 2, DEFAULT_SEC_UA]);
  });

  test('strict validation: bad ranges, HISTORY_RANGE, MAX_RETRIES < 1, unknown keys, non-scalars, booleans, CR/LF/NUL', () => {
    for (const value of [
      { UNKNOWN: 1 }, { OUTPUT_DIR: '/tmp' }, { SEC_UA: 'x\nEVIL=yes' }, { CONCURRENCY: 0 }, { MAX_RETRIES: 0 }, { MAX_RETRIES: -1 }, { MAX_FETCHES: 1.5 },
      { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' }, { SKIP_YAHOO: 'maybe' }, { EDGAR_FALLBACK: 'x' }, { HISTORY_RANGE: '5' }, { HISTORY_RANGE: '0y' },
      { AUM: '1:2:3' }, { TER: '5:1' }, { TICKERS: ['ASHR'] }, { TICKERS: '../ASHR' }, { PERFORMANCE_1Y: 'x:y' }, { USE_SYSTEM_CA: 'maybe' }, null, [],
    ]) expect(() => resolveControls(value)).toThrow();
    expect(() => resolveControls({}, { SEC_UA: 'x\rfoo' })).toThrow();
    expect(() => resolveControls({}, {}, {}, { SEC_UA: 'x\0bad' })).toThrow();
    expect(() => resolveControls({}, {}, { TICKERS: { a: 1 } })).toThrow();
    expect(() => resolveControls({}, 'x')).toThrow();
    for (const [key, value] of [['CONCURRENCY', '0'], ['MAX_RETRIES', '0'], ['MAX_FETCHES', '-1'], ['REQUEST_SLEEP', 'NaN'], ['TICKERS', '../ASHR'], ['SEC_UA', 'contact\nx-test: bad'], ['VERBOSE', 'maybe'], ['HISTORY_RANGE', 'forever'], ['USE_SYSTEM_CA', 'maybe']]) {
      expect(() => readConfig({ [key]: value })).toThrow(key);
    }
    expect(readConfig({ TICKERS: 'ashr, HYLB; DBEF' }).tickers).toEqual(new Set(['ASHR', 'HYLB', 'DBEF']));
    const config = readConfig({ MAX_RETRIES: '1', REQUEST_SLEEP: '0', VERBOSE: 'yes', SKIP_YAHOO: 'on', EDGAR_FALLBACK: 'off', HISTORY_RANGE: '5Y' });
    expect([config.verbose, config.skipYahoo, config.edgarFallback, config.historyRange, parseHistoryRange('max')]).toEqual([true, true, false, '5y', 'max']);
  });

  test('config file: keys equal CONTROL_NAMES and --help, values are strings, the scheduled path equals the defaults, SEC_UA defaults', async () => {
    const file = configFile();
    expect(Object.keys(file).sort()).toEqual([...CONTROL_NAMES].sort());
    expect(Object.values(file).every(value => typeof value === 'string')).toBe(true);
    expect(resolveControls(file, {}, {}, {})).toEqual(file);
    expect(await runtimeControls({})).toEqual(file);
    expect((await runtimeControls({ CONCURRENCY: '1', SEC_UA: 'protected contact' })).SEC_UA).toBe('protected contact');
    await expect(runtimeControls({ CONCURRENCY: '0' })).rejects.toThrow('CONCURRENCY');
    const config = readConfig(resolveControls(file));
    expect([config.tickers.size, config.maxFetches, config.requestSleepSeconds, config.concurrency, config.holdingsPageSize, config.historyPageSize, config.maxRetries, config.historyRange]).toEqual([0, 0, 1.5, 2, 250, 1000, 2, 'max']);
    expect([config.skipYahoo, config.edgarFallback, config.verbose, config.secUa]).toEqual([false, true, false, 'daggerok ETF feed daggerok@gmail.com']);
    expect([DEFAULT_SEC_UA, file.SEC_UA]).toEqual(['daggerok ETF feed daggerok@gmail.com', 'daggerok ETF feed daggerok@gmail.com']);
    expect(Object.entries(file).filter(([key, value]) => key !== 'SEC_UA' && /@/.test(value))).toEqual([]);
    expect(resolveControls(file, { SEC_UA: 'adv' }, { SEC_UA: 'in' }, { SEC_UA: 'protected' }).SEC_UA).toBe('protected');
    expect(resolveControls(file, { SEC_UA: 'adv' }, { SEC_UA: 'in' }, {}).SEC_UA).toBe('in');
    const entries = outputConfigEntries(readConfig({}));
    expect(entries.map(([key]) => key).sort()).toEqual([...CONTROL_NAMES].sort());
    const command = Bun.spawn([process.execPath, join(scriptsDir, 'update-data.ts'), '--help'], { cwd: tmpdir(), stdout: 'pipe', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } });
    const help = await new Response(command.stdout).text();
    expect(await command.exited).toBe(0);
    for (const name of CONTROL_NAMES) expect(help).toContain(`${name}=`);
    expect(help).toContain('MAX_RETRIES: retries after the initial request, integer >= 1');
  });

  test('a real bootstrap uses the edited adjacent config, ENOENT keeps the built-in defaults, malformed JSON or unknown keys fail', async () => {
    const root = await tempRoot();
    const script = join(root, 'scripts', 'update-data.ts'), file = join(root, 'scripts', 'update-data.config.json');
    await Bun.write(script, await Bun.file(new URL('./update-data.ts', import.meta.url)).text());
    await Bun.write(file, JSON.stringify({ ...configFile(), REQUEST_SLEEP: '2.5', CONCURRENCY: '3', TICKERS: 'HYLB', HISTORY_RANGE: '5y' }));
    const evaluate = async (env: Record<string, string | undefined>) => {
      const code = `const m=await import(${JSON.stringify(script)});const c=m.readConfig(await m.runtimeControls());console.log(JSON.stringify({sleep:c.requestSleepSeconds,lanes:c.concurrency,tickers:[...c.tickers],range:c.historyRange}));`;
      const child = Bun.spawn([process.execPath, '-e', code], { cwd: tmpdir(), env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env } as Record<string, string>, stdout: 'pipe', stderr: 'pipe' });
      const text = await new Response(child.stdout).text(), error = await new Response(child.stderr).text();
      return { text, error, status: await child.exited };
    };
    const defaults = await evaluate({}); expect([defaults.status, defaults.error]).toEqual([0, '']);
    expect(JSON.parse(defaults.text)).toEqual({ sleep: 2.5, lanes: 3, tickers: ['HYLB'], range: '5y' });
    expect(JSON.parse((await evaluate({ REQUEST_SLEEP: '0', CONCURRENCY: '1', TICKERS: 'ASHR DBEF', HISTORY_RANGE: 'max' })).text)).toEqual({ sleep: 0, lanes: 1, tickers: ['ASHR', 'DBEF'], range: 'max' });
    expect(JSON.parse((await evaluate({ TICKERS: '', CONCURRENCY: '' })).text)).toEqual({ sleep: 2.5, lanes: 2, tickers: [], range: '5y' });
    await rm(file);
    const missing = await evaluate({});
    expect([missing.status, JSON.parse(missing.text)]).toEqual([0, { sleep: 1.5, lanes: 2, tickers: [], range: 'max' }]);
    await Bun.write(file, '{ invalid');
    const malformed = await evaluate({});
    expect([malformed.status === 0, malformed.text]).toEqual([false, '']);
    await Bun.write(file, '{"UNKNOWN":"1"}');
    expect((await evaluate({})).status).not.toBe(0);
  });

  test('ranges are ANDed; true zero and missing data differ; AUM presets respect boundaries; missing current facts retain published ones', () => {
    expect(parseRange('-5:0')).toMatchObject({ min: -5, max: 0 });
    expect(() => parseRange('5')).toThrow('min:max');
    expect(() => parseRange('5:4')).toThrow('bounds');
    expect([inRange(0, parseRange(':0')), inRange(null, parseRange(':0'))]).toEqual([true, false]);
    expect(parseAumRange('1B:2B')).toMatchObject({ min: 1e9, max: 2e9 });
    expect([inRange(10e6, parseAumRange('nano')), inRange(10e6, parseAumRange('micro')), inRange(300e6, parseAumRange('small')), inRange(2e9, parseAumRange('mid')), inRange(10e9, parseAumRange('large'))]).toEqual([false, true, true, true, true]);
    expect(() => parseAumRange('unknown')).toThrow('AUM');
    const details = parseFundDetails(pdp('ASHR'), 'ASHR', 'https://etf.dws.com/en-us/');
    const config = readConfig({ TICKERS: 'ASHR', AUM: '2B:', TER: ':0.5', DIVIDEND_YIELD: '3:', SEC_YIELD: '2:', PERFORMANCE_1Y: '1:', TOTAL_RETURN_3Y: '2:' });
    expect(fundFilterReasons(details, { dividendYield: 2.33, secYield: 1.37, tr1y: 0, tr3y: 0 }, config)).toEqual(['AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD', 'PERFORMANCE_1Y', 'TOTAL_RETURN_3Y']);
    const merged = mergeDetails({ ...details, aumValue: null, terValue: 0, secYield: null, frequency: null } as FundDetails, details);
    expect([merged.aumValue, merged.terValue, merged.secYield]).toEqual([details.aumValue, 0, 1.37]);
  });

  test('HISTORY_RANGE maps to the Yahoo request window and to the published history rows', () => {
    const now = Date.parse('2026-10-01T00:00:00Z') / 1000;
    expect([historyWindowStartEpoch('max', now), historyWindowStartEpoch('5y', now)]).toEqual([0, Math.floor(now - 5 * 365.25 * 86400)]);
    expect(yahooChartUrl('ASHR', now)).toContain('period1=0&period2=' + now);
    expect(yahooChartUrl('ASHR', now, '1y')).toContain(`period1=${Math.floor(now - 365.25 * 86400)}&period2=${now}`);
    const items = ['2020-01-01', '2025-10-02', '2026-09-30'].map(date => ({ date }));
    expect(windowByHistoryRange(items, 'max', now)).toEqual(items);
    expect(windowByHistoryRange(items, '1y', now).map(i => i.date)).toEqual(['2025-10-02', '2026-09-30']);
    expect(windowByHistoryRange(items, '1y', Date.parse('2040-01-01T00:00:00Z') / 1000)).toEqual(items);
  });

  test('bounded cursor rotates only a deterministic selected universe, a full pass ignores the cursor', () => {
    const funds = ['HYLB', 'ASHR', 'DBEF'].map(ticker => ({ ticker }));
    expect(selectUpdateBatch(funds, 2, 'DBEF').map(f => f.ticker)).toEqual(['HYLB', 'ASHR']);
    expect(selectUpdateBatch(funds, 0, 'DBEF').map(f => f.ticker)).toEqual(['ASHR', 'DBEF', 'HYLB']);
    expect(selectUpdateBatch(funds, 1, 'missing').map(f => f.ticker)).toEqual(['ASHR']);
  });

  test('USE_SYSTEM_CA: auto by default, case-insensitive, restart only on certificate errors', async () => {
    expect(configFile().USE_SYSTEM_CA).toBe('auto');
    expect(readConfig({}).useSystemCa).toBe('auto');
    for (const mode of ['auto', 'true', 'false', 'AUTO', 'True', 'FALSE']) expect(readConfig({ USE_SYSTEM_CA: mode }).useSystemCa).toBe(mode.toLowerCase());
    expect(isCertError({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' })).toBe(true);
    expect(isCertError(Object.assign(new Error('fetch failed'), { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } }))).toBe(true);
    expect([isCertError({ code: 'ECONNRESET' }), isCertError(new Error('HTTP 403 Forbidden')), isCertError(null)]).toEqual([false, false, false]);
    console.error = () => {};
    let restarts = 0;
    const reexec = ((): never => { restarts++; throw new Error('reexec'); }) as () => never;
    installSystemCa('false', reexec, false);
    installSystemCa('auto', reexec, true);
    installSystemCa('true', reexec, true);
    expect([globalThis.fetch === realFetch, restarts]).toEqual([true, 0]);
    expect(() => installSystemCa('true', reexec, false)).toThrow('reexec');
    const responses: Array<() => Promise<Response>> = [
      async () => new Response('ok'),
      async () => { throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }); },
      async () => { throw Object.assign(new Error('x'), { cause: new Error('unable to get local issuer certificate') }); },
    ];
    let index = 0;
    globalThis.fetch = (async () => responses[index++]()) as unknown as typeof fetch;
    installSystemCa('auto', reexec, false);
    expect(await (await fetch('https://example.test/')).text()).toBe('ok');
    await expect(fetch('https://example.test/')).rejects.toThrow('fetch failed');
    expect(restarts).toBe(1);
    await expect(fetch('https://example.test/')).rejects.toThrow('reexec');
    expect(restarts).toBe(2);
  });
});

// ===========================================================================
describe('parsing', () => {
  test('numbers keep zero and negatives, placeholders are null (never 0); dates are UTC and validated', () => {
    expect([0, '0', '-1.25%', '($1,234.5)', ' $2,500.25 ', null, undefined, '', ' ', '—', '--', 'N/A', 'garbage'].map(numberOrNull))
      .toEqual([0, 0, -1.25, -1234.5, 2500.25, null, null, null, null, null, null, null, null]);
    expect(['46294', '09/29/2026', 'Sep 29, 2026', '2026-09-29T00:00:00', '2026-02-30', '99/99/2026', '12', ''].map(toIsoDate))
      .toEqual(['2026-09-29', '2026-09-29', '2026-09-29', '2026-09-29', null, null, null, null]);
  });

  test('the zero-dependency OpenXML reader handles rich strings, entities, sparse columns, cached formulas, and rejects bad archives', () => {
    const strings = parseSharedStrings('<sst><si><r><t>A &amp; </t></r><r><t>B</t></r></si><si/><si><t>&#x41;&#66;</t></si></sst>');
    expect(strings).toEqual(['A & B', '', 'AB']);
    const rows = parseWorksheetXml('<sheetData><row r="1"><c r="B1" t="s"><v>0</v></c><c r="D1" t="inlineStr"><is><t>001280</t></is></c><c r="F1"><f>1-1</f><v>0</v></c><c r="G1" t="e"><v>#N/A</v></c><c r="AA1"><v>-3</v></c></row><row/></sheetData>', strings);
    expect([rows[0][0], rows[0][1], rows[0][3], rows[0][5], rows[0][6], rows[0][26], rows[1]]).toEqual(['', 'A & B', '001280', '0', '', '-3', []]);
    expect(() => readZipEntries(new TextEncoder().encode('<html>403</html>'))).toThrow('ZIP');
    const bytes = syntheticWorkbook('ASHR', 'Securities');
    expect(() => readZipEntries(bytes.subarray(0, bytes.length - 30))).toThrow('ZIP');
    expect(readZipEntries(bytes).has('xl/worksheets/sheet1.xml')).toBe(true);
    expect(parseXlsxSheet(bytes)[0]).toEqual(['Ticker:', 'ASHR']);
  });

  test('catalog: an empty workbook, the US sitemap only (no EU products, promos, remote hosts, bad tickers), percentages not fractions', () => {
    expect(parseCatalogRows(parseXlsxSheet(EMPTY_CATALOG))).toEqual([]);
    const funds = parseSitemap(SITEMAP);
    expect(funds.map(f => f.ticker)).toEqual(SITEMAP_TICKERS);
    expect(funds.every(f => f.name === null && f.terValue === null)).toBe(true);
    const xml = '<urlset><loc>https://etf.dws.com/en-us/ASHR-test-etf/</loc><loc>https://etf.dws.com/en-us/ASHR-test-etf/</loc><loc>https://etf.dws.com/en-gb/IE123-test-etf/</loc><loc>https://evil.test/en-us/ASHR-test-etf/</loc><loc>https://etf.dws.com/en-us/etf-products/</loc></urlset>';
    expect(parseSitemap(xml).map(f => f.ticker)).toEqual(['ASHR']);
    const rows = parseCatalogRows([
      ['Product List'],
      ['Fund name', 'Ticker', 'Asset class', 'YTD (%)', '1Y (%)', '5Y (%)', '10Y (%)', 'Performance in % since Inception', 'Sub-fund launch', 'Gross expenses (%)', 'Net expenses (%)', 'Total net assets ($)'],
      ['Xtrackers Test ETF', 'TEST', 'Equities', '0', '-4.2', '5', '', '8', '09/01/2015', '0.4', '0.3', '1200000000'],
      ['© DWS'],
    ], '2026-08-31');
    expect([rows.length, rows[0].terValue, rows[0].aumValue]).toEqual([1, 0.4, 1200000000]);
    expect(rows[0].officialReturns).toEqual({ ...emptyReturns(), asOfDate: '2026-08-31', ytd: 0, yr1: -4.2, yr5: 5, sinceInception: 8 });
  });

  test('typed return mapping: every tenor, reordered headers, zero, negative, null and missing values', () => {
    expect(['YTD', '1Y (%)', '3Y', '5Y', '10Y', 'Since inception', 'Since launch', 'asOfDate', '2Y', 'Unknown'].map(h => returnHeaderSlot(h.replace(/\(%\)/g, ''))))
      .toEqual(['ytd', 'yr1', 'yr3', 'yr5', 'yr10', 'sinceInception', 'sinceInception', null, null, null]);
    expect(parseReturnRow(['10Y', 'YTD', '5Y', '1Y', 'Since inception', '3Y', 'Unknown'], [4.2, 0, -5, null, '6%', undefined, 999], '2026-08-31'))
      .toEqual({ asOfDate: '2026-08-31', ytd: 0, yr1: null, yr3: null, yr5: -5, yr10: 4.2, sinceInception: 6 });
    expect(parseReturnRow(['asOfDate', '1Y'], [123, ''], 'unchanged-string').asOfDate).toBe('unchanged-string');
  });

  test('PDP details: legal name, exact AUM, gross and net costs, NAV, date, frequency, identifiers, yields, annualized returns only', () => {
    const details = parseFundDetails(pdp('ASHR', { name: 'Xtrackers Harvest CSI 300 China A-Shares ETF' }), 'ASHR', 'https://etf.dws.com/en-us/');
    expect([details.name, details.aumValue, details.terValue, details.netTerValue, details.navValue, details.navAsOfDate]).toEqual(['Xtrackers Harvest CSI 300 China A-Shares ETF', 1387217695, 0.65, 0.6, 32.56, '2026-09-29']);
    expect([details.secYield, details.distributionRate, details.frequency, details.inceptionDate, details.cusip, details.isin, details.indexTicker, details.midpoint, details.fundPage])
      .toEqual([1.37, 2.33, 'Annual', '2013-11-06', '233051879', 'US2330518794', 'CSIN0301', 32.66, 'https://etf.dws.com/en-us/ASHR-xtrackers-test-etf/']);
    // Only the named annualized table supplies returns; Morningstar stars and the discrete table are ignored.
    expect(details.officialReturns).toEqual({ ...emptyReturns(), asOfDate: '2026-09-30', ytd: 1.5, yr1: -2, yr5: 0 });
    expect(parseFundDetails(pdp('DBEF', { classes: ['Currency-hedged', 'Equities', 'International'] }), 'DBEF', 'https://etf.dws.com/en-us/').category).toBe('Currency-hedged / Equities / International');
    expect(() => parseFundDetails({}, 'ASHR', '')).toThrow('PDP');
    expect(() => parseFundDetails(pdp('ASHR'), 'HYLB', '')).toThrow('PDP');
  });

  test('holdings keep source symbols with leading zeros, identifiers, placeholders and cash; reordered headers and wrong tickers are handled', () => {
    const sheet = parseHoldingsRows(parseXlsxSheet(syntheticWorkbook('ASHR', 'Securities')), 'ASHR');
    expect([sheet.asOfDate, sheet.rows.length]).toEqual(['2026-09-29', 2]);
    expect(sheet.rows[0]).toMatchObject({ Name: 'ASHR test position', Ticker: '001280', Identifier: '000000001', Weight: '99' });
    expect(sheet.rows[1]).toMatchObject({ Ticker: '-', Weight: '-1' });
    expect(parseHoldingsRows([...META_ROWS('ASHR'), ['Name', 'Weight %', '$ Market Value'], ['Cash & Cash Equivalents', '1', '5']], 'ASHR').rows[0]).toMatchObject({ Ticker: '-', 'Asset Category': 'Cash' });
    const rows = [['Ticker:', 'BOND'], ['As of:', '09/29/2026'],
      ['Name', '$ Market Value', 'Weight %', 'Symbol', 'ISIN', 'CUSIP', 'SEDOL', 'Quantity', 'Asset Class'],
      ['Corporate bond', '200', '2', 'ISSUER', 'US1234567890', '012345678', '', '10', 'Fixed Income'],
      ['FX forward', '-50', '-0.5', 'EURUSD', '', '', '', '-2', 'Forward'],
      ['Subtotal', '', '', '', '', '', '', '', '']];
    const bond = parseHoldingsRows(rows, 'BOND');
    expect([bond.rows.length, bond.rows[0].Ticker, bond.rows[0].Identifier, bond.rows[1].Weight]).toEqual([2, '-', '012345678', '-0.5']);
    expect(() => parseHoldingsRows(rows, 'WRONG')).toThrow('ticker mismatch');
    expect(() => parseHoldingsRows([['Ticker:', 'ASHR'], ['Name', 'Weight %', '$ Market Value']], 'ASHR')).toThrow('no usable');
  });

  test('distributions retain zero events, are chronological with the latest positive amount; daily NAV is not confused with a growth chart', () => {
    const events = parseDistributionsRows([...META_ROWS('ASHR'), ['Ex-Date', 'Record date', 'Pay date', 'US$ / Share'],
      ['12/19/2025', '12/19/2025', '12/29/2025', '0.75811'], ['06/20/2025', '', '', '0'], ['12/19/2025', '12/19/2025', '12/29/2025', '0.75811']], 'ASHR');
    expect([events.length, events.some(d => d.amount === 0)]).toEqual([2, true]);
    expect(events.filter(d => d.amount > 0).at(-1)).toMatchObject({ exDate: '2025-12-19', amount: 0.75811, payDate: '2025-12-29' });
    expect(events.map(d => d.epoch)).toEqual(events.map(d => d.epoch).sort((a, b) => a - b));
    expect(() => parseDistributionsRows([...META_ROWS('ASHR'), ['Ex-Date', 'US$ / Share'], ['12/19/2025', '1'], ['12/19/2025', '2']], 'ASHR')).toThrow('ambiguous');
    expect(() => parseDistributionsRows([['Ticker:', 'ASHR']], 'ASHR')).toThrow('headers');
    const nav = parseNavRows(parseXlsxSheet(syntheticWorkbook('ASHR', 'Performance')), 'ASHR');
    expect(nav).toHaveLength(3);
    expect(nav[0]).toMatchObject({ date: '2026-08-31', nav: 35, aum: 100, shares: 10 });
    expect(nav.at(-1)).toMatchObject({ date: '2026-09-29', nav: 35.29 });
    expect(() => parseNavRows([['Ticker:', 'ASHR'], ['Date', 'Cumulative growth'], ['46294', '100']], 'ASHR')).toThrow('headers');
    expect(() => parseNavRows([['Ticker:', 'ASHR'], ['Date', 'NAV'], ['2026-09-29', '']], 'ASHR')).toThrow('no daily');
  });

  test('SEC: N-PORT identifiers and negative or zero weights, company mapping never gives bonds an equity ticker, exact series and trust', () => {
    const parsed = parseNport(NPORT), names = parseCompanyTickerMap({ 0: { ticker: 'ACME', title: 'ACME INC' } });
    expect([parsed.repPdDate, parsed.netAssets, parsed.holdings.length, parsed.holdings[0].Weight, parsed.holdings[1].Identifier, parsed.holdings[1].Weight]).toEqual(['2026-08-31', 3e9, 2, '0', 'US1234567890', '-0.5']);
    const filled = fillNportTickers(parsed.holdings, names);
    expect([filled[0].Ticker, filled[1].Ticker]).toEqual(['-', 'ACME']);
    expect(parseNport(NPORT.replace(/(<\/?)([a-zA-Z])/g, '$1n:$2')).holdings).toEqual(parsed.holdings);
    const map = parseFundTickerMap({ fields: ['symbol', 'classId', 'cik', 'seriesId'], data: [['HYLB', 'C000001', 1503123, 'S000001']] });
    expect(map.get('HYLB')).toEqual({ cik: '0001503123', seriesId: 'S000001', classId: 'C000001' });
    const catalogFund = { ticker: 'HYLB', name: 'Xtrackers USD High Yield Corporate Bond ETF', category: null, fundPage: '', inceptionDate: null, terValue: null, netTerValue: null, aumValue: null, officialReturns: emptyReturns() };
    const ref = map.get('HYLB') || null;
    expect([
      matchesNportFund(parsed, catalogFund, ref), matchesNportFund(parseNport(NPORT.replace('S000001', 'S000002')), catalogFund, ref),
      matchesNportFund(parseNport(NPORT.replace('<regCik>1503123', '<regCik>999999')), catalogFund, ref), matchesNportFund(parsed, catalogFund, null), matchesNportFund(parsed, { ...catalogFund, name: 'Another fund' }, null),
    ]).toEqual([true, false, false, true, false]);
    const accession = '0001503123-26-000001';
    expect(parseNportAccessions({ cik: 1503123, filings: { recent: { form: ['NPORT-P', '10-K'], accessionNumber: [accession, accession], filingDate: ['2026-09-01'], reportDate: ['2026-08-31'] } } })).toHaveLength(1);
    expect(parseEdgarAtomFilings(`<feed><entry><filing-type>NPORT-P</filing-type><accession-number>${accession}</accession-number><filing-href>https://www.sec.gov/Archives/edgar/data/1503123/x</filing-href></entry></feed>`)[0].url).toContain('/1503123/000150312326000001/primary_doc.xml');
  });

  test('page manifests cover zero rows and exact boundaries; the verified official URL namespaces stay case-correct', () => {
    const sheet = { headers: ['x'], asOfDate: null, rows: Array.from({ length: 501 }, () => ({ x: '' })) };
    expect(pageManifest('holdings', sheet, 250, 'official').pages).toEqual(['holdings/001.json', 'holdings/002.json', 'holdings/003.json']);
    expect(pageManifest('history', { ...sheet, rows: [] }, 1000, 'official').pages).toEqual([]);
    expect(() => pageManifest('holdings', sheet, 0, '')).toThrow('pageSize');
    expect(detailsUrl('HYLB')).toBe('https://etf.dws.com/api/pdp/en-us/etfus/HYLB/pdpMetaTagsTealium');
    expect(exportUrl('ASHR', 'Performance')).toBe('https://etf.dws.com/api/pdp/en-us/Export/etf/ASHR/Performance');
    expect(exportUrl('ASHR', 'Securities')).toBe('https://etf.dws.com/api/pdp/en-us/export/etf/ASHR/Securities');
  });

  test('Yahoo chart: adjusted closes rounded to 2 decimals, daily prices retained, a null close dropped', () => {
    const result = parseChart({ chart: { result: [{ meta: {}, timestamp: [1767225600, 1767312000], indicators: { quote: [{ close: [12.12345678, null], volume: [0, 12] }], adjclose: [{ adjclose: [11.98765432, 12] }] }, events: { dividends: { first: { date: 1767225600, amount: 0.5 } } } }] } });
    expect(result.days).toEqual([{ date: '2026-01-01', close: 12.123457, adjClose: 11.99, volume: 0 }]);
    expect(result.dividends[0].amount).toBe(0.5);
    expect(yahooSourceUrl('ASHR')).not.toContain('?');
    expect(() => parseChart({ chart: { result: null, error: {} } })).toThrow('empty');
  });
});

// ===========================================================================
describe('metrics', () => {
  const nav = (date: string, value: number) => ({ date, nav: value, aum: null, shares: null, dividend: null });
  const day = (date: string, close: number): ChartDay => ({ date, close, adjClose: close, volume: 1 });

  test('metrics end with returnsBasis then performanceAsOf, catalog-only rows included; performanceAsOf is null without a return figure', () => {
    const stub = indexRowForCatalog({ ticker: 'NEWF', name: 'New', category: null, fundPage: 'https://etf.dws.com/en-us/NEWF/', inceptionDate: null, terValue: null, netTerValue: null, aumValue: null, officialReturns: emptyReturns() });
    const stubMetrics = record(stub.metrics);
    expect(Object.keys(stubMetrics).slice(-2)).toEqual(['returnsBasis', 'performanceAsOf']);
    expect([String(stubMetrics.returnsBasis).includes('unavailable'), stubMetrics.performanceAsOf, stubMetrics.ytd]).toEqual([true, null, null]);
    const dated = indexRowForCatalog({ ticker: 'NEWF', name: 'New', category: null, fundPage: 'x', inceptionDate: null, terValue: null, netTerValue: null, aumValue: null, officialReturns: { ...emptyReturns(), asOfDate: '2026-09-30', ytd: 1.5 } });
    expect([record(dated.metrics).performanceAsOf, record(dated.metrics).ytd, String(record(dated.metrics).returnsBasis).includes('official DWS')]).toEqual(['2026-09-30', 1.5, true]);
    const none = { ...emptyReturns(), asOfDate: '2026-09-30' };
    expect(deriveCatalogMetrics(none, null, null, 'x').performanceAsOf).toBeNull();
    expect(deriveCatalogMetrics({ ...none, yr1: 4.2 }, null, null, 'x').performanceAsOf).toBe('2026-09-30');
  });

  test('a young or range-limited fund cannot claim long history or since-inception; stale anchors are not valid', () => {
    const days: ChartDay[] = ['2025-12-31', '2026-01-02', '2026-08-31'].map((date, i) => ({ date, close: 10 + i, adjClose: 10 + i, volume: 0 }));
    const returns = deriveReturns(days, '2026-08-31', '2015-01-01');
    expect([returns.ytd, returns.yr1, returns.yr3, returns.sinceInception]).toEqual([20, null, null, null]);
    expect(deriveReturns([], '2026-08-31')).toEqual(emptyReturns());
    const old = ['2024-12-01', '2026-08-31'].map(date => ({ date, close: 10, adjClose: 10, volume: 0 }));
    expect([deriveReturns(old, '2026-08-31').yr1, deriveReturns(old, '2026-08-31').ytd]).toEqual([null, null]);
    const points = ['2025-12-31', '2026-01-02', '2026-01-05'].map(date => nav(date, 10));
    expect(reinvestmentCoverageStart(points, [dividend('2026-01-01')])).toBe('2026-01-02');
  });

  test('NAV reinvestment is date-matched and does not double count, TR and CAGR are inverses with true zero, negatives and null', () => {
    const points = [nav('2026-01-01', 10), { ...nav('2026-01-02', 9), dividend: 1 }, nav('2026-01-03', 9.9)];
    expect(navTotalReturnDays(points, [dividend('2026-01-02')]).map(d => roundForTest(d.adjClose))).toEqual([10, 10, 11]);
    expect([annualizedToTotal(0, 3), annualizedToTotal(10, 3), totalToAnnualized(33.1, 3), annualizedToTotal(-10, 3), annualizedToTotal(null, 3), totalToAnnualized(-101, 3), annualizedToTotal(-101, 3), annualizedToTotal(-100, 3)])
      .toEqual([0, 33.1, 10, -27.1, null, null, null, -100]);
    expect([indicatedYield(0.5, 12, 100), indicatedYield(0, 12, 100), indicatedYield(1, 4, 0)]).toEqual([6, null, null]);
  });

  test('distribution frequency prioritizes the official value, zero distributions create no cadence', () => {
    expect(distributionFrequency('Annual', [])).toEqual({ frequency: 'Annually', paymentsPerYear: 1 });
    expect(distributionFrequency(null, [dividend('2026-01-01', 0)])).toEqual({ frequency: 'None', paymentsPerYear: null });
    expect(distributionFrequency(null, [dividend('2026-01-15'), dividend('2026-02-15'), dividend('2026-03-15')])).toEqual({ frequency: 'Monthly', paymentsPerYear: 12 });
    expect(distributionFrequency(null, [dividend('2026-01-15'), dividend('2026-01-20'), dividend('2026-03-15')]).frequency).toBe('Irregular');
  });

  test('history sheets never compute premium/discount from unmatched dates, the official schema ignores Yahoo half-cent noise, real corrections show', () => {
    const unmatched = historySheet([nav('2026-09-28', 10)], [day('2026-09-29', 11)]);
    expect([unmatched.rows.length, unmatched.rows.every(row => row['Premium/Discount'] === '')]).toEqual([2, true]);
    const points = [nav('2022-09-09', 34.71)];
    const first = [{ date: '2022-09-09', close: 34.709999, adjClose: 27.07, volume: 1867900 }];
    expect(historySheet(points, first).headers).toEqual(['Date', 'NAV', 'Market Price', 'Premium/Discount']);
    expect(historySheet(points, first)).toEqual(historySheet(points, [{ ...first[0], adjClose: 27.08 }]));
    expect(historySheet(points, first).rows[0]).toEqual({ Date: '2022-09-09', NAV: '34.71', 'Market Price': '34.709999', 'Premium/Discount': '0' });
    expect(historySheet(points, first)).not.toEqual(historySheet(points, [{ ...first[0], close: 35 }]));
    expect(historySheet([], first).headers).toEqual(['Date', 'Close', 'Adj Close', 'Volume']);
    expect(historySheet([], first).rows[0]['Adj Close']).toBe('27.07');
    expect(historySheet([], first)).not.toEqual(historySheet([], [{ ...first[0], adjClose: 27.08 }]));
  });

  test('official returns: undated zero or negative values stay undated, cumulative SI of young funds is not labelled annualized, periods follow source dates', () => {
    const primary = { ...emptyReturns(), ytd: 0, yr1: -2 };
    const derived = { ...emptyReturns(), asOfDate: '2026-08-31', ytd: 99, yr1: 99, yr3: 5, sinceInception: 7 };
    const combined = coalesceReturns(primary, derived);
    expect([combined.asOfDate, combined.ytd, combined.yr1, combined.yr3, combined.sinceInception]).toEqual([null, 0, -2, null, null]);
    expect(coalesceReturns(emptyReturns(), derived)).toEqual(derived);
    expect([coalesceReturns({ ...primary, asOfDate: '2026-08-31' }, derived).yr3, coalesceReturns({ ...primary, asOfDate: '2026-07-31' }, derived).yr3]).toEqual([5, null]);
    const source = { ...emptyReturns(), asOfDate: '2026-08-31', sinceInception: 0, yr1: -1 };
    expect([annualizedOfficialReturns(source, '2026-01-01').sinceInception, annualizedOfficialReturns(source, '2024-01-01').sinceInception, annualizedOfficialReturns({ ...source, sinceInception: -5 }, '2024-01-01').sinceInception, annualizedOfficialReturns({ ...source, asOfDate: null }, '2024-01-01').sinceInception, annualizedOfficialReturns(source, null).sinceInception]).toEqual([null, 0, -5, null, null]);
    expect([source.sinceInception, annualizedOfficialReturns(source, '2026-01-01').yr1]).toEqual([0, -1]);
    expect(reportingPeriodEnds('2026-09-29')).toEqual({ monthEnd: '2026-08-31', quarterEnd: '2026-06-30' });
    expect(reportingPeriodEnds('2026-09-30')).toEqual({ monthEnd: '2026-09-30', quarterEnd: '2026-09-30' });
    expect(reportingPeriodEnds('2026-08-15')).toEqual({ monthEnd: '2026-07-31', quarterEnd: '2026-06-30' });
  });

  test('premium/discount uses the latest date that has both NAV and close; TER is net with gross beside it, legacy rows are mapped; trailing-year yield', () => {
    const pair = latestSamePair([nav('2026-09-29', 50), nav('2026-09-30', 50.1)], [day('2026-09-29', 50.5), day('2026-09-30', 50.2), day('2026-10-01', 50.3)]);
    expect(pair).toMatchObject({ date: '2026-09-30', premium: 0.1996 });
    expect([latestSamePair([nav('2026-09-01', 50)], [day('2026-09-30', 50)]), latestSamePair([], [day('2026-09-30', 50)])]).toEqual([null, null]);
    expect(expenseFields(0.65, 0.6)).toEqual({ ter: '0.60%', terValue: 0.6, terGross: '0.65%', terGrossValue: 0.65 });
    expect(expenseFields(0.65, null)).toMatchObject({ terValue: 0.65, terGrossValue: 0.65 });
    expect(expenseFields(null, null)).toMatchObject({ terValue: null, terGrossValue: null, ter: '—' });
    expect(previousExpenses({ terValue: 0.65 }, { netTerValue: 0.6 })).toEqual({ gross: 0.65, net: 0.6 });
    expect(previousExpenses({ terValue: 0.6, terGrossValue: 0.65 }, {})).toEqual({ gross: 0.65, net: 0.6 });
    expect([trailingYearYield([dividend('2025-12-19', 1.25), dividend('2024-01-01', 9)], '2026-09-30', 50), trailingYearYield([dividend('2024-01-01', 9)], '2026-09-30', 50)]).toEqual([2.5, null]);
  });
});

// ===========================================================================
describe('pipeline', () => {
  test('requested funds only; the catalog and unrequested entries and files are preserved; every row has the same metrics keys', async () => {
    const root = await seeded();
    const beforeIndex = await Bun.file(join(root, 'index.json')).json();
    const result = await quietRun(root);
    expect([result.selected, result.failures, result.outcomes.every(r => r.freshSources.length === 5)]).toEqual([['ASHR', 'DBEF', 'HYLB'], 0, true]);
    const afterIndex = await Bun.file(join(root, 'index.json')).json();
    expect(afterIndex.funds).toHaveLength(SITEMAP_TICKERS.length + 1);
    const keys = Object.keys(record((await rowOf(root, 'ASHR')).metrics));
    for (const fund of afterIndex.funds) expect(Object.keys(record(fund.metrics))).toEqual(keys);
    for (const ticker of result.selected) {
      const metrics = record(record(afterIndex.funds.find((fund: JsonRecord) => fund.ticker === ticker)).metrics);
      expect(Object.keys(metrics).slice(-2)).toEqual(['returnsBasis', 'performanceAsOf']);
      expect(String(metrics.returnsBasis).trim()).not.toMatch(/^(-|—)?$/);
      expect(metrics.performanceAsOf === null || /^\d{4}-\d{2}-\d{2}$/.test(String(metrics.performanceAsOf))).toBe(true);
    }
    const selected = new Set(result.selected);
    for (const row of beforeIndex.funds) if (!selected.has(row.ticker)) expect(afterIndex.funds.find((fund: JsonRecord) => fund.ticker === row.ticker)).toEqual(row);
    expect(await Bun.file(join(root, 'funds', 'CHPS', 'untouched.json')).text()).toBe('{"sentinel":true}\n');
    const meta = await metaOf(root, 'ASHR');
    expect([record(meta.holdings).totalRows, record(meta.history).totalRows]).toEqual([2, 4]);
    expect([String(record(meta.source).yahoo).includes('?'), String(record(meta.source).historySource).includes('period2=')]).toEqual([false, false]);
  });

  test('a second identical run writes nothing: same bytes, no touched file', async () => {
    const root = await seeded();
    await quietRun(root);
    backdate(root);
    const before = await hashes(root);
    const second = await quietRun(root);
    expect([second.failures, second.updated, second.outcomes.every(r => r.status === 'unchanged')]).toEqual([0, 0, true]);
    expect(await hashes(root)).toEqual(before);
    expect(touched(root)).toEqual([]);
  });

  test('an unknown ticker fails before any write; TICKERS does not bypass financial filters', async () => {
    const root = await seeded();
    const before = await hashes(root);
    await expect(quietRun(root, { TICKERS: 'NOTREAL' })).rejects.toThrow('absent from catalog');
    expect(await hashes(root)).toEqual(before);
    const result = await quietRun(root, { TICKERS: 'ASHR', AUM: '2B:' });
    expect([result.selected, result.outcomes[0].status]).toEqual([['ASHR'], 'skipped']);
    expect(await Bun.file(join(root, 'funds', 'ASHR', 'meta.json')).exists()).toBe(false);
    expect((await rowOf(root, 'ASHR')).holdings).toBe(0);
  });

  test('an all-provider outage retains every published byte, reports cached rather than fresh, and never writes an empty row', async () => {
    const root = await seeded();
    await quietRun(root);
    const before = await hashes(root);
    const result = await quietRun(root, {}, async () => new Response('offline test denial', { status: 403 }));
    expect([result.failures, result.updated, result.outcomes.every(row => row.freshSources.length === 0), result.outcomes.every(row => row.reason?.includes('retained published data'))]).toEqual([0, 0, true, true]);
    expect(await hashes(root)).toEqual(before);
    const index = await Bun.file(join(root, 'index.json')).json();
    index.funds = index.funds.filter((row: JsonRecord) => row.ticker !== 'ASHR');
    await Bun.write(join(root, 'index.json'), JSON.stringify(index));
    await quietRun(root, { TICKERS: 'ASHR' }, async url => url.endsWith('/en-us/sitemap.xml') ? new Response(SITEMAP) : url.includes('downloadxls/') ? new Response(EMPTY_CATALOG) : new Response('down', { status: 403 }));
    expect((await indexOf(root)).every(row => typeof row.ticker === 'string' && row.ticker.length > 0)).toBe(true);
  });

  test('one failed fund does not abort the healthy ones and the bounded cursor moves past it', async () => {
    const root = await seeded();
    const result = await quietRun(root, { MAX_FETCHES: '3' }, fakeFetch(['/HYLB/Securities']));
    expect(result.failures).toBe(1);
    expect(['HYLB', 'ASHR', 'DBEF'].map(t => result.outcomes.find(r => r.ticker === t)?.status)).toEqual(['failed', 'updated', 'updated']);
    expect(await Bun.file(join(root, 'funds', 'HYLB', 'meta.json')).exists()).toBe(false);
    expect(Object.values((await Bun.file(join(root, 'update-state.json')).json()).cursors)).toEqual(['HYLB']);
    const pinned = await seeded();
    const denied = fakeFetch(['/ASHR/Securities']);
    const first = await quietRun(pinned, { MAX_FETCHES: '1' }, denied);
    expect([first.failures, first.processedThrough]).toEqual([1, 'ASHR']);
    const second = await quietRun(pinned, { MAX_FETCHES: '1' }, denied);
    expect([second.selected, second.failures]).toEqual([['DBEF'], 0]);
  });

  test('the bounded cursor resumes, scope changes reset it, a TICKERS run never moves it, a full pass clears only its own scope, stale pages go', async () => {
    const root = await seeded();
    expect((await quietRun(root, { MAX_FETCHES: '1' })).selected).toEqual(['ASHR']);
    expect((await quietRun(root, { MAX_FETCHES: '1' })).selected).toEqual(['DBEF']);
    const state = await readFile(join(root, 'update-state.json'), 'utf8');
    expect((await quietRun(root, { MAX_FETCHES: '1', TICKERS: 'HYLB' })).selected).toEqual(['HYLB']);
    await Bun.write(join(root, 'update-state.json'), state);
    await quietRun(root, { TICKERS: 'HYLB' });
    expect(await readFile(join(root, 'update-state.json'), 'utf8')).toBe(state);
    await Bun.write(join(root, 'funds', 'ASHR', 'holdings', '003.json'), '{"old":true}\n');
    const full = await quietRun(root);
    expect([full.selected, full.failures]).toEqual([['ASHR', 'DBEF', 'HYLB'], 0]);
    expect(await Bun.file(join(root, 'funds', 'ASHR', 'holdings', '003.json')).exists()).toBe(false);
  });

  test('the soft deadline stops taking funds and still writes the index', async () => {
    const root = await seeded();
    console.log = () => {}; console.warn = () => {};
    let result; try { result = await runUpdater(readConfig({ TICKERS: 'ASHR DBEF', REQUEST_SLEEP: '0' }), { root, fetcher: fakeFetch(), deadlineMs: 0 }); } finally { Object.assign(console, realConsole); }
    expect(SOFT_DEADLINE_MS).toBe(25 * 60_000);
    expect([result.outcomes.length, result.deadlineReached]).toEqual([0, true]);
    expect(renderUpdateSummary(readConfig({}), result)).toContain('Soft deadline reached');
    expect((await indexOf(root)).length).toBeGreaterThan(0);
  });

  test('SEC fallback: the exact series fills failed official holdings, the wrong series is rejected, EDGAR_FALLBACK=false never calls SEC', async () => {
    const root = await seeded();
    const result = await quietRun(root, { TICKERS: 'HYLB' }, fakeFetch(['/HYLB/Securities'], NPORT));
    expect([result.failures, result.outcomes[0].freshSources.includes('SEC N-PORT')]).toEqual([0, true]);
    const meta = await metaOf(root, 'HYLB');
    expect([record(meta.holdings).totalRows, String(record(meta.source).holdingsSource).includes('primary_doc.xml')]).toEqual([2, true]);
    const wrongRoot = await seeded();
    const wrong = await quietRun(wrongRoot, { TICKERS: 'HYLB' }, fakeFetch(['/HYLB/Securities'], NPORT.replace('S000001', 'S000002')));
    expect(wrong.failures).toBe(1);
    expect(await Bun.file(join(wrongRoot, 'funds', 'HYLB', 'meta.json')).exists()).toBe(false);
    const offRoot = await seeded();
    calls.length = 0;
    const off = await quietRun(offRoot, { TICKERS: 'HYLB', EDGAR_FALLBACK: 'false' }, fakeFetch(['/HYLB/Securities'], NPORT));
    expect([off.failures, calls.some(url => url.includes('sec.gov'))]).toEqual([1, false]);
  });

  test('N-PORT freshness: an older SEC filing never replaces fresher published holdings', async () => {
    const root = await seeded();
    await quietRun(root, { TICKERS: 'HYLB' }); // published holdings dated 2026-09-29
    await quietRun(root, { TICKERS: 'HYLB' }, fakeFetch(['/HYLB/Securities'], NPORT)); // filing report date 2026-08-31
    const meta = await metaOf(root, 'HYLB');
    expect([String(record(meta.source).holdingsSource).includes('primary_doc.xml'), record(meta.holdings).asOfDate]).toEqual([false, '2026-09-29']);
  });

  test('official NAV missing gives Yahoo-only history without inventing NAV, SKIP_YAHOO gives NAV-only history and never calls Yahoo', async () => {
    const root = await seeded();
    expect((await quietRun(root, { TICKERS: 'HYLB' }, fakeFetch(['/HYLB/Performance']))).failures).toBe(0);
    const page = await Bun.file(join(root, 'funds', 'HYLB', 'history', '001.json')).json();
    expect(page.headers).toEqual(['Date', 'Close', 'Adj Close', 'Volume']);
    expect(page.rows.every((row: JsonRecord) => row.NAV === undefined)).toBe(true);
    const source = String(record((await metaOf(root, 'HYLB')).source).historySource);
    expect([source.includes('finance.yahoo.com'), source.includes('Performance')]).toEqual([true, false]);
    const skipRoot = await seeded();
    calls.length = 0;
    const skipped = await quietRun(skipRoot, { TICKERS: 'HYLB', SKIP_YAHOO: 'true' });
    expect([skipped.failures, calls.some(url => url.includes('finance.yahoo.com')), skipped.outcomes[0].freshSources.includes('Yahoo')]).toEqual([0, false, false]);
    const skippedPage = await Bun.file(join(skipRoot, 'funds', 'HYLB', 'history', '001.json')).json();
    expect(skippedPage.headers).toEqual(['Date', 'NAV', 'Market Price', 'Premium/Discount']);
    expect(skippedPage.rows.every((row: JsonRecord) => row['Market Price'] === '')).toBe(true);
  });

  test('rows without meta.json have dataFile null and a full metrics object, rows with it use the ./ prefix', async () => {
    const root = await seeded();
    await quietRun(root, { TICKERS: 'ASHR' });
    const stub = await rowOf(root, 'CHPS');
    expect(stub.dataFile).toBeNull();
    expect(Object.keys(record(stub.metrics))).toEqual(Object.keys(record((await rowOf(root, 'ASHR')).metrics)));
    expect((await rowOf(root, 'ASHR')).dataFile).toBe('./funds/ASHR/meta.json');
  });

  test('premium/discount is published with its date, the net and gross TER survive an outage of the product page', async () => {
    const root = await seeded();
    await quietRun(root, { TICKERS: 'ASHR' });
    const row = await rowOf(root, 'ASHR');
    expect([row.premiumDiscountValue === null, row.premiumDiscountAsOfDate, row.premiumDiscount === '—']).toEqual([false, '2026-09-29', false]);
    expect(row).toMatchObject({ terValue: 0.6, terGrossValue: 0.65 });
    await quietRun(root, { TICKERS: 'ASHR' }, fakeFetch(['/pdpMetaTagsTealium']));
    expect(await rowOf(root, 'ASHR')).toMatchObject({ terValue: 0.6, terGrossValue: 0.65 });
  });

  test('a distribution rate of 0 with payments in the last 12 months falls back to trailing distributions, a published 0.00% with none stays and says so', async () => {
    const zeroRate = override(fakeFetch(), url => url.includes('/pdpMetaTagsTealium'), url => Response.json(pdp(/\/etfus\/([A-Z]+)\//.exec(url)![1], { rate: '0%' })));
    const root = await seeded();
    await quietRun(root, { TICKERS: 'ASHR' }, zeroRate);
    expect(Number(record((await rowOf(root, 'ASHR')).metrics).dividendYield)).toBeGreaterThan(0);
    expect(String(record((await metaOf(root, 'ASHR')).yields).dividendYieldKind)).toContain('trailing 12-month');
    const noPayments = override(zeroRate, url => url.includes('/Distributions'), url => new Response(literalWorkbook([...META_ROWS(/etf\/([A-Z]+)\//.exec(url)![1]), ['Ex-Date', 'Record date', 'Pay date', 'US$ / Share']])));
    const second = await seeded();
    await quietRun(second, { TICKERS: 'DBEF' }, noPayments);
    expect(record((await rowOf(second, 'DBEF')).metrics).dividendYield).toBe(0);
    expect(String(record((await metaOf(second, 'DBEF')).yields).dividendYieldKind)).toContain('no distributions in the last 12 months');
  });

  test('a new catalog fund is reported, the step summary lists controls, outcomes and failures and redacts the SEC contact', async () => {
    const root = await seeded();
    const withNew = override(fakeFetch(), url => url.endsWith('/en-us/sitemap.xml'), () => new Response(SITEMAP.replace('</urlset>', '<url><loc>https://etf.dws.com/en-us/NEWX-xtrackers-test-etf/</loc></url></urlset>')));
    console.log = () => {}; console.warn = () => {};
    let fresh; try { fresh = await runUpdater(readConfig({ TICKERS: 'ASHR', REQUEST_SLEEP: '0' }), { root, fetcher: withNew }); } finally { Object.assign(console, realConsole); }
    expect(fresh.newFunds).toEqual(['NEWX']);
    expect(renderUpdateSummary(readConfig({}), fresh)).toContain('NEW FUNDS: NEWX');

    const summaryRoot = await seeded();
    const config = readConfig({ TICKERS: 'ASHR HYLB DBEF', REQUEST_SLEEP: '0', MAX_FETCHES: '3' });
    const result = await quietRun(summaryRoot, { MAX_FETCHES: '3' }, fakeFetch(['/HYLB/Securities']));
    expect([result.manifestChanged, result.progressChanged, result.processedThrough]).toEqual([true, true, 'HYLB']);
    const before = await hashes(summaryRoot), path = join(await tempRoot(), 'step-summary.md');
    await writeSummary(config, result, path);
    const text = await Bun.file(path).text();
    for (const part of ['## Xtrackers updater', `| Catalog funds | ${SITEMAP_TICKERS.length + 1} |`, '| Fund update attempts | 3 |', '| Failed | 1 |', '### Failures', '**HYLB**', 'REQUEST_SLEEP=0', 'SEC_UA=<redacted>']) expect(text).toContain(part);
    expect(text).not.toContain('daggerok@gmail.com');
    for (const key of CONTROL_NAMES) expect(text).toContain(key + '=');
    await writeSummary(config, result, path);
    expect(await Bun.file(path).text()).toBe(text + text);
    expect(renderUpdateSummary(config, result)).toBe(text);
    expect(await hashes(summaryRoot)).toEqual(before);
    const cached = await quietRun(summaryRoot, {}, async () => new Response('denied', { status: 403 }));
    expect(cached.manifestChanged).toBe(false);
    expect(renderUpdateSummary(readConfig({}), cached)).toContain('### Retained published data');
  });

  test('a generated feed is internally consistent: counts, manifests, pages and file listings agree', async () => {
    const root = await seeded();
    await quietRun(root);
    const json = async (path: string) => record(JSON.parse(await readFile(join(root, path), 'utf8')));
    const index = await json('index.json'), funds = array(index.funds).map(record);
    expect(index.provider).toBe('Xtrackers (DWS)');
    expect(new Set(funds.map(fund => fund.ticker)).size).toBe(funds.length);
    const counts = record(index.counts);
    expect([counts.funds, counts.holdings, counts.history]).toEqual([funds.length, funds.reduce((sum, fund) => sum + (numberOrNull(fund.holdings) ?? 0), 0), funds.reduce((sum, fund) => sum + (numberOrNull(fund.history) ?? 0), 0)]);
    for (const fund of funds) {
      const ticker = String(fund.ticker);
      expect(ticker).toMatch(/^[A-Z][A-Z0-9.-]{0,9}$/);
      expect([null, `./funds/${ticker}/meta.json`]).toContain(fund.dataFile);
      if (!fund.holdings && !fund.history) continue;
      const meta = await json(`funds/${ticker}/meta.json`);
      expect([meta.ticker, record(meta.source).trustCik]).toEqual([ticker, '0001503123']);
      for (const kind of ['holdings', 'history'] as const) {
        const manifest = record(meta[kind]), pages = array(manifest.pages).map(String);
        expect(pages.length).toBe(Math.ceil(Number(manifest.totalRows) / Number(manifest.pageSize)));
        let rowCount = 0;
        for (const [i, path] of pages.entries()) {
          const page = await json(`funds/${ticker}/${path}`), rows = array(page.rows).map(record);
          expect([page.ticker, page.page, page.totalRows]).toEqual([ticker, i + 1, manifest.totalRows]);
          expect(rows.length).toBeLessThanOrEqual(Number(manifest.pageSize));
          rowCount += rows.length;
        }
        expect([rowCount, rowCount]).toEqual([manifest.totalRows, fund[kind]]);
        const actual = (await readdir(join(root, `funds/${ticker}/${kind}`))).filter(name => /^\d+\.json$/.test(name)).sort();
        expect(actual).toEqual(pages.map(path => path.split('/')[1]).sort());
      }
    }
  });

  test('run timestamps never cause byte churn, material changes do', async () => {
    const root = await tempRoot(), path = join(root, 'nested.json');
    const first = { generatedAt: 'one', source: { catalogReadAt: 'one', rows: [{ generatedAt: 'one', value: 0 }] } };
    const second = { source: { rows: [{ value: 0, generatedAt: 'two' }], catalogReadAt: 'two' }, generatedAt: 'two' };
    expect(samePublishedContent(JSON.stringify(first), second)).toBe(true);
    expect(await writeJsonIfChanged(path, first)).toBe(true);
    const before = await Bun.file(path).text();
    expect(await writeJsonIfChanged(path, second)).toBe(false);
    expect(await Bun.file(path).text()).toBe(before);
    expect(await writeJsonIfChanged(path, { ...second, value: 1 })).toBe(true);
    expect(samePublishedContent('invalid', {})).toBe(false);
  });
});

// ===========================================================================
describe('network', () => {
  test('two independent request lanes start two requests immediately, the rest wait one REQUEST_SLEEP', async () => {
    const waits: number[] = [];
    const gate = createRequestGate(1.5, 2, () => 0, async ms => { waits.push(ms); });
    await Promise.all([gate(), gate(), gate(), gate()]);
    expect(waits).toEqual([1500, 1500]);
  });

  test('429, 5xx and network errors retry honouring Retry-After, a permanent 403 does not, retries are bounded by MAX_RETRIES', async () => {
    let requests = 0, gates = 0; const waits: number[] = [];
    const cfg = readConfig({ MAX_RETRIES: '2' });
    const response = await fetchWithRetry('https://example.test', cfg, async () => { gates++; }, async () => {
      requests++; return requests === 1 ? new Response('throttle', { status: 429, headers: { 'Retry-After': '2' } }) : requests === 2 ? new Response('server', { status: 500 }) : new Response('ok');
    }, {}, async ms => { waits.push(ms); });
    expect([response.status, requests, gates, waits]).toEqual([200, 3, 3, [2000, 2000]]);
    requests = 0;
    await expect(fetchWithRetry('https://example.test', cfg, async () => {}, async () => { requests++; return new Response('blocked', { status: 403 }); }, {}, async () => {})).rejects.toBeInstanceOf(HttpError);
    expect(requests).toBe(1);
    requests = 0;
    await fetchWithRetry('https://example.test', cfg, async () => {}, async () => { if (++requests === 1) throw new Error('network'); return new Response('ok'); }, {}, async () => {});
    expect(requests).toBe(2);
    requests = 0;
    await expect(fetchWithRetry('https://example.test', cfg, async () => {}, async () => { requests++; return new Response('busy', { status: 503 }); }, {}, async () => {})).rejects.toBeInstanceOf(HttpError);
    expect(requests).toBe(3);
  });

  test('every request carries a 45 s timeout signal; a request that never answers is aborted and retried up to the limit', async () => {
    const timeouts: number[] = [];
    AbortSignal.timeout = ((ms: number) => { timeouts.push(ms); return realAbortTimeout.call(AbortSignal, 30); }) as typeof AbortSignal.timeout;
    let attempts = 0;
    const hanging: Fetcher = (_url, init) => { attempts++; return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')))); };
    await expect(fetchWithRetry('https://example.test/slow', readConfig({ MAX_RETRIES: '1' }), async () => {}, hanging, {}, async () => {})).rejects.toThrow('aborted');
    expect([attempts, timeouts]).toEqual([2, [45000, 45000]]);
  });

  test('in-flight peak is 1 at CONCURRENCY=1 and N at CONCURRENCY=N', async () => {
    const peakFor = async (concurrency: string): Promise<number> => {
      let inFlight = 0, peak = 0;
      const base = fakeFetch();
      const counting: Fetcher = async (url, init) => {
        inFlight++; peak = Math.max(peak, inFlight);
        try { await new Promise(resolve => setTimeout(resolve, 20)); return await base(url, init); } finally { inFlight--; }
      };
      const root = await seeded();
      expect((await quietRun(root, { CONCURRENCY: concurrency }, counting)).failures).toBe(0);
      return peak;
    };
    expect(await peakFor('1')).toBe(1);
    expect(await peakFor('3')).toBe(3);
  });

  test('HISTORY_RANGE narrows the real Yahoo request, max requests the whole history', async () => {
    const root = await seeded(), other = await seeded();
    calls.length = 0;
    await quietRun(root, { TICKERS: 'HYLB', HISTORY_RANGE: '1y' });
    const limited = /period1=(\d+)&period2=(\d+)/.exec(calls.find(url => url.includes('finance.yahoo.com')) ?? '');
    expect(limited).not.toBeNull();
    expect(Number(limited![2]) - Number(limited![1])).toBe(Math.floor(365.25 * 86400));
    calls.length = 0;
    await quietRun(other, { TICKERS: 'HYLB', HISTORY_RANGE: 'max' });
    expect(calls.find(url => url.includes('finance.yahoo.com'))).toContain('period1=0&');
  });
});
