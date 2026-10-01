/**
 * The Reality Collective dependency rule, from scripts/rc-dependencies.mjs, which is identical in
 * every Reality Collective TypeScript repository: a dependency on a package published from
 * ANOTHER repository names npm's latest release going into main, and the newest version on npm,
 * release or preview, going anywhere else. CI runs the script against the real registry; these
 * cases drive the rule with a registry held in memory, so each one shows the check passing what
 * it should and failing what it exists for. It imports nothing from node itself.
 */
import { describe, expect, it } from 'vitest';
import {
  checkRcDependencies,
  compareVersions,
  formatViolation,
  intoMain,
  movedRange,
  rangeFloor,
  siblingNames,
  targetVersion,
  type LockFile,
  type Manifest,
  type RegistryDocument,
} from '../../../scripts/rc-dependencies.mjs';

const INPUT = '@realitycollective/webxr-input';
const NATIVE = '@realitycollective/native-thing';
const OURS = '@realitycollective/our-core';

// Input as npm serves it: 0.1.8 released and tagged latest, two newer previews, and a third
// newer preview that was deprecated, which must never become a target.
const registry = new Map<string, RegistryDocument | null>([
  [
    INPUT,
    {
      'dist-tags': { latest: '0.1.8', preview: '0.1.9-preview.1' },
      versions: {
        '0.1.7': {},
        '0.1.8': {},
        '0.1.9-preview.0': {},
        '0.1.9-preview.1': {},
        '0.1.9-preview.2': { deprecated: 'broken build' },
      },
    },
  ],
  // Only ever published as a preview, so npm points `latest` at one.
  [NATIVE, { 'dist-tags': { latest: '0.1.1-preview.0' }, versions: { '0.1.1-preview.0': {}, '0.1.1-preview.1': {} } }],
]);

const ours = (deps: Record<string, string>, extra: Record<string, unknown> = {}): Manifest => ({
  file: 'packages/our-adapter/package.json',
  json: { name: '@realitycollective/our-adapter', dependencies: deps, ...extra },
});
const core: Manifest = { file: 'packages/our-core/package.json', json: { name: OURS } };

const check = (manifests: Manifest[], into: string, lock: LockFile | null = null) =>
  checkRcDependencies({ manifests: [core, ...manifests], lock, registry, into });
const reasons = (report: ReturnType<typeof check>) => report.violations.map((v) => `${v.name} ${v.reason}`);

describe('versions', () => {
  it('orders a release after its own previews and previews numerically', () => {
    expect(compareVersions('0.1.8', '0.1.8-preview.0')).toBeGreaterThan(0);
    expect(compareVersions('0.1.9-preview.10', '0.1.9-preview.2')).toBeGreaterThan(0);
    expect(compareVersions('0.1.9-preview.0', '0.1.8')).toBeGreaterThan(0);
    expect(compareVersions('1.0.2', '1.0.2')).toBe(0);
    expect(() => compareVersions('1.x', '1.0.0')).toThrow(/not a version/);
  });

  it('reads the lowest version from the range forms a sibling dependency uses, and nothing else', () => {
    expect(rangeFloor('^0.1.8')).toEqual({ operator: '^', version: '0.1.8' });
    expect(rangeFloor('0.1.1-preview.2')).toEqual({ operator: '', version: '0.1.1-preview.2' });
    expect(rangeFloor('>=1.0.0')).toEqual({ operator: '>=', version: '1.0.0' });
    for (const range of ['*', '1.x', '>=0.1.8 <0.2.0', 'workspace:*', '^0.1.8 || ^0.2.0']) expect(rangeFloor(range)).toBeNull();
    expect(movedRange('^0.1.8-preview.0', '0.1.8')).toBe('^0.1.8');
    expect(movedRange('0.1.7', '0.1.8')).toBe('0.1.8');
    expect(() => movedRange('*', '0.1.8')).toThrow();
  });

  it('applies the main rule only to main', () => {
    expect(intoMain('main')).toBe(true);
    expect(intoMain('refs/heads/main')).toBe(true);
    for (const branch of ['development', 'feature/main-menu', 'release/0.1.1', '', undefined]) expect(intoMain(branch)).toBe(false);
  });
});

