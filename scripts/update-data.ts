#!/usr/bin/env bun
/// <reference types="bun" />

// Xtrackers (DWS) static feed. Bun-only, zero runtime dependencies.
// ZIP/OpenXML helpers adapted from daggerok/SPDR @ d26fe5547c98f1a259f1198f4e789363b11f2491.
// Reporting, N-PORT and financial helpers follow pinned JPMorgan.
import { inflateRawSync } from 'node:zlib';
import { readFileSync as readUpdaterConfig } from 'node:fs';
import { appendFile, readFile, readdir, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile as outputReadFile, readdir as outputReadDir } from 'node:fs/promises';
import { createHash as outputCreateHash } from 'node:crypto';
import { join as outputJoin } from 'node:path';
import { fileURLToPath as outputFileURLToPath } from 'node:url';

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
// adjCloseRaw: Yahoo's unrounded value, only used to tell float noise from a real change (never persisted).
export type ChartDay = { date: string; close: number; adjClose: number; volume: number; adjCloseRaw?: number };
export type ParsedChart = {
  days: ChartDay[];
  dividends: Dividend[];
  exchange: string | null;
  firstTradeDate: string | null;
};
export const HOLDINGS_HEADERS = ['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held', 'Asset Category'];
/** Funds whose holdings legitimately fail a holdingsGuard check (geared, futures, look-through, top-N lists): ticker, or '*' for every fund -> relaxed checks. */
export const HOLDINGS_GUARD_RELAX: Record<string, string[]> = {};
/** Funds the issuer closed, each confirmed from an SEC filing or the issuer notice (`source`): never fetched or guarded, last published data kept, index row marked closed. */
export const CLOSED_FUNDS: ClosedFund[] = [];
export const HISTORY_HEADERS = ['Date', 'NAV', 'Market Price', 'Premium/Discount'];
export const YAHOO_HISTORY_HEADERS = ['Date', 'Close', 'Adj Close', 'Volume'];
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
  // ISO, U.S. and month-name dates as plain calendar text, never through the local time zone (shared calendar-dates block)
  return calendarIso(text);
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
/**
 * A DWS holdings symbol as published (XT-1): a U.S. venue suffix (`NVDA.O`, `TER.N`, `HPE.UN`, `GOOG UW`, `TSM US`, `THC N`) is
 * dropped, so one U.S. listing has one ticker in every fund; a foreign exchange code stays (`8035 JT`, `SAP GY`), so a local
 * code never poses as a U.S. ticker. '' for an empty cell.
 */
