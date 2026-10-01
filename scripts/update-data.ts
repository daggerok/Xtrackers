#!/usr/bin/env bun
/// <reference types="bun" />

// Xtrackers (DWS) static feed. Bun-only, zero runtime dependencies.
// ZIP/OpenXML helpers adapted from daggerok/SPDR @ d26fe5547c98f1a259f1198f4e789363b11f2491.
// Reporting, N-PORT and financial helpers follow pinned JPMorgan; see .worklog.txt.
import { inflateRawSync } from 'node:zlib';

export type JsonRecord = Record<string, unknown>;
export type SheetRow = Record<string, string>;
export type Sheet = { headers: string[]; rows: SheetRow[]; asOfDate: string | null };
export type OfficialReturnRow = {
  asOfDate: string | null;
  ytd: number | null;
  yr1: number | null;
  yr3: number | null;
  yr5: number | null;
  yr10: number | null;
  sinceInception: number | null;
};
export type NumericReturnKey = Exclude<keyof OfficialReturnRow, 'asOfDate'>;
export const emptyReturns = (): OfficialReturnRow => ({
  asOfDate: null, ytd: null, yr1: null, yr3: null, yr5: null, yr10: null, sinceInception: null,
});
export type CatalogFund = {
  ticker: string;
  name: string | null;
  category: string | null;
  fundPage: string;
  inceptionDate: string | null;
  terValue: number | null;
  netTerValue: number | null;
  aumValue: number | null;
  officialReturns: OfficialReturnRow;
};
export type FundDetails = CatalogFund & {
  cusip: string | null;
  isin: string | null;
  indexTicker: string | null;
  exchange: string | null;
  navValue: number | null;
  navAsOfDate: string | null;
  secYield: number | null;
  distributionRate: number | null;
  frequency: string | null;
  midpoint: number | null;
  premiumDiscount: number | null;
};
export type Dividend = {
  epoch: number;
  amount: number;
  exDate: string;
  recordDate: string | null;
  payDate: string | null;
};
export type NavPoint = {
  date: string;
  nav: number;
  aum: number | null;
  shares: number | null;
  dividend: number | null;
};
export type ChartDay = { date: string; close: number; adjClose: number; volume: number };
export type ParsedChart = {
  days: ChartDay[];
  dividends: Dividend[];
  exchange: string | null;
  firstTradeDate: string | null;
};
export const HOLDINGS_HEADERS = ['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held', 'Asset Category'];
export const HISTORY_HEADERS = ['Date', 'NAV', 'Market Price', 'Premium/Discount', 'Adj Close', 'Volume'];
export const CATALOG_URL = 'https://etf.dws.com/en-us/etf-products/downloadxls/?query=' + encodeURIComponent(JSON.stringify({
  selectedTabIndex: 1, totalReturnType: 0, searchTerm: '', filters: [],
}));
export const SITEMAP_URL = 'https://etf.dws.com/en-us/sitemap.xml';
export const TRUST_CIK = '0001503123';
export const detailsUrl = (ticker: string): string => `https://etf.dws.com/api/pdp/en-us/etfus/${encodeURIComponent(ticker)}/pdpMetaTagsTealium`;
export const exportUrl = (ticker: string, kind: 'Securities' | 'Distributions' | 'Performance'): string =>
  `https://etf.dws.com/api/pdp/en-us/${kind === 'Performance' ? 'Export' : 'export'}/etf/${encodeURIComponent(ticker)}/${kind}`;
export const yahooSourceUrl = (ticker: string): string => `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`;

