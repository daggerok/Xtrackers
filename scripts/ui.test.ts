/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

const source = await Bun.file(new URL('../app.tsx', import.meta.url)).text();
const html = await Bun.file(new URL('../index.html', import.meta.url)).text();
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function clientFunction(name: string, extra = ''): string {
  const start = new RegExp(`^function ${name}(?:<[^>]*>)?\\(`, 'm').exec(source);
  if (!start) throw new Error(`Missing client helper ${name}`);
  const tail = source.slice(start.index), end = /^}/m.exec(tail);
  if (!end) throw new Error(`Missing helper end ${name}`);
  return new Bun.Transpiler({ loader: 'ts' }).transformSync(tail.slice(0, end.index + 1)) + extra;
}

class NodeDouble {
  childNodes: NodeDouble[] = [];
  dataset: Record<string, string> = {};
  listeners: Record<string, (event: { preventDefault(): void }) => void> = {};
  href = ''; title = ''; className = '';
  constructor(public textContent = '') {}
  replaceChildren(...children: NodeDouble[]): void { this.childNodes = children; }
  append(...children: NodeDouble[]): void { this.childNodes.push(...children); }
  addEventListener(type: string, handler: (event: { preventDefault(): void }) => void): void { this.listeners[type] = handler; }
}
function headerHarness() {
  const panel = new NodeDouble(), subtitle = new NodeDouble(), details = new NodeDouble('Data: timestamp, per-view count, source links');
  const apiLink = new NodeDouble('api/xtrackers/index.json'); apiLink.href = './api/xtrackers/index.json';
  details.append(apiLink); subtitle.append(details);
  const document = { getElementById: () => panel, createTextNode: (text: string) => new NodeDouble(text), createElement: () => new NodeDouble() };
  const render = new Function('document', clientFunction('renderHeaderSummary', ';return renderHeaderSummary;'))(document);
  const text = () => subtitle.childNodes.map(node => node.textContent).join('');
  return { panel, subtitle, details, apiLink, render, text };
}

describe('literal sibling UI parity', () => {
  test('every app/HTML/favicon difference reverses to the pinned source hashes', async () => {
    const manifest = await Bun.file(new URL('../research/2026-10-01/ui-parity.json', import.meta.url)).json();
    expect(manifest.reference.revision).toBe('8ce0ddca58b5459dd7df98f22463fb31afa82f2b');
    for (const [name, file] of Object.entries(manifest.files)) {
      const entry = file as { referenceSha256: string; currentSha256: string; substitutions: { from: string; to: string; occurrences: number; category: string }[] };
      const bytes = new Uint8Array(await Bun.file(new URL(`../${name}`, import.meta.url)).arrayBuffer());
      expect(sha(bytes)).toBe(entry.currentSha256);
      if (!entry.substitutions.length) { expect(sha(bytes)).toBe(entry.referenceSha256); continue; }
      let reverse = new TextDecoder().decode(bytes);
      for (const substitution of [...entry.substitutions].reverse()) {
        expect(substitution.category.length).toBeGreaterThan(0);
        expect(reverse.split(substitution.to).length - 1).toBeGreaterThanOrEqual(substitution.occurrences);
        reverse = reverse.replaceAll(substitution.to, substitution.from);
      }
      expect(sha(reverse)).toBe(entry.referenceSha256);
    }
  });
  test('storage, API and export prefixes are isolated; bootstrap data/CDN structure retained', () => {
    expect(source).not.toContain('jpmorgan'); expect(html).not.toContain('JPMorgan');
    expect(source).toContain("const INDEX_URL = './api/xtrackers/index.json'");
    for (const key of ['theme', 'selected-etfs', 'blacklisted-etfs', 'active-fund', 'tab-filters', 'tab-sorts', 'site-state']) expect(source).toContain(`xtrackers-${key}`);
    expect(source).toContain('return `xtrackers-${scope.toLowerCase()');
    expect(html).toContain('type="text/babel" data-presets="typescript" src="./app.tsx"');
    expect(html).toContain('https://cdn.tailwindcss.com'); expect(html).toContain('https://unpkg.com/@babel/standalone@7.24.0/babel.min.js');
  });
});