export function dwsTicker(raw: unknown): string {
  const symbol = cleanText(raw).toUpperCase();
  const us = /^([A-Z0-9][A-Z0-9./-]*?)(?:\.(?:O|N|OQ|UW|UN|UQ)| (?:US|UN|UW|UQ|UR|UA|UP|UF|UV|N|O))$/.exec(symbol);
  return us ? us[1] : symbol;
}
export function parseHoldingsRows(rows: string[][], ticker: string): Sheet {
  validateWorkbookTicker(rows, ticker);
  const records = workbookRecords(rows, findHeader(rows, ['Name', 'Weight %', '$ Market Value']));
  const holdings = records.filter(row => cleanText(row.name) && numberOrNull(row.weight) !== null && numberOrNull(row.marketvalue) !== null)
    .map(row => ({
      Name: cleanText(row.name),
      // Bond/forward Bloomberg symbols are not equity tickers. Do not invent exchange symbols.
      Ticker: /equity|equities|stock|\betf\b|\bfund\b/i.test(row.assetclass) ? dwsTicker(row.symbol) || '-' : '-',
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
    const adjClose = numberOrNull(array(adj.adjclose)[i]) ?? close;
    return [{ date: epochToIsoDate(epoch), close: round(close), adjClose: round(adjClose, 2),
      volume: numberOrNull(array(quote.volume)[i]) ?? 0, adjCloseRaw: adjClose }];
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
  if (typeof annualizedPercent !== 'number' || !Number.isFinite(annualizedPercent) || annualizedPercent < -100 || years <= 0) return null;
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
  const at = (iso: string): ChartDay | null => {
    const day = series.findLast(point => point.date <= iso);
    return day && Date.parse(iso) - Date.parse(day.date) <= 7 * 86400000 ? day : null;
  };
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
// Yahoo's adjusted close is float32 and its last digits move with the request's period2, so a value
// sitting on a cent boundary (31.544998 vs 31.545001) flips between runs. Within that noise the
// published cent is kept: a rerun with the same source data changes nothing.
export const ADJ_CLOSE_NOISE = 1e-4;
export function keepPublishedAdjClose(published: ChartDay[], fresh: ChartDay[]): ChartDay[] {
  const prior = new Map(published.map(day => [day.date, day.adjClose]));
  return fresh.map(day => {
    const kept = prior.get(day.date), raw = day.adjCloseRaw ?? day.adjClose;
    return kept !== undefined && kept !== day.adjClose && Math.abs(raw - kept) <= 0.005 + ADJ_CLOSE_NOISE ? { ...day, adjClose: kept } : day;
  });
}
export function historySheet(points: NavPoint[], days: ChartDay[]): Sheet {
  // Keep official NAV and adjusted market-price series distinct, as in the primary sibling.
  if (!points.length) return { headers: YAHOO_HISTORY_HEADERS, asOfDate: days.at(-1)?.date ?? null,
    rows: days.map(day => ({ Date: day.date, Close: String(day.close), 'Adj Close': String(day.adjClose), Volume: String(day.volume) })) };
  const nav = new Map(points.map(point => [point.date, point]));
  const prices = new Map(days.map(day => [day.date, day]));
  const dates = [...new Set([...nav.keys(), ...prices.keys()])].sort();
  return { headers: HISTORY_HEADERS, asOfDate: dates.at(-1) ?? null, rows: dates.map(date => {
    const n = nav.get(date), p = prices.get(date);
    return { Date: date, NAV: n ? String(n.nav) : '', 'Market Price': p ? String(p.close) : '',
      'Premium/Discount': n && p ? String(round((p.close / n.nav - 1) * 100, 4)) : '' };
  }) };
}
export type PageManifest = { pages: string[]; pageSize: number; totalRows: number; asOfDate: string | null; source: string };
export function pageManifest(kind: 'holdings' | 'history', sheet: Sheet, pageSize: number, source: string): PageManifest {
  if (!Number.isInteger(pageSize) || pageSize <= 0) throw new Error('pageSize must be positive');
  return { pages: Array.from({ length: Math.ceil(sheet.rows.length / pageSize) }, (_, i) => `${kind}/${String(i + 1).padStart(3, '0')}.json`),
    pageSize, totalRows: sheet.rows.length, asOfDate: sheet.asOfDate, source };
}



// Console presentation; no changes to provider requests or persisted data.
/** Presentation only: no requests, writes, filtering, or changes to updater state. */

const outputClean = (value: unknown): string => String(value ?? 'null').replace(/[\r\n\t]+/g, ' ');
/** Presentation only: per-fund retry and fallback notices are printed when VERBOSE is enabled. */
const outputVerbose = (): boolean => /^(1|true|yes|on)$/i.test((globalThis as any).process?.env?.VERBOSE ?? '');
function outputNote(message: string): void { if (outputVerbose()) console.warn(message); }
/** Names are the canonical environment knobs, not internal parser properties. */
function outputConfigEntries(config: Record<string, any>): [string, string][] {
  const values = new Map<string, string>();
  const aliases: Record<string, string> = {
    requestSleepSeconds: 'REQUEST_SLEEP', categories: 'CATEGORY',
    aumRange: 'AUM', terRange: 'TER', dividendYieldRange: 'DIVIDEND_YIELD', secYieldRange: 'SEC_YIELD',
    performanceRanges: 'PERFORMANCE', totalReturnRanges: 'TOTAL_RETURN',
    skipVanEck: 'SKIP_VANECK', skipProShares: 'SKIP_PROSHARES',
    skipWisdomTree: 'SKIP_WISDOMTREE', skipGoldmanSachs: 'SKIP_GOLDMANSACHS',
    skipGlobalX: 'SKIP_GLOBALX', skipNorthernTrust: 'SKIP_NORTHERNTRUST',
  };
  const range = (v: any): string => typeof v === 'string' ? v : v?.source ?? `${Number.isFinite(v?.min) ? v.min : ''}:${Number.isFinite(v?.max) ? v.max : ''}`;
  for (const [key, value] of Object.entries(config)) {
    if (['proxyGapMs', 'fetchTimeoutMs', 'retryDelayMs'].includes(key)) continue;
    const name = aliases[key] ?? (/^[A-Z0-9_]+$/.test(key) ? key : key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase());
    if (name === 'PERFORMANCE' || name === 'TOTAL_RETURN') {
      for (const period of ['YTD', '1Y', '3Y', '5Y', '10Y']) values.set(`${name}_${period}`, range(value?.[period]));
    } else if (['AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD'].includes(name)) {
      values.set(name, range(value));
    } else {
      values.set(name, value instanceof Set ? [...value].join(',') || 'all' : Array.isArray(value) ? value.join(',') || 'all' : outputClean(value));
    }
  }
  const first = ['MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY'];
  return [...values].sort(([a], [b]) => {
    const ai = first.indexOf(a), bi = first.indexOf(b);
    return (ai < 0 ? first.length : ai) - (bi < 0 ? first.length : bi) || a.localeCompare(b);
  });
}
function outputConfigValue(key: string, value: string): string {
  if (/TOKEN|PASSWORD|SECRET|COOKIE|SEC_UA/i.test(key)) return '<redacted>';
  if (key === 'TICKERS' && ['', 'null', 'undefined'].includes(value)) return 'all';
  return outputClean(value);
}
function outputPrintConfig(brand: string, config: Record<string, any>): void {
  const entries: [string, string][] = [...outputConfigEntries(config), ['VERBOSE', String(outputVerbose())]];
  console.log(`[ config   ] ${brand} updater:\n${entries.map(([key, value]) => `              ${key}=${outputConfigValue(key, value)}`).join('\n')}`);
}
function outputHasOutputFilters(config: Record<string, any>): boolean {
  return outputConfigEntries(config).some(([name, value]) =>
    /^(CATEGORY|AUM|TER|DIVIDEND_YIELD|SEC_YIELD|PERFORMANCE_|TOTAL_RETURN_)/.test(name) &&
    !['', ':', 'null', 'all'].includes(value));
}
function outputPrintFilter(selected: number, total: number, deferred = false): void {
  console.log(`[ filter   ] ${selected} of ${total} funds ${deferred ? 'selected for evaluation (data-dependent filters applied per fund)' : 'pass filters'}`);
}
function outputStable(value: any): any {
  if (Array.isArray(value)) return value.map(outputStable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => !['generatedAt', 'catalogReadAt'].includes(key)).map(key => [key, outputStable(value[key])]));
  return value;
}
function outputContentKey(value: unknown): string { return JSON.stringify(outputStable(value)) ?? 'null'; }
async function outputInspectFund(root: URL | string, ticker: string): Promise<{ digest: string; meta: any }> {
  const dir = outputJoin(root instanceof URL ? outputFileURLToPath(root) : root, 'funds', ticker);
  const hash = outputCreateHash('sha256');
  async function visit(path: string): Promise<void> {
    const entries = await outputReadDir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) await visit(outputJoin(path, entry.name));
      else if (entry.name.endsWith('.json')) {
        const text = await outputReadFile(outputJoin(path, entry.name), 'utf8').catch(() => '');
        hash.update(outputJoin(path.slice(dir.length), entry.name));
        try { hash.update(outputContentKey(JSON.parse(text))); } catch { hash.update(text); }
      }
    }
  }
  await visit(dir);
  const meta = await outputReadFile(outputJoin(dir, 'meta.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  return { digest: hash.digest('hex'), meta };
}
const outputCount = (value: any): unknown => typeof value === 'number' ? value : Array.isArray(value) ? value.length : value?.totalRows ?? value?.rows?.length ?? null;
const outputScalar = (value: any): any => value && typeof value === 'object' ? value.display ?? value.value ?? null : value;
const outputUnits: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12, THOUSAND: 1e3, MILLION: 1e6, BILLION: 1e9, TRILLION: 1e12 };
function outputMoney(value: any): string {
  const raw = value && typeof value === 'object' && typeof value.value === 'number' && Number.isFinite(value.value) ? value.value : outputScalar(value);
  if (raw === null || raw === undefined || raw === '—' || raw === '--') return 'null';
  const text = String(raw).replace(/[$,\s]/g, '');
  const match = text.match(/^([+-]?[\d.]+)(K|M|B|T|Thousand|Million|Billion|Trillion)?$/i);
  if (!match) return outputClean(raw);
  const number = Number(match[1]) * (outputUnits[match[2]?.toUpperCase() ?? ''] ?? 1);
  if (!Number.isFinite(number)) return 'null';
  for (const [unit, scale] of [['T', 1e12], ['B', 1e9], ['M', 1e6], ['K', 1e3]] as const) {
    if (Math.abs(number) >= scale) return `$${(number / scale).toFixed(1)}${unit}`;
  }
  return `$${number.toFixed(2)}`;
}
/** Yields: rounded to 2 decimals without trailing zeros; placeholders are omitted like null. */
function outputPercent(value: any): unknown {
  const raw = outputScalar(value);
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Number(raw.toFixed(2)) : null;
  const text = String(raw).trim().replace(/%$/, '').trim();
  if (['', '-', '—', '--', 'n/a'].includes(text.toLowerCase())) return null;
  const number = Number(text.replace(/,/g, ''));
  return Number.isFinite(number) ? Number(number.toFixed(2)) : outputClean(raw);
}
function outputFundLine(index: number, total: number, ticker: string, status: string, data: any = {}, reason?: unknown): string {
  const width = Math.max(2, String(total).length);
  const metrics = data.metrics ?? {};
  // Presentation only. Keep valid zero/false values; omit unavailable fields.
  // outputMoney returns the string 'null' for an unavailable monetary value.
  const field = (key: string, value: unknown): string =>
    value === null || value === undefined || value === 'null' ? '' : `${key}=${outputClean(value)}`;
  const sources = [
    field('official', data.officialHistoryCount),
    field('yahoo', data.yahooHistoryCount),
  ].filter(part => part !== '').join(' ');
  const detail = [
    field('port', data.portId ?? data.portfolioId),
    field('history', outputCount(data.history ?? data.historyCount)),
    sources ? `(${sources})` : '',
    field('holdings', outputCount(data.holdings ?? data.holdingsCount)),
    field('divs', outputCount(data.worksheets?.Distributions ?? data.distributions)),
    field('netAssets', outputMoney(data.netAssets ?? data.aum)),
    field('total', outputMoney(data.totalFundNetAssets ?? data.totalNetAssets)),
    field('div', outputPercent(data.trailingYield ?? data.yields?.effectiveYield ?? data.yields?.dividendYield ?? data.dividendYield ?? metrics.dividendYield)),
    field('sec', outputPercent(data.secYield ?? data.yields?.secYield ?? metrics.secYield)),
    field('wp', data.workplaceRaw),
  ].filter(part => part !== '').join(' ');
  return `[ ${String(index).padStart(width)}/${String(total).padEnd(width)}  ] ${outputClean(ticker).padEnd(5)} ${status.padEnd(9)}${detail ? ` ${detail}` : ''}${reason ? ` reason=${outputClean(reason)}` : ''}`;
}
function outputCreateReporter(root: URL | string, total: number) {
  let completed = 0;
  const tally = new Map<string, number>();
  return {
    before: (ticker: string) => outputInspectFund(root, ticker),
    async result(ticker: string, before: { digest: string }, status?: string, reason?: unknown, extra: any = {}) {
      const after = await outputInspectFund(root, ticker);
      const final = status ?? (before.digest === after.digest ? 'unchanged' : 'updated');
      tally.set(final, (tally.get(final) ?? 0) + 1);
      console.log(outputFundLine(++completed, total, ticker, final, { ...after.meta, ...extra }, reason));
    },
    /** First [ done ] line: the statuses of every fund line this reporter printed. */
    summary(startedAt: number): string {
      const order = ['updated', 'unchanged', 'kept', 'skipped', 'failed'];
      const statuses = [...order, ...[...tally.keys()].filter(status => !order.includes(status))];
      return `[ done     ] ${completed} fund${completed === 1 ? '' : 's'}: ${statuses.map(status => `${tally.get(status) ?? 0} ${status}`).join(', ')} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
    },
  };
}
/** Second [ done ] line: published totals. */
function outputCounts(funds: number, holdings: number, history: number): string {
  return `[ done     ] counts: ${funds.toLocaleString('en-US')} funds / ${holdings.toLocaleString('en-US')} holdings rows / ${history.toLocaleString('en-US')} history rows`;
}

// --- TLS trust store (identical in every ETF repo) ---
const SYSTEM_CA_MARKER = 'ETF_UPDATER_SYSTEM_CA';
const CERT_ERROR = /UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_HAS_EXPIRED|unable to get (?:local )?issuer certificate|self[- ]signed certificate|certificate has expired/i;

export function isCertError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; cause?: unknown } | null;
  return CERT_ERROR.test(`${String(e?.code ?? '')} ${String(e?.message ?? '')}`) || (e?.cause ? isCertError(e.cause) : false);
}

export function systemCaActive(env: Record<string, string | undefined> = process.env, execArgv: string[] = process.execArgv): boolean {
  return execArgv.includes('--use-system-ca') || env.NODE_USE_SYSTEM_CA === '1' || env[SYSTEM_CA_MARKER] === '1';
}

export function reexecWithSystemCa(): never {
  const child = Bun.spawnSync([process.execPath, '--use-system-ca', ...process.argv.slice(1)], {
    env: { ...process.env, [SYSTEM_CA_MARKER]: '1' },
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  process.exit(child.exitCode ?? 1);
}

/** mode: auto (restart once on an untrusted-certificate error), true (restart now), false (never). */
export function installSystemCa(mode: string, reexec: () => never = reexecWithSystemCa, active: boolean = systemCaActive()): void {
  if (mode === 'false' || active) return;
  if (mode === 'true') reexec();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    try { return await realFetch(...args); }
    catch (error) {
      if (!isCertError(error)) throw error;
      console.error('[ notice   ] TLS certificate not trusted; restarting once with --use-system-ca');
      return reexec();
    }
  }) as typeof fetch;
}
export function parseSystemCaMode(raw: string): 'auto' | 'true' | 'false' {
  const mode = raw.trim().toLowerCase();
  if (mode !== 'auto' && mode !== 'true' && mode !== 'false') throw new Error('USE_SYSTEM_CA: auto, true or false required');
  return mode;
}

// Configuration: canonical controls are also used to generate/guard help and Actions inputs.
export const RETURN_PERIODS = ['YTD', '1Y', '3Y', '5Y', '10Y'] as const;
export type ReturnPeriod = typeof RETURN_PERIODS[number];
export type Range = { min?: number; max?: number; source?: string };
export type RangeMap = Partial<Record<ReturnPeriod, Range>>;
export type UpdaterConfig = {
  maxFetches: number; requestSleepSeconds: number; concurrency: number; tickers: Set<string>;
  aumRange?: Range; terRange?: Range; dividendYieldRange?: Range; secYieldRange?: Range;
  performanceRanges: RangeMap; totalReturnRanges: RangeMap;
  holdingsPageSize: number; historyPageSize: number; maxRetries: number; historyRange: string;
  secUa: string; skipYahoo: boolean; edgarFallback: boolean; verbose: boolean; useSystemCa: 'auto' | 'true' | 'false';
};
export const DEFAULT_SEC_UA = 'daggerok ETF feed daggerok@gmail.com';
// Built-in values used when a control resolves blank; the checked-in JSON mirrors them.
const BUILTIN_CONTROL_DEFAULTS: Record<string, string> = {
  MAX_FETCHES: '0', REQUEST_SLEEP: '1.5', CONCURRENCY: '2', TICKERS: '', AUM: ':', TER: ':',
  DIVIDEND_YIELD: ':', SEC_YIELD: ':', HOLDINGS_PAGE_SIZE: '250', HISTORY_PAGE_SIZE: '1000', MAX_RETRIES: '2',
  HISTORY_RANGE: 'max', SEC_UA: DEFAULT_SEC_UA, SKIP_YAHOO: 'false', EDGAR_FALLBACK: 'true', VERBOSE: 'false', USE_SYSTEM_CA: 'auto',
  ...Object.fromEntries(RETURN_PERIODS.flatMap(period => [[`PERFORMANCE_${period}`, ':'], [`TOTAL_RETURN_${period}`, ':']])),
};
export const CONFIG_FILE_URL = new URL('./update-data.config.json', import.meta.url);
function readConfigFile(path: string | URL = CONFIG_FILE_URL): unknown {
  try { return JSON.parse(readUpdaterConfig(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return {}; }
}
// A control that resolves blank uses its built-in default; every other value is validated strictly.
const controlValue = (env: Record<string, string | undefined>, name: string): string => env[name]?.trim() || BUILTIN_CONTROL_DEFAULTS[name] || '';
export function parsePositiveInt(raw: string, name: string, minimum = 1): number {
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < minimum) throw new Error(`${name}: integer >= ${minimum} required`);
  return Number(raw);
}
export function parseDecimal(raw: string, name: string, minimum = 0): number {
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw) || !Number.isFinite(Number(raw)) || Number(raw) < minimum) throw new Error(`${name}: decimal >= ${minimum} required`);
  return Number(raw);
}
export function parseBoolean(raw: string, name: string): boolean {
  if (/^(1|true|yes|y|on)$/i.test(raw)) return true;
  if (/^(0|false|no|n|off)$/i.test(raw)) return false;
  throw new Error(`${name}: boolean required`);
}
export function parseHistoryRange(raw: string): string {
  if (!/^(max|[1-9]\d*y)$/i.test(raw)) throw new Error('HISTORY_RANGE: use max or Ny (e.g. 5y)');
  return raw.toLowerCase();
}
/** First epoch second of the Yahoo/history window: `max` -> 0, `Ny` -> N years before now. */
export function historyWindowStartEpoch(historyRange: string, nowEpochSeconds: number): number {
  const years = /^([1-9]\d*)y$/i.exec(historyRange.trim());
  return years ? Math.max(0, Math.floor(nowEpochSeconds - Number(years[1]) * 365.25 * 86400)) : 0;
}
export function yahooChartUrl(ticker: string, nowEpochSeconds = Math.floor(Date.now() / 1000), historyRange = 'max'): string {
  return yahooSourceUrl(ticker) + `?period1=${historyWindowStartEpoch(historyRange, nowEpochSeconds)}&period2=${Math.floor(nowEpochSeconds)}&interval=1d&events=div%7Csplit`;
}
export function parseRange(raw: string, name = 'range'): Range | undefined {
  if (!raw.trim() || raw.trim() === ':') return undefined;
  const match = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))?\s*:\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))?\s*$/.exec(raw);
  if (!match) throw new Error(`${name}: min:max required`);
  const min = match[1] ? Number(match[1]) : undefined, max = match[2] ? Number(match[2]) : undefined;
  if ((min !== undefined && !Number.isFinite(min)) || (max !== undefined && !Number.isFinite(max)) || (min !== undefined && max !== undefined && min > max)) throw new Error(`${name}: invalid bounds`);
  return { min, max, source: raw.trim() };
}
const AUM_PRESET_BOUNDS: Record<string, [number | undefined, number | undefined]> = {
  nano: [undefined, 10000000], micro: [10000000, 300000000], small: [300000000, 2000000000], mid: [2000000000, 10000000000], large: [10000000000, undefined],
};
export function parseAumRange(raw: string): Range | undefined {
  if (!raw.trim() || raw.trim() === ':') return undefined;
  const input = raw.trim().toLowerCase();
  if (AUM_PRESET_BOUNDS[input]) {
    const [min, upper] = AUM_PRESET_BOUNDS[input];
    return { min, max: upper === undefined ? undefined : upper - 0.01, source: raw.trim() };
  }
  if (input.split(':').length !== 2) throw new Error('AUM: min:max or a preset required');
  const bound = (text: string, side: 0 | 1): string => {
    text = text.trim();
    if (!text) return '';
    if (AUM_PRESET_BOUNDS[text]) {
      const value = AUM_PRESET_BOUNDS[text][side];
      return value === undefined ? '' : String(side === 1 ? value - 0.01 : value);
    }
    const m = /^(\d+(?:\.\d+)?)([kmbt])?$/.exec(text);
    if (!m) throw new Error('AUM: invalid amount');
    const multiplier: Record<string, number> = { k: 1000, m: 1000000, b: 1000000000, t: 1000000000000 };
    return String(Number(m[1]) * (multiplier[m[2] || ''] || 1));
  };
  const [min, max] = input.split(':');
  return { ...parseRange(`${bound(min, 0)}:${bound(max, 1)}`, 'AUM'), source: raw.trim() };
}
export function readConfig(env: Record<string, string | undefined> = process.env): UpdaterConfig {
  const value = (name: string): string => controlValue(env, name);
  const ranges = (prefix: string): RangeMap => Object.fromEntries(RETURN_PERIODS.flatMap(period => {
    const parsed = parseRange(value(`${prefix}_${period}`), `${prefix}_${period}`);
    return parsed ? [[period, parsed]] : [];
  }));
  const tickers = new Set(value('TICKERS').split(/[\s,;]+/).filter(Boolean).map(raw => {
    const ticker = sanitizeTicker(raw); if (!ticker) throw new Error(`TICKERS: invalid ticker ${cleanText(raw)}`); return ticker;
  }));
  const secUa = value('SEC_UA');
  if (/[\r\n\x00-\x1f]/.test(secUa)) throw new Error('SEC_UA: control characters forbidden');
  return {
    maxFetches: parsePositiveInt(value('MAX_FETCHES'), 'MAX_FETCHES', 0),
    requestSleepSeconds: parseDecimal(value('REQUEST_SLEEP'), 'REQUEST_SLEEP'),
    concurrency: parsePositiveInt(value('CONCURRENCY'), 'CONCURRENCY'), tickers,
    aumRange: parseAumRange(value('AUM')), terRange: parseRange(value('TER'), 'TER'),
    dividendYieldRange: parseRange(value('DIVIDEND_YIELD'), 'DIVIDEND_YIELD'), secYieldRange: parseRange(value('SEC_YIELD'), 'SEC_YIELD'),
    performanceRanges: ranges('PERFORMANCE'), totalReturnRanges: ranges('TOTAL_RETURN'),
    holdingsPageSize: parsePositiveInt(value('HOLDINGS_PAGE_SIZE'), 'HOLDINGS_PAGE_SIZE'),
    historyPageSize: parsePositiveInt(value('HISTORY_PAGE_SIZE'), 'HISTORY_PAGE_SIZE'),
    maxRetries: parsePositiveInt(value('MAX_RETRIES'), 'MAX_RETRIES', 1), historyRange: parseHistoryRange(value('HISTORY_RANGE')),
    secUa, skipYahoo: parseBoolean(value('SKIP_YAHOO'), 'SKIP_YAHOO'), edgarFallback: parseBoolean(value('EDGAR_FALLBACK'), 'EDGAR_FALLBACK'),
    verbose: parseBoolean(value('VERBOSE'), 'VERBOSE'), useSystemCa: parseSystemCaMode(value('USE_SYSTEM_CA')),
  };
}
// Allowlisted scalar controls, shared by the CLI and the Actions resolver step so user input is never interpolated into bash.
// Precedence: config file < advanced JSON < nonblank individual inputs < environment (an explicitly set variable wins, even empty).
export const CONTROL_NAMES = [
  'MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY', 'TICKERS', 'AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD',
  'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE', 'MAX_RETRIES', 'HISTORY_RANGE', 'SEC_UA', 'SKIP_YAHOO', 'EDGAR_FALLBACK', 'VERBOSE', 'USE_SYSTEM_CA',
  ...(['PERFORMANCE', 'TOTAL_RETURN'] as const).flatMap(prefix => RETURN_PERIODS.map(period => `${prefix}_${period}` as const)),
] as const;
export type ControlName = (typeof CONTROL_NAMES)[number];
// Environment aliases of every control: XTRACKERS_<NAME> plus the legacy HISTORICAL_PAGE_SIZE. They sit in the
// environment layer; the plain name wins when both are set, and an explicitly empty alias counts as set.
export const ENV_ALIASES: Record<string, string[]> = { HISTORY_PAGE_SIZE: ['HISTORICAL_PAGE_SIZE'] };
export const envNames = (key: string): string[] => [key, `XTRACKERS_${key}`, ...(ENV_ALIASES[key] ?? [])];
export function resolveControls(
  file: unknown = {}, advanced: unknown = {}, inputs: unknown = {}, env: Record<string, string | undefined> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  const known = new Set<string>(CONTROL_NAMES);
  const apply = (value: unknown, skipEmpty = false): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuration must be a JSON object');
    for (const [key, raw] of Object.entries(value)) {
      if (!known.has(key)) throw new Error(`Unknown updater control: ${key}`);
      if (skipEmpty && (raw === '' || raw === undefined || raw === null)) continue;
      if (!['string', 'number', 'boolean'].includes(typeof raw)) throw new Error(`${key}: expected string, number or boolean`);
      const text = String(raw);
      if (/[\r\n\0]/.test(text)) throw new Error(`${key}: multiline/control characters are not allowed`);
      result[key] = text;
    }
  };
  apply(file);
  apply(advanced);
  apply(inputs, true);
  // The workflow writes resolved values to GITHUB_ENV and the updater resolves again, so env is authoritative:
  // an explicitly set variable wins even when empty (it clears the control to its built-in default).
  apply(Object.fromEntries(CONTROL_NAMES.flatMap(key => {
    const value = envNames(key).map(name => env[name]).find(candidate => candidate !== undefined);
    return value === undefined ? [] : [[key, value.trim()]];
  })));
  readConfig(result); // strict validation of every control before any request or write
  return result;
}
export async function runtimeControls(env: Record<string, string | undefined> = process.env): Promise<Record<string, string>> {
  return resolveControls(readConfigFile(), {}, {}, env);
}
export function inRange(value: number | null | undefined, range?: Range): boolean {
  if (!range) return true;
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  return (range.min === undefined || value >= range.min) && (range.max === undefined || value <= range.max);
}
export function fundFilterReasons(details: FundDetails, metrics: JsonRecord, config: UpdaterConfig): string[] {
  const reasons: string[] = [];
  for (const [name, value, range] of [
    ['AUM', details.aumValue, config.aumRange], ['TER', details.netTerValue ?? details.terValue, config.terRange],
    ['DIVIDEND_YIELD', numberOrNull(metrics.dividendYield), config.dividendYieldRange], ['SEC_YIELD', numberOrNull(metrics.secYield), config.secYieldRange],
  ] as const) if (!inRange(value, range)) reasons.push(name);
  const annualizedKeys: Record<ReturnPeriod, string> = { YTD: 'ytd', '1Y': 'tr1y', '3Y': 'cagr3y', '5Y': 'cagr5y', '10Y': 'cagr10y' };
  const cumulativeKeys: Record<ReturnPeriod, string> = { YTD: 'ytd', '1Y': 'tr1y', '3Y': 'tr3y', '5Y': 'tr5y', '10Y': 'tr10y' };
  for (const period of RETURN_PERIODS) {
    if (!inRange(numberOrNull(metrics[annualizedKeys[period]]), config.performanceRanges[period])) reasons.push(`PERFORMANCE_${period}`);
    if (!inRange(numberOrNull(metrics[cumulativeKeys[period]]), config.totalReturnRanges[period])) reasons.push(`TOTAL_RETURN_${period}`);
  }
  return reasons;
}
export function selectUpdateBatch<T extends { ticker: string }>(funds: T[], maximum: number, cursor: string | null): T[] {
  const sorted = [...funds].sort((a, b) => a.ticker.localeCompare(b.ticker));
  if (maximum <= 0) return sorted;
  const at = cursor ? sorted.findIndex(fund => fund.ticker === cursor) : -1;
  return (at < 0 ? sorted : sorted.slice(at + 1).concat(sorted.slice(0, at + 1))).slice(0, maximum);
}
export function printHelp(): void {
  const raw = readConfigFile() as Record<string, unknown>;
  console.log('Xtrackers ETF updater (Bun-only, zero runtime dependencies)\nUsage: bun scripts/update-data.ts [-h|--help]\n\nDefaults: scripts/update-data.config.json (an explicitly set environment variable overrides JSON; filters use AND). Every control also reads XTRACKERS_<NAME> from the environment (the plain name wins when both are set); HISTORICAL_PAGE_SIZE is an alias of HISTORY_PAGE_SIZE:');
  for (const name of CONTROL_NAMES) {
    const value = String(raw[name] ?? BUILTIN_CONTROL_DEFAULTS[name] ?? '');
    console.log(`  ${name}=${name === 'SEC_UA' ? value : value || 'all'}`);
  }
  console.log('\nMAX_FETCHES: 0 = full selected pass; positive = resumable evaluation batch.\nREQUEST_SLEEP: seconds per independent request lane, including retries.\nTICKERS: spaces, commas or semicolons; an unknown requested ticker fails before writes.\nAUM: min:max, K/M/B/T or nano/micro/small/mid/large. Other ranges: min:max in %.\nPERFORMANCE: annualized 3Y/5Y/10Y; TOTAL_RETURN: cumulative.\nMAX_RETRIES: retries after the initial request, integer >= 1.\nHISTORY_RANGE: Yahoo request window and published history rows, max or Ny (e.g. 5y).\nSEC_UA: User-Agent with a real contact for SEC EDGAR (default daggerok ETF feed daggerok@gmail.com).\nSKIP_YAHOO: do not call Yahoo Finance (published prices are retained). EDGAR_FALLBACK: SEC N-PORT-P holdings fallback.\nVERBOSE: per-request warnings. All source failures keep existing published data.\nUSE_SYSTEM_CA: auto restarts once with Bun --use-system-ca on an untrusted-certificate error; true always uses the system CA store; false never restarts.\n\nExamples:\n  TICKERS="ASHR HYLB DBEF" VERBOSE=1 bun scripts/update-data.ts\n  MAX_FETCHES=3 bun scripts/update-data.ts\n  AUM="1B:" TER=":0.5" bun scripts/update-data.ts\n  PERFORMANCE_1Y="15:" HISTORY_RANGE=5y bun scripts/update-data.ts');
}

// Independently paced request lanes. Reserve a lane synchronously before awaiting it.
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
export function createSerialQueue() {
  let tail: Promise<void> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const work = tail.then(fn, fn);
    tail = work.then(() => undefined, () => undefined);
    return work;
  };
}
export function createRequestGate(seconds: number, laneCount = 1, clock = Date.now, pause = sleep): () => Promise<void> {
  const interval = seconds * 1000;
  const nextStart = Array.from({ length: Math.max(1, laneCount) }, () => 0);
  const tails: Promise<void>[] = nextStart.map(() => Promise.resolve());
  const actualNext = nextStart.map(() => 0);
  return () => {
    let lane = 0;
    for (let i = 1; i < nextStart.length; i++) if (nextStart[i] < nextStart[lane]) lane = i;
    const start = Math.max(clock(), nextStart[lane]);
    nextStart[lane] = start + interval;
    const work = tails[lane].then(async () => {
      const wait = Math.max(0, Math.max(start, actualNext[lane]) - clock());
      if (wait) await pause(wait);
      actualNext[lane] = clock() + interval;
    });
    tails[lane] = work.then(() => undefined, () => undefined);
    return work;
  };
}
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export class HttpError extends Error {
  constructor(public status: number, public url: string) { super(`HTTP ${status} ${url}`); }
}
export function retryAfterMilliseconds(raw: string | null): number | null {
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.max(0, parsed - Date.now()) : null;
}
export async function fetchWithRetry(url: string, config: UpdaterConfig, gate: () => Promise<void>, fetcher: Fetcher = fetch,
  headers: Record<string, string> = {}, pause = sleep): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    await gate();
    try {
      const response = await fetcher(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; XtrackersStaticFeed/1.0; +https://github.com/daggerok/Xtrackers)', Accept: '*/*', ...headers }, signal: AbortSignal.timeout(45000) });
      if (response.ok) return response;
      const retryable = [408, 425, 429].includes(response.status) || response.status >= 500;
      if (attempt >= config.maxRetries || !retryable) throw new HttpError(response.status, url);
      const delay = Math.min(60000, retryAfterMilliseconds(response.headers.get('Retry-After')) ?? 1000 * 2 ** attempt);
      await response.body?.cancel();
      outputNote(`[ retry    ] ${response.status} ${url}; retry ${attempt + 1}/${config.maxRetries}`);
      await pause(delay);
    } catch (error) {
      if (error instanceof HttpError || attempt >= config.maxRetries) throw error;
      outputNote(`[ retry    ] ${url}; ${errorMessage(error)}; retry ${attempt + 1}/${config.maxRetries}`);
      await pause(Math.min(60000, 1000 * 2 ** attempt));
    }
  }
}
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
export const secHeaders = (config: UpdaterConfig): Record<string, string> => ({ 'User-Agent': config.secUa, Accept: 'application/json, text/xml, */*' });

// Recursive timestamp/key normalization is used BOTH for reporting and actual file writes.
export function samePublishedContent(previous: string, value: unknown): boolean {
  try { return outputContentKey(JSON.parse(previous)) === outputContentKey(value); } catch { return false; }
}
export async function writeJsonIfChanged(path: string, value: unknown): Promise<boolean> {
  const before = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error; return null;
  });
  if (before !== null && samePublishedContent(before, value)) return false;
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
  return true;
}
async function readJson(path: string): Promise<JsonRecord> {
  try { return record(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
}
export async function writePages(fundDir: string, ticker: string, kind: 'holdings' | 'history', sheet: Sheet, pageSize: number, source: string): Promise<PageManifest> {
  const manifest = pageManifest(kind, sheet, pageSize, source);
  for (const [i, path] of manifest.pages.entries()) await writeJsonIfChanged(join(fundDir, path), {
    ticker, page: i + 1, pageSize, totalRows: sheet.rows.length, headers: sheet.headers, rows: sheet.rows.slice(i * pageSize, (i + 1) * pageSize),
  });
  return manifest;
}
async function removeStalePages(fundDir: string, kind: 'holdings' | 'history', pages: string[]): Promise<void> {
  const kept = new Set(pages.map(path => path.slice(kind.length + 1)));
  const entries = await readdir(join(fundDir, kind)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
  for (const name of entries) if (/^\d+\.json$/.test(name) && !kept.has(name)) await rm(join(fundDir, kind, name));
}
async function readPublishedSheet(fundDir: string, kind: 'holdings' | 'history', meta: JsonRecord): Promise<Sheet> {
  const manifest = record(meta[kind]), paths = array(manifest.pages);
  const rows: SheetRow[] = [];
  let headers: string[] = [];
  for (const raw of paths) {
    const path = cleanText(raw);
    if (!new RegExp(`^${kind}/\\d+\\.json$`).test(path)) throw new Error('Published manifest: unsafe page path');
    const page = await readJson(join(fundDir, path));
    if (!Object.keys(page).length) throw new Error(`Published manifest: missing page ${path}`);
    headers = array(page.headers).map(cleanText);
    rows.push(...array(page.rows).map(row => Object.fromEntries(Object.entries(record(row)).map(([key, value]) => [key, cleanText(value)]))));
  }
  if (numberOrNull(manifest.totalRows) !== null && rows.length !== Number(manifest.totalRows)) throw new Error('Published manifest: incorrect row count');
  return { headers, rows, asOfDate: toIsoDate(manifest.asOfDate) };
}

// SEC EDGAR Form N-PORT-P fallback: the shared nport-reader block at the end of this file finds, reads and checks the filing.
const SEC_FUND_TICKERS_URL = 'https://www.sec.gov/files/company_tickers_mf.json';
const SEC_COMPANY_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
/**
 * The Xtrackers holdings sheet of an N-PORT filing (HOLDINGS_HEADERS, largest weight first). A missing number stays empty
 * (never 0), a missing text is '-'; tickers come from nportTickers (U.S. equities only), identifiers are the position's own.
 */
export function nportHoldingsSheet(filing: NportFiling, tickers: ReadonlyArray<string>): SheetRow[] {
  return filing.positions.map((position, index) => ({
    Name: position.name || '-',
    Ticker: tickers[index] || '-',
    Identifier: nportIdentifier(position) || '-',
    Weight: nportCell(position.weight),
    'Market Value': nportCell(position.value, 2),
    'Shares Held': nportCell(position.balance) || '-',
    'Asset Category': position.assetCat || '-',
  })).sort((x, y) => (Number(y.Weight) || 0) - (Number(x.Weight) || 0) || x.Identifier.localeCompare(y.Identifier) || x.Name.localeCompare(y.Name));
}
export type SourceClient = {
  bytes(url: string, headers?: Record<string, string>): Promise<Uint8Array>;
  text(url: string, headers?: Record<string, string>): Promise<string>;
  json(url: string, headers?: Record<string, string>): Promise<unknown>;
};
function createEdgarFallback(client: SourceClient, config: UpdaterConfig) {
  let funds: Promise<Map<string, NportSeriesRef>> | null = null;
  let companies: Promise<Map<string, string>> | null = null;
  const cache = new Map<string, unknown>();
  const loadFundTickerTable = () => funds ??= client.json(SEC_FUND_TICKERS_URL, secHeaders(config)).then(parseSecFundTickers).catch(error => {
    outputNote(`[ edgar    ] fund ticker table: ${errorMessage(error)}`); return new Map<string, NportSeriesRef>();
  });
  const loadCompanyTickerTable = () => companies ??= client.json(SEC_COMPANY_TICKERS_URL, secHeaders(config)).then(parseSecCompanyNames).catch(error => {
    outputNote(`[ edgar    ] company ticker table: ${errorMessage(error)}`); return new Map<string, string>();
  });
  /** The fund's own newest filing, only when strictly newer than the published holdings (`published`: ISO date and row count). */
  return async (fund: CatalogFund, published: { asOf: string | null; rows: number }): Promise<{ sheet: Sheet; source: string } | null> => {
    const ref = (await loadFundTickerTable()).get(fund.ticker) || null;
    // The brand's verified Trust is fixed. Do not silently use another registrant.
    if (ref && Number(ref.cik) !== Number(TRUST_CIK)) return null;
    const read = await readNportHoldings({ ticker: fund.ticker, cik: TRUST_CIK, seriesId: ref?.seriesId || null, name: fund.name }, published,
      url => client.text(url, secHeaders(config)), { cache, maxDocuments: ref?.seriesId ? 3 : 80 });
    if ('problem' in read) { outputNote(`[ edgar    ] ${read.problem}`); return null; }
    const rows = nportHoldingsSheet(read.filing, nportTickers(read.filing.positions, await loadCompanyTickerTable()));
    return { sheet: { headers: HOLDINGS_HEADERS, rows, asOfDate: read.filing.repPdDate || null }, source: read.url };
  };
}

// Complete source values win; missing fields retain the last published facts (zero is real data).
export function indexRowForCatalog(fund: CatalogFund): JsonRecord {
  return {
    ticker: fund.ticker, name: fund.name || fund.ticker, category: fund.category || 'Unclassified', fundPage: fund.fundPage,
    dataFile: null, ...expenseFields(fund.terValue, fund.netTerValue),
    nav: '—', navValue: null, aum: moneyText(fund.aumValue), aumValue: fund.aumValue,
    asOfDate: null, inceptionDate: fund.inceptionDate, exchange: null, closePrice: '—', premiumDiscount: '—', premiumDiscountValue: null,
    cusip: null, isin: null, distributions: { frequency: null, exDate: null, dividend: null },
    returns: { monthEnd: fund.officialReturns, quarterEnd: emptyReturns() },
    metrics: deriveCatalogMetrics(fund.officialReturns, null, null, Object.values(fund.officialReturns).some(value => typeof value === 'number')
      ? 'official DWS catalog NAV total returns (catalog-only entry, not yet updated)' : 'unavailable: catalog-only entry, returns not fetched yet'),
    holdings: 0, history: 0,
  };
}
const percentageText = (value: number | null): string => value === null ? '—' : `${value.toFixed(2)}%`;
const moneyText = (value: number | null): string => value === null ? '—' : `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
function detailsFromPrevious(fund: CatalogFund, previous: JsonRecord, meta: JsonRecord): FundDetails {
  const identifiers = record(meta.identifiers), yields = record(meta.yields);
  return {
    ...fund, name: cleanText(previous.name) || fund.name, category: cleanText(previous.category) || fund.category,
    inceptionDate: toIsoDate(previous.inceptionDate) || fund.inceptionDate,
    terValue: previousExpenses(previous, meta).gross ?? fund.terValue, netTerValue: previousExpenses(previous, meta).net ?? fund.netTerValue,
    aumValue: numberOrNull(previous.aumValue) ?? fund.aumValue, fundPage: cleanText(previous.fundPage) || fund.fundPage,
    cusip: cleanText(identifiers.cusip || previous.cusip) || null, isin: cleanText(identifiers.isin || previous.isin) || null,
    indexTicker: cleanText(identifiers.indexTicker) || null, exchange: cleanText(previous.exchange) || null,
    navValue: numberOrNull(previous.navValue), navAsOfDate: toIsoDate(previous.asOfDate),
    secYield: numberOrNull(yields.secYield) ?? numberOrNull(record(previous.metrics).secYield),
    distributionRate: numberOrNull(yields.distributionRate), frequency: cleanText(record(previous.distributions).frequency) || null,
    midpoint: numberOrNull(meta.midpoint), premiumDiscount: numberOrNull(previous.premiumDiscount),
  };
}
export function mergeDetails(current: FundDetails, previous: FundDetails): FundDetails {
  return {
    ...current, name: current.name ?? previous.name, category: current.category ?? previous.category,
    inceptionDate: current.inceptionDate ?? previous.inceptionDate, terValue: current.terValue ?? previous.terValue,
    netTerValue: current.netTerValue ?? previous.netTerValue, aumValue: current.aumValue ?? previous.aumValue,
    navValue: current.navValue ?? previous.navValue, navAsOfDate: current.navAsOfDate ?? previous.navAsOfDate,
    secYield: current.secYield ?? previous.secYield, distributionRate: current.distributionRate ?? previous.distributionRate,
    frequency: current.frequency ?? previous.frequency, exchange: current.exchange ?? previous.exchange,
    cusip: current.cusip ?? previous.cusip, isin: current.isin ?? previous.isin, indexTicker: current.indexTicker ?? previous.indexTicker,
    midpoint: current.midpoint ?? previous.midpoint, premiumDiscount: current.premiumDiscount ?? previous.premiumDiscount,
  };
}
function previousDividends(meta: JsonRecord): Dividend[] {
  const events = array(meta.distributionEvents).map(record).flatMap(row => {
    const date = toIsoDate(row.exDate), amount = numberOrNull(row.amount);
    return date && amount !== null ? [{ exDate: date, epoch: Date.parse(date) / 1000, amount, recordDate: toIsoDate(row.recordDate), payDate: toIsoDate(row.payDate) }] : [];
  });
  if (events.length) return events;
  return array(record(meta.distributions).rows).flatMap(row => {
    const columns = array(row), date = toIsoDate(columns[0]), amount = numberOrNull(columns[1]);
    return date && amount !== null ? [{ exDate: date, epoch: Date.parse(date) / 1000, amount, recordDate: null, payDate: null }] : [];
  });
}
function mergeDividends(previous: Dividend[], current: Dividend[]): Dividend[] {
  const merged = new Map(previous.map(event => [event.exDate, event]));
  current.forEach(event => merged.set(event.exDate, event));
  return [...merged.values()].sort((a, b) => a.epoch - b.epoch);
}
function navFromPublished(sheet: Sheet): NavPoint[] {
  return sheet.rows.flatMap(row => {
    const date = toIsoDate(row.Date), nav = numberOrNull(row.NAV);
    return date && nav !== null && nav > 0 ? [{ date, nav, aum: null, shares: null, dividend: null }] : [];
  });
}
function pricesFromPublished(sheet: Sheet): ChartDay[] {
  return sheet.rows.flatMap(row => {
    const date = toIsoDate(row.Date), close = numberOrNull(row['Market Price'] || row.Close);
    return date && close !== null && close > 0 ? [{ date, close, adjClose: numberOrNull(row['Adj Close']) ?? close, volume: numberOrNull(row.Volume) ?? 0 }] : [];
  });
}
export function reinvestmentCoverageStart(points: NavPoint[], dividends: Dividend[]): string | null {
  const available = new Set(points.map(point => point.date));
  let start = points[0]?.date || null;
  const end = points.at(-1)?.date;
  if (!start || !end) return null;
  for (const event of dividends) if (event.amount > 0 && event.exDate >= start && event.exDate <= end && !available.has(event.exDate)) {
    start = points.find(point => point.date > event.exDate)?.date ?? end;
  }
  return start;
}
export function reportingPeriodEnds(lastDate: string): { monthEnd: string; quarterEnd: string } {
  const date = new Date(lastDate + 'T00:00:00Z'), year = date.getUTCFullYear(), month = date.getUTCMonth();
  const monthLast = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
  const monthEnd = monthLast === lastDate ? lastDate : new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  const quarterLast = new Date(Date.UTC(year, Math.floor(month / 3) * 3 + 3, 0)).toISOString().slice(0, 10);
  const quarterEnd = quarterLast === lastDate ? lastDate : new Date(Date.UTC(year, Math.floor(month / 3) * 3, 0)).toISOString().slice(0, 10);
  return { monthEnd, quarterEnd };
}
export function coalesceReturns(primary: OfficialReturnRow, secondary: OfficialReturnRow): OfficialReturnRow {
  const result = emptyReturns();
  const keys = ['ytd', 'yr1', 'yr3', 'yr5', 'yr10', 'sinceInception'] as const;
  const hasOfficialValues = keys.some(key => primary[key] !== null);
  // An undated published figure must stay undated, not inherit the derived series date.
  result.asOfDate = hasOfficialValues ? primary.asOfDate : secondary.asOfDate;
  const allowDerived = !hasOfficialValues || (primary.asOfDate !== null && primary.asOfDate === secondary.asOfDate);
  for (const key of keys) result[key] = primary[key] ?? (allowDerived ? secondary[key] : null);
  return result;
}
export function annualizedOfficialReturns(source: OfficialReturnRow, inception: string | null): OfficialReturnRow {
  // DWS's <1-year SI figures are cumulative, not annualized: the shared calendar-anniversary rule drops them
  return withoutYoungReturns(source, inception, source.asOfDate, { sinceInception: 1 });
}
export type DividendYieldBasis = 'official-distribution-rate' | 'computed-trailing-12m' | 'indicated';
/** Which definition stands behind dividendYield; null exactly when the yield is null. */
export function dividendYieldBasisCode(dividendYield: number | null, officialRate: number | null, trailing: number | null): DividendYieldBasis | null {
  if (dividendYield === null) return null;
  if (officialRate === null) return 'indicated';
  return officialRate === 0 && trailing !== null ? 'computed-trailing-12m' : 'official-distribution-rate';
}
export function deriveCatalogMetrics(returns: OfficialReturnRow, dividendYield: number | null, secYield: number | null, basis: string, yieldBasis: DividendYieldBasis | null = null): JsonRecord {
  return { ytd: returns.ytd, tr1y: returns.yr1, cagr3y: returns.yr3, cagr5y: returns.yr5, cagr10y: returns.yr10,
    tr3y: annualizedToTotal(returns.yr3, 3), tr5y: annualizedToTotal(returns.yr5, 5), tr10y: annualizedToTotal(returns.yr10, 10),
    siAnn: returns.sinceInception, dividendYield, dividendYieldText: percentageText(dividendYield), dividendYieldBasis: dividendYield === null ? null : yieldBasis, secYield, secYieldText: percentageText(secYield), returnsBasis: basis,
    // The date describes the returns: with no return figure there is nothing to date.
    performanceAsOf: (['ytd', 'yr1', 'yr3', 'yr5', 'yr10', 'sinceInception'] as const).some(key => returns[key] !== null) ? toIsoDate(returns.asOfDate) : null };
}

/** Net and gross expense ratio of a published row. Rows published before the split carried the gross ratio in terValue and the net ratio only in meta.json. */
export function previousExpenses(previous: JsonRecord, meta: JsonRecord): { gross: number | null; net: number | null } {
  if ('terGrossValue' in previous) return { gross: numberOrNull(previous.terGrossValue), net: numberOrNull(previous.terValue) };
  return { gross: numberOrNull(previous.terValue), net: numberOrNull(meta.netTerValue) };
}
/** terValue is the NET ratio (the gross one when that is the only number); terGrossValue is the gross ratio when published. */
export function expenseFields(gross: number | null, net: number | null): JsonRecord {
  const value = net ?? gross;
  return { ter: percentageText(value), terValue: value, terGross: percentageText(gross), terGrossValue: gross };
}

/** The latest date that has both an official NAV and a market close (premium/discount needs a same-date pair), within 7 days of the newest point. */
export function latestSamePair(points: NavPoint[], days: ChartDay[]): { date: string; nav: number; close: number; premium: number } | null {
  const prices = new Map(days.map(day => [day.date, day.close]));
  const common = points.filter(point => point.nav > 0 && (prices.get(point.date) ?? 0) > 0).at(-1);
  if (!common) return null;
  const newest = [points.at(-1)?.date, days.at(-1)?.date].filter(Boolean).sort().at(-1)!;
  if (Date.parse(newest) - Date.parse(common.date) > 7 * 86400000) return null;
  const close = prices.get(common.date)!;
  return { date: common.date, nav: common.nav, close, premium: round((close / common.nav - 1) * 100, 4) };
}

/** Sum of distributions with an ex-date in the 365 days up to asOf, over NAV, in percent; null without payments or a usable NAV. */
export function trailingYearYield(events: Dividend[], asOf: string | null, nav: number | null): number | null {
  if (!asOf || nav === null || !(nav > 0)) return null;
  const end = Date.parse(asOf), start = end - 365 * 86400000;
  const paid = events.filter(event => event.amount > 0 && Date.parse(event.exDate) > start && Date.parse(event.exDate) <= end);
  return paid.length ? round(paid.reduce((sum, event) => sum + event.amount, 0) / nav * 100, 2) : null;
}

export type FundOutcome = { ticker: string; status: 'updated' | 'unchanged' | 'skipped' | 'failed'; freshSources: string[]; retainedSources: string[]; holdings: number; history: number; reason?: string };
export type UpdateResult = {
  selected: string[]; outcomes: FundOutcome[]; failures: number; updated: number;
  counts: { funds: number; holdings: number; history: number };
  catalogFunds: number; catalogSource: string; manifestChanged: boolean; progressChanged: boolean; processedThrough: string | null;
  newFunds: string[]; deadlineReached: boolean;
};
export type RuntimeOptions = { root?: string; fetcher?: Fetcher; deadlineMs?: number };
/** The run stops taking new funds after this long and still writes the index (the workflow times out at 30 minutes). */
export const SOFT_DEADLINE_MS = 25 * 60_000;
// Same iShares automatic GITHUB_STEP_SUMMARY presentation; no extra runtime knob.
export function renderUpdateSummary(config: UpdaterConfig, result: UpdateResult): string {
  const count = (status: FundOutcome['status']) => result.outcomes.filter(row => row.status === status).length;
  const clean = (value: unknown) => outputClean(value).replace(/[\\`*_[\]<>|]/g, character => `\\${character}`);
  const markdown = [
    '## Xtrackers updater', '', '| Result | Count |', '|---|---:|',
    `| Catalog funds | ${result.catalogFunds} |`, `| Fund update attempts | ${result.outcomes.length} |`,
    `| Updated | ${count('updated')} |`, `| Unchanged | ${count('unchanged')} |`,
    `| Filtered | ${count('skipped')} |`, `| Failed | ${count('failed')} |`,
    `| Published funds | ${result.counts.funds} |`, `| Holdings rows | ${result.counts.holdings} |`, `| History rows | ${result.counts.history} |`,
    `| Manifest changed | ${result.manifestChanged ? 'yes' : 'no'} |`, `| Progress state changed | ${result.progressChanged ? 'yes' : 'no'} |`,
    `| Processed through | ${result.processedThrough || '—'} |`, '', `Catalog source: ${clean(result.catalogSource)}`, '',
    ...(result.newFunds.length ? ['### NEW FUNDS', '', ...result.newFunds.map(clean), ''] : []),
    ...(result.deadlineReached ? ['Soft deadline reached: not every selected fund was taken this run; the index was still written.', ''] : []),
    '<details><summary>Configuration</summary>', '', '```text',
    ...outputConfigEntries(config).map(([key, value]) => `${key}=${key === 'SEC_UA' ? '<redacted>' : outputClean(value).replace(/`/g, "'")}`),
    '```', '</details>', '',
  ];
  for (const [title, outcomes] of [
    ['Filtered funds', result.outcomes.filter(row => row.status === 'skipped')],
    ['Failures', result.outcomes.filter(row => row.status === 'failed')],
    ['Retained published data', result.outcomes.filter(row => row.status !== 'skipped' && row.status !== 'failed' && row.retainedSources.length > 0)],
  ] as const) {
    if (outcomes.length) markdown.push(`### ${title}`, '', ...outcomes.map(row => `- **${row.ticker}**: ${clean(row.reason || row.retainedSources.join(', '))}`), '');
  }
  return markdown.join('\n') + '\n';
}
export async function writeSummary(config: UpdaterConfig, result: UpdateResult, path = process.env.GITHUB_STEP_SUMMARY): Promise<void> {
  if (path?.trim()) await appendFile(path, renderUpdateSummary(config, result));
}

const API_ROOT = fileURLToPath(new URL('../api/xtrackers/', import.meta.url));
function catalogFromPrevious(row: JsonRecord): CatalogFund {
  const ticker = sanitizeTicker(row.ticker);
  return { ticker, name: cleanText(row.name) || null, category: cleanText(row.category) || null,
    fundPage: cleanText(row.fundPage) || `https://etf.dws.com/en-us/etf-products/?SearchTerm=${ticker}`,
    inceptionDate: toIsoDate(row.inceptionDate), terValue: previousExpenses(row, {}).gross, netTerValue: previousExpenses(row, {}).net,
    aumValue: numberOrNull(row.aumValue), officialReturns: emptyReturns() };
}
/** A fund's published state: its previous index row only when that row points at a meta.json. A catalog-only row (dataFile null) was never published and must not be retained as facts, returns or basis. */
export function publishedRow(row: JsonRecord | undefined): JsonRecord {
  return row && row.dataFile ? row : {};
}
function returnsFromPublished(raw: unknown): OfficialReturnRow {
  const source = record(raw), result = emptyReturns();
  result.asOfDate = toIsoDate(source.asOfDate);
  for (const key of ['ytd', 'yr1', 'yr3', 'yr5', 'yr10', 'sinceInception'] as const) result[key] = numberOrNull(source[key]);
  return result;
}
async function updateFund(fund: CatalogFund, previousRow: JsonRecord, root: string, client: SourceClient, config: UpdaterConfig,
  edgar: ReturnType<typeof createEdgarFallback>): Promise<{ row: JsonRecord | null; outcome: FundOutcome }> {
  const dir = join(root, 'funds', fund.ticker), previousMeta = await readJson(join(dir, 'meta.json'));
  const previousHoldings = await readPublishedSheet(dir, 'holdings', previousMeta);
  const previousHistory = await readPublishedSheet(dir, 'history', previousMeta);
  const previousEvents = previousDividends(previousMeta);
  const previousSource = record(previousMeta.source);
  const freshSources: string[] = [], retainedSources: string[] = [];
  const outcome = (status: FundOutcome['status'], holdings: number, history: number, reason?: string): FundOutcome => ({ ticker: fund.ticker, status, holdings, history, freshSources, retainedSources, ...(reason ? { reason } : {}) });
  const attempt = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    try { const value = await fn(); freshSources.push(label); return value; }
    catch (error) { outputNote(`[ ${(label === 'Yahoo' ? 'history' : 'product').padEnd(9)}] ${fund.ticker} ${label}: ${errorMessage(error)} — trying fallbacks/published data`); return null; }
  };
  let details = detailsFromPrevious(fund, previousRow, previousMeta);
  const currentDetails = await attempt('DWS PDP', async () => parseFundDetails(await client.json(detailsUrl(fund.ticker)), fund.ticker, fund.fundPage));
  if (currentDetails) details = mergeDetails(currentDetails, details);
  else if (Object.keys(previousMeta).length || Object.keys(previousRow).length) retainedSources.push('fund facts');

  let holdings = await attempt('DWS Securities', async () => parseHoldingsRows(parseXlsxSheet(await client.bytes(exportUrl(fund.ticker, 'Securities'))), fund.ticker));
  let holdingsSource = exportUrl(fund.ticker, 'Securities');
  let holdingsFresh = holdings !== null; // false while holdings is the previous run's sheet
  if (!holdings) {
    const fallback = config.edgarFallback ? await edgar({ ...fund, name: details.name }, { asOf: previousHoldings.asOfDate, rows: previousHoldings.rows.length }) : null;
    if (fallback) { holdings = fallback.sheet; holdingsSource = fallback.source; freshSources.push('SEC N-PORT'); holdingsFresh = true; }
    else if (previousHoldings.rows.length) { holdings = previousHoldings; holdingsSource = cleanText(previousSource.holdingsSource) || exportUrl(fund.ticker, 'Securities'); retainedSources.push('holdings'); }
  }
  const currentNav = await attempt('DWS Performance', async () => parseNavRows(parseXlsxSheet(await client.bytes(exportUrl(fund.ticker, 'Performance'))), fund.ticker));
  const currentEvents = await attempt('DWS Distributions', async () => parseDistributionsRows(parseXlsxSheet(await client.bytes(exportUrl(fund.ticker, 'Distributions'))), fund.ticker));
  const chart = config.skipYahoo ? null : await attempt('Yahoo', async () => {
    const parsed = parseChart(await client.json(yahooChartUrl(fund.ticker, Math.floor(Date.now() / 1000), config.historyRange)));
    if (!parsed.days.length) throw new Error('Yahoo: no usable daily prices');
    if (!historyWindowStartEpoch(config.historyRange, Math.floor(Date.now() / 1000))) return parsed;
    // A HISTORY_RANGE window never shrinks the published market-price history: older published closes join it, rescaled
    const merged = mergeWindowedChart(parsed, previousHistory.headers.includes('Adj Close') ? previousHistory.rows : []);
    if (!merged) throw new Error(`the ${config.historyRange} chart window does not join the published history`);
    return merged;
  });
  const nav = new Map(navFromPublished(previousHistory).map(point => [point.date, point]));
  currentNav?.forEach(point => nav.set(point.date, point));
  const points = [...nav.values()].sort((a, b) => a.date.localeCompare(b.date));
  const prices = new Map(pricesFromPublished(previousHistory).map(day => [day.date, day]));
  // Only a published Adj Close column is a cent to keep; the NAV schema has none.
  const chartDays = chart ? keepPublishedAdjClose(previousHistory.headers.includes('Adj Close') ? [...prices.values()] : [], chart.days) : null;
  chartDays?.forEach(day => prices.set(day.date, day));
  const days = [...prices.values()].sort((a, b) => a.date.localeCompare(b.date));
  const events = mergeDividends(previousEvents, currentEvents ?? chart?.dividends ?? []);
  if (!currentNav && points.length) retainedSources.push('NAV history');
  if (!chart && days.length) retainedSources.push('market-price history');
  if (!currentEvents && previousEvents.length) retainedSources.push('distributions');
  if (!holdings?.rows.length) throw new Error('no usable holdings and no published holdings to retain');
  const history = historySheet(points, days);
  if (!history.rows.length) throw new Error('no usable history and no published history to retain');
  if (!freshSources.length) return { row: Object.keys(previousRow).length ? previousRow : null, outcome: outcome('unchanged', holdings.rows.length, history.rows.length, 'all providers unavailable; retained published data') };

  // Prefer official NAV total-return reconstruction, but never silently ignore a missing distribution series.
  const navReinvestmentKnown = currentEvents !== null || previousEvents.length > 0;
  const returnDays = points.length && navReinvestmentKnown ? navTotalReturnDays(points, events)
    : chartDays ?? (previousHistory.headers.includes('Adj Close') ? days : []);
  const coverage = points.length && navReinvestmentKnown ? reinvestmentCoverageStart(points, events) : null;
  const coveredDays = coverage ? returnDays.filter(day => day.date >= coverage) : returnDays;
  const latestDate = returnDays.at(-1)?.date;
  const ends = latestDate ? reportingPeriodEnds(latestDate) : null;
  const derivedMonth = ends ? deriveReturns(coveredDays, ends.monthEnd, details.inceptionDate) : emptyReturns();
  const derivedQuarter = ends ? deriveReturns(coveredDays, ends.quarterEnd, details.inceptionDate) : emptyReturns();
  const official = annualizedOfficialReturns(Object.values(fund.officialReturns).some(value => typeof value === 'number') ? fund.officialReturns : details.officialReturns, details.inceptionDate);
  // the shared "younger than one year" rule (calendar anniversary): no horizon the fund is too young for, official or derived
  const young = (returns: OfficialReturnRow): OfficialReturnRow => withoutYoungReturns(returns, details.inceptionDate, returns.asOfDate, { yr1: 1, yr3: 3, yr5: 5, yr10: 10, sinceInception: 1 });
  const monthEnd = returnDays.length ? young(coalesceReturns(official, derivedMonth)) : returnsFromPublished(record(previousRow.returns).monthEnd);
  const quarterEnd = returnDays.length ? young(derivedQuarter) : returnsFromPublished(record(previousRow.returns).quarterEnd);
  const frequency = distributionFrequency(details.frequency, events);
  const latestDividend = events.filter(event => event.amount > 0).at(-1);
  const latestPrice = days.at(-1), latestNav = points.at(-1);
  const navValue = details.navValue ?? latestNav?.nav ?? null;
  const navAsOfDate = details.navAsOfDate ?? latestNav?.date ?? null;
  const price = latestPrice?.close ?? null;
  // Premium/discount needs a NAV and a close of the same date: the latest such pair, or null.
  const pair = latestSamePair(points, days);
  const premiumDiscount = pair?.premium ?? null;
  const yieldAsOf = navAsOfDate ?? latestNav?.date ?? latestPrice?.date ?? null;
  const trailing = trailingYearYield(events, yieldAsOf, navValue);
  // An official distribution rate of 0 next to payments in the last 12 months is a stale or empty field: use the trailing distributions.
  const officialRate = details.distributionRate;
  const dividendYield = officialRate === null ? indicatedYield(latestDividend?.amount ?? null, frequency.paymentsPerYear, navValue)
    : officialRate === 0 && trailing !== null ? trailing : officialRate;
  const dividendYieldKind = officialRate === null ? 'latest positive distribution x payments per year / NAV'
    : officialRate === 0 ? (trailing !== null ? 'trailing 12-month distributions / NAV (the official distribution rate is 0 but distributions were paid)' : 'official distribution rate 0.00% (no distributions in the last 12 months)')
    : 'official indicated distribution rate / NAV';
  const basis = Object.values(official).some(value => typeof value === 'number') ? (official.asOfDate ? 'official DWS NAV total returns; covered daily-series derivation fills same-date gaps' : 'official DWS NAV total returns (source as-of date unavailable; no dated-series mixing)')
    : points.length && navReinvestmentKnown ? 'derived from official DWS daily NAV with total distributions reinvested at ex-date NAV; not published standardized NAV returns'
    : 'derived from Yahoo adjusted market-price closes; not official NAV returns';
  // Returns kept from the published row keep the basis they were published with.
  const retainedBasis = returnDays.length ? '' : cleanText(record(previousRow.metrics).returnsBasis);
  const metrics = deriveCatalogMetrics(monthEnd, dividendYield, details.secYield, retainedBasis || basis, dividendYieldBasisCode(dividendYield, officialRate, trailing));
  const filters = fundFilterReasons(details, metrics, config);
  if (filters.length) return { row: null, outcome: outcome('skipped', previousHoldings.rows.length, previousHistory.rows.length, `filters: ${filters.join(',')}`) };
  // Fresh holdings (DWS or the N-PORT fallback) that look broken - no weight column, non-numeric weights, a bad weight sum,
  // half the rows gone - never replace the published ones: the fund fails and keeps every published file and its index row.
  const publishedWeights = holdingsFresh && previousHoldings.rows.length ? holdingsWeightCount(previousHoldings.headers, previousHoldings.rows) : null;
  const holdingsProblem = holdingsFresh ? holdingsGuard(holdings.headers, holdings.rows, numberOrNull(record(previousMeta.holdings).totalRows), HOLDINGS_GUARD_RELAX[fund.ticker] ?? HOLDINGS_GUARD_RELAX['*'] ?? [], publishedWeights) : null;
  if (holdingsProblem) throw new Error(`holdings guard: ${holdingsProblem}; ${Object.keys(previousMeta).length ? 'kept the previous complete data' : 'no data published for this fund yet'}`);

  const holdingsManifest = pageManifest('holdings', holdings, config.holdingsPageSize, holdingsSource);
  const historySource = points.length ? exportUrl(fund.ticker, 'Performance') + (days.length ? ' + ' + yahooSourceUrl(fund.ticker) : '') : yahooSourceUrl(fund.ticker);
  const historyManifest = pageManifest('history', history, config.historyPageSize, historySource);
  const generatedAt = new Date().toISOString();
  const row: JsonRecord = {
    ticker: fund.ticker, name: details.name || cleanText(previousRow.name) || fund.ticker, category: details.category || 'Unclassified',
    fundPage: details.fundPage, dataFile: `./funds/${fund.ticker}/meta.json`, ...expenseFields(details.terValue, details.netTerValue),
    nav: navValue === null ? '—' : `$${navValue.toFixed(2)}`, navValue,
    aum: moneyText(details.aumValue ?? latestNav?.aum ?? null), aumValue: details.aumValue ?? latestNav?.aum ?? null,
    asOfDate: navAsOfDate, inceptionDate: details.inceptionDate, exchange: details.exchange || chart?.exchange || null,
    closePrice: price === null ? '—' : `$${price.toFixed(2)}`, closePriceAsOfDate: latestPrice?.date || null,
    premiumDiscount: percentageText(premiumDiscount), premiumDiscountValue: premiumDiscount, premiumDiscountAsOfDate: pair?.date ?? null, cusip: details.cusip, isin: details.isin,
    distributions: { frequency: frequency.frequency, exDate: latestDividend?.exDate || null, dividend: latestDividend ? String(latestDividend.amount) : null },
    returns: { monthEnd, quarterEnd }, metrics, holdings: holdings.rows.length, history: history.rows.length,
  };
  const meta: JsonRecord = {
    ...row, generatedAt, netTerValue: details.netTerValue,
    source: { provider: 'Xtrackers (DWS)', site: 'https://etf.dws.com/en-us/', catalog: CATALOG_URL, details: detailsUrl(fund.ticker),
      holdingsSource, historySource, distributionsSource: currentEvents !== null || previousEvents.length ? exportUrl(fund.ticker, 'Distributions') : yahooSourceUrl(fund.ticker),
      yahoo: yahooSourceUrl(fund.ticker), trust: 'DBX ETF TRUST', trustCik: TRUST_CIK },
    identifiers: { cusip: details.cusip, isin: details.isin, indexTicker: details.indexTicker },
    yields: { dividendYield, dividendYieldText: percentageText(dividendYield), dividendYieldKind,
      distributionRate: details.distributionRate, secYield: details.secYield, secYieldText: percentageText(details.secYield), secYieldKind: details.secYield === null ? null : 'official DWS 30-day SEC yield' },
    distributions: { ...record(row.distributions), paymentsPerYear: frequency.paymentsPerYear, headers: ['Ex-Date', 'Amount'],
      rows: events.slice(-12).map(event => [event.exDate, String(event.amount)]) },
    distributionEvents: events, holdings: holdingsManifest, history: historyManifest,
  };
  const before = await outputInspectFund(root, fund.ticker);
  await writePages(dir, fund.ticker, 'holdings', holdings, config.holdingsPageSize, holdingsSource);
  await writePages(dir, fund.ticker, 'history', history, config.historyPageSize, historySource);
  await writeJsonIfChanged(join(dir, 'meta.json'), meta);
  // Delete old pages only after the new manifest is published successfully.
  await removeStalePages(dir, 'holdings', holdingsManifest.pages);
  await removeStalePages(dir, 'history', historyManifest.pages);
  const after = await outputInspectFund(root, fund.ticker);
  return { row, outcome: outcome(before.digest === after.digest ? 'unchanged' : 'updated', holdings.rows.length, history.rows.length,
    retainedSources.length ? `retained: ${retainedSources.join(',')}` : undefined) };
}
export async function runUpdater(config: UpdaterConfig, options: RuntimeOptions = {}): Promise<UpdateResult> {
  const root = resolve(options.root || API_ROOT);
  const startedAt = Date.now(), deadlineMs = options.deadlineMs ?? SOFT_DEADLINE_MS;
  process.env.VERBOSE = String(config.verbose);
  outputPrintConfig('Xtrackers', config);
  const gate = createRequestGate(config.requestSleepSeconds, config.concurrency);
  const get = (url: string, headers?: Record<string, string>) => fetchWithRetry(url, config, gate, options.fetcher || fetch, headers);
  const client: SourceClient = {
    bytes: async (url, headers) => new Uint8Array(await (await get(url, headers)).arrayBuffer()),
    text: async (url, headers) => (await get(url, headers)).text(),
    json: async (url, headers) => (await get(url, headers)).json(),
  };
  const previousIndex = await readJson(join(root, 'index.json'));
  const previousRows = new Map(array(previousIndex.funds).map(record).flatMap(row => {
    const ticker = sanitizeTicker(row.ticker); return ticker ? [[ticker, row] as const] : [];
  }));
  let discovered: CatalogFund[] = [], catalogSource = 'previous published catalog', catalogFresh = false;
  try {
    discovered = parseCatalogRows(parseXlsxSheet(await client.bytes(CATALOG_URL)));
    if (!discovered.length) throw new Error('official workbook contains zero products');
    catalogSource = 'official DWS catalog XLSX'; catalogFresh = true;
    // Catalog performance dates are published in the finder, not invented from fetch time.
    try {
      const finder = record(record(await client.json('https://etf.dws.com/api/fundfinder/en-us/fundFinderMetaTagsTealium')).fundFinder);
      const tab = record(array(finder.fundFinderTabs)[1]), disclaimer = cleanText(record(tab.disclaimerForResultTable).text);
      const date = toIsoDate(/as of\s+(\d{2}\/\d{2}\/\d{4})/i.exec(disclaimer)?.[1]);
      discovered.forEach(fund => { fund.officialReturns.asOfDate = date; });
    } catch (error) { outputNote(`[ catalog  ] performance date unavailable: ${errorMessage(error)}`); }
  } catch (error) {
    console.warn(`[ catalog  ] ${errorMessage(error)} — trying official US sitemap`);
    try {
      discovered = parseSitemap(await client.text(SITEMAP_URL));
      if (!discovered.length) throw new Error('official US sitemap has no valid funds');
      catalogSource = 'official US sitemap (catalog XLSX unavailable/empty)'; catalogFresh = true;
    } catch (fallbackError) { console.warn(`[ catalog  ] ${errorMessage(fallbackError)} — retaining published catalog`); }
  }
  // The live catalog (null when only the published feed is known): a catalog-only row it no longer lists is dropped, never retried.
  const live = catalogFresh ? discovered.map(fund => fund.ticker) : null;
  const catalog = new Map(discovered.map(fund => [fund.ticker, fund]));
  for (const [ticker, row] of previousRows) if (!catalog.has(ticker) && (!live || row.dataFile)) catalog.set(ticker, catalogFromPrevious(row));
  if (!catalog.size) throw new Error('no official or published catalog available; no files changed');
  // Q27: a TICKERS entry outside the live catalog and the published funds stops the run before any fund request
  assertKnownTickers(config.tickers.size ? Array.from(config.tickers) : null, knownTickers(live, Array.from(previousRows.values())), 'the Xtrackers catalog or published feed');
  const universe = [...catalog.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
  console.log(`[ catalog  ] ${universe.length} Xtrackers ETFs (${catalogSource})`);
  // A closed fund leaves the run here, before the MAX_FETCHES budget and any request: never fetched, guarded or reported.
  const filtered = withoutClosedFunds(universe.filter(fund => !config.tickers.size || config.tickers.has(fund.ticker)), fund => fund.ticker, CLOSED_FUNDS);
  const deferred = Boolean(config.aumRange || config.terRange || config.dividendYieldRange || config.secYieldRange || Object.keys(config.performanceRanges).length || Object.keys(config.totalReturnRanges).length);
  outputPrintFilter(filtered.length, universe.length, deferred);
  const statePath = join(root, 'update-state.json'), updateState = await readJson(statePath);
  const scope = outputContentKey({ tickers: [...config.tickers].sort(), aum: config.aumRange, ter: config.terRange, dividend: config.dividendYieldRange, sec: config.secYieldRange, performance: config.performanceRanges, totalReturn: config.totalReturnRanges });
  // One cursor per filter scope (TICKERS included): a run with other filters never moves or deletes this scope's cursor.
  const scopeId = outputCreateHash('sha256').update(scope).digest('hex').slice(0, 12);
  const cursors: Record<string, string> = Object.fromEntries(Object.entries(record(updateState.cursors)).map(([key, value]) => [key, cleanText(value)]).filter(([, value]) => value));
  if (typeof updateState.scope === 'string' && cleanText(updateState.cursor)) cursors[outputCreateHash('sha256').update(updateState.scope).digest('hex').slice(0, 12)] ??= cleanText(updateState.cursor); // legacy single-cursor file
  const cursor = config.maxFetches > 0 ? cursors[scopeId] || null : null;
  const batch = selectUpdateBatch(filtered, config.maxFetches, cursor), queue = [...batch];
  if (config.maxFetches > 0) console.log(`[ cursor   ] ${batch.length} selected for this batch; after ${cursor || 'start'}`);
  const rows = new Map(withoutStalePlaceholders(Array.from(previousRows.values()), live).map(row => [sanitizeTicker(row.ticker), row] as [string, JsonRecord]));
  for (const fund of universe) if (!rows.has(fund.ticker) && (!config.tickers.size || !previousRows.size || config.tickers.has(fund.ticker))) rows.set(fund.ticker, indexRowForCatalog(fund));
  const outcomes: FundOutcome[] = [], edgar = createEdgarFallback(client, config);
  const reporter = outputCreateReporter(root, batch.length);
  // Advances for every fund taken from the queue, whatever its outcome, so one failing fund can never pin the cursor.
  let lastDispatched: string | null = null, deadlineReached = false;
  async function worker(): Promise<void> {
    for (;;) {
      if (Date.now() - startedAt >= deadlineMs) { deadlineReached = deadlineReached || queue.length > 0; return; }
      const fund = queue.shift(); if (!fund) return;
      lastDispatched = fund.ticker;
      const before = await reporter.before(fund.ticker);
      try {
        const result = await updateFund(fund, publishedRow(previousRows.get(fund.ticker)), root, client, config, edgar);
        if (result.row?.ticker) rows.set(fund.ticker, result.row);
        outcomes.push(result.outcome);
        await reporter.result(fund.ticker, before, result.outcome.status, result.outcome.reason);
      } catch (error) {
        outcomes.push({ ticker: fund.ticker, status: 'failed', freshSources: [], retainedSources: ['all published files'], holdings: Number(previousRows.get(fund.ticker)?.holdings || 0), history: Number(previousRows.get(fund.ticker)?.history || 0), reason: errorMessage(error) });
        await reporter.result(fund.ticker, before, 'failed', errorMessage(error));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(config.concurrency, batch.length) }, worker));
  // A row points at its meta.json only when that file exists (the path is written with the same ./ prefix everywhere).
  for (const [ticker, row] of rows) {
    const hasMeta = await Bun.file(join(root, 'funds', ticker, 'meta.json')).exists();
    const dataFile = hasMeta ? `./funds/${ticker}/meta.json` : null;
    if (row.dataFile !== dataFile) rows.set(ticker, { ...row, dataFile });
  }
  const funds = markClosedFunds([...rows.values()].sort((a, b) => String(a.ticker).localeCompare(String(b.ticker))), CLOSED_FUNDS);
  const counts = { funds: funds.length, holdings: funds.reduce((sum, row) => sum + (numberOrNull(row.holdings) || 0), 0), history: funds.reduce((sum, row) => sum + (numberOrNull(row.history) || 0), 0) };
  const manifestChanged = await writeJsonIfChanged(join(root, 'index.json'), {
    provider: 'Xtrackers (DWS)', generatedAt: new Date().toISOString(),
    source: catalogFresh ? { catalog: CATALOG_URL, catalogSource, sitemap: SITEMAP_URL, site: 'https://etf.dws.com/en-us/', trust: 'DBX ETF TRUST', trustCik: TRUST_CIK } : previousIndex.source,
    counts, funds,
  });
  // Q28: a fund is announced on its first successful publish (a catalog-only row is not published), new catalog-only rows as pending
  const newFunds = newFundsLines(newFundsReport(Array.from(previousRows.values()), funds));
  for (const line of newFunds) console.log(line);
  const failures = outcomes.filter(result => result.status === 'failed').length;
  let progressChanged = false;
  {
    // The cursor moves past every fund taken (failed or filtered too). A full pass over exactly this scope resets only this scope's cursor;
    // a full pass that evaluates data-dependent filters leaves it alone. Other scopes' cursors are never touched.
    const next = { ...cursors };
    if (config.maxFetches > 0 && lastDispatched) next[scopeId] = lastDispatched;
    else if (config.maxFetches === 0 && !deferred) delete next[scopeId];
    const keys = Object.keys(next).slice(-8);
    const state = keys.length ? { cursors: Object.fromEntries(keys.map(key => [key, next[key]])), generatedAt: new Date().toISOString() } : null;
    if (state) progressChanged = await writeJsonIfChanged(statePath, state);
    else if (await Bun.file(statePath).exists()) { await rm(statePath, { force: true }); progressChanged = true; }
  }
  if (deadlineReached) console.warn('[ deadline ] soft deadline reached; the remaining selected funds were not taken this run (the index was still written)');
  const updated = outcomes.filter(result => result.status === 'updated').length;
  console.log(reporter.summary(startedAt));
  console.log(outputCounts(counts.funds, counts.holdings, counts.history));
  return { selected: batch.map(fund => fund.ticker), outcomes, failures, updated, counts,
    catalogFunds: universe.length, catalogSource, manifestChanged, progressChanged,
    processedThrough: config.maxFetches > 0 ? lastDispatched : null, newFunds, deadlineReached };
}
export { outputFundLine, outputConfigEntries };
if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => arg === '-h' || arg === '--help')) printHelp();
    else {
      if (args.length) throw new Error(`unknown arguments: ${args.join(' ')}`);
      const config = readConfig(await runtimeControls());
      installSystemCa(config.useSystemCa);
      const result = await runUpdater(config);
      await writeSummary(config, result);
      if (result.failures) process.exitCode = 1;
    }
  } catch (error) { console.error(`[ failed   ] ${errorMessage(error)}`); process.exitCode = 1; }
}

// <holdings-guard> shared block of .claude/tools/etfs/etf-std/holdings-guard.block.ts, applied by apply-holdings-guard.ts: never edit it in one repo
/**
 * Sanity check of a fund's new holdings before they replace the published ones. Returns why they must be rejected
 * (the caller then keeps the fund's previous state and reports it as failed), or null when they may be written.
 * An empty sheet passes only when nothing was published before. Otherwise a Name and a weight column (Weight,
 * Weight (%) or Market Weight) are required, >= 80% of the rows carry a numeric weight, the weights add up to
 * 50..150 and the sheet keeps >= 50% of the previously published rows. `relax` switches off the checks a fund
 * legitimately fails: 'numeric' and 'sum' (geared, inverse, futures, look-through, top-N lists) and 'count'. No relax lets
 * a sheet without a single numeric weight replace a published sheet that had numeric weights (`previousWeights`: how many
 * rows of the published sheet carry a numeric weight, see holdingsWeightCount; open-items etfs Q24).
 * Rows are arrays in header order or objects keyed by the header text. A fund in the brand's CLOSED_FUNDS never reaches the guard.
 */
export function holdingsGuard(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>, previousRows: number | null | undefined, relax: ReadonlyArray<string> = [], previousWeights: number | null = null): string | null {
  const previous = Number(previousRows) > 0 ? Number(previousRows) : 0;
  if (!rows.length) return previous ? `no holdings rows (${previous} published)` : null;
  const names = headers.map((header) => String(header).trim().toLowerCase());
  const nameAt = names.indexOf('name');
  let weightAt = names.indexOf('weight');
  if (weightAt < 0) weightAt = names.indexOf('weight (%)');
  if (weightAt < 0) weightAt = names.indexOf('market weight');
  if (nameAt < 0 || weightAt < 0) return `no ${nameAt < 0 ? 'Name' : 'weight'} column (headers: ${headers.join(', ') || 'none'})`;
  const weights = holdingsGuardWeights(headers, rows, weightAt);
  const numeric = weights.count;
  const sum = weights.sum;
  if (numeric === 0 && Number(previousWeights) > 0) return `no row has a numeric weight, the published sheet had ${Number(previousWeights)}`;
  if (relax.indexOf('numeric') < 0 && numeric < rows.length * 0.8) return `only ${numeric} of ${rows.length} rows have a numeric weight`;
  if (relax.indexOf('sum') < 0 && (sum < 50 || sum > 150)) return `weights add up to ${sum.toFixed(2)}, outside 50..150`;
  if (relax.indexOf('count') < 0 && previous && rows.length < previous * 0.5) return `${rows.length} rows, less than half of the ${previous} published`;
  return null;
}

/** How many rows carry a numeric weight (Weight, Weight (%) or Market Weight column), 0 without such a column: pass it for the published sheet as holdingsGuard's previousWeights. */
export function holdingsWeightCount(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>): number {
  const names = headers.map((header) => String(header).trim().toLowerCase());
  let weightAt = names.indexOf('weight');
  if (weightAt < 0) weightAt = names.indexOf('weight (%)');
  if (weightAt < 0) weightAt = names.indexOf('market weight');
  return weightAt < 0 ? 0 : holdingsGuardWeights(headers, rows, weightAt).count;
}

/** Count and sum of the numeric weights in column weightAt; rows are arrays in header order or objects keyed by the header text. */
function holdingsGuardWeights(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>, weightAt: number): { count: number; sum: number } {
  let count = 0;
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    const row: any = rows[i];
    const weight = holdingsGuardNumber(Array.isArray(row) ? row[weightAt] : row && typeof row === 'object' ? row[headers[weightAt]] : undefined);
    if (weight !== null) {
      count++;
      sum += weight;
    }
  }
  return { count, sum };
}