describe('targets', () => {
  it('into main: the release npm tags latest', () => {
    expect(targetVersion(registry.get(INPUT)!, true)).toEqual({ version: '0.1.8' });
  });

  it('elsewhere: the newest version on npm, a preview when one is newer, never a deprecated one', () => {
    expect(targetVersion(registry.get(INPUT)!, false)).toEqual({ version: '0.1.9-preview.1' });
    expect(targetVersion({ 'dist-tags': { latest: '0.2.0' }, versions: { '0.1.9-preview.0': {}, '0.2.0': {} } }, false)).toEqual({ version: '0.2.0' });
  });

  it('into main, a package npm has never released has no target', () => {
    expect(targetVersion(registry.get(NATIVE)!, true)).toEqual({ error: 'no-release' });
    expect(targetVersion(null, true)).toEqual({ error: 'unpublished' });
    expect(targetVersion(null, false)).toEqual({ error: 'unpublished' });
  });
});

describe('into main: npm latest release, no previews', () => {
  it('passes a range on the latest release', () => {
    expect(check([ours({ [INPUT]: '^0.1.8' })], 'main').violations).toEqual([]);
  });

  it('fails a preview of the released version, and can move it', () => {
    const report = check([ours({ [INPUT]: '^0.1.8-preview.0' })], 'main');
    expect(report.violations).toMatchObject([{ name: INPUT, reason: 'behind', expected: '^0.1.8', fixable: true }]);
  });

  it('fails a range behind the latest release', () => {
    expect(check([ours({ [INPUT]: '^0.1.7' })], 'main').violations).toMatchObject([{ reason: 'behind', expected: '^0.1.8' }]);
  });

  it('fails a preview newer than the release, and cannot move it: that repository releases first', () => {
    const report = check([ours({ [INPUT]: '^0.1.9-preview.0' })], 'main');
    expect(report.violations).toMatchObject([{ reason: 'ahead', fixable: false }]);
    expect(formatViolation(report.violations[0]!, report)).toMatch(/not released.*Release @realitycollective\/webxr-input first/);
  });

  it('fails a package npm has only previews of', () => {
    expect(check([ours({ [NATIVE]: '0.1.1-preview.1' })], 'main').violations).toMatchObject([{ reason: 'no-release', fixable: false }]);
  });

  it('fails a range in a demo as much as one in a published package', () => {
    const demo: Manifest = { file: 'demos/playground/package.json', json: { name: 'playground', private: true, dependencies: { [INPUT]: '0.1.9-preview.1' } } };
    expect(check([demo], 'main').violations).toMatchObject([{ file: 'demos/playground/package.json', reason: 'ahead' }]);
  });

  it('fails a package of this repository still ranged at a preview, but passes the workspace wildcard', () => {
    expect(reasons(check([ours({ [OURS]: '^0.1.1-preview.4' })], 'main'))).toEqual([`${OURS} internal-prerelease`]);
    expect(check([ours({ [OURS]: '^0.1.1' }), ours({ [OURS]: '*' })], 'main').violations).toEqual([]);
  });
});

describe('elsewhere: the newest version on npm', () => {
  it('passes the newest preview', () => {
    expect(check([ours({ [INPUT]: '^0.1.9-preview.1' })], 'development').violations).toEqual([]);
  });

  it('fails the latest release when a newer preview exists', () => {
    expect(check([ours({ [INPUT]: '^0.1.8' })], 'development').violations).toMatchObject([{ reason: 'behind', expected: '^0.1.9-preview.1', fixable: true }]);
  });

  it('treats a pull request into a feature branch like development', () => {
    expect(check([ours({ [INPUT]: '^0.1.8' })], 'feature/x').violations).toMatchObject([{ reason: 'behind' }]);
  });

  it('leaves a package of this repository at its preview alone', () => {
    expect(check([ours({ [OURS]: '^0.1.1-preview.4' })], 'development').violations).toEqual([]);
  });

  it('fails a range newer than anything on npm', () => {
    expect(check([ours({ [INPUT]: '^0.2.0' })], 'development').violations).toMatchObject([{ reason: 'ahead', fixable: false }]);
  });
});

