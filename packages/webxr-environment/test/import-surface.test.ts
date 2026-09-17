/**
 * Architectural gate, every published package: a name imported from a
 * dependency must be one that dependency exports itself, and every imported
 * package must be declared.
 *
 * Three.js maths imported through `@iwsdk/core` (which does
 * `export * from 'three'`) is the case that shipped. It resolves in node, in
 * TypeScript and in every demo, and fails the first consumer whose Vite config
 * excludes `three` from dependency optimization: esbuild cannot enumerate a
 * star re-export it is not bundling, and the error names the wrong package.
 * The rule and its reasons live in scripts/import-surface.mjs, which is
 * identical in every Reality Collective TypeScript repository; this test only
 * points it at the packages release.config.json publishes. It imports nothing
 * from node itself, so it type-checks in packages that keep node's typings out.
 */
import { describe, expect, it } from 'vitest';
import { releasePackageReport, type ReleasePackageEntry } from '../../../scripts/import-surface.mjs';

const report = releasePackageReport(import.meta.url);

describe.each(report.map((entry): [string, ReleasePackageEntry] => [entry.name, entry]))('%s', (_name, entry) => {
  it('imports only names its dependencies export themselves, from packages it declares', () => {
    expect(entry.violations).toEqual([]);
  });
});