/** A weight cell as a number: %, $, commas and spaces are ignored, (x) is negative; null when it is no plain number (a zero-width character inside counts as broken). */
function holdingsGuardNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = String(value === null || value === undefined ? '' : value).replace(/[ \t ,%$]/g, '').replace(/−/g, '-');
  const negative = /^\(.*\)$/.test(text);
  if (negative) text = text.slice(1, -1);
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  return negative ? -Number(text) : Number(text);
}

/** A fund its issuer closed (liquidated, delisted or merged away), confirmed from an official source: an SEC filing or the issuer's notice. */
export type ClosedFund = { ticker: string; closed: string; source: string };

/**
 * The brand's CLOSED_FUNDS entry for a ticker, or null. A closed fund is never fetched, never guarded and never reported failed: it keeps
 * its last published data and its index row carries `status: 'closed'`, `closedDate` and `closedSource`. A malformed entry throws, so a
 * typo (no ISO date, no https source) never ships.
 */
export function closedFund(list: ReadonlyArray<ClosedFund>, ticker: unknown): ClosedFund | null {
  const wanted = String(ticker === null || ticker === undefined ? '' : ticker).trim().toUpperCase();
  let found: ClosedFund | null = null;
  for (let i = 0; i < list.length; i++) {
    const fund = list[i];
    if (!/^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(fund.ticker) || !/^\d{4}-\d{2}-\d{2}$/.test(fund.closed) || !/^https:\/\/\S+$/.test(fund.source)) throw new Error(`CLOSED_FUNDS: ${fund.ticker} needs an upper-case ticker, an ISO closing date and an https source`);
    if (fund.ticker === wanted) found = fund;
  }
  return found;
}

