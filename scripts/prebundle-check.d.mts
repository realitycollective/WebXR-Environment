export interface OptimizerRun {
  readonly ok: boolean;
  /** The bundler's error lines, deduplicated, with colour codes removed. Empty when ok. */
  readonly errors: readonly string[];
}

/** One bundler to test, as declared in scripts/release.config.json. */
export interface BundlerTarget {
  /** Short id used in test names and cache paths, e.g. "vite7". */
  readonly id: string;
  /** Installed package (npm alias) to import Vite from, e.g. "vite-7". */
  readonly package: string;
  /**
   * Whether this bundler is expected to REJECT a name imported through another
   * package's `export *`. Verified on every run: a mismatch in either
   * direction fails, so a change in bundler strictness is reported rather than
   * silently making the gate decorative.
   */
  readonly detectsStarHops: boolean;
}

/** The deliberately broken twin, and what the bundler made of it. */
export interface CanaryResult {
  /** False when the host re-exports nothing wholesale, so there is no hazard to probe. */
  readonly available: boolean;
  /** Whether the bundler rejected the broken import. `null` when unavailable. */
  readonly detected: boolean | null;
  /** The package the probed name really comes from, e.g. "three". */
  readonly via: string | null;
  /** The probed name, e.g. "Vector3". */
  readonly name: string | null;
  readonly errors: readonly string[];
}

export interface PrebundleCheckOptions {
  /** The repository root, which holds node_modules and packages/. */
  readonly repoRoot: string;
  /** The package under test. */
  readonly packageDir: string;
  /** Packages the application imports directly, so they are optimizer entries too. */
  readonly hostEntries: readonly string[];
  /** The bundler to load and run. */
  readonly bundler: BundlerTarget;
  /** Packages to exclude from optimization. Defaults to every package the hosts re-export wholesale. */
  readonly exclude?: readonly string[];
}

export interface PrebundleCheckResult {
  readonly bundler: string;
  readonly bundlerPackage: string;
  /** The resolved version behind the alias, e.g. "7.3.6". */
  readonly viteVersion: string;
  /** The exclusion list the excluded and canary runs used. */
  readonly exclude: readonly string[];
  /** Packages the host entries re-export wholesale. */
  readonly stars: readonly string[];
  /** Default optimizer settings. Must pass; proves the harness runs. */
  readonly control: OptimizerRun;
  /** With `exclude` external to the optimizer. The gate. */
  readonly excluded: OptimizerRun;
  /** The broken twin, which proves the gate can still fail. */
  readonly canary: CanaryResult;
}

export interface PrebundlePlan {
  readonly repoRoot: string;
  readonly packageDir: string;
  readonly hostEntries: readonly string[];
  readonly bundlers: readonly BundlerTarget[];
}

export function prebundleCheck(options: PrebundleCheckOptions): Promise<PrebundleCheckResult>;

/** The plan for the package a test file sits in, from scripts/release.config.json. */
export function prebundlePlan(fromUrl: string): PrebundlePlan;
