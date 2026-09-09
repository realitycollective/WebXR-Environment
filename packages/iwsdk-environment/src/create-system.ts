/**
 * `createSystem` from `@iwsdk/core`, with its return type written out.
 *
 * Why this file exists. IWSDK 0.5.3 declares `createSystem` in
 * `dist/ecs/system.d.ts` as returning `SystemConstructor<S, Q, World, System<S, Q>>`,
 * and that file imports `World` from './world' with no extension, the only
 * extensionless relative import in the package. This repository builds with
 * `moduleResolution: NodeNext`, under which an extensionless relative import
 * in an ES module does not resolve (TS2835), so inside the host's own
 * declaration `World` is an unresolved name. `skipLibCheck` hides the error,
 * and TypeScript's declaration emitter preserves an unresolved name verbatim,
 * so every `export class X extends createSystem(...)` in this package was
 * emitted with a bare `World` in its base type. A consumer that checks
 * library files (`skipLibCheck: false`, or a package emitting declarations on
 * top of ours) fails with TS2304 on its first import of this package. A file
 * that happened to import `World` for another signature resolved the bare
 * name by accident, which is how the sibling adapters looked clean.
 *
 * The annotation below names `World` through `@iwsdk/core`'s barrel, whose
 * imports all carry extensions, so the emitter writes
 * `import("@iwsdk/core").World` wherever the result is extended. Every system
 * in this package takes `createSystem` from here, never from `@iwsdk/core`.
 * `elics` is imported for its types only: it is `@iwsdk/core`'s own
 * dependency, the import is erased at build time, and the emitted
 * declarations already name `import("elics").SystemConstructor`.
 *
 * Delete this file, and import `createSystem` from `@iwsdk/core` again, once
 * IWSDK ships `./world.js` there. `scripts/declaration-check.mjs`, run by
 * `verify:pack`, is the check that fails while the bare name is emitted.
 */
import { createSystem as createIWSDKSystem, type System, type World } from "@iwsdk/core";
import type { SystemConstructor, SystemQueries, SystemSchema } from "elics";

export function createSystem<S extends SystemSchema, Q extends SystemQueries>(
  queries?: Q,
  schema?: S,
): SystemConstructor<S, Q, World, System<S, Q>> {
  return createIWSDKSystem(queries, schema);
}