/** The index rows with every closed fund marked (`status: 'closed'`, `closedDate`, `closedSource`); other rows are returned as they are. */
export function markClosedFunds<T extends object>(rows: ReadonlyArray<T>, list: ReadonlyArray<ClosedFund>): T[] {
  return rows.map((row) => {
    const fund = closedFund(list, (row as { ticker?: unknown }).ticker);
    return fund ? ({ ...row, status: 'closed', closedDate: fund.closed, closedSource: fund.source } as T) : row;
  });
}

/** A run's queue without the closed funds, which are named once in the log: they are neither fetched nor counted as failed. */
export function withoutClosedFunds<T>(queue: ReadonlyArray<T>, tickerOf: (item: T) => string, list: ReadonlyArray<ClosedFund>): T[] {
  const closed: string[] = [];
  const open: T[] = [];
  for (let i = 0; i < queue.length; i++) {
    if (closedFund(list, tickerOf(queue[i]))) closed.push(tickerOf(queue[i]));
    else open.push(queue[i]);
  }
  if (closed.length) console.log(`[ closed   ] ${closed.join(', ')}: closed by the issuer, published data kept`);
  return open;
}
// </holdings-guard>

// <nport-reader> shared block of .claude/tools/etfs/etf-std/nport-reader.block.ts, applied by apply-block.ts: never edit it in one repo
/**
 * SEC EDGAR Form N-PORT-P holdings reader (open-items etfs ETF-H2), one copy for every brand. Pure functions plus one reader
 * that takes the brand's own `getText(url, label)` (its SEC User-Agent, timeout, retries and pacing). Rules it enforces:
 * - identifiers come from the position itself: `<cusip>` text (or a `value` attribute), `<isin value>`, `<ticker value>`,
 *   `<other value>`; a derivative's reference instrument (inside `<derivativeInfo>`) never lends its identifiers to the position
 * - CUSIP `000000000` and `N/A` are missing; a missing weight or value is null (an empty cell), never 0
 * - a ticker only for a common-stock row (assetCat EC, not a CVR, right, warrant or escrow line) traded in USD with a U.S.
 *   ISIN or none, and never one ticker on two different securities (`nportTickers`)
 * - identity: the filing must name the fund's own series id, or, with no series id known, the fund's name (`nportIdentity`)
 * - freshness: the report period must be strictly newer than the published holdings (`nportIsFresh`)
 * - filings come newest report period first from the registrant's own archive folder, never from the filer agent's CIK
 *   (the accession number prefix)
 */
