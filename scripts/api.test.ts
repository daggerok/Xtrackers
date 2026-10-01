/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { array, record, numberOrNull, toIsoDate } from './update-data';

const root = fileURLToPath(new URL('../api/xtrackers/', import.meta.url));
const json = async (path: string) => record(JSON.parse(await readFile(join(root, path), 'utf8')));

describe('published static API contract (offline, permits legitimate future refreshes)', () => {
  test('catalog has unique tickers, truthful counts and the three live-accepted starter funds', async () => {
    const index = await json('index.json'), funds = array(index.funds).map(record);
    expect(index.provider).toBe('Xtrackers (DWS)');
    expect(funds.length).toBeGreaterThanOrEqual(3);
    expect(new Set(funds.map(fund => fund.ticker)).size).toBe(funds.length);
    const counts = record(index.counts);
    expect(counts.funds).toBe(funds.length);
    expect(counts.holdings).toBe(funds.reduce((sum, fund) => sum + (numberOrNull(fund.holdings) ?? 0), 0));
    expect(counts.history).toBe(funds.reduce((sum, fund) => sum + (numberOrNull(fund.history) ?? 0), 0));
    for (const ticker of ['ASHR', 'DBEF', 'HYLB']) {
      const fund = funds.find(fund => fund.ticker === ticker);
      expect(fund).toBeDefined();
      expect(numberOrNull(fund?.holdings)).toBeGreaterThan(0);
      expect(numberOrNull(fund?.history)).toBeGreaterThan(0);
    }
  });
  test('every published manifest and page agrees; catalog-only funds do not invent files or facts', async () => {
    const index = await json('index.json');
    for (const fund of array(index.funds).map(record)) {
      const ticker = String(fund.ticker);
      expect(ticker).toMatch(/^[A-Z][A-Z0-9.-]{0,9}$/);
      expect(fund.dataFile).toBe(`funds/${ticker}/meta.json`);
      if (!fund.holdings && !fund.history) continue; // intentionally catalog-only until a real update
      const meta = await json(`funds/${ticker}/meta.json`);
      expect(meta.ticker).toBe(ticker);
      for (const kind of ['holdings', 'history'] as const) {
        const manifest = record(meta[kind]), pages = array(manifest.pages).map(String);
        expect(pages.length).toBe(Math.ceil(Number(manifest.totalRows) / Number(manifest.pageSize)));
        let rowCount = 0;
        for (const [i, path] of pages.entries()) {
          expect(path).toMatch(new RegExp(`^${kind}/\\d{3,}\\.json$`));
          const page = await json(`funds/${ticker}/${path}`), rows = array(page.rows).map(record), headers = array(page.headers).map(String);
          expect(page.ticker).toBe(ticker); expect(page.page).toBe(i + 1); expect(page.pageSize).toBe(manifest.pageSize);
          expect(page.totalRows).toBe(manifest.totalRows); expect(rows.length).toBeLessThanOrEqual(Number(manifest.pageSize));
          expect(headers.length).toBeGreaterThan(0);
          for (const row of rows) for (const header of headers) expect(typeof row[header]).toBe('string');
          if (kind === 'holdings') for (const row of rows) {
            expect(numberOrNull(row.Weight)).not.toBeNull();
            expect(numberOrNull(row['Market Value'])).not.toBeNull();
            expect(String(row.Name).length).toBeGreaterThan(0);
          }
          if (kind === 'history') for (const row of rows) expect(toIsoDate(row.Date)).toBe(row.Date);
          rowCount += rows.length;
        }
        expect(rowCount).toBe(manifest.totalRows); expect(rowCount).toBe(fund[kind]);
        const actual = (await readdir(join(root, `funds/${ticker}/${kind}`))).filter(name => /^\d+\.json$/.test(name)).sort();
        expect(actual).toEqual(pages.map(path => path.split('/')[1]).sort());
      }
    }
  });
  test('source provenance is query-stable; dated NAV and prices are not mixed for headline premium', async () => {
    for (const fund of array((await json('index.json')).funds).map(record)) {
      if (!fund.holdings && !fund.history) continue;
      const meta = await json(`funds/${fund.ticker}/meta.json`), source = record(meta.source);
      expect(source.provider).toBe('Xtrackers (DWS)'); expect(source.trust).toBe('DBX ETF TRUST'); expect(source.trustCik).toBe('0001503123');
      expect(String(source.yahoo)).toMatch(/^https:\/\/query1\.finance\.yahoo\.com\/v8\/finance\/chart\/[A-Z0-9.-]+$/);
      expect(String(source.historySource)).not.toContain('period2=');
      expect(String(source.historySource)).not.toContain('period1=');
      if (fund.asOfDate !== fund.closePriceAsOfDate) expect(fund.premiumDiscount).toBe('—');
      const events = array(meta.distributionEvents).map(record);
      expect(events.every(event => numberOrNull(event.amount) !== null)).toBe(true);
      expect(events.map(event => event.exDate)).toEqual(events.map(event => event.exDate).sort());
    }
  });
});