describe('every case', () => {
  it('ignores dependencies outside the Reality Collective scope, whatever their range', () => {
    expect(check([ours({ three: 'npm:super-three@0.181.0', xrblocks: '^0.21.1', lit: '*' })], 'main').violations).toEqual([]);
  });

  it('reads every dependency field', () => {
    const manifest = ours({}, { devDependencies: { [INPUT]: '^0.1.7' }, peerDependencies: { [INPUT]: '>=0.1.7' }, optionalDependencies: { [INPUT]: '0.1.7' } });
    expect(check([manifest], 'main').violations.map((v) => v.field)).toEqual(['devDependencies', 'optionalDependencies', 'peerDependencies']);
  });

  it('fails a range it cannot read one lowest version from', () => {
    expect(check([ours({ [INPUT]: '>=0.1.8 <0.2.0' })], 'main').violations).toMatchObject([{ reason: 'unreadable-range', fixable: false }]);
  });

  it('fails a package npm does not have', () => {
    expect(check([ours({ '@realitycollective/never-published': '^1.0.0' })], 'development').violations).toMatchObject([{ reason: 'unpublished' }]);
  });

  it('names only packages from other repositories as the ones to look up', () => {
    const lock: LockFile = { packages: { 'node_modules/@realitycollective/other': { version: '1.0.0' } } };
    expect(siblingNames({ manifests: [core, ours({ [INPUT]: '^0.1.8', [OURS]: '*', three: '0.1.0' })], lock })).toEqual(['@realitycollective/other', INPUT]);
  });
});

describe('the lockfile', () => {
  const lock = (packages: NonNullable<LockFile['packages']>): LockFile => ({ packages: { '': {}, ...packages } });

  it('passes a copy on the target and skips workspace links and this repository own packages', () => {
    const l = lock({
      [`node_modules/${INPUT}`]: { version: '0.1.8' },
      [`node_modules/${OURS}`]: { version: '0.0.1', link: true },
      'node_modules/@realitycollective/our-adapter': { version: '0.0.1' },
      'node_modules/three': { version: '0.1.0' },
    });
    expect(check([ours({ [INPUT]: '^0.1.8' })], 'main', l).violations).toEqual([]);
  });

  it('fails a copy behind the target, which regenerating the lockfile fixes', () => {
    const l = lock({ [`node_modules/${INPUT}`]: { version: '0.1.7' } });
    expect(check([ours({ [INPUT]: '^0.1.8' })], 'main', l).violations).toMatchObject([{ file: 'package-lock.json', reason: 'lock', fixable: true }]);
  });

  it('fails a nested second copy and names the package that requires it', () => {
    const l = lock({
      [`node_modules/${INPUT}`]: { version: '0.1.8' },
      [`node_modules/@realitycollective/old-sibling/node_modules/${INPUT}`]: { version: '0.1.4' },
    });
    const report = check([ours({ [INPUT]: '^0.1.8' })], 'main', l);
    expect(report.violations).toMatchObject([{ reason: 'second-copy', parent: '@realitycollective/old-sibling', fixable: false }]);
    expect(formatViolation(report.violations[0]!, report)).toMatch(/required by @realitycollective\/old-sibling/);
  });

  it('reports a copy ahead of the target as following its range, not as fixable on its own', () => {
    const l = lock({ [`node_modules/${INPUT}`]: { version: '0.1.9-preview.0' } });
    expect(reasons(check([ours({ [INPUT]: '^0.1.9-preview.0' })], 'main', l))).toEqual([`${INPUT} ahead`, `${INPUT} lock-ahead`]);
  });
});