export type NportPosition = {
  name: string;
  title: string;
  lei: string;
  cusip: string;
  isin: string;
  ticker: string;
  other: string;
  otherDesc: string;
  balance: number | null;
  units: string;
  currency: string;
  /** valUSD, null when the filing has none */
  value: number | null;
  /** pctVal: percent of net assets (0.5 = 0.5%), null when the filing has none */
  weight: number | null;
  payoff: string;
  assetCat: string;
  issuerCat: string;
  country: string;
  /** derivCat of the position's derivativeInfo (FUT, FWD, SWP, OPT, ...), empty for a security */
  derivative: string;
  /** debtSec annualizedRt and maturityDt (ISO), null and '' for a non-debt row */
  coupon: number | null;
  maturity: string;
};

export type NportFiling = {
  seriesId: string;
  seriesName: string;
  regName: string;
  regCik: string;
  /** report period end (genInfo repPdDate) as ISO, '' when missing */
  repPdDate: string;
  netAssets: number | null;
  totalAssets: number | null;
  positions: NportPosition[];
};

export type NportCandidate = { accession: string; filed: string; period: string; cik: string };
export type NportSeriesRef = { cik: string; seriesId: string; classId: string };

/** XML text: entities decoded, tags dropped, whitespace collapsed. */
function nportText(raw: string): string {
  return String(raw)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_m: string, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m: string, dec: string) => String.fromCharCode(Number(dec)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[\s ]+/g, ' ')
    .trim();
}