export function record(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}
export function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
export function decodeXml(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10))).replace(/&amp;/g, '&');
}
export function cleanText(raw: unknown): string {
  if (raw === null || raw === undefined || typeof raw === 'object') return '';
  return decodeXml(String(raw).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
export function numberOrNull(raw: unknown): number | null {
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  let text = cleanText(raw).replace(/[$,%\s]/g, '').replace(/\u2212/g, '-');
  if (!text || /^(?:-|—|–|N\/?A|--|null)$/i.test(text)) return null;
  if (/^\(.+\)$/.test(text)) text = '-' + text.slice(1, -1);
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}
export function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}
export function toIsoDate(raw: unknown): string | null {
  const text = cleanText(raw);
  if (!text || text === '—' || text === '--') return null;
  // Excel's modern 1900 date system: day 25569 is 1970-01-01. Reject footer numbers.
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (serial < 20000 || serial > 100000) return null;
    return new Date(Math.round((serial - 25569) * 86400000)).toISOString().slice(0, 10);
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(text);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  const candidate = iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : us ? `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}` : null;
  if (candidate) {
    const ms = Date.parse(candidate + 'T00:00:00Z');
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === candidate ? candidate : null;
  }
  if (!/[A-Za-z]{3}/.test(text)) return null;
  const ms = Date.parse(text + ' UTC');
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}
export function epochToIsoDate(epoch: number): string { return new Date(epoch * 1000).toISOString().slice(0, 10); }
export function sanitizeTicker(raw: unknown): string {
  const value = cleanText(raw).toUpperCase();
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(value) ? value : '';
}

// A small ZIP reader for machine-generated XLSX exports: stored + deflate, no files extracted.
export function readZipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP: end of central directory not found');
  const count = view.getUint16(eocd + 10, true);
  if (count === 65535) throw new Error('ZIP64 is not supported');
  let offset = view.getUint32(eocd + 16, true);
  const entries = new Map<string, Uint8Array>();
  let inflated = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > eocd || view.getUint32(offset, true) !== 0x02014b50) throw new Error('ZIP: bad central directory');
    if (view.getUint16(offset + 8, true) & 1) throw new Error('ZIP: encrypted entry');
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    if (offset + 46 + nameLength + extraLength + commentLength > eocd || localOffset + 30 > offset) throw new Error('ZIP: truncated entry');
    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('ZIP: bad local header');
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    if (dataStart + compressedSize > offset || (inflated += size) > 64 * 1024 * 1024) throw new Error('ZIP: invalid size');
    const data = bytes.subarray(dataStart, dataStart + compressedSize);
    const content = method === 0 ? data : method === 8 ? new Uint8Array(inflateRawSync(data, { maxOutputLength: 64 * 1024 * 1024 })) : null;
    if (!content) throw new Error(`ZIP: unsupported compression method ${method}`);
    if (content.length !== size) throw new Error('ZIP: uncompressed size mismatch');
    entries.set(name, content);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
