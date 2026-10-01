/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CONTROL_NAMES, readConfig, resolveControls, runtimeControls } from './update-data';
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const configFile = () => JSON.parse(read('scripts/update-data.config.json'));

test('configuration precedence: file < advanced < nonblank input < environment', () => {
  const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'ASHR' }, { CONCURRENCY: 3, TICKERS: 'HYLB' }, { CONCURRENCY: '4', TICKERS: '' }, { CONCURRENCY: '6' });
  expect(c.CONCURRENCY).toBe('6'); expect(c.TICKERS).toBe('HYLB');
  expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
  expect(resolveControls({ TICKERS: 'ASHR' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
  expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '' }).CONCURRENCY).toBe('2');
  expect(resolveControls({ VERBOSE: true }, {}, {}, { VERBOSE: 'false' }).VERBOSE).toBe('false');
  expect(resolveControls({ MAX_FETCHES: 5 }, {}, {}, { MAX_FETCHES: '0' }).MAX_FETCHES).toBe('0');
  expect(resolveControls({ CONCURRENCY: 2 }, {}, {}, { CONCURRENCY: '  ' }).CONCURRENCY).toBe('2');
  expect(readConfig(resolveControls({ MAX_RETRIES: 0 })).maxRetries).toBe(0);
  expect(readConfig(resolveControls({ AUM: '1B:' })).aumRange).toMatchObject({ min: 1e9 });
});

test('safe resolver rejects unknown, invalid and environment-file injection values', () => {
  for (const value of [{ UNKNOWN: 1 }, { SEC_UA: 'x\nEVIL=yes' }, { CONCURRENCY: 0 }, { MAX_RETRIES: -1 }, { MAX_FETCHES: 1.5 }, { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' }, { AUM: '1:2:3' }, { TER: '5:1' }, { TICKERS: ['ASHR'] }, { TICKERS: '../ASHR' }, null, []]) {
    expect(() => resolveControls(value)).toThrow();
  }
  expect(() => resolveControls({}, { SEC_UA: 'x\rfoo' })).toThrow();
  expect(() => resolveControls({}, {}, {}, { SEC_UA: 'x\0bad' })).toThrow();
  expect(() => resolveControls({}, {}, { TICKERS: { a: 1 } })).toThrow();
  expect(() => resolveControls({}, 'x')).toThrow();
  expect(() => resolveControls({}, { OUTPUT_DIR: '/tmp' })).toThrow();
});

test('runtimeControls reads the checked-in file and lets nonblank environment values win', async () => {
  expect(await runtimeControls({})).toEqual(Object.fromEntries(Object.entries(configFile()).map(([k, v]) => [k, String(v)])));
  expect((await runtimeControls({ CONCURRENCY: '1', REQUEST_SLEEP: '0', TICKERS: 'ASHR' })).CONCURRENCY).toBe('1');
  await expect(runtimeControls({ CONCURRENCY: '0' })).rejects.toThrow('CONCURRENCY');
});

test('config keys == CONTROL_NAMES == help == README rows; Xtrackers defaults', async () => {
  const file = configFile();
  expect(Object.keys(file).sort()).toEqual([...CONTROL_NAMES].sort());
  expect(Object.values(file).every(value => typeof value === 'string')).toBe(true);
  const config = readConfig(resolveControls(file));
  expect(config.tickers.size).toBe(0); expect(config.maxFetches).toBe(0); expect(config.requestSleepSeconds).toBe(1.5); expect(config.concurrency).toBe(2);
  expect(config.holdingsPageSize).toBe(250); expect(config.historyPageSize).toBe(1000); expect(config.maxRetries).toBe(2); expect(config.verbose).toBe(false);
  const doc = read('README.md');
  // README lists each of the PERFORMANCE_* / TOTAL_RETURN_* tenors as its own row; every control name must have a row.
  const documented = [...doc.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|/gm)].map(match => match[1]);
  expect(documented.sort()).toEqual([...CONTROL_NAMES].sort());
  expect(doc).toContain('scripts/update-data.config.json');
  const command = Bun.spawn([process.execPath, 'scripts/update-data.ts', '--help'], { cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe' });
  const help = await new Response(command.stdout).text(); expect(await command.exited).toBe(0);
  for (const name of CONTROL_NAMES) expect(help).toContain(`${name}=`);
});

test('scheduled path (empty inputs and advanced) equals config defaults; no personal contact in defaults', () => {
  const file = configFile();
  expect(resolveControls(file, {}, {}, {})).toEqual(file);
  expect(file.SEC_UA).not.toMatch(/@/); expect(file.SEC_UA).toContain('https://github.com/daggerok/Xtrackers');
  expect(readConfig(resolveControls(file)).secUa).toBe(file.SEC_UA);
});

test('protected SEC_UA variable wins only when nonblank', () => {
  const file = configFile();
  expect(resolveControls(file, { SEC_UA: 'adv' }, { SEC_UA: 'in' }, { SEC_UA: 'protected' }).SEC_UA).toBe('protected');
  expect(resolveControls(file, { SEC_UA: 'adv' }, { SEC_UA: 'in' }, {}).SEC_UA).toBe('in');
  expect(resolveControls(file, { SEC_UA: 'adv' }, {}, {}).SEC_UA).toBe('adv');
});

test('workflow: <= 25 inputs, advanced, every input is a control, fixed api/xtrackers output, no direct input interpolation', () => {
  const actual = read('.github/workflows/update-data.yml');
  const workflow = Bun.YAML.parse(actual) as any;
  const inputs = Object.keys(workflow.on.workflow_dispatch.inputs);
  expect(inputs.length).toBeLessThanOrEqual(25); expect(inputs).toContain('advanced');
  expect(workflow.on.workflow_dispatch.inputs.advanced.default).toBe('{}');
  for (const name of inputs.filter(n => n !== 'advanced')) expect(CONTROL_NAMES).toContain(name.toUpperCase() as never);
  expect(workflow.on.schedule[0].cron).toBe('0 0 * * 0');
  expect(actual).toContain('PROTECTED_SEC_UA: ${{ vars.SEC_UA }}');
  expect(actual).toContain('resolveControls(file, advanced, individual, protectedVars)');
  expect(actual).toContain('toJSON(inputs)');
  expect(actual).not.toMatch(/\$\{\{\s*(github\.event\.)?inputs\./);
  expect(actual).not.toMatch(/OUTPUT_DIR|output_dir/i);
  expect(actual.match(/git add (\S+)/g)).toEqual(['git add api/xtrackers']);
  expect(actual.match(/api\/[\w-]+/g)!.every(path => path === 'api/xtrackers')).toBe(true);
  expect(actual).toContain('if: ${{ !cancelled() }}');
});