/** Text of the first `<tag>` (any namespace prefix) in `xml`, '' when absent. */
function nportTag(xml: string, tag: string): string {
  const match = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${tag}>`, 'i').exec(xml);
  return match ? nportText(match[1]) : '';
}

/** The `attribute` of the first `<tag ...>` (any namespace prefix) in `xml`, '' when absent. */
function nportAttr(xml: string, tag: string, attribute: string): string {
  const match = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}\\s[^>]*?\\b${attribute}\\s*=\\s*"([^"]*)"`, 'i').exec(xml);
  return match ? nportText(match[1]) : '';
}

/** A plain decimal or exponent number, null for an empty, N/A or broken cell. */
function nportNumber(raw: string): number | null {
  const text = String(raw).replace(/[\s,]/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** An identifier code, '' for N/A, NONE and all zeros (CUSIP 000000000 means "no CUSIP"). */
function nportCode(raw: string): string {
  const text = String(raw).trim().toUpperCase();
  return !text || /^(N\/?A|NONE|-+|0+)$/.test(text) ? '' : text;
}

/** ISO date of an N-PORT date (YYYY-MM-DD, possibly with a time), '' otherwise. */
function nportIso(raw: unknown): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw === null || raw === undefined ? '' : raw).trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

/** One N-PORT-P primary_doc.xml (or the full submission .txt that embeds it) as series facts and positions. */
export function parseNportFiling(xml: string): NportFiling {
  const text = String(xml === null || xml === undefined ? '' : xml);
  const genInfo = /<(?:[A-Za-z0-9_.-]+:)?genInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?genInfo>/i.exec(text);
  const fundInfo = /<(?:[A-Za-z0-9_.-]+:)?fundInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?fundInfo>/i.exec(text);
  const gen = genInfo ? genInfo[1] : '';
  const fund = fundInfo ? fundInfo[1].replace(/<(?:[A-Za-z0-9_.-]+:)?returnInfo\b[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?returnInfo>/gi, ' ') : '';
  const positions: NportPosition[] = [];
  const blocks = /<(?:[A-Za-z0-9_.-]+:)?invstOrSec\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?invstOrSec>/gi;
  let block: RegExpExecArray | null;
  while ((block = blocks.exec(text)) !== null) {
    const raw = block[1];
    const derivativeInfo = /<(?:[A-Za-z0-9_.-]+:)?derivativeInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?derivativeInfo>/i.exec(raw);
    // The reference instrument of a derivative (SPY for a SPY option, a bond for a CDS) is another security: drop it first.
    const own = raw.replace(/<(?:[A-Za-z0-9_.-]+:)?derivativeInfo\b[^>]*>[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?derivativeInfo>/gi, ' ');
    const identifiers = /<(?:[A-Za-z0-9_.-]+:)?identifiers\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?identifiers>/i.exec(own);
    const ids = identifiers ? identifiers[1] : '';
    const debt = /<(?:[A-Za-z0-9_.-]+:)?debtSec\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?debtSec>/i.exec(own);
    const name = nportTag(own, 'name');
    positions.push({
      name: name && !/^N\/?A$/i.test(name) ? name : nportTag(own, 'title'),
      title: nportTag(own, 'title'),
      lei: nportCode(nportTag(own, 'lei')),
      cusip: nportCode(nportTag(own, 'cusip') || nportAttr(ids, 'cusip', 'value')),
      isin: nportCode(nportAttr(ids, 'isin', 'value')),
      ticker: nportCode(nportAttr(ids, 'ticker', 'value')),
      other: nportCode(nportAttr(ids, 'other', 'value')),
      otherDesc: nportAttr(ids, 'other', 'otherDesc'),
      balance: nportNumber(nportTag(own, 'balance')),
      units: nportTag(own, 'units'),
      currency: (nportTag(own, 'curCd') || nportAttr(own, 'currencyConditional', 'curCd')).toUpperCase(),
      value: nportNumber(nportTag(own, 'valUSD')),
      weight: nportNumber(nportTag(own, 'pctVal')),
      payoff: nportTag(own, 'payoffProfile'),
      assetCat: (nportTag(own, 'assetCat') || nportAttr(own, 'assetConditional', 'assetCat')).toUpperCase(),
      issuerCat: (nportTag(own, 'issuerCat') || nportAttr(own, 'issuerConditional', 'issuerCat')).toUpperCase(),
      country: nportTag(own, 'invCountry').toUpperCase(),
      derivative: derivativeInfo ? (/\bderivCat\s*=\s*"([^"]*)"/i.exec(derivativeInfo[1]) || ['', 'OTHER'])[1].toUpperCase() : '',
      coupon: debt ? nportNumber(nportTag(debt[1], 'annualizedRt')) : null,
      maturity: debt ? nportIso(nportTag(debt[1], 'maturityDt')) : '',
    });
  }
  return {
    seriesId: nportTag(gen, 'seriesId').toUpperCase(),
    seriesName: nportTag(gen, 'seriesName'),
    regName: nportTag(gen, 'regName'),
    regCik: nportTag(gen, 'regCik').replace(/\D/g, ''),
    repPdDate: nportIso(nportTag(gen, 'repPdDate')),
    netAssets: nportNumber(nportTag(fund, 'netAssets')),
    totalAssets: nportNumber(nportTag(fund, 'totAssets')),
    positions,
  };
}

/**
 * A number as sheet text: '' for null, no exponent, at most `digits` decimals (trailing zeros dropped), and no binary float
 * artifact: `115797518.01` stays `115797518.01`, not the `115797518.01000001` of `toFixed(8)`.
 */
export function nportCell(value: number | null, digits = 8): string {
  if (value === null || !Number.isFinite(value)) return '';
  const fixed = value.toFixed(digits);
  // the shortest text of the rounded number; toFixed only where that text would be an exponent (very small or large numbers)
  const shortest = String(Number(fixed));
  if (!/e/i.test(shortest)) return shortest;
  return fixed.indexOf('.') < 0 ? fixed : fixed.replace(/0+$/, '').replace(/\.$/, '');
}

/** The position's own identifier for a sheet: CUSIP, else ISIN, else the "other" code (a Bloomberg or internal id), else ''. */
export function nportIdentifier(position: NportPosition): string {
  return position.cusip || position.isin || position.other;
}

/**
 * A company name as a lookup key: upper case, punctuation and legal suffixes dropped, `CLASS A` -> `CL A`. Initials are one
 * word whether written with dots, spaces or a slash (`N.V.` = `N V` = `NV`, `C.H. ROBINSON` = `C H ROBINSON`, `A/S` = `A S`,
 * `S.A.B. de C.V.` = `SAB DE CV`), `PUBLIC LIMITED COMPANY` is `plc`, and a leading `US` stays (`U.S. BANCORP` is not
 * `BANCORP, INC.`), so both spellings of one issuer give one key.
 */
export function nportNameKey(value: unknown): string {
  // EDGAR adds a state or qualifier suffix to company titles ("COSTCO WHOLESALE CORP /NEW", "BANK OF AMERICA CORP /DE/",
  // "US BANCORP \DE\", "ACUITY INC. (DE)"): drop a trailing one
  const raw = String(value === null || value === undefined ? '' : value).replace(/(?:\s*(?:[\/\\]\s*[A-Za-z]{2,3}\s*[\/\\]?|\(\s*[A-Za-z]{2,3}\s*\)))+\s*$/, '');
  let text = nportText(raw).toUpperCase().replace(/['’]/g, '').replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ').trim();
  text = text.replace(/\bCLASS\s+([A-Z])\b/g, 'CL $1').replace(/\bCL\s+([A-Z])\b/g, 'CL $1');
  // a run of single letters is one word, never the class letter after CL
  const words: string[] = [];
  let joining = false;
  text.split(' ').forEach((word) => {
    const letter = /^[A-Z]$/.test(word);
    if (letter && joining) words[words.length - 1] += word;
    else words.push(word);
    joining = letter && (joining || words[words.length - 2] !== 'CL');
  });
  text = words.join(' ').replace(/\bPUBLIC (?:(?:LIMITED|LTD)(?: (?:COMP[A-Z]*|CO))?|(?:COMPANY|CO) (?:LIMITED|LTD))\b/g, 'PLC').replace(/\b(?:S DE RL )?DE CV\b/g, ' ');
  const share = /\bCL [A-Z]\b/.exec(text);
  text = text.replace(/\b(THE|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|SA|SAB|NV|AG|SE|SPA|AS|ASA|ORDINARY|COMMON|STOCK|SHS|SHARES|ADR|DEPOSITARY|RECEIPT|USD|US|REG|REGISTERED)\b/g, (word: string, _name: string, at: number) => (word === 'US' && at === 0 ? word : ' ')).replace(/\s+/g, ' ').trim();
  if (share && !/\bCL [A-Z]\b/.test(text)) text = `${text} ${share[0]}`;
  return text;
}

/** SEC company_tickers.json -> name key -> ticker (the first, largest company wins a shared key; the class-less key is added too). */
export function parseSecCompanyNames(payload: unknown): Map<string, string> {
  const names = new Map<string, string>();
  const rows = payload && typeof payload === 'object' ? Object.keys(payload as object).map((key) => (payload as Record<string, unknown>)[key]) : [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as { ticker?: unknown; title?: unknown } | null;
    if (!row || typeof row !== 'object') continue;
    const ticker = String(row.ticker === null || row.ticker === undefined ? '' : row.ticker).trim().toUpperCase();
    const key = nportNameKey(row.title);
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) || !key) continue;
    if (!names.has(key)) names.set(key, ticker);
    const core = key.replace(/ CL [A-Z]$/, '');
    if (core && !names.has(core)) names.set(core, ticker);
  }
  return names;
}

/** SEC company_tickers_mf.json -> fund ticker -> registrant CIK (10 digits), series id, class id. */
export function parseSecFundTickers(payload: unknown): Map<string, NportSeriesRef> {
  const map = new Map<string, NportSeriesRef>();
  const record = (payload && typeof payload === 'object' ? payload : {}) as { fields?: unknown; data?: unknown };
  const fields = Array.isArray(record.fields) ? record.fields.map(String) : [];
  const rows = Array.isArray(record.data) ? record.data : [];
  const at = (row: unknown[], field: string): string => (fields.indexOf(field) < 0 ? '' : String(row[fields.indexOf(field)] === null || row[fields.indexOf(field)] === undefined ? '' : row[fields.indexOf(field)]).trim());
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const ticker = at(row, 'symbol').toUpperCase();
    const cik = at(row, 'cik').replace(/\D/g, '');
    const seriesId = at(row, 'seriesId').toUpperCase();
    if (!ticker || !Number(cik) || !/^S\d{9}$/.test(seriesId) || map.has(ticker)) continue;
    map.set(ticker, { cik: `0000000000${Number(cik)}`.slice(-10), seriesId, classId: at(row, 'classId').toUpperCase() });
  }
  return map;
}