describe('mandatory shared Frequency rendering exception', () => {
  const format = new Function(clientFunction('formatDividendFrequency', ';return formatDividendFrequency;'))();
  test('missing/whitespace/all dash variants and legacy coded dash placeholders render None', () => {
    for (const value of [undefined, null, '', '   ', '-', '--', '---', '‐', '‑', '‒', '–', '—', ' — ', ' - - ', '00 - —', '00 - --']) expect(format(value)).toBe('00 - None');
  });
  test('explicit Unknown stays Unknown; all cadence mappings and unknown values stay unchanged', () => {
    for (const [input, expected] of [['None', '00 - None'], ['Unknown', '00 - Unknown'], ['Monthly', '01 - Monthly'], ['Quarterly', '04 - Quarterly'], ['Semi-annually', '06 - Semi-annually'], ['Semi-Annual', '06 - Semi-annually'], ['Annually', '12 - Annually'], ['Irregular', '99 - Irregular'], ['Weekly', 'Weekly'], ['Daily', 'Daily'], ['00 - Unknown', '00 - Unknown']]) expect(format(input)).toBe(expected);
  });
});

describe('shared count-badge rich panel and visible selected tickers', () => {
  test('zero selection removes visible details but preserves original rich nodes and link targets', () => {
    const h = headerHarness();
    h.render(h.subtitle, new Set(), null, () => {});
    expect(h.text()).toBe(''); expect(h.panel.childNodes[0]).toBe(h.details);
    expect(h.details.childNodes[0]).toBe(h.apiLink); expect(h.apiLink.href).toBe('./api/xtrackers/index.json');
  });
  test('one/multiple/all selections always sort and label clickable tickers; activation never mutates membership', () => {
    const h = headerHarness(), activated: string[] = [], selected = new Set(['HYLB', 'DBEF', 'ASHR']);
    h.render(h.subtitle, selected, 'ASHR', (ticker: string) => activated.push(ticker));
    expect(h.text()).toBe('3 selected: ASHR, DBEF, HYLB');
    const links = h.subtitle.childNodes.filter(node => node.dataset.headerFund);
    expect(links).toHaveLength(3); expect(links.every(link => link.className.includes('font-semibold'))).toBe(true);
    expect(links[0].className).toContain('underline');
    links[2].listeners.click({ preventDefault() {} }); expect(activated).toEqual(['HYLB']); expect([...selected]).toEqual(['HYLB', 'DBEF', 'ASHR']);
    h.subtitle.replaceChildren(new NodeDouble('New per-view source context'));
    h.render(h.subtitle, new Set(['DBEF']), 'DBEF', () => {}); expect(h.text()).toBe('1 selected: DBEF');
  });
  test('selection clear updates panel without stale original nodes', () => {
    const h = headerHarness(); h.render(h.subtitle, new Set(['ASHR']), 'ASHR', () => {});
    const next = new NodeDouble('Cleared / restored context'); h.subtitle.replaceChildren(next);
    h.render(h.subtitle, new Set(), null, () => {}); expect(h.text()).toBe(''); expect(h.panel.childNodes).toEqual([next]);
  });
  test('focusable badge and hidden panel retain hover/focus/touch/Escape and viewport logic', () => {
    expect(html).toMatch(/<button[^>]*aria-controls="app-summary"[^>]*id="ticker-count"/);
    expect(html).toContain('id="app-summary" role="region" aria-label="ETF catalog information" hidden');
    for (const clause of ["event.key !== 'Escape'", "trigger.addEventListener('focus', show)", "trigger.addEventListener('pointerenter'", "event.pointerType !== 'touch'", "trigger.addEventListener('click'", "document.addEventListener('pointerdown'", "new ResizeObserver", 'innerWidth - panel.offsetWidth - 16', 'innerHeight - panel.offsetHeight - 16']) expect(html).toContain(clause);
    expect(html).toContain('DBX ETF TRUST, CIK 0001503123');
    expect(html).toContain('width: min(42rem, calc(100vw - 2rem)); max-height: min(70vh, 32rem)');
    expect(source).toContain('panel.replaceChildren(...Array.from(subtitle.childNodes))');
  });
});

