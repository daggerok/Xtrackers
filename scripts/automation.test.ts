/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { CONTROL_DEFAULTS, readConfig, outputConfigEntries, record, array } from './update-data';

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
  test('all 23 defaults and input/env mappings agree, with no undocumented skip switches', async () => {
    const workflow = await yaml('.github/workflows/update-data.yml');
    const inputs = record(record(record(workflow.on).workflow_dispatch).inputs);
    expect(Object.keys(inputs).length).toBe(23); expect(Object.keys(inputs).length).toBeLessThanOrEqual(25);
    expect(Object.keys(inputs).map(key => key.toUpperCase()).sort()).toEqual(Object.keys(CONTROL_DEFAULTS).sort());
    for (const [key, value] of Object.entries(CONTROL_DEFAULTS)) expect(String(record(inputs[key.toLowerCase()]).default)).toBe(value);
    const steps = array(record(record(workflow.jobs).update).steps).map(record);
    const refresh = steps.find(step => step.id === 'refresh'); expect(refresh).toBeDefined();
    const env = record(refresh?.env);
    expect(Object.keys(env).sort()).toEqual(Object.keys(CONTROL_DEFAULTS).sort());
    for (const key of Object.keys(CONTROL_DEFAULTS)) expect(env[key]).toBe(`\${{ inputs.${key.toLowerCase()} || '' }}`);
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
  test('weekly/manual trigger, scoped commit, retained-data handling and credential hygiene are configured', async () => {
    const workflow = await yaml('.github/workflows/update-data.yml');
    expect(record(array(record(workflow.on).schedule)[0]).cron).toBe('0 0 * * 0');
    expect(record(workflow.on).workflow_dispatch).toBeDefined();
    const steps = array(record(record(workflow.jobs).update).steps).map(record);
    const checkout = steps.find(step => step.uses === 'actions/checkout@v6'); expect(record(checkout?.with)['persist-credentials']).toBe(false);
    const refresh = steps.find(step => step.id === 'refresh'); expect(refresh?.['continue-on-error']).toBe(true);
    expect(steps.some(step => step.if === "steps.refresh.outcome == 'failure'" && String(step.run).includes('exit 1'))).toBe(true);
    const source = await read('.github/workflows/update-data.yml');
    expect(source).toContain('git add api/xtrackers'); expect(source).not.toContain('git add .'); expect(source).not.toContain('--force');
    expect(source).toContain("<<'ASKPASS'"); expect(source).toContain('persist-credentials: false');
    expect(source).not.toContain('extraheader'); expect(source).not.toContain('git config credential');
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

describe('pinned README family parity', () => {
  test('common headings/feature introduction/Bun commands/TypeScript wording retained; deployment caveat truthful', async () => {
    const text = await read('README.md');
    const ref = JSON.parse(await read('research/2026-10-01/readme-reference.json'));
    expect(text.startsWith('# Xtrackers\n')).toBe(true);
    expect(headings(text).map(line => line.replaceAll('Xtrackers', 'JPMorgan'))).toEqual(ref.headings);
    const intro = text.split('\n\n')[1];
    expect(intro.split('A single-file client-side tool')[0]).toBe(ref.referenceIntro.replaceAll('JPMorgan', 'Xtrackers').split('A single-file client-side tool')[0]);
    expect(intro.split(') into a searchable')[1]).toBe(ref.referenceIntro.split(') into a searchable')[1]);
    const using = text.split('## Using Bun\n\n')[1].split('```')[1];
    expect(using).toBe(ref.usingBunBlock.replaceAll('JPMorgan', 'Xtrackers'));
    expect(text.split('## TypeScript\n\n')[1].split('\n\n')[0]).toBe(ref.commonTypeScriptParagraph);
    expect(text).toContain('Deployment is pending'); expect(text).not.toContain('The published application is available');
    expect(text).toContain('SEC endpoints returned HTTP 403'); expect(text).toContain('39 catalog-only');
    expect(text).toContain('not published standardized NAV returns');
  });
  test('all existing 20 brand + 20 sibling rows are unchanged, plus alphabetically placed Xtrackers rows', async () => {
    const text = await read('README.md'), ref = JSON.parse(await read('research/2026-10-01/readme-reference.json'));
    const brands = text.split('## Brands table')[1].split('## Sibling applications')[0].split('\n').filter(line => line.startsWith('| **'));
    const siblings = text.split('## Sibling applications')[1].split('## License')[0].split('\n').filter(line => line.startsWith('| ') && !line.startsWith('| Application') && !line.startsWith('| ---'));
    expect(brands.slice(0, -1)).toEqual(ref.brandRows); expect(siblings.slice(0, -1)).toEqual(ref.siblingRows);
    expect(brands).toHaveLength(21); expect(siblings).toHaveLength(21);
    expect(brands.at(-1)).toContain('**Xtrackers**'); expect(siblings.at(-1)).toContain('Xtrackers');
    const names = (rows: string[]) => rows.map(row => row.split('|')[1].replaceAll('*', '').trim().toLowerCase());
    expect(names(brands)).toEqual([...names(brands)].sort()); expect(names(siblings)).toEqual([...names(siblings)].sort());
  });
});