/**
 * Is the row a contingent value right, a right, a warrant or an escrow line filed as equity? A placeholder CUSIP or ISIN
 * (`436CVR021`, `US009CVR0445`, `549ESC028`, `866CNT017`) says so; so does the name or title (`NOVO NORDISK A/S - CVR`,
 * `XYZ INC RIGHTS`, `... WARRANT FEB 2026`, `Luby's Inc Escrow`), except on a CUSIP with the common-stock issue number 10
 * (Schwab titles Enovix common stock 293594107 "Enovix Corp Warrants"). `CVR` as the first word is a company (CVR Energy).
 */
function nportIsRight(position: NportPosition): boolean {
  if (/^[0-9A-Z]{3}(?:CVR|ESC|CNT)/.test(position.cusip) || /^US[0-9A-Z]{3}(?:CVR|ESC|CNT)/.test(position.isin)) return true;
  if (/^[0-9A-Z]{6}10[0-9]$/.test(position.cusip)) return false;
  return [position.name, position.title].some((text) => /\S\s*\bCVRS?\b|\bCONTINGENT\b|\bRIGHTS?\b|\bRTS\b|\bWARRANTS?\b|\bWTS\b|\bESCROW\b/i.test(text));
}

/**
 * Exchange tickers for the positions, in their order ('' for none). A ticker is given only to a common-stock row (assetCat
 * EC; a preferred EP, a CVR, right, warrant or escrow line gets none, a name match would give it the issuer's common ticker)
 * traded in USD (or with no currency) whose ISIN is U.S. or missing: first the filer's own `<ticker value>`, else the
 * SEC issuer-name table (`names`) when the row has a CUSIP or a U.S. ISIN. A ticker that lands on two different securities
 * (Alphabet A and C, an ordinary share and its ADR) is dropped from the name-matched rows; when the filer itself gave it
 * to two securities it is dropped from all of them. Bonds, cash, funds and derivatives stay identifier-keyed.
 */
export function nportTickers(positions: ReadonlyArray<NportPosition>, names: Map<string, string> | null = null): string[] {
  const fromFiler: boolean[] = [];
  const tickers = positions.map((position, index) => {
    fromFiler[index] = false;
    const equity = position.assetCat === 'EC' && !position.derivative && !nportIsRight(position);
    const usd = !position.currency || position.currency === 'USD';
    if (!equity || !usd || (position.isin && position.isin.slice(0, 2) !== 'US')) return '';
    if (/^[A-Z][A-Z0-9.-]{0,9}$/.test(position.ticker)) {
      fromFiler[index] = true;
      return position.ticker;
    }
    if (!names || !(/^[0-9A-Z]{9}$/.test(position.cusip) || /^US[0-9A-Z]{10}$/.test(position.isin))) return '';
    const key = nportNameKey(position.name);
    return names.get(key) || names.get(key.replace(/ CL [A-Z]$/, '')) || '';
  });
  const securities = new Map<string, { keys: string[]; filer: string[] }>();
  tickers.forEach((ticker, index) => {
    if (!ticker) return;
    const position = positions[index];
    const key = position.cusip || position.isin || position.other || nportNameKey(position.name);
    const seen = securities.get(ticker) || { keys: [], filer: [] };
    if (seen.keys.indexOf(key) < 0) seen.keys.push(key);
    if (fromFiler[index] && seen.filer.indexOf(key) < 0) seen.filer.push(key);
    securities.set(ticker, seen);
  });
  return tickers.map((ticker, index) => {
    const seen = ticker ? securities.get(ticker) : undefined;
    if (!seen || seen.keys.length < 2) return ticker;
    return seen.filer.length === 1 && fromFiler[index] ? ticker : '';
  });
}

/** The browse-edgar Atom feed of one series' NPORT-P filings. */
export function nportSeriesFeedUrl(seriesId: string, count = 10): string {
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(String(seriesId).toUpperCase())}&type=NPORT-P&dateb=&owner=include&count=${count}&output=atom`;
}

/** The registrant's submissions JSON (report periods of its recent filings). */
export function nportSubmissionsUrl(cik: string): string {
  return `https://data.sec.gov/submissions/CIK${`0000000000${Number(String(cik).replace(/\D/g, '')) || 0}`.slice(-10)}.json`;
}

/** primary_doc.xml of a filing in the registrant's own folder. Throws without a registrant CIK: the accession prefix is the filer agent. */
export function nportDocumentUrl(registrantCik: string, accession: string): string {
  const cik = Number(String(registrantCik).replace(/\D/g, ''));
  if (!cik) throw new Error(`N-PORT ${accession}: no registrant CIK (the accession prefix is the filer agent, never used as the folder)`);
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${String(accession).replace(/-/g, '')}/primary_doc.xml`;
}

/** NPORT-P entries of a browse-edgar Atom feed (amendments and other forms skipped), with the registrant CIK of the filing link. */
export function parseNportFeed(atom: string): NportCandidate[] {
  const out: NportCandidate[] = [];
  const entries = /<entry>([\s\S]*?)<\/entry>/gi;
  let entry: RegExpExecArray | null;
  while ((entry = entries.exec(String(atom === null || atom === undefined ? '' : atom))) !== null) {
    const body = entry[1];
    const form = (nportTag(body, 'filing-type') || nportAttr(body, 'category', 'term')).toUpperCase();
    const accession = nportTag(body, 'accession-number');
    if (form !== 'NPORT-P' || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    const folder = /\/Archives\/edgar\/data\/(\d+)\//i.exec(nportTag(body, 'filing-href'));
    out.push({ accession, filed: nportIso(nportTag(body, 'filing-date')), period: nportIso(nportTag(body, 'period')), cik: folder ? folder[1] : '' });
  }
  return out;
}

/** NPORT-P filings of a registrant's submissions JSON (`filings.recent`), with report periods; the registrant is the JSON's own CIK. */
export function parseNportSubmissions(payload: unknown): NportCandidate[] {
  const record = (payload && typeof payload === 'object' ? payload : {}) as { cik?: unknown; filings?: { recent?: Record<string, unknown> } };
  const recent = record.filings && record.filings.recent ? record.filings.recent : {};
  const column = (name: string): unknown[] => (Array.isArray(recent[name]) ? (recent[name] as unknown[]) : []);
  const forms = column('form'), accessions = column('accessionNumber'), filed = column('filingDate'), periods = column('reportDate');
  const cik = String(record.cik === null || record.cik === undefined ? '' : record.cik).replace(/\D/g, '');
  const out: NportCandidate[] = [];
  for (let i = 0; i < forms.length; i++) {
    const accession = String(accessions[i] === null || accessions[i] === undefined ? '' : accessions[i]);
    if (String(forms[i]).toUpperCase() !== 'NPORT-P' || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    out.push({ accession, filed: nportIso(filed[i]), period: nportIso(periods[i]), cik });
  }
  return out;
}

/**
 * Candidates newest report period first, then newest filing: a late filing for an older period never wins. A missing
 * period is taken from `known` (the registrant's submissions) by accession; candidates still without one go last.
 */
export function nportNewestFirst(candidates: ReadonlyArray<NportCandidate>, known: ReadonlyArray<NportCandidate> = []): NportCandidate[] {
  const periods = new Map<string, string>();
  for (let i = 0; i < known.length; i++) if (known[i].period) periods.set(known[i].accession, known[i].period);
  return candidates
    .map((candidate) => (candidate.period ? candidate : { ...candidate, period: periods.get(candidate.accession) || '' }))
    .sort((a, b) => (a.period && b.period ? b.period.localeCompare(a.period) : a.period ? -1 : b.period ? 1 : 0) || b.filed.localeCompare(a.filed));
}

/**
 * Does the filing belong to the fund? With a series id: only the same series id. Without one: the normalized series name
 * equals the fund name, or (`loose`, reported to the caller) one contains the other. Returns the problem, or null.
 */
export function nportIdentity(filing: Pick<NportFiling, 'seriesId' | 'seriesName'>, fund: { seriesId?: string | null; name?: string | null }): { problem: string | null; loose: boolean } {
  const wantedSeries = String(fund.seriesId || '').trim().toUpperCase();
  if (wantedSeries) return { problem: filing.seriesId === wantedSeries ? null : `names series ${filing.seriesId || 'none'}, not ${wantedSeries}`, loose: false };
  const filed = nportNameKey(filing.seriesName), wanted = nportNameKey(fund.name);
  if (!filed || !wanted) return { problem: 'no series id and no fund name to match', loose: false };
  if (filed === wanted) return { problem: null, loose: false };
  if (filed.indexOf(wanted) >= 0 || wanted.indexOf(filed) >= 0) return { problem: null, loose: true };
  return { problem: `names series "${filing.seriesName}", not "${String(fund.name)}"`, loose: false };
}

/**
 * May a filing replace the published holdings? Nothing published (no rows): any dated or undated report. Otherwise only a
 * report period strictly newer than the published holdings date; both must be ISO dates (convert the brand's display
 * date first), an unknown date on either side keeps the published sheet.
 */
export function nportIsFresh(repPdDate: unknown, publishedAsOf: unknown, publishedRows: unknown): boolean {
  if (!(Number(publishedRows) > 0)) return true;
  const report = nportIso(repPdDate), published = nportIso(publishedAsOf);
  return Boolean(report && published && String(publishedAsOf).trim().length === 10 && report > published);
}

export type NportRead = { filing: NportFiling; candidate: NportCandidate; url: string; loose: boolean } | { problem: string };

/**
 * The newest N-PORT-P filing of one fund, or why there is none. Candidates: the series' Atom feed (when a series id is known;
 * an empty feed means no filing yet) with periods from the registrant's submissions, else (no series id, or the feed failed)
 * the registrant's NPORT-P filings themselves; newest period first.
 * Documents are read until one passes the identity check (at most `maxDocuments`); that newest own filing is returned only
 * when it is fresh against the published holdings (`published.asOf` ISO, `published.rows`). Errors of the optional
 * submissions request are tolerated; others come back as `problem`. `cache` (one Map per run) keeps the submissions and
 * the parsed documents, so funds of one registrant share requests.
 */
export async function readNportHoldings(
  fund: { ticker: string; cik: string; seriesId?: string | null; name?: string | null },
  published: { asOf?: unknown; rows?: unknown },
  getText: (url: string, label: string) => Promise<string>,
  options: { maxDocuments?: number; cache?: Map<string, unknown> } = {},
): Promise<NportRead> {
  const cache = options.cache || new Map<string, unknown>();
  const once = async <T>(key: string, load: () => Promise<T>): Promise<T> => {
    if (!cache.has(key)) cache.set(key, load().catch((error: unknown) => { cache.delete(key); throw error; }));
    return (await cache.get(key)) as T;
  };
  const cik = String(fund.cik || '').replace(/\D/g, '');
  if (!Number(cik)) return { problem: `${fund.ticker}: no registrant CIK` };
  let known: NportCandidate[] = [];
  try {
    known = await once(`submissions:${Number(cik)}`, async () => parseNportSubmissions(JSON.parse(await getText(nportSubmissionsUrl(cik), `${fund.ticker} N-PORT periods`))));
  } catch {
    known = [];
  }
  // null: no series feed (no series id, or the feed failed), so the registrant's own NPORT-P filings are scanned instead
  let candidates: NportCandidate[] | null = null;
  try {
    if (fund.seriesId) candidates = parseNportFeed(await getText(nportSeriesFeedUrl(fund.seriesId), `${fund.ticker} N-PORT filings`));
  } catch (error) {
    if (!known.length) return { problem: `${fund.ticker}: N-PORT filings unavailable (${error instanceof Error ? error.message : String(error)})` };
  }
  const sorted = nportNewestFirst(candidates || known, known);
  if (!sorted.length) return { problem: `${fund.ticker}: no NPORT-P filing yet` };
  const limit = Math.max(1, options.maxDocuments || (candidates ? 3 : 12));
  const misses: string[] = [];
  for (let i = 0; i < sorted.length && i < limit; i++) {
    const candidate = sorted[i];
    const url = nportDocumentUrl(Number(candidate.cik) ? candidate.cik : cik, candidate.accession);
    let filing: NportFiling;
    try {
      filing = await once(`document:${url}`, async () => parseNportFiling(await getText(url, `${fund.ticker} N-PORT ${candidate.accession}`)));
    } catch (error) {
      misses.push(`${candidate.accession} unreadable (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const identity = nportIdentity(filing, fund);
    if (identity.problem) {
      misses.push(`${candidate.accession} ${identity.problem}`);
      continue;
    }
    if (!filing.positions.length) return { problem: `${fund.ticker}: ${candidate.accession} has no positions` };
    if (!nportIsFresh(filing.repPdDate, published.asOf, published.rows)) return { problem: `${fund.ticker}: N-PORT ${filing.repPdDate || 'undated'} is not newer than the published holdings (${String(published.asOf || 'undated')})` };
    return { filing, candidate, url, loose: identity.loose };
  }
  return { problem: `${fund.ticker}: no N-PORT-P filing of its own${misses.length ? `: ${misses.join('; ')}` : ''}` };
}
// </nport-reader>

