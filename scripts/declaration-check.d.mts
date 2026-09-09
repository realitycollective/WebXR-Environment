/** The consumer module resolution modes the check compiles under. */
export type DeclarationResolution = 'nodenext' | 'bundler';

/** The modes checked by default, in the order they are reported. */
export const RESOLUTION_MODES: readonly DeclarationResolution[];

export interface DeclarationDiagnostic {
  /** Relative to the package directory, forward slashes. Empty for a diagnostic with no file. */
  readonly file: string;
  readonly line: number;
  readonly column: number;
  /** The TypeScript error number, e.g. 2304. */
  readonly code: number;
  readonly message: string;
}

export interface DeclarationPackageResult {
  /** The package directory name, e.g. "iwsdk-uiextensions". */
  readonly name: string;
  /** The manifest name, e.g. "@realitycollective/iwsdk-uiextensions". */
  readonly packageName: string;
  readonly dir: string;
  /** The declaration entry checked, relative to the package directory. */
  readonly entry: string;
  /** Diagnostics inside the package directory. Empty when the package passes. */
  readonly diagnostics: readonly DeclarationDiagnostic[];
}

export interface DeclarationModeResult {
  readonly moduleResolution: DeclarationResolution;
  readonly packages: readonly DeclarationPackageResult[];
  /** Diagnostics with no file, such as a compiler option the mode rejects. These fail the run. */
  readonly global: readonly DeclarationDiagnostic[];
  /** Diagnostics in declarations outside every checked package. Counted, not held against anyone. */
  readonly upstream: number;
  /**
   * Declaration files in the program that are neither ours nor TypeScript's
   * own lib. This is the check's reach: only a foreign declaration can put a
   * name into our emitted types that the build did not already check, so zero
   * means the check cannot fail in this repository.
   */
  readonly foreignDeclarations: number;
}

export interface DeclarationCheckResult {
  readonly typescriptVersion: string;
  readonly modes: readonly DeclarationModeResult[];
}

export interface DeclarationCheckOptions {
  /** Package directories, each with a built declaration entry. */
  readonly packageDirs: readonly string[];
  /** Defaults to RESOLUTION_MODES. */
  readonly modes?: readonly DeclarationResolution[];
}

export function checkDeclarations(options: DeclarationCheckOptions): DeclarationCheckResult;

/** Every package scripts/release.config.json publishes. */
export function releaseDeclarationReport(modes?: readonly DeclarationResolution[]): DeclarationCheckResult;

export function formatDiagnostic(diagnostic: DeclarationDiagnostic): string;