function xmlText(xml: string): string { return decodeXml(xml.replace(/<!\[CDATA\[([\s\S]*?)]]>/g, '$1')); }
export function parseSharedStrings(xml: string): string[] {
  xml = xml.replace(/(<\/?)[A-Za-z_][\w.-]*:/g, '$1');
  return (xml.match(/<si[\s>][\s\S]*?<\/si>|<si\/>/g) || []).map(item => xmlText(
    (item.match(/<t(?:\s[^>]*)?>[\s\S]*?<\/t>/g) || [])
      .map(part => part.replace(/^<t[^>]*>/, '').replace(/<\/t>$/, '')).join(''),
  ));
}
function columnIndex(reference: string): number {
  let index = 0;
  for (const letter of reference.replace(/\d+/g, '')) index = index * 26 + letter.charCodeAt(0) - 64;
  return index - 1;
}
export function parseWorksheetXml(xml: string, sharedStrings: string[] = []): string[][] {
  xml = xml.replace(/(<\/?)[A-Za-z_][\w.-]*:/g, '$1');
  const rows: string[][] = [];
  for (const rowXml of xml.match(/<row[\s>][\s\S]*?<\/row>|<row\/>/g) || []) {
    const cells: string[] = [];
    for (const cellXml of rowXml.match(/<c(?:\s[^>]*)?\/>|<c(?:\s[^>]*)?>[\s\S]*?<\/c>/g) || []) {
      const reference = /r="([A-Z]+\d+)"/.exec(cellXml)?.[1];
      const target = reference ? columnIndex(reference) : cells.length;
      const type = /t="([^"]+)"/.exec(cellXml)?.[1] || 'n';
      const value = /<v[^>]*>([\s\S]*?)<\/v>/.exec(cellXml)?.[1];
      let text = '';
      if (type === 'e') text = ''; // Formula errors are not numeric zero.
      else if (value !== undefined) text = type === 's' ? sharedStrings[Number(value)] ?? '' : xmlText(value);
      else text = xmlText((cellXml.match(/<t(?:\s[^>]*)?>[\s\S]*?<\/t>/g) || [])
        .map(part => part.replace(/^<t[^>]*>/, '').replace(/<\/t>$/, '')).join(''));
      while (cells.length < target) cells.push('');
      cells[target] = text.trim();
    }
    rows.push(cells);
  }
  return rows;
}
export function parseXlsxSheet(bytes: Uint8Array): string[][] {
  const entries = readZipEntries(bytes);
  const stringsXml = entries.get('xl/sharedStrings.xml');
  const shared = stringsXml ? parseSharedStrings(new TextDecoder().decode(stringsXml)) : [];
  const sheetName = [...entries.keys()].find(name => /^xl\/worksheets\/sheet1\.xml$/.test(name))
    ?? [...entries.keys()].find(name => /^xl\/worksheets\/.+\.xml$/.test(name));
  if (!sheetName) throw new Error('XLSX: worksheet not found');
  return parseWorksheetXml(new TextDecoder().decode(entries.get(sheetName)), shared);
}
export function headerKey(value: unknown): string { return cleanText(value).toLowerCase().replace(/[^a-z0-9]/g, ''); }
function findHeader(rows: string[][], required: string[]): number {
  return rows.findIndex(row => required.every(key => row.some(cell => headerKey(cell) === headerKey(key))));
}
function workbookRecords(rows: string[][], index: number): SheetRow[] {
  if (index < 0) throw new Error('XLSX: required headers missing');
  return rows.slice(index + 1).filter(row => row.some(Boolean))
    .map(row => Object.fromEntries(rows[index].map((header, i) => [headerKey(header), row[i] || ''])));
}
function metaValue(rows: string[][], label: string): string | null {
  for (const row of rows) {
    const index = row.findIndex(cell => headerKey(cell) === headerKey(label));
    if (index >= 0) return cleanText(row[index + 1]) || null;
  }
  return null;
}
function validateWorkbookTicker(rows: string[][], ticker: string): void {
  const actual = sanitizeTicker(metaValue(rows, 'Ticker'));
  if (actual !== ticker) throw new Error(`XLSX: ticker mismatch (${actual || 'missing'} != ${ticker})`);
}
export function returnHeaderSlot(header: string): NumericReturnKey | null {
  const key = headerKey(header);
  if (['ytd', 'ytdreturn'].includes(key)) return 'ytd';
  if (['1y', '1year', 'oneyear'].includes(key)) return 'yr1';
  if (['3y', '3years', 'threeyears'].includes(key)) return 'yr3';
  if (['5y', '5years', 'fiveyears'].includes(key)) return 'yr5';
  if (['10y', '10years', 'tenyears'].includes(key)) return 'yr10';
  if (['sincelaunch', 'sinceinception', 'inception', 'performanceinsinceinception'].includes(key)) return 'sinceInception';
  return null;
}
export function parseReturnRow(headers: string[], values: unknown[], asOfDate: string | null): OfficialReturnRow {
  const result = emptyReturns();
  result.asOfDate = asOfDate;
  headers.forEach((header, index) => {
    const slot = returnHeaderSlot(header.replace(/\(%\)/g, ''));
    if (slot !== null) result[slot] = numberOrNull(values[index]);
  });
  return result;
}
export function parseCatalogRows(rows: string[][], asOfDate: string | null = null): CatalogFund[] {
  const at = findHeader(rows, ['Fund name', 'Ticker']);
  return workbookRecords(rows, at).flatMap(row => {
    const ticker = sanitizeTicker(row.ticker);
    if (!ticker || !row.fundname) return [];
    return [{
      ticker, name: cleanText(row.fundname), category: cleanText(row.assetclass) || null,
      fundPage: `https://etf.dws.com/en-us/etf-products/?SearchTerm=${encodeURIComponent(ticker)}`,
      inceptionDate: toIsoDate(row.subfundlaunch), terValue: numberOrNull(row.grossexpenses),
      netTerValue: numberOrNull(row.netexpenses), aumValue: numberOrNull(row.totalnetassets),
      officialReturns: parseReturnRow(['YTD', '1Y', '5Y', '10Y', 'Since inception'],
        [row.ytd, row['1y'], row['5y'], row['10y'], row.performanceinsinceinception], asOfDate),
    }];
  }).sort((a, b) => a.ticker.localeCompare(b.ticker));
}
export function parseSitemap(xml: string): CatalogFund[] {
  const funds = new Map<string, CatalogFund>();
  for (const match of xml.matchAll(/<loc(?:\s[^>]*)?>([\s\S]*?)<\/loc>/g)) {
    const url = cleanText(match[1]);
    const ticker = /^https:\/\/etf\.dws\.com\/en-us\/([A-Z][A-Z0-9.]{1,9})-[^/?]+-etf\/$/.exec(url)?.[1];
    if (!ticker) continue;
    funds.set(ticker, { ticker, name: null, category: null, fundPage: url, inceptionDate: null,
      terValue: null, netTerValue: null, aumValue: null, officialReturns: emptyReturns() });
  }
  return [...funds.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
}
function itemValue(items: unknown, label: string): unknown {
  const found = array(items).map(record).find(item => headerKey(item.key) === headerKey(label));
  return found?.value;
}
export function parseFundDetails(payload: unknown, expectedTicker: string, fundPage: string): FundDetails {
  const root = record(record(payload).pdpResult);
  const frame = record(root.pageFrame);
  const header = record(frame.productHeader);
  if (sanitizeTicker(itemValue(header.identifier, 'Ticker')) !== expectedTicker) throw new Error('PDP: ticker mismatch or missing header');
  const sections = record(root.pageSections);
  const facts = record(sections.keyFacts);
  const profileItems = array(facts.accordionItems).map(record)
    .filter(item => ['fundinformation-fundprofile', 'fundinformation-indexdetails', 'fundinformation-feesandexpenses'].includes(String(item.id)))
    .flatMap(item => array(record(item.list).items));
  const fact = (label: string): unknown => itemValue(profileItems, label);
  const head = (label: string): unknown => itemValue(header.tableValues, label);
  const navItem = array(header.tableValues).map(record).find(item => headerKey(item.key) === 'nav');
  const rawName = cleanText(record(header.texts).title);
  if (!rawName) throw new Error('PDP: missing fund name');
  const categories = array(head('Asset class')).map(record).map(item => cleanText(item.text)).filter(Boolean);
  const actualPage = cleanText(record(record(payload).metaTags).canonical);
  const navDateText = cleanText(navItem?.date).replace(/^As of:\s*/i, '');
  const officialReturns = emptyReturns();
  // Ratings are deliberately not inspected. Only the named performance table can supply returns.
  const performance = record(record(sections.performanceSection).performanceTables);
  const asOf = toIsoDate(performance.asOfDate);
  for (const tab of array(performance.tabs).map(record)) {
    if (!/^annuali[sz]ed$/i.test(cleanText(tab.header))) continue;
    const table = record(tab.table);
    const columns = array(table.columns).map(record);
    const navRow = array(table.values).map(record).find(row => /^(?:NAV|Fund|Total return \(USD\))$/i.test(cleanText(record(row[String(columns[0]?.key)]).value)));
    if (!navRow || !asOf) continue;
    Object.assign(officialReturns, parseReturnRow(columns.map(col => cleanText(col.value)),
      columns.map(col => record(navRow[String(col.key)]).value), asOf));
  }
  return {
    ticker: expectedTicker, name: rawName, category: categories.join(' / ') || null,
    fundPage: /^https:\/\/etf\.dws\.com\/en-us\//.test(actualPage) ? actualPage : fundPage,
    inceptionDate: toIsoDate(fact('Listing date')), terValue: numberOrNull(fact('Total operating expenses')),
    netTerValue: numberOrNull(fact('Net expense ratio')), aumValue: numberOrNull(fact('Net assets')),
    officialReturns, cusip: cleanText(fact('CUSIP')) || null, isin: cleanText(fact('ISIN')) || null,
    indexTicker: cleanText(fact('Index ticker')) || null, exchange: cleanText(fact('Primary listing exchange')) || null,
    navValue: numberOrNull(record(navItem?.value).price), navAsOfDate: toIsoDate(navDateText),
    secYield: numberOrNull(head('30-day SEC yield')), distributionRate: numberOrNull(head('Distribution rate')),
    frequency: cleanText(fact('Distribution frequency')) || null,
    midpoint: numberOrNull(itemValue(record(record(sections.pricingDetails).premiumDiscount).premiumDiscountList &&
      record(record(record(sections.pricingDetails).premiumDiscount).premiumDiscountList).items, 'Mid-point')),
    premiumDiscount: numberOrNull(itemValue(record(record(record(sections.pricingDetails).premiumDiscount).premiumDiscountList).items, 'Premium discount')),
  };
}
export function parseHoldingsRows(rows: string[][], ticker: string): Sheet {
  validateWorkbookTicker(rows, ticker);
  const records = workbookRecords(rows, findHeader(rows, ['Name', 'Weight %', '$ Market Value']));
  const holdings = records.filter(row => cleanText(row.name) && numberOrNull(row.weight) !== null && numberOrNull(row.marketvalue) !== null)
    .map(row => ({
      Name: cleanText(row.name),
      // Bond/forward Bloomberg symbols are not equity tickers. Do not invent exchange symbols.
      Ticker: /equity|equities|stock|\betf\b|\bfund\b/i.test(row.assetclass) ? cleanText(row.symbol) || '-' : '-',
      Identifier: cleanText(row.cusip || row.isin || row.sedol) || '-',
      Weight: String(numberOrNull(row.weight)), 'Market Value': String(numberOrNull(row.marketvalue)),
      'Shares Held': numberOrNull(row.quantity) === null ? '-' : String(numberOrNull(row.quantity)),
      'Asset Category': cleanText(row.assetclass) || (/cash/i.test(row.name) ? 'Cash' : '-'),
    })).sort((a, b) => Number(b.Weight) - Number(a.Weight) || a.Identifier.localeCompare(b.Identifier) || a.Name.localeCompare(b.Name));
  if (!holdings.length) throw new Error('Securities: no usable positions');
  return { headers: HOLDINGS_HEADERS, rows: holdings, asOfDate: toIsoDate(metaValue(rows, 'As of')) };
}
export function parseDistributionsRows(rows: string[][], ticker: string): Dividend[] {
  validateWorkbookTicker(rows, ticker);
  const records = workbookRecords(rows, findHeader(rows, ['Ex-Date', 'US$ / Share']));
  const events = new Map<string, Dividend>();
  for (const row of records) {
    const date = toIsoDate(row.exdate), amount = numberOrNull(row.usshare);
    if (!date || amount === null || amount < 0) continue;
    const event = { exDate: date, epoch: Date.parse(date + 'T00:00:00Z') / 1000, amount,
      recordDate: toIsoDate(row.recorddate), payDate: toIsoDate(row.paydate) };
    const previous = events.get(date);
    if (previous && previous.amount !== amount) throw new Error(`Distributions: ambiguous duplicate ${date}`);
    events.set(date, event);
  }
  return [...events.values()].sort((a, b) => a.epoch - b.epoch);
}
export function parseNavRows(rows: string[][], ticker: string): NavPoint[] {
  validateWorkbookTicker(rows, ticker);
  const records = workbookRecords(rows, findHeader(rows, ['Date', 'NAV']));
  const points = new Map<string, NavPoint>();
  for (const row of records) {
    const date = toIsoDate(row.date), nav = numberOrNull(row.nav);
    if (!date || nav === null || nav <= 0) continue;
    points.set(date, { date, nav, aum: numberOrNull(row.aum), shares: numberOrNull(row.outstandingshares), dividend: numberOrNull(row.dividendspaid) });
  }
  if (!points.size) throw new Error('Performance: no daily NAV points');
  return [...points.values()].sort((a, b) => a.date.localeCompare(b.date));
}
export function parseChart(payload: unknown): ParsedChart {
  const chart = record(record(payload).chart);
  const result = record(array(chart.result)[0]);
  if (!Object.keys(result).length) throw new Error('Yahoo: empty chart result');
  const meta = record(result.meta), indicators = record(result.indicators);
  const quote = record(array(indicators.quote)[0]), adj = record(array(indicators.adjclose)[0]);
  const days = array(result.timestamp).flatMap((epoch, i) => {
    const close = numberOrNull(array(quote.close)[i]);
    if (typeof epoch !== 'number' || !Number.isFinite(epoch) || close === null || close <= 0) return [];
    return [{ date: epochToIsoDate(epoch), close: round(close), adjClose: round(numberOrNull(array(adj.adjclose)[i]) ?? close, 2),
      volume: numberOrNull(array(quote.volume)[i]) ?? 0 }];
  }).sort((a, b) => a.date.localeCompare(b.date));
  const dividends = Object.values(record(record(result.events).dividends)).map(record).flatMap(event => {
    const epoch = numberOrNull(event.date), amount = numberOrNull(event.amount);
    if (epoch === null || amount === null || amount <= 0) return [];
    return [{ epoch, amount, exDate: epochToIsoDate(epoch), recordDate: null, payDate: null }];
  }).sort((a, b) => a.epoch - b.epoch);
  return { days, dividends, exchange: cleanText(meta.fullExchangeName || meta.exchangeName) || null,
    firstTradeDate: numberOrNull(meta.firstTradeDate) === null ? null : epochToIsoDate(Number(meta.firstTradeDate)) };
}
export function annualizedToTotal(annualizedPercent: number | null | undefined, years: number): number | null {
  if (typeof annualizedPercent !== 'number' || !Number.isFinite(annualizedPercent) || years <= 0) return null;
  return round(((1 + annualizedPercent / 100) ** years - 1) * 100, 2);
}
export function totalToAnnualized(totalPercent: number | null | undefined, years: number): number | null {
  if (typeof totalPercent !== 'number' || !Number.isFinite(totalPercent) || totalPercent < -100 || years <= 0) return null;
  return round(((1 + totalPercent / 100) ** (1 / years) - 1) * 100, 2);
}
export function indicatedYield(amount: number | null, payments: number | null, price: number | null): number | null {
  if (amount === null || payments === null || price === null || ![amount, payments, price].every(Number.isFinite) || amount <= 0 || payments <= 0 || price <= 0) return null;
  return round(amount * payments / price * 100, 2);
}
export function distributionFrequency(raw: string | null, dividends: Dividend[]): { frequency: string; paymentsPerYear: number | null } {
  const key = cleanText(raw).toLowerCase().replace(/[^a-z]/g, '');
  const known: Record<string, [string, number]> = { monthly: ['Monthly', 12], quarterly: ['Quarterly', 4],
    semiannual: ['Semi-annually', 2], semiannually: ['Semi-annually', 2], annual: ['Annually', 1], annually: ['Annually', 1], yearly: ['Annually', 1] };
  if (known[key]) return { frequency: known[key][0], paymentsPerYear: known[key][1] };
  const dates = [...new Set(dividends.filter(d => d.amount > 0).map(d => d.epoch))].sort((a, b) => a - b).slice(-13);
  if (dates.length < 3) return { frequency: dates.length ? 'Unknown' : 'None', paymentsPerYear: null };
  const gaps = dates.slice(1).map((date, i) => (date - dates[i]) / 86400);
  for (const [lo, hi, frequency, payments] of [[20, 40, 'Monthly', 12], [65, 115, 'Quarterly', 4], [140, 220, 'Semi-annually', 2], [300, 400, 'Annually', 1]] as const) {
    if (gaps.filter(gap => gap >= lo && gap <= hi).length / gaps.length >= 0.8) return { frequency, paymentsPerYear: payments };
  }
  return { frequency: 'Irregular', paymentsPerYear: null };
}
export function navTotalReturnDays(points: NavPoint[], dividends: Dividend[]): ChartDay[] {
  const cash = new Map<string, number>();
  for (const event of dividends) cash.set(event.exDate, (cash.get(event.exDate) ?? 0) + event.amount);
  let adjusted = points[0]?.nav ?? 0;
  return points.map((point, i) => {
    if (i > 0) adjusted *= (point.nav + (cash.get(point.date) ?? 0)) / points[i - 1].nav;
    return { date: point.date, close: point.nav, adjClose: adjusted, volume: 0 };
  });
}
export function deriveReturns(days: ChartDay[], asOfDate: string, inception: string | null = null): OfficialReturnRow {
  const series = days.filter(day => day.date <= asOfDate && day.adjClose > 0);
  const last = series.at(-1), result = emptyReturns();
  if (!last) return result;
  result.asOfDate = last.date;
  const at = (iso: string): ChartDay | null => series.findLast(day => day.date <= iso) ?? null;
  const target = new Date(asOfDate + 'T00:00:00Z');
  const change = (anchor: ChartDay | null, years?: number): number | null => {
    if (!anchor || anchor.date >= last.date) return null;
    const ratio = last.adjClose / anchor.adjClose;
    return round((years ? ratio ** (1 / years) - 1 : ratio - 1) * 100, 2);
  };
  result.ytd = change(at(`${target.getUTCFullYear() - 1}-12-31`));
  for (const [years, slot] of [[1, 'yr1'], [3, 'yr3'], [5, 'yr5'], [10, 'yr10']] as const) {
    const anchor = new Date(target); anchor.setUTCFullYear(anchor.getUTCFullYear() - years);
    result[slot] = change(at(anchor.toISOString().slice(0, 10)), years > 1 ? years : undefined);
  }
  const first = series[0];
  const span = (Date.parse(last.date) - Date.parse(first.date)) / (365.25 * 86400000);
  // A range-limited chart must never be labelled since inception.
  if (inception && Math.abs(Date.parse(first.date) - Date.parse(inception)) <= 7 * 86400000 && span >= 1) result.sinceInception = change(first, span);
  return result;
}
export function historySheet(points: NavPoint[], days: ChartDay[]): Sheet {
  const nav = new Map(points.map(point => [point.date, point]));
  const prices = new Map(days.map(day => [day.date, day]));
  const dates = [...new Set([...nav.keys(), ...prices.keys()])].sort();
  return { headers: HISTORY_HEADERS, asOfDate: dates.at(-1) ?? null, rows: dates.map(date => {
    const n = nav.get(date), p = prices.get(date);
    return { Date: date, NAV: n ? String(n.nav) : '', 'Market Price': p ? String(p.close) : '',
      'Premium/Discount': n && p ? String(round((p.close / n.nav - 1) * 100, 4)) : '',
      'Adj Close': p ? String(p.adjClose) : '', Volume: p ? String(p.volume) : '' };
  }) };
}
export type PageManifest = { pages: string[]; pageSize: number; totalRows: number; asOfDate: string | null; source: string };
export function pageManifest(kind: 'holdings' | 'history', sheet: Sheet, pageSize: number, source: string): PageManifest {
  if (!Number.isInteger(pageSize) || pageSize <= 0) throw new Error('pageSize must be positive');
  return { pages: Array.from({ length: Math.ceil(sheet.rows.length / pageSize) }, (_, i) => `${kind}/${String(i + 1).padStart(3, '0')}.json`),
    pageSize, totalRows: sheet.rows.length, asOfDate: sheet.asOfDate, source };
}

// CLI/provider orchestration is added in the next tested checkpoint.
