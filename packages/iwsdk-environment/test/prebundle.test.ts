/**
 * Consumer gate: this adapter must survive the dependency optimizer of every
 * bundler we support, in the shape an application gives it. Built output next
 * to `@iwsdk/core`, both as optimizer entries, including when the application
 * excludes from optimization every package `@iwsdk/core` re-exports wholesale
 * (three.js and IWSDK's own input and locomotion packages). An application
 * does that the day it needs to transform one of those packages' sources, and
 * on Vite 7 that is the day a name imported through a star re-export stops
 * resolving.
 *
 * Three assertions per bundler, and one across them:
 *   - the default run passes, which proves the harness actually ran;
 *   - the excluded run passes, which is the gate;
 *   - a deliberately broken copy is rejected, or not, exactly as
 *     `scripts/release.config.json` says it should be for that bundler. Vite 7
 *     rejects it (esbuild), Vite 8 does not (rolldown). Verifying the
 *     expectation both ways means a change in bundler strictness is reported
 *     rather than quietly turning this gate into decoration;
 *   - at least one supported bundler still rejects it, so we know the dynamic
 *     gate is worth something. If that ever fails, the static import-surface
 *     rule is the only remaining guard, which is the message it prints.
 *
 * The harness is scripts/prebundle-check.mjs, identical in every Reality
 * Collective repository that ships an engine adapter.
 */
import { describe, expect, it } from 'vitest';
import { prebundleCheck, prebundlePlan } from '../../../scripts/prebundle-check.mjs';

const plan = prebundlePlan(import.meta.url);

describe('consumer prebundle, per supported bundler', () => {
  it('has at least one bundler to test', () => {
    expect(plan.bundlers.length).toBeGreaterThan(0);
  });

  for (const bundler of plan.bundlers) {
    it(`${bundler.id}: prebundles next to ${plan.hostEntries.join(', ')}`, async () => {
      const result = await prebundleCheck({ ...plan, bundler });

      expect(result.control.errors, 'the harness itself must prebundle cleanly').toEqual([]);
      expect(
        result.excluded.errors,
        `${result.bundlerPackage}@${result.viteVersion} with ${result.exclude.join(', ')} excluded from optimization`,
      ).toEqual([]);

      if (result.canary.available) {
        expect(
          result.canary.detected,
          `${result.bundlerPackage}@${result.viteVersion} ${result.canary.detected ? 'now rejects' : 'no longer rejects'} '${result.canary.name}' imported through ${plan.hostEntries[0]}'s re-export of ${result.canary.via}. Set detectsStarHops to ${String(result.canary.detected)} for "${bundler.id}" in scripts/release.config.json.`,
        ).toBe(bundler.detectsStarHops);
      } else {
        // Nothing re-exports another package wholesale any more, so the fault
        // this gate exists for cannot be constructed.
        expect(result.canary.detected).toBeNull();
      }
    }, 240_000);
  }

  it('at least one supported bundler still rejects a star-hop import', () => {
    expect(
      plan.bundlers.some((bundler) => bundler.detectsStarHops),
      'No supported bundler can detect a name imported through another package\'s export *. This gate can no longer fail, so packages/<core>/test/import-surface.test.ts is the only thing guarding it. Either keep a strict bundler in the matrix or accept the static rule as the sole guard.',
    ).toBe(true);
  });
});
