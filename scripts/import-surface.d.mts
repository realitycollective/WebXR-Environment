export interface ModuleSurface {
  /** Names the module defines itself, following its own relative `export *` chains. */
  readonly names: Set<string>;
  /** Packages the module re-exports wholesale with `export * from '<package>'`. */
  readonly externalStars: Set<string>;
  /** True when the module is CommonJS, whose surface cannot be read statically. */
  readonly cjs: boolean;
}

export interface ResolvedEntry {
  readonly packageName: string;
  readonly packageDir?: string;
  readonly entryFile?: string;
  readonly manifest?: Record<string, unknown>;
  /** Present when the entry could not be resolved. */
  readonly reason?: string;
}

export type ViolationKind = 'star-hop' | 'missing' | 'undeclared' | 'unresolvable';

export interface ImportViolation {
  readonly kind: ViolationKind;
  readonly file: string;
  readonly line: number;
  readonly name: string | null;
  readonly specifier: string;
  readonly packageName: string;
  readonly via: readonly string[];
  readonly reason?: string;
}

export interface ImportSurfaceOptions {
  /** Exceptions as `"<specifier>:<name>"`. Keep empty unless a dependency leaves no honest import path. */
  readonly allow?: readonly string[];
}

export function packageNameOf(specifier: string): string;
export function isBareSpecifier(specifier: string): boolean;
export function resolveEntry(specifier: string, fromDir: string): ResolvedEntry;
export function moduleSurface(file: string, seen?: Set<string>): ModuleSurface;
export function packageImportViolations(packageDir: string, options?: ImportSurfaceOptions): ImportViolation[];
export function formatViolation(violation: ImportViolation, relativeTo?: string): string;

export interface ReleasePackageEntry {
  readonly name: string;
  readonly packageDir: string;
  /** Formatted violations, relative to the repository root. Empty when the package passes. */
  readonly violations: readonly string[];
}

/** Every package scripts/release.config.json publishes, found by walking up from `fromUrl`. */
export function releasePackageReport(fromUrl: string): ReleasePackageEntry[];