describe('copied client per-ticker queue Promise<void> normalization', () => {
  test('preserves generic caller result and recovers from rejection in source helper', async () => {
    const chains = new Map<string, Promise<void>>();
    const enqueue = new Function('holdingsChains', clientFunction('withTickerChain', ';return withTickerChain;'))(chains) as <T>(ticker: string, fn: () => Promise<T>) => Promise<T>;
    expect(await enqueue('ASHR', async () => 123)).toBe(123); expect(await chains.get('ASHR')).toBeUndefined();
    const failure = enqueue('ASHR', async () => { throw new Error('expected'); });
    await expect(failure).rejects.toThrow('expected'); expect(await chains.get('ASHR')).toBeUndefined();
    expect(await enqueue('ASHR', async () => 'recovered')).toBe('recovered');
  });
});

test('rich details keep local-upload provenance explicit without replacing static catalog links/counts', () => {
  const state = { generatedAt: null, counts: { funds: 42, holdings: 2238, history: 9562 }, funds: [{ ticker: 'UPLD' }], blacklist: new Set(), selected: new Set(['UPLD']), activeFundTicker: 'UPLD', activeTab: 'All' };
  const subtitle = { innerHTML: '', querySelectorAll: () => [] };
  const uploaded = new Map([['UPLD', { uploaded: true }]]);
  const render = new Function('state', 'fundMetaCache', 'el', 'escapeHtml', 'activateFund', clientFunction('renderSubtitleDetails', ';return renderSubtitleDetails;'))(state, uploaded, { subtitle, tickerCount: { textContent: '42 ETFs' } }, String, () => {});
  render('UPLD Holdings — 1 of 1 rows loaded');
  expect(subtitle.innerHTML).toContain('Local N-PORT XML holdings are included for this session.');
  expect(subtitle.innerHTML).toContain('Static catalog data:');
  expect(subtitle.innerHTML).toContain('href="./api/xtrackers/index.json"');
  expect(subtitle.innerHTML).toContain('42 ETFs');
  expect(state.selected.size).toBe(1);
  uploaded.clear(); render('Ordinary static view');
  expect(subtitle.innerHTML).not.toContain('Local N-PORT'); expect(subtitle.innerHTML).toContain('Data:');
});

test('restored selections at early bootstrap use initialized metadata and preserve per-view rich counts', () => {
  const state = { generatedAt: null, counts: null, funds: [], blacklist: new Set(), selected: new Set(['ASHR', 'DBEF', 'HYLB']), activeFundTicker: 'ASHR', activeTab: 'Fixed Income' };
  const subtitle = { innerHTML: '', querySelectorAll: () => [] };
  const metadata = new Map();
  const render = new Function('state', 'fundMetaCache', 'el', 'escapeHtml', 'activateFund', clientFunction('categoryLabel') + clientFunction('renderSubtitleDetails', ';return renderSubtitleDetails;'))(state, metadata, { subtitle, tickerCount: { textContent: '1 ETFs' } }, String, () => {});
  expect(() => render()).not.toThrow();
  expect(subtitle.innerHTML).toContain('Fixed Income: 1 ETFs.');
  expect(subtitle.innerHTML).not.toContain('Local N-PORT');
  expect(state.selected.size).toBe(3);
});

test('explicit Bun directive placement is correct in app and Bun tooling files', async () => {
  for (const path of ['app.tsx', 'scripts/update-data.ts', 'scripts/update-data.test.ts', 'scripts/api.test.ts', 'scripts/ui.test.ts', 'research/2026-10-01/browser-check.ts']) {
    const lines = (await Bun.file(new URL('../' + path, import.meta.url)).text()).split('\n');
    expect(lines.slice(0, 2).some(line => line === '/// <reference types="bun" />')).toBe(true);
  }
});
