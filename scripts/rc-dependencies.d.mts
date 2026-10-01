export interface ParsedVersion {
  /** Major, minor and patch. */
  readonly core: [number, number, number];
  /** Prerelease identifiers, empty for a release. */
  readonly pre: string[];
}

/** npm's document for a package: its dist-tags and the versions it has published. */
export interface RegistryDocument {
  readonly 'dist-tags'?: Record<string, string>;
  readonly versions?: Record<string, { readonly deprecated?: string } | undefined>;
}

export interface Manifest {
  /** Path of the package.json, relative to the repository root, with forward slashes. */
  readonly file: string;
  readonly json: Record<string, any>;
}

export interface LockFile {
  readonly packages?: Record<string, { readonly version?: string; readonly link?: boolean }>;
}

export type ViolationReason =
  | 'behind'
  | 'ahead'
  | 'no-release'
  | 'unpublished'
  | 'unreadable-range'
  | 'internal-prerelease'
  | 'lock'
  | 'lock-ahead'
  | 'second-copy';

export interface Violation {
  readonly file: string;
  readonly field?: string;
  readonly name: string;
  /** The range a manifest names, or the version the lockfile records. */
  readonly found: string;
  /** The range or version the rule asks for, when there is one. */
  readonly expected?: string;
  /** For a nested lockfile copy: the package that requires it. */
  readonly parent?: string | null;
  readonly reason: ViolationReason;
  /** True when `--fix` can resolve it in this repository. */
  readonly fixable: boolean;
}

export type Target = { readonly version: string; readonly error?: undefined } | { readonly version?: undefined; readonly error: 'unpublished' | 'no-release' };

export interface Report {
  readonly into: string;
  /** True when the change goes into main: npm's latest release, no previews. */
  readonly main: boolean;
  readonly targets: Record<string, Target>;
  readonly violations: Violation[];
}

export function parseVersion(version: string): ParsedVersion | null;
export function compareVersions(a: string, b: string): number;
export function rangeFloor(range: string): { operator: string; version: string } | null;
export function movedRange(range: string, version: string): string;
export function intoMain(branch: string | null | undefined): boolean;
export function targetVersion(meta: RegistryDocument | null, main: boolean): Target;
export function siblingNames(repository: { manifests: Manifest[]; lock: LockFile | null }): string[];
export function checkRcDependencies(input: {
  manifests: Manifest[];
  lock: LockFile | null;
  registry: Map<string, RegistryDocument | null>;
  into: string;
}): Report;
export function formatViolation(violation: Violation, report?: Pick<Report, 'main'>): string;
export function readRepository(root: string): { manifests: Manifest[]; lock: LockFile | null };
export function fetchRegistry(names: string[], registryUrl?: string): Promise<Map<string, RegistryDocument | null>>;
export function reportFor(root: string, into: string): Promise<Report>;
export function fixRepository(root: string, into: string): Promise<{ changed: string[]; report: Report }>;