// <calendar-dates> shared block of .claude/tools/etfs/etf-std/calendar-dates.block.ts, applied by apply-block.ts: never edit it in one repo
/**
 * A calendar date as ISO `YYYY-MM-DD`, or null. Pure text work, never `Date.parse` or local getters, so a run in Tokyo
 * publishes the same day as CI (open-items etfs ETF-H4). Accepts ISO (`2026-10-24`, with a time the date part is kept as
 * written), `2026/10/24`, U.S. `10/24/2026` and `10-24-26` (two-digit years up to 69 are 20xx), month names in either order
 * (`Oct 24, 2026`, `October 24 2026`, `Sept. 30, 2026`, `24 Oct 2026`, `24-Oct-26`), an optional weekday or `as of` in front.
 * A day that does not exist (`02/30/2026`) is null.
 */
export function calendarIso(value: unknown): string | null {
  const text = String(value === null || value === undefined ? '' : value).replace(/[\s ]+/g, ' ').trim()
    .replace(/^as of:? /i, '').replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,? /i, '');
  const year = (raw: string): number => (raw.length === 2 ? (Number(raw) <= 69 ? 2000 : 1900) + Number(raw) : Number(raw));
  const month = (raw: string): number => {
    const word = raw.toLowerCase();
    const names = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    for (let i = 0; i < names.length; i++) if (word.length >= 3 && names[i].indexOf(word) === 0) return i + 1;
    return 0;
  };
  let y = 0, m = 0, d = 0, match: RegExpExecArray | null;
  if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(text)) || (match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(text))) {
    y = Number(match[1]); m = Number(match[2]); d = Number(match[3]);
  } else if ((match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})$/.exec(text))) {
    y = year(match[3]); m = Number(match[1]); d = Number(match[2]);
  } else if ((match = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(text))) {
    y = Number(match[3]); m = month(match[1]); d = Number(match[2]);
  } else if ((match = /^(\d{1,2})(?:st|nd|rd|th)?[ -]([A-Za-z]{3,9})\.?,?[ -](\d{4}|\d{2})$/.exec(text))) {
    y = year(match[3]); m = month(match[2]); d = Number(match[1]);
  } else {
    return null;
  }
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1900 || y > 2999 || m < 1 || m > 12 || d < 1 || d > days[m - 1]) return null;
  return `${y}-${m < 10 ? '0' : ''}${m}-${d < 10 ? '0' : ''}${d}`;
}

/**
 * Is the fund at least `years` old on `asOf`? Calendar anniversary, inclusive: a fund started 2025-10-24 is one year old on
 * 2026-10-24 (a 29 February start on 1 March). Unknown or unreadable dates answer true, so a value is never dropped for want
 * of a date. The shared "younger than one year" rule: since-inception returns are annualized only from one year on.
 */
export function fundAgeAtLeast(inception: unknown, asOf: unknown, years: number): boolean {
  const start = calendarIso(inception), end = calendarIso(asOf);
  if (!start || !end) return true;
  return end >= `${Number(start.slice(0, 4)) + years}${start.slice(4)}`;
}

/**
 * The returns with every horizon the fund is too young for set to null: `horizons` maps a key of `returns` to the years it
 * needs (`{ yr1: 1, cagr3y: 3, siAnn: 1 }`). Keys that are absent or already null stay as they are; the object is copied.
 */
export function withoutYoungReturns<T extends object>(returns: T, inception: unknown, asOf: unknown, horizons: Record<string, number>): T {
  const out: Record<string, unknown> = { ...(returns as Record<string, unknown>) };
  const keys = Object.keys(horizons);
  for (let i = 0; i < keys.length; i++) {
    if (out[keys[i]] !== undefined && out[keys[i]] !== null && !fundAgeAtLeast(inception, asOf, horizons[keys[i]])) out[keys[i]] = null;
  }
  return out as T;
}
// </calendar-dates>

// <windowed-chart> shared block of .claude/tools/etfs/etf-std/windowed-chart.block.ts, applied by apply-block.ts: never edit it in one repo
export type WindowedChartDay = { date: string; close: number; adjClose: number; volume: number; adjCloseRaw?: number };
export type WindowedChartDividend = { epoch: number; amount: number };

/**
 * A HISTORY_RANGE window (`period1` N years back) never shrinks the published history, and with it the 3y, 5y, 10y and
 * since-inception returns (open-items etfs Q25; was a byte-identical copy in Fidelity, Invesco and JPMorgan). The published
 * rows older than the first fresh day are put in front of the fresh days; their Adj Close is rescaled by the ratio measured on
 * the overlapping days (Yahoo re-adjusts the whole series after each distribution). Published distributions older than the
 * window are kept as well. Returns the chart unchanged when nothing published is older, and null when the window cannot be
 * joined safely (no overlap, Close changed, inconsistent or implausible ratio): the caller then keeps the fund as published.
 * `published` rows carry `Date` (any calendarIso form), `Close`, `Adj Close`, `Volume`; distribution rows are
 * [date, amount, ...] arrays. The chart's days must be sorted by ISO date.
 */
export function mergeWindowedChart<C extends { days: WindowedChartDay[]; dividends: WindowedChartDividend[] }>(chart: C, published: ReadonlyArray<Record<string, unknown>>, publishedDistributions: ReadonlyArray<unknown> = []): C | null {
  if (!chart.days.length || !published.length) return chart;
  const num = (value: unknown): number | null => {
    const text = String(value === null || value === undefined ? '' : value).replace(/[\s,$]/g, '');
    return text && Number.isFinite(Number(text)) ? Number(text) : null;
  };
  const firstFresh = chart.days[0].date;
  const rows: Array<{ date: string; close: number; adjClose: number; volume: number }> = [];
  for (let i = 0; i < published.length; i++) {
    const date = calendarIso(published[i].Date), close = num(published[i].Close), adjClose = num(published[i]['Adj Close']);
    if (date && close !== null && adjClose !== null && adjClose > 0) rows.push({ date, close, adjClose, volume: num(published[i].Volume) || 0 });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const older = rows.filter((row) => row.date < firstFresh);
  if (!older.length) return chart;
  const byDate = new Map<string, { close: number; adjClose: number }>();
  for (let i = 0; i < rows.length; i++) byDate.set(rows[i].date, rows[i]);
  const adjRatios: number[] = [];
  const closeRatios: number[] = [];
  for (let i = 0; i < chart.days.length; i++) {
    const day = chart.days[i];
    const prior = byDate.get(day.date);
    if (!prior) continue;
    adjRatios.push((day.adjCloseRaw === undefined ? day.adjClose : day.adjCloseRaw) / prior.adjClose);
    if (prior.close > 0) closeRatios.push(day.close / prior.close);
  }
  if (!adjRatios.length) return null;
  const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
  if (closeRatios.length && Math.abs(mean(closeRatios) - 1) > 1e-3) return null;
  if (Math.max.apply(null, adjRatios) / Math.min.apply(null, adjRatios) - 1 > 5e-3) return null;
  const measured = mean(adjRatios);
  if (measured < 0.5 || measured > 1.001) return null;
  const factor = Math.abs(measured - 1) < 1e-4 ? 1 : measured;
  const days: WindowedChartDay[] = older.map((row) => {
    const raw = row.adjClose * factor;
    return { date: row.date, close: row.close, adjClose: factor === 1 ? row.adjClose : Math.round(raw * 100) / 100, volume: row.volume, adjCloseRaw: raw };
  });
  const firstFreshEpoch = Date.UTC(Number(firstFresh.slice(0, 4)), Number(firstFresh.slice(5, 7)) - 1, Number(firstFresh.slice(8, 10))) / 1000;
  const kept: WindowedChartDividend[] = [];
  for (let i = 0; i < publishedDistributions.length; i++) {
    const cells = publishedDistributions[i];
    const date = Array.isArray(cells) ? calendarIso(cells[0]) : null;
    const amount = Array.isArray(cells) ? num(cells[1]) : null;
    if (!date || amount === null || amount <= 0) continue;
    const epoch = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 1000;
    if (epoch < firstFreshEpoch) kept.push({ epoch, amount });
  }
  kept.sort((a, b) => a.epoch - b.epoch);
  return { ...chart, days: days.concat(chart.days), dividends: kept.concat(chart.dividends.filter((dividend) => dividend.epoch >= firstFreshEpoch)) };
}
// </windowed-chart>

// <fund-selection> shared block of .claude/tools/etfs/etf-std/fund-selection.block.ts, applied by apply-block.ts: never edit it in one repo
/** An index row as far as these helpers read it: the ticker and whether it has published data (`dataFile`, null for a catalog-only row). */
export type FundSelectionRow = { ticker?: unknown; dataFile?: unknown };

function fundSelectionTicker(row: FundSelectionRow): string {
  return String(row.ticker === null || row.ticker === undefined ? '' : row.ticker).trim().toUpperCase();
}

/**
 * The tickers a TICKERS entry may name: the live catalog plus every fund with published data (closed funds included). When
 * the live catalog could not be read (`live` null) every previous index row counts, since nothing tells a real catalog-only
 * row from a stale one. A catalog-only row from an earlier mistyped TICKERS run is therefore not "known" (open-items etfs Q27).
 */
export function knownTickers(live: ReadonlyArray<string> | null, previous: ReadonlyArray<FundSelectionRow>): string[] {
  const out: string[] = [];
  const add = (ticker: string): void => { if (ticker && out.indexOf(ticker) < 0) out.push(ticker); };
  if (live) for (let i = 0; i < live.length; i++) add(String(live[i]).trim().toUpperCase());
  for (let i = 0; i < previous.length; i++) if (!live || previous[i].dataFile) add(fundSelectionTicker(previous[i]));
  return out;
}

/** Throws before any fund request when TICKERS names a fund outside `known` (see knownTickers): a clear error, nothing fetched or written. */
export function assertKnownTickers(selected: ReadonlyArray<string> | null, known: ReadonlyArray<string>, where: string): void {
  const unknown = (selected || []).map((ticker) => String(ticker).trim().toUpperCase()).filter((ticker) => ticker && known.indexOf(ticker) < 0);
  if (unknown.length) throw new Error(`TICKERS: ${unknown.join(', ')} not in ${where}; nothing was fetched or written`);
}

/**
 * The index rows without stale catalog-only rows: a row with no published data whose ticker the live catalog no longer lists
 * (an earlier mistyped TICKERS entry, a fund withdrawn before launch). Rows with data always stay; nothing is dropped when the
 * live catalog could not be read (`live` null).
 */
export function withoutStalePlaceholders<T extends FundSelectionRow>(rows: ReadonlyArray<T>, live: ReadonlyArray<string> | null): T[] {
  if (!live) return rows.slice();
  const listed = live.map((ticker) => String(ticker).trim().toUpperCase());
  return rows.filter((row) => Boolean(row.dataFile) || listed.indexOf(fundSelectionTicker(row)) >= 0);
}

/**
 * New funds of a run (open-items etfs Q28): `published` - first published in this run (the previous index had no row for it,
 * or only a catalog-only one), so a fund whose first read failed is announced when it finally succeeds; `pending` - new in the
 * catalog this run but not published yet. Nothing is reported on a first run (empty previous index).
 */
export function newFundsReport(previous: ReadonlyArray<FundSelectionRow>, next: ReadonlyArray<FundSelectionRow>): { published: string[]; pending: string[] } {
  const report = { published: [] as string[], pending: [] as string[] };
  if (!previous.length) return report;
  const before = new Map<string, boolean>();
  for (let i = 0; i < previous.length; i++) before.set(fundSelectionTicker(previous[i]), Boolean(previous[i].dataFile));
  for (let i = 0; i < next.length; i++) {
    const ticker = fundSelectionTicker(next[i]);
    if (!ticker || before.get(ticker)) continue;
    if (next[i].dataFile) report.published.push(ticker);
    else if (!before.has(ticker)) report.pending.push(ticker);
  }
  report.published.sort();
  report.pending.sort();
  return report;
}

/** The log and step-summary lines of a newFundsReport: `NEW FUNDS: A, B` and `NEW FUNDS (not published yet): C`; none when empty. */
export function newFundsLines(report: { published: ReadonlyArray<string>; pending: ReadonlyArray<string> }): string[] {
  const lines: string[] = [];
  if (report.published.length) lines.push(`NEW FUNDS: ${report.published.join(', ')}`);
  if (report.pending.length) lines.push(`NEW FUNDS (not published yet): ${report.pending.join(', ')}`);
  return lines;
}
// </fund-selection>
