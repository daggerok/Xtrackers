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
export type ChartDay = { date: string; close: number; adjClose: number; volume: number };
export type ParsedChart = {
  days: ChartDay[];
  dividends: Dividend[];
  exchange: string | null;
  firstTradeDate: string | null;
};
export const HOLDINGS_HEADERS = ['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held', 'Asset Category'];
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



// Shared console contract copied from the pinned JPMorgan reference.
const outputClean = (value: unknown): string => String(value ?? 'null').replace(/[\r\n\t]+/g, ' ');
/** Presentation only: per-fund retry and fallback notices are printed when VERBOSE is enabled. */
let currentVerbose = false;
const outputVerbose = (): boolean => currentVerbose;
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
  };
  const range = (v: any): string => v?.source ?? `${Number.isFinite(v?.min) ? v.min : ''}:${Number.isFinite(v?.max) ? v.max : ''}`;
  for (const [key, value] of Object.entries(config)) {
    const name = aliases[key] ?? key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
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
function outputPrintConfig(brand: string, config: Record<string, any>): void {
  const entries = outputConfigEntries(config);
  console.log(`[ config   ] ${brand} updater:\n${entries.map(([key, value]) => `              ${key}=${/TOKEN|PASSWORD|SECRET|COOKIE|^SEC_UA$/i.test(key) ? '<redacted>' : outputClean(value)}`).join('\n')}`);
}
function outputHasOutputFilters(config: Record<string, any>): boolean {
  return outputConfigEntries(config).some(([name, value]) =>
    /^(TICKERS|CATEGORY|AUM|TER|DIVIDEND_YIELD|SEC_YIELD|PERFORMANCE_|TOTAL_RETURN_)/.test(name) &&
    !['', ':', 'null', 'all'].includes(value));
}
function outputPrintFilter(selected: number, total: number, deferred = false): void {
  console.log(`[ filter   ] ${selected} of ${total} funds ${deferred ? 'selected for evaluation (data-dependent filters applied per fund)' : 'pass filters'}`);
}
function outputStable(value: any): any {
  if (Array.isArray(value)) return value.map(outputStable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => !['generatedAt', 'catalogReadAt', 'savedAt'].includes(key)).map(key => [key, outputStable(value[key])]));
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
function outputMoney(value: any): string {
  const raw = outputScalar(value);
  if (raw === null || raw === undefined || raw === '—' || raw === '--') return 'null';
  const text = String(raw).replace(/[$,\s]/g, '');
  const match = text.match(/^([+-]?[\d.]+)([KMBT])?$/i);
  if (!match) return outputClean(raw);
  const number = Number(match[1]) * ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[match[2]?.toUpperCase() as 'K' | 'M' | 'B' | 'T'] ?? 1);
  if (!Number.isFinite(number)) return 'null';
  for (const [unit, scale] of [['T', 1e12], ['B', 1e9], ['M', 1e6], ['K', 1e3]] as const) {
    if (Math.abs(number) >= scale) return `$${(number / scale).toFixed(1)}${unit}`;
  }
  return `$${number.toFixed(2)}`;
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
    field('div', outputScalar(data.trailingYield ?? data.yields?.effectiveYield ?? data.yields?.dividendYield ?? data.dividendYield ?? metrics.dividendYield)),
    field('sec', outputScalar(data.secYield ?? data.yields?.secYield ?? metrics.secYield)),
    field('wp', data.workplaceRaw),
  ].filter(part => part !== '').join(' ');
  return `[ ${String(index).padStart(width)}/${String(total).padEnd(width)}  ] ${outputClean(ticker).padEnd(5)} ${status.padEnd(9)}${detail ? ` ${detail}` : ''}${reason ? ` reason=${outputClean(reason)}` : ''}`;
}
function outputCreateReporter(root: URL | string, total: number) {
  let completed = 0;
  return {
    before: (ticker: string) => outputInspectFund(root, ticker),
    async result(ticker: string, before: { digest: string }, status?: string, reason?: unknown, extra: any = {}) {
      const after = await outputInspectFund(root, ticker);
      console.log(outputFundLine(++completed, total, ticker, status ?? (before.digest === after.digest ? 'unchanged' : 'updated'), { ...after.meta, ...extra }, reason));
    },
  };
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
/** Rows dated before the HISTORY_RANGE window are not published; an empty window keeps everything. */
export function windowByHistoryRange<T extends { date: string }>(items: T[], historyRange: string, nowEpochSeconds = Math.floor(Date.now() / 1000)): T[] {
  const start = historyWindowStartEpoch(historyRange, nowEpochSeconds);
  if (!start) return items;
  const from = new Date(start * 1000).toISOString().slice(0, 10);
  const kept = items.filter(item => item.date >= from);
  return kept.length ? kept : items;
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
  apply(Object.fromEntries(CONTROL_NAMES.flatMap(key => env[key] === undefined ? [] : [[key, env[key]!.trim()]])));
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
    ['AUM', details.aumValue, config.aumRange], ['TER', details.terValue, config.terRange],
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
  console.log('Xtrackers ETF updater (Bun-only, zero runtime dependencies)\nUsage: bun scripts/update-data.ts [-h|--help]\n\nDefaults: scripts/update-data.config.json (an explicitly set environment variable overrides JSON; filters use AND):');
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

// SEC issuer-name normalization copied verbatim from the pinned JPMorgan reference.
const HOLDING_NAME_SUFFIXES = new Set([
  'STOCK', 'COMMON', 'PREFERRED', 'PFD', 'SHARES', 'ORDINARY', 'DEPOSITARY', 'ADS', 'ADR',
  'INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LIMITED', 'PLC',
  'PUBLIC', 'SA', 'SAS', 'SARL', 'SRL', 'SL', 'KG', 'AG', 'BA', 'BV', 'NV', 'OY', 'SE',
  'AS', 'AB', 'AD', 'KK', 'KABUSHIKI', 'KAISHA', 'PTY', 'PT', 'SFC', 'ANONIMA', 'GMBH',
  'HOLDINGS', 'HLDGS', 'DEL', 'NEW', 'DELISTED', 'REPR', 'GROUP', 'TR', 'TRUST', 'NOTE',
  'NL', 'SPA', 'LP', 'LC', 'LLC', 'CAP', 'STK', 'SHS',
  'NOTES', 'BOND', 'BONDS', 'SER', 'SERIES',
]);
const HOLDING_NAME_PHRASES = new Set([
  'COMMON STOCK', 'PREFERRED STOCK', 'DEPOSITARY SHARES', 'AMERICAN DEPOSITARY SHARES',
  'ORDINARY SHARES', 'LIABILITY CO', 'S A', 'N V', 'B V', 'PRIVATE LTD', 'PUBLIC LTD',
]);
// Words that carry no identity at all: dropped wherever they sit at the edge
// of a filed name, so "The Coca-Cola Co" and "Coca CO" meet.
const HOLDING_NAME_FILLERS = new Set([
  'THE', 'OF', 'AND', 'FOR', 'DE', 'LA', 'LE', 'VAN', 'VON', 'DER', 'DEN', 'DI', 'Y',
  'E', 'DU', 'DA', 'LOS', 'LAS', 'EL', 'AL', 'DEL', 'NPV', 'PAR', 'VAL', 'USD', 'EUR',
  'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'HKD', 'CNY', 'SEK', 'NOK', 'NZD', 'MXN', 'INR',
]);

// Trailing share-class / security-type designations. The class letter is kept
// and canonicalized ("... Class C Capital Stock" -> "... Cl C") rather than
// dropped, so GOOG vs GOOGL — like BF/A vs BF/B — never collide.
const SHARE_CLASS_RE = /(?:\s+(?:CLASS|CL))\s+([A-Z])\b\s*$/;
// Words that only describe the security, never the issuer; safe to peel off the
// end of a filed name (and, once a share class is known, from behind it).
const SECURITY_TYPE_WORDS = new Set([
  'STOCK', 'STK', 'SHARES', 'SHS', 'SH', 'SHARE', 'CAPITAL', 'CAP', 'COMMON', 'ORDINARY',
  'GENERAL', 'VOTING', 'NON', 'NONVOTING', 'NVOTING', 'CONVERTIBLE', 'DEPOSITARY', 'PAID',
  'SUBORDINATED', 'NOTES', 'NOTE', 'SER', 'SERIES', 'LIABILITY', 'NEW', 'REP', 'REPR',
]);

export function normalizeHoldingName(raw: unknown): string {
  const text = String(raw ?? '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  let tokens = text.split(' ').filter(Boolean);
  let classLetter = '';
  let changed = true;
  while (changed && tokens.length > 1) {
    changed = false;
    const withClass = tokens.join(' ').match(SHARE_CLASS_RE);
    if (withClass) {
      classLetter = withClass[1];
      tokens = tokens.slice(0, tokens.length - 2); // drop "Class C" (or "Cl C")
      changed = true;
    }
    const last = tokens[tokens.length - 1];
    if (SECURITY_TYPE_WORDS.has(last) && tokens.length > 1) {
      tokens.pop(); // "... Capital Stock" -> "... Capital"
      changed = true;
      continue;
    }
    if (tokens.length >= 2 && HOLDING_NAME_PHRASES.has(`${tokens[tokens.length - 2]} ${last}`)) {
      tokens = tokens.slice(0, -2);
      changed = true;
      continue;
    }
    if (HOLDING_NAME_SUFFIXES.has(last)) {
      tokens.pop();
      changed = true;
      continue;
    }
    while (tokens.length > 2 && HOLDING_NAME_FILLERS.has(tokens[tokens.length - 1])) {
      tokens.pop(); // keep peeling: a filler may hide the next legal-form suffix
      changed = true;
    }
  }
  while (tokens.length > 1 && HOLDING_NAME_FILLERS.has(tokens[0])) tokens.shift();
  const body = tokens.join(' ').trim();
  return classLetter ? `${body} CL ${classLetter}`.replace(/\s+/g, ' ').trim() : body;
}

export function normalizeHoldingNameCore(raw: unknown): string {
  return normalizeHoldingName(raw).replace(/ /g, '');
}

// Holding tickers keep their class-share markers (SCE^L, BF/A, BRK-B): they
// are the real exchange symbols, unlike fund tickers which sanitizeTicker
// upper-cases and strips everything but letters/digits.
const HOLDING_TICKER_PLACEHOLDERS = new Set(['', 'N/A', 'NA', 'NONE', 'NIL', 'NULL', '-', '--', '---', 'SEE FILE', 'VARIES']);

export function cleanHoldingTicker(raw: unknown): string {
  const symbol = String(raw ?? '').trim().toUpperCase();
  if (HOLDING_TICKER_PLACEHOLDERS.has(symbol)) return '';
  return /^[A-Z0-9][A-Z0-9.^/-]*$/.test(symbol) ? symbol : '';
}


// N-PORT XML parsing copied from the pinned JPMorgan reference (row/date types narrowed).
function tagValue(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return match ? cleanText(match[1]) : '';
}

export type NportHolding = SheetRow;

export type ParsedNport = {
  regName: string;
  regCik: string;
  seriesName: string;
  seriesId: string;
  repPdDate: string | null;
  holdings: NportHolding[];
  totalValue: number;
  netAssets: number | null;
};

// Minimal, forgiving N-PORT-P XML reader (machine-generated schemas only),
// in the same spirit as SPDR's hand-rolled ZIP/OOXML workbook reader.
export function parseNport(xml: string): ParsedNport {
  xml = xml.replace(/(<\/?)[A-Za-z_][\w.-]*:/g, '$1');
  const genInfoMatch = /<genInfo>([\s\S]*?)<\/genInfo>/i.exec(xml);
  const genInfo = genInfoMatch ? genInfoMatch[1] : String(xml || '').slice(0, 4000);
  const fundInfoMatch = /<fundInfo>([\s\S]*?)<\/fundInfo>/i.exec(xml);
  const fundInfo = fundInfoMatch ? fundInfoMatch[1] : '';
  const holdings: NportHolding[] = [];
  const blockRe = /<invstOrSec>([\s\S]*?)<\/invstOrSec>/g;
  let block: RegExpExecArray | null;
  let totalValue = 0;
  while ((block = blockRe.exec(xml)) !== null) {
    const body = block[1];
    const name = tagValue(body, 'name') || tagValue(body, 'title') || '-';
    const cusip = tagValue(body, 'cusip');
    let identifier = cusip && cusip.toUpperCase() !== 'N/A' ? cusip : '';
    if (!identifier) {
      // Real EDGAR schema: <identifiers><isin value="..."/><other value="..."/></identifiers>
      for (const tagMatch of body.matchAll(/<(isin|sedol|other|cusip)[^>]*value="([^"]+)"/gi)) {
        identifier = cleanText(tagMatch[2]);
        if (identifier) break;
      }
    }
    const weight = normalizeNumberText(tagValue(body, 'pctVal'));
    const valueMatch = /<valUSD[^>]*>([\s\S]*?)<\/valUSD>/i.exec(body);
    const value = Number(valueMatch ? valueMatch[1].replace(/[,\s]/g, '') : tagValue(body, 'curVal'));
    const balance = normalizeNumberText(tagValue(body, 'balance'));
    holdings.push({
      Name: name,
      Ticker: '-',
      Identifier: identifier || '-',
      Weight: weight === '' ? '0' : weight,
      'Market Value': Number.isFinite(value) ? String(value) : '0',
      'Shares Held': balance === '' ? '-' : balance,
      'Asset Category': tagValue(body, 'assetCat') || '-',
    });
    if (Number.isFinite(value)) totalValue += value;
  }
  return {
    regName: tagValue(genInfo, 'regName'),
    regCik: tagValue(genInfo, 'regCik'),
    seriesName: tagValue(genInfo, 'seriesName'),
    seriesId: tagValue(genInfo, 'seriesId'),
    repPdDate: toIsoDate(tagValue(genInfo, 'repPdDate')),
    holdings,
    totalValue,
    netAssets: numberOrNull(normalizeNumberText(tagValue(fundInfo, 'netAssets'))),
  };
}


export type SecSeriesRef = { cik: string; seriesId: string; classId: string };
export type NportAccession = { accession: string; filed: string; reportDate: string; url: string };
const SEC_FUND_TICKERS_URL = 'https://www.sec.gov/files/company_tickers_mf.json';
const SEC_COMPANY_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SEC_DATA_HOST = 'https://data.sec.gov';
const EDGAR_ARCHIVES = 'https://www.sec.gov/Archives/edgar/data';
const EDGAR_BROWSE_URL = 'https://www.sec.gov/cgi-bin/browse-edgar';
export function normalizeNumberText(raw: unknown): string { const value = numberOrNull(raw); return value === null ? '' : String(value); }
export function nportUrlFor(cik: string, accession: string): string {
  if (!/^\d+$/.test(cik) || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) throw new Error('EDGAR: invalid accession or CIK');
  return `${EDGAR_ARCHIVES}/${Number(cik)}/${accession.replace(/-/g, '')}/primary_doc.xml`;
}
export function parseFundTickerMap(payload: unknown): Map<string, SecSeriesRef> {
  const object = record(payload), fields = array(object.fields).map(cleanText);
  const result = new Map<string, SecSeriesRef>();
  const at = (row: unknown[], key: string): string => cleanText(row[fields.indexOf(key)]);
  for (const row of array(object.data)) {
    if (!Array.isArray(row)) continue;
    const ticker = sanitizeTicker(at(row, 'symbol')), cik = at(row, 'cik').replace(/\D/g, '');
    if (!ticker || !cik || Number(cik) === 0 || result.has(ticker)) continue;
    result.set(ticker, { cik: cik.padStart(10, '0'), seriesId: at(row, 'seriesId').toUpperCase(), classId: at(row, 'classId').toUpperCase() });
  }
  return result;
}
export function parseCompanyTickerMap(payload: unknown): Map<string, string> {
  const result = new Map<string, string>();
  for (const row of Object.values(record(payload)).map(record)) {
    const ticker = cleanHoldingTicker(row.ticker), name = cleanText(row.title);
    if (!ticker || !name) continue;
    for (const key of [normalizeHoldingName(name), normalizeHoldingNameCore(name)]) if (key && !result.has(key)) result.set(key, ticker);
  }
  return result;
}
export function parseNportAccessions(payload: unknown): NportAccession[] {
  const object = record(payload), recent = record(record(object.filings).recent);
  return array(recent.form).flatMap((form, i) => {
    const accession = cleanText(array(recent.accessionNumber)[i]);
    if (form !== 'NPORT-P' || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) return [];
    return [{ accession, filed: cleanText(array(recent.filingDate)[i]), reportDate: cleanText(array(recent.reportDate)[i]), url: nportUrlFor(cleanText(object.cik), accession) }];
  });
}
export function edgarSeriesFilingsUrl(seriesId: string, count = 10): string {
  return `${EDGAR_BROWSE_URL}?${new URLSearchParams({ action: 'getcompany', CIK: seriesId.toUpperCase(), type: 'NPORT-P', dateb: '', owner: 'include', count: String(count), output: 'atom' })}`;
}
export function parseEdgarAtomFilings(xml: string): NportAccession[] {
  const result: NportAccession[] = [];
  for (const entry of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)) {
    const body = entry[1], form = tagValue(body, 'filing-type') || tagValue(body, 'type');
    if (form && form.toUpperCase() !== 'NPORT-P') continue;
    const accession = tagValue(body, 'accession-number') || tagValue(body, 'accession-nunber');
    if (!/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    const cik = /\/edgar\/data\/(\d+)\//.exec(tagValue(body, 'filing-href'))?.[1] || accession.slice(0, 10);
    result.push({ accession, filed: tagValue(body, 'filing-date'), reportDate: tagValue(body, 'period'), url: nportUrlFor(cik, accession) });
  }
  return result;
}
export function matchesNportFund(parsed: ParsedNport, fund: CatalogFund, ref: SecSeriesRef | null): boolean {
  if (Number(parsed.regCik) !== Number(ref?.cik || TRUST_CIK) || !parsed.repPdDate || !parsed.holdings.length) return false;
  if (ref?.seriesId) return parsed.seriesId.toUpperCase() === ref.seriesId;
  return Boolean(fund.name) && normalizeHoldingName(parsed.seriesName) === normalizeHoldingName(fund.name);
}
export function fillNportTickers(rows: NportHolding[], names: Map<string, string>): NportHolding[] {
  return rows.map(row => {
    if (cleanHoldingTicker(row.Ticker) || !/^(?:EC|EQ|equity|equities|common stock)$/i.test(row['Asset Category'])) return row;
    const ticker = names.get(normalizeHoldingName(row.Name)) || names.get(normalizeHoldingNameCore(row.Name));
    return ticker ? { ...row, Ticker: ticker } : row;
  });
}
export type SourceClient = {
  bytes(url: string, headers?: Record<string, string>): Promise<Uint8Array>;
  text(url: string, headers?: Record<string, string>): Promise<string>;
  json(url: string, headers?: Record<string, string>): Promise<unknown>;
};
function createEdgarFallback(client: SourceClient, config: UpdaterConfig) {
  let funds: Promise<Map<string, SecSeriesRef>> | null = null;
  let companies: Promise<Map<string, string>> | null = null;
  const loadFundTickerTable = () => funds ??= client.json(SEC_FUND_TICKERS_URL, secHeaders(config)).then(parseFundTickerMap).catch(error => {
    outputNote(`[ edgar    ] fund ticker table: ${errorMessage(error)}`); return new Map<string, SecSeriesRef>();
  });
  const loadCompanyTickerTable = () => companies ??= client.json(SEC_COMPANY_TICKERS_URL, secHeaders(config)).then(parseCompanyTickerMap).catch(error => {
    outputNote(`[ edgar    ] company ticker table: ${errorMessage(error)}`); return new Map<string, string>();
  });
  return async (fund: CatalogFund): Promise<{ sheet: Sheet; source: string } | null> => {
    const ref = (await loadFundTickerTable()).get(fund.ticker) || null;
    // The brand's verified Trust is fixed. Do not silently use another registrant.
    if (ref && Number(ref.cik) !== Number(TRUST_CIK)) return null;
    let filings: NportAccession[] = [];
    if (ref?.seriesId) {
      try { filings = parseEdgarAtomFilings(await client.text(edgarSeriesFilingsUrl(ref.seriesId), secHeaders(config))); }
      catch (error) { outputNote(`[ edgar    ] ${fund.ticker} series: ${errorMessage(error)}`); }
    }
    if (!filings.length) {
      try { filings = parseNportAccessions(await client.json(`${SEC_DATA_HOST}/submissions/CIK${TRUST_CIK}.json`, secHeaders(config))); }
      catch (error) { outputNote(`[ edgar    ] ${fund.ticker} submissions: ${errorMessage(error)}`); return null; }
    }
    for (const filing of filings.slice(0, ref?.seriesId ? 10 : 80)) {
      try {
        const parsed = parseNport(await client.text(filing.url, secHeaders(config)));
        if (!matchesNportFund(parsed, fund, ref)) continue;
        const rows = fillNportTickers(parsed.holdings, await loadCompanyTickerTable());
        rows.sort((a, b) => Number(b.Weight) - Number(a.Weight) || a.Identifier.localeCompare(b.Identifier) || a.Name.localeCompare(b.Name));
        return { sheet: { headers: HOLDINGS_HEADERS, rows, asOfDate: parsed.repPdDate }, source: filing.url };
      } catch (error) {
        outputNote(`[ edgar    ] ${fund.ticker} ${filing.accession}: ${errorMessage(error)}`);
        if (error instanceof HttpError && [403, 429].includes(error.status)) break;
      }
    }
    return null;
  };
}

// Complete source values win; missing fields retain the last published facts (zero is real data).
export function indexRowForCatalog(fund: CatalogFund): JsonRecord {
  return {
    ticker: fund.ticker, name: fund.name || fund.ticker, category: fund.category || 'Unclassified', fundPage: fund.fundPage,
    dataFile: `funds/${fund.ticker}/meta.json`, ter: percentageText(fund.terValue), terValue: fund.terValue,
    nav: '—', navValue: null, aum: moneyText(fund.aumValue), aumValue: fund.aumValue,
    asOfDate: null, inceptionDate: fund.inceptionDate, exchange: null, closePrice: '—', premiumDiscount: '—',
    cusip: null, isin: null, distributions: { frequency: null, exDate: null, dividend: null },
    returns: { monthEnd: fund.officialReturns, quarterEnd: emptyReturns() }, metrics: {}, holdings: 0, history: 0,
  };
}
const percentageText = (value: number | null): string => value === null ? '—' : `${value.toFixed(2)}%`;
const moneyText = (value: number | null): string => value === null ? '—' : `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
function detailsFromPrevious(fund: CatalogFund, previous: JsonRecord, meta: JsonRecord): FundDetails {
  const identifiers = record(meta.identifiers), yields = record(meta.yields);
  return {
    ...fund, name: cleanText(previous.name) || fund.name, category: cleanText(previous.category) || fund.category,
    inceptionDate: toIsoDate(previous.inceptionDate) || fund.inceptionDate,
    terValue: numberOrNull(previous.terValue) ?? fund.terValue, netTerValue: numberOrNull(meta.netTerValue) ?? fund.netTerValue,
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
  const result = { ...source };
  if (result.sinceInception !== null) {
    const age = inception && source.asOfDate ? (Date.parse(source.asOfDate) - Date.parse(inception)) / (365.25 * 86400000) : null;
    // DWS's <1-year SI figures are cumulative; age/date uncertainty cannot certify annualized SI.
    if (age === null || age < 1) result.sinceInception = null;
  }
  return result;
}
export function deriveCatalogMetrics(returns: OfficialReturnRow, dividendYield: number | null, secYield: number | null, basis: string): JsonRecord {
  return { ytd: returns.ytd, tr1y: returns.yr1, cagr3y: returns.yr3, cagr5y: returns.yr5, cagr10y: returns.yr10,
    tr3y: annualizedToTotal(returns.yr3, 3), tr5y: annualizedToTotal(returns.yr5, 5), tr10y: annualizedToTotal(returns.yr10, 10),
    siAnn: returns.sinceInception, dividendYield, dividendYieldText: percentageText(dividendYield), secYield, secYieldText: percentageText(secYield), returnsBasis: basis };
}

export type FundOutcome = { ticker: string; status: 'updated' | 'unchanged' | 'skipped' | 'failed'; freshSources: string[]; retainedSources: string[]; holdings: number; history: number; reason?: string };
export type UpdateResult = {
  selected: string[]; outcomes: FundOutcome[]; failures: number; updated: number;
  counts: { funds: number; holdings: number; history: number };
  catalogFunds: number; catalogSource: string; manifestChanged: boolean; progressChanged: boolean; processedThrough: string | null;
};
export type RuntimeOptions = { root?: string; fetcher?: Fetcher };
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
    inceptionDate: toIsoDate(row.inceptionDate), terValue: numberOrNull(row.terValue), netTerValue: null,
    aumValue: numberOrNull(row.aumValue), officialReturns: emptyReturns() };
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
  if (!holdings) {
    const fallback = config.edgarFallback ? await edgar({ ...fund, name: details.name }) : null;
    if (fallback) { holdings = fallback.sheet; holdingsSource = fallback.source; freshSources.push('SEC N-PORT'); }
    else if (previousHoldings.rows.length) { holdings = previousHoldings; holdingsSource = cleanText(previousSource.holdingsSource) || exportUrl(fund.ticker, 'Securities'); retainedSources.push('holdings'); }
  }
  const currentNav = await attempt('DWS Performance', async () => parseNavRows(parseXlsxSheet(await client.bytes(exportUrl(fund.ticker, 'Performance'))), fund.ticker));
  const currentEvents = await attempt('DWS Distributions', async () => parseDistributionsRows(parseXlsxSheet(await client.bytes(exportUrl(fund.ticker, 'Distributions'))), fund.ticker));
  const chart = config.skipYahoo ? null : await attempt('Yahoo', async () => {
    const parsed = parseChart(await client.json(yahooChartUrl(fund.ticker, Math.floor(Date.now() / 1000), config.historyRange)));
    if (!parsed.days.length) throw new Error('Yahoo: no usable daily prices');
    return parsed;
  });
  const nav = new Map(navFromPublished(previousHistory).map(point => [point.date, point]));
  currentNav?.forEach(point => nav.set(point.date, point));
  const points = [...nav.values()].sort((a, b) => a.date.localeCompare(b.date));
  const prices = new Map(pricesFromPublished(previousHistory).map(day => [day.date, day]));
  chart?.days.forEach(day => prices.set(day.date, day));
  const days = [...prices.values()].sort((a, b) => a.date.localeCompare(b.date));
  const events = mergeDividends(previousEvents, currentEvents ?? chart?.dividends ?? []);
  if (!currentNav && points.length) retainedSources.push('NAV history');
  if (!chart && days.length) retainedSources.push('market-price history');
  if (!currentEvents && previousEvents.length) retainedSources.push('distributions');
  if (!holdings?.rows.length) throw new Error('no usable holdings and no published holdings to retain');
  const history = historySheet(windowByHistoryRange(points, config.historyRange), windowByHistoryRange(days, config.historyRange));
  if (!history.rows.length) throw new Error('no usable history and no published history to retain');
  if (!freshSources.length) return { row: previousRow, outcome: outcome('unchanged', holdings.rows.length, history.rows.length, 'all providers unavailable; retained published data') };

  // Prefer official NAV total-return reconstruction, but never silently ignore a missing distribution series.
  const navReinvestmentKnown = currentEvents !== null || previousEvents.length > 0;
  const returnDays = points.length && navReinvestmentKnown ? navTotalReturnDays(points, events)
    : chart?.days ?? (previousHistory.headers.includes('Adj Close') ? days : []);
  const coverage = points.length && navReinvestmentKnown ? reinvestmentCoverageStart(points, events) : null;
  const coveredDays = coverage ? returnDays.filter(day => day.date >= coverage) : returnDays;
  const latestDate = returnDays.at(-1)?.date;
  const ends = latestDate ? reportingPeriodEnds(latestDate) : null;
  const derivedMonth = ends ? deriveReturns(coveredDays, ends.monthEnd, details.inceptionDate) : emptyReturns();
  const derivedQuarter = ends ? deriveReturns(coveredDays, ends.quarterEnd, details.inceptionDate) : emptyReturns();
  const official = annualizedOfficialReturns(Object.values(fund.officialReturns).some(value => typeof value === 'number') ? fund.officialReturns : details.officialReturns, details.inceptionDate);
  const monthEnd = returnDays.length ? coalesceReturns(official, derivedMonth) : returnsFromPublished(record(previousRow.returns).monthEnd);
  const quarterEnd = returnDays.length ? derivedQuarter : returnsFromPublished(record(previousRow.returns).quarterEnd);
  const frequency = distributionFrequency(details.frequency, events);
  const latestDividend = events.filter(event => event.amount > 0).at(-1);
  const latestPrice = days.at(-1), latestNav = points.at(-1);
  const navValue = details.navValue ?? latestNav?.nav ?? null;
  const navAsOfDate = details.navAsOfDate ?? latestNav?.date ?? null;
  const price = latestPrice?.close ?? null;
  const premiumDiscount = latestPrice && navAsOfDate === latestPrice.date && navValue !== null && navValue > 0 ? round((latestPrice.close / navValue - 1) * 100, 4) : null;
  const dividendYield = details.distributionRate ?? indicatedYield(latestDividend?.amount ?? null, frequency.paymentsPerYear, navValue);
  const basis = Object.values(official).some(value => typeof value === 'number') ? (official.asOfDate ? 'official DWS NAV total returns; covered daily-series derivation fills same-date gaps' : 'official DWS NAV total returns (source as-of date unavailable; no dated-series mixing)')
    : points.length && navReinvestmentKnown ? 'derived from official DWS daily NAV with total distributions reinvested at ex-date NAV; not published standardized NAV returns'
    : 'derived from Yahoo adjusted market-price closes; not official NAV returns';
  const metrics = deriveCatalogMetrics(monthEnd, dividendYield, details.secYield, basis);
  const filters = fundFilterReasons(details, metrics, config);
  if (filters.length) return { row: null, outcome: outcome('skipped', previousHoldings.rows.length, previousHistory.rows.length, `filters: ${filters.join(',')}`) };

  const holdingsManifest = pageManifest('holdings', holdings, config.holdingsPageSize, holdingsSource);
  const historySource = points.length ? exportUrl(fund.ticker, 'Performance') + (days.length ? ' + ' + yahooSourceUrl(fund.ticker) : '') : yahooSourceUrl(fund.ticker);
  const historyManifest = pageManifest('history', history, config.historyPageSize, historySource);
  const generatedAt = new Date().toISOString();
  const row: JsonRecord = {
    ticker: fund.ticker, name: details.name || cleanText(previousRow.name) || fund.ticker, category: details.category || 'Unclassified',
    fundPage: details.fundPage, dataFile: `funds/${fund.ticker}/meta.json`, ter: percentageText(details.terValue), terValue: details.terValue,
    nav: navValue === null ? '—' : `$${navValue.toFixed(2)}`, navValue,
    aum: moneyText(details.aumValue ?? latestNav?.aum ?? null), aumValue: details.aumValue ?? latestNav?.aum ?? null,
    asOfDate: navAsOfDate, inceptionDate: details.inceptionDate, exchange: details.exchange || chart?.exchange || null,
    closePrice: price === null ? '—' : `$${price.toFixed(2)}`, closePriceAsOfDate: latestPrice?.date || null,
    premiumDiscount: percentageText(premiumDiscount), cusip: details.cusip, isin: details.isin,
    distributions: { frequency: frequency.frequency, exDate: latestDividend?.exDate || null, dividend: latestDividend ? String(latestDividend.amount) : null },
    returns: { monthEnd, quarterEnd }, metrics, holdings: holdings.rows.length, history: history.rows.length,
  };
  const meta: JsonRecord = {
    ...row, generatedAt, netTerValue: details.netTerValue,
    source: { provider: 'Xtrackers (DWS)', site: 'https://etf.dws.com/en-us/', catalog: CATALOG_URL, details: detailsUrl(fund.ticker),
      holdingsSource, historySource, distributionsSource: currentEvents !== null || previousEvents.length ? exportUrl(fund.ticker, 'Distributions') : yahooSourceUrl(fund.ticker),
      yahoo: yahooSourceUrl(fund.ticker), trust: 'DBX ETF TRUST', trustCik: TRUST_CIK },
    identifiers: { cusip: details.cusip, isin: details.isin, indexTicker: details.indexTicker },
    yields: { dividendYield, dividendYieldText: percentageText(dividendYield), dividendYieldKind: details.distributionRate !== null ? 'official indicated distribution rate / NAV' : 'latest positive distribution x payments per year / NAV',
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
  currentVerbose = config.verbose;
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
  const catalog = new Map(discovered.map(fund => [fund.ticker, fund]));
  for (const [ticker, row] of previousRows) if (!catalog.has(ticker)) catalog.set(ticker, catalogFromPrevious(row));
  if (!catalog.size) throw new Error('no official or published catalog available; no files changed');
  const unknown = [...config.tickers].filter(ticker => !catalog.has(ticker));
  if (unknown.length) throw new Error(`requested tickers absent from catalog: ${unknown.join(',')}; no files changed`);
  const universe = [...catalog.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
  console.log(`[ catalog  ] ${universe.length} Xtrackers ETFs (${catalogSource})`);
  const filtered = universe.filter(fund => !config.tickers.size || config.tickers.has(fund.ticker));
  const deferred = Boolean(config.aumRange || config.terRange || config.dividendYieldRange || config.secYieldRange || Object.keys(config.performanceRanges).length || Object.keys(config.totalReturnRanges).length);
  outputPrintFilter(filtered.length, universe.length, deferred);
  const statePath = join(root, 'update-state.json'), updateState = await readJson(statePath);
  const scope = outputContentKey({ tickers: [...config.tickers].sort(), aum: config.aumRange, ter: config.terRange, dividend: config.dividendYieldRange, sec: config.secYieldRange, performance: config.performanceRanges, totalReturn: config.totalReturnRanges });
  const cursor = config.maxFetches > 0 && updateState.scope === scope ? cleanText(updateState.cursor) || null : null;
  const batch = selectUpdateBatch(filtered, config.maxFetches, cursor), queue = [...batch];
  if (config.maxFetches > 0) console.log(`[ cursor   ] ${batch.length} selected for this batch; after ${cursor || 'start'}`);
  const rows = new Map(previousRows);
  for (const fund of universe) if (!rows.has(fund.ticker) && (!config.tickers.size || !previousRows.size || config.tickers.has(fund.ticker))) rows.set(fund.ticker, indexRowForCatalog(fund));
  const outcomes: FundOutcome[] = [], edgar = createEdgarFallback(client, config);
  const reporter = outputCreateReporter(root, batch.length);
  async function worker(): Promise<void> {
    for (;;) {
      const fund = queue.shift(); if (!fund) return;
      const before = await reporter.before(fund.ticker);
      try {
        const result = await updateFund(fund, previousRows.get(fund.ticker) || {}, root, client, config, edgar);
        if (result.row) rows.set(fund.ticker, result.row);
        outcomes.push(result.outcome);
        await reporter.result(fund.ticker, before, result.outcome.status, result.outcome.reason);
      } catch (error) {
        outcomes.push({ ticker: fund.ticker, status: 'failed', freshSources: [], retainedSources: ['all published files'], holdings: Number(previousRows.get(fund.ticker)?.holdings || 0), history: Number(previousRows.get(fund.ticker)?.history || 0), reason: errorMessage(error) });
        await reporter.result(fund.ticker, before, 'failed', errorMessage(error));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(config.concurrency, batch.length) }, worker));
  const funds = [...rows.values()].sort((a, b) => String(a.ticker).localeCompare(String(b.ticker)));
  const counts = { funds: funds.length, holdings: funds.reduce((sum, row) => sum + (numberOrNull(row.holdings) || 0), 0), history: funds.reduce((sum, row) => sum + (numberOrNull(row.history) || 0), 0) };
  const manifestChanged = await writeJsonIfChanged(join(root, 'index.json'), {
    provider: 'Xtrackers (DWS)', generatedAt: new Date().toISOString(),
    source: catalogFresh ? { catalog: CATALOG_URL, catalogSource, sitemap: SITEMAP_URL, site: 'https://etf.dws.com/en-us/', trust: 'DBX ETF TRUST', trustCik: TRUST_CIK } : previousIndex.source,
    counts, funds,
  });
  const failures = outcomes.filter(result => result.status === 'failed').length;
  let progressChanged = false;
  if (!failures) {
    if (config.maxFetches > 0 && batch.length) progressChanged = await writeJsonIfChanged(statePath, { scope, cursor: batch.at(-1)?.ticker, generatedAt: new Date().toISOString() });
    else if (config.maxFetches === 0) { progressChanged = await Bun.file(statePath).exists(); await rm(statePath, { force: true }); }
  }
  const updated = outcomes.filter(result => result.status === 'updated').length;
  console.log(`[ done     ] ${updated} funds updated, ${failures} failures`);
  console.log(`[ done     ] counts: funds=${counts.funds} holdings=${counts.holdings} history=${counts.history}; processed=${outcomes.length} skipped=${outcomes.filter(result => result.status === 'skipped').length}`);
  return { selected: batch.map(fund => fund.ticker), outcomes, failures, updated, counts,
    catalogFunds: universe.length, catalogSource, manifestChanged, progressChanged,
    processedThrough: failures ? cursor : config.maxFetches > 0 && batch.length ? batch.at(-1)?.ticker || null : null };
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
