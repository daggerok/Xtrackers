/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { CONTROL_DEFAULTS, CONTROL_NAMES, readConfig, outputConfigEntries, record, array } from './update-data';

const read = (path: string) => Bun.file(new URL('../' + path, import.meta.url)).text();
const yaml = async (path: string) => record(Bun.YAML.parse(await read(path)));
function headings(text: string): string[] {
  let fenced = false;
  return text.split('\n').flatMap(line => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return []; }
    return !fenced && /^#{2,3} /.test(line) ? [line] : [];
  });
}

describe('automation/config/help/documentation contract (offline)', () => {
  test('JSON controls have blank optional string inputs, job ENV mapping and truthful help/docs', async () => {
    const workflow = await yaml('.github/workflows/update-data.yml');
    const inputs = record(record(record(workflow.on).workflow_dispatch).inputs);
    expect(Object.keys(inputs).length).toBe(24); expect(Object.keys(inputs).length).toBeLessThanOrEqual(25);
    expect(Object.keys(inputs).filter(key => key !== 'advanced').map(key => key.toUpperCase()).sort()).toEqual([...CONTROL_NAMES].sort());
    expect(JSON.parse(await read('scripts/update-data.config.json'))).toEqual(CONTROL_DEFAULTS);
    for (const [key, value] of Object.entries(inputs)) {
      const input = record(value);
      expect(input.default).toBe(key === 'advanced' ? '{}' : ''); expect(input.type).toBe('string'); expect(input.required).toBe(false);
    }
    const job = record(record(workflow.jobs)['update-data']), steps = array(job.steps).map(record);
    const refresh = steps.find(step => step.run === 'bun ./scripts/update-data.ts'); expect(refresh).toBeDefined(); expect(refresh?.env).toBeUndefined();
    expect(job.env).toBeUndefined();
    expect(outputConfigEntries(readConfig({})).map(([key]) => key).sort()).toEqual(Object.keys(CONTROL_DEFAULTS).sort());
    const command = Bun.spawn([process.execPath, 'scripts/update-data.ts', '--help'], { cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe' });
    const help = await new Response(command.stdout).text(); expect(await command.exited).toBe(0);
    for (const [key, value] of Object.entries(CONTROL_DEFAULTS)) expect(help).toContain(`${key}=${value || 'all'}`);
    const readme = await read('README.md');
    const documented = [...readme.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|/gm)].map(match => match[1]).sort();
    expect(documented).toEqual(Object.keys(CONTROL_DEFAULTS).sort());
    for (const text of [readme, help, await read('.github/workflows/update-data.yml')]) {
      expect(text).not.toContain('SKIP_YAHOO'); expect(text).not.toContain('HISTORY_RANGE'); expect(text).not.toContain('EDGAR_FALLBACK');
    }
  });
  test('weekly/manual step order, fail-before-push, api-only conditional commit', async () => {
    const workflow = await yaml('.github/workflows/update-data.yml');
    expect(record(array(record(workflow.on).schedule)[0]).cron).toBe('0 0 * * 0');
    expect(record(workflow.on).workflow_dispatch).toBeDefined();
    const steps = array(record(record(workflow.jobs)['update-data']).steps).map(record);
    expect(steps.map(step => step.uses || step.name)).toEqual([
      'actions/checkout@v7', 'oven-sh/setup-bun@v2', 'Install dependencies', 'Run updater unit tests', 'Resolve file defaults and manual overrides',
      'Generate api/xtrackers static data', 'Commit updated data',
    ]);
    expect(steps[2].run).toBe('bun install --frozen-lockfile'); expect(steps[3].run).toBe('bun test');
    expect(record(workflow.permissions).contents).toBe('write');
    expect(record(workflow.concurrency)).toEqual({ group: 'update-data', 'cancel-in-progress': false });
    expect(String(steps[6].run)).toContain('git diff --cached --quiet -- api/xtrackers');
    const source = await read('.github/workflows/update-data.yml');
    expect(source).toContain('git add api/xtrackers'); expect(source).not.toContain('git add .'); expect(source).not.toContain('--force');
    expect(source).not.toContain('pull_request'); expect(source).not.toContain('STORE_RAW_DOWNLOADS');
    const readme = await read('README.md'); expect(readme).toContain('nonblank'); expect(readme).toContain('GITHUB_STEP_SUMMARY');
  });
  test('Pages is main-only and stages public app/feed, not logs, tooling, credentials or research', async () => {
    const pages = await yaml('.github/workflows/pages.yml');
    const job = record(record(pages.jobs).deploy);
    expect(String(job.if)).toContain("github.ref == 'refs/heads/main'");
    expect(String(job.if)).toContain("github.event.workflow_run.head_branch == 'main'");
    const source = await read('.github/workflows/pages.yml');
    expect(source).toContain('cp index.html app.tsx favicon.ico _site/'); expect(source).toContain('cp -R api/xtrackers _site/api/');
    expect(source).not.toContain('cp -R . ');
    const dependabot = await yaml('.github/dependabot.yml');
    expect(array(dependabot.updates).map(item => record(item)['package-ecosystem']).sort()).toEqual(['bun', 'github-actions']);
    expect(array(dependabot.updates).every(item => record(record(item).schedule).interval === 'monthly')).toBe(true);
    for (const file of ['ci.yml', 'pages.yml']) {
      const jobs = record((await yaml('.github/workflows/' + file)).jobs);
      for (const job of Object.values(jobs).map(record)) {
        const steps = array(job.steps).map(record);
        const checkout = steps.find(step => step.uses === 'actions/checkout@v7'); expect(checkout).toBeDefined();
        expect(record(checkout?.with)['persist-credentials']).toBe(false);
        expect(steps.find(step => step.uses === 'oven-sh/setup-bun@v2')?.with).toBeUndefined();
      }
    }
    const ci = await read('.github/workflows/ci.yml');
    for (const check of ['bun install --frozen-lockfile', 'bun test', 'bun build --target=bun scripts/update-data.ts', 'bun build app.tsx', 'git diff --check']) expect(ci).toContain(check);
  });
  test('Bun-only package has zero runtime deps and exactly two pinned types-only dev dependencies', async () => {
    const pkg = JSON.parse(await read('package.json'));
    expect(pkg.dependencies).toEqual({});
    expect(pkg.devDependencies).toEqual({ '@types/bun': '1.4.2', '@types/node': '26.6.2' });
    expect(await Bun.file(new URL('../tsconfig.json', import.meta.url)).exists()).toBe(false);
    expect(pkg.scripts.test).toBe('bun test'); expect(pkg.scripts.update).toBe('bun scripts/update-data.ts');
  });
});

describe('README structure and retained facts', () => {
  test('standard sections in order; deployment caveat and data caveats truthful', async () => {
    const text = await read('README.md');
    expect(text.startsWith('# Xtrackers\n')).toBe(true);
    const order = ['## Using Bun', '## Updating the static Xtrackers data', '### Data sources', '### Metrics and caveats', '### Update controls', '### Examples', '## TypeScript and verification', '## Brands table', '## Sibling applications', '## License'];
    const found = headings(text);
    expect(order.every(heading => found.includes(heading))).toBe(true);
    expect(order.map(heading => found.indexOf(heading))).toEqual([...order.map(heading => found.indexOf(heading))].sort((a, b) => a - b));
    expect(text).toContain('Deployment is pending'); expect(text).not.toContain('The published application is available');
    expect(text).toContain('SEC endpoints returned HTTP 403'); expect(text).toContain('39 catalog-only');
    expect(text).toContain('not published standardized NAV returns');
  });
  test('shared brand and sibling tables have equal row counts and an Xtrackers row', async () => {
    const text = await read('README.md');
    const brands = text.split('## Brands table')[1].split('## Sibling applications')[0].split('\n').filter(line => line.startsWith('| **'));
    const siblings = text.split('## Sibling applications')[1].split('## License')[0].split('\n').filter(line => line.startsWith('| ') && !line.startsWith('| Application') && !line.startsWith('| ---'));
    expect(brands.length).toBe(siblings.length); expect(brands.length).toBeGreaterThanOrEqual(21);
    expect(brands.some(row => row.includes('**Xtrackers**'))).toBe(true); expect(siblings.some(row => row.startsWith('| Xtrackers |'))).toBe(true);
  });
});
