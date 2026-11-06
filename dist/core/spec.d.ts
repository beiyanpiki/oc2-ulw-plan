import type { Diagnostic, ParsedSpec, Risk, Spec, TaskSpec } from "./types.js";
export declare const SPEC_SCHEMA = "ulw-spec/v1";
export declare const SPEC_SLUG_RE: RegExp;
export declare const DEFAULT_CHECK_TIMEOUT_MS = 120000;
export declare const MAX_CHECK_TIMEOUT_MS = 900000;
export declare const MAX_SPEC_BYTES: number;
export declare function sha256(value: string | Buffer): string;
export declare function isSpecSlug(value: string): boolean;
export declare function assertSafeRelativePath(value: string, label: string): string;
export declare function isWithin(parent: string, child: string): boolean;
export declare function parseFrontmatter(content: string): {
    yaml: string;
    body: string;
};
export interface SpecAnalysis {
    parsed?: ParsedSpec;
    diagnostics: Diagnostic[];
    hash: string;
    declaredID?: string;
}
/**
 * Parse a spec and collect every structural error instead of failing fast. The
 * returned `parsed` is only present when the file is structurally valid; lint
 * diagnostics are deliberately left to the caller so `parseSpec` keeps its
 * historical meaning.
 */
export declare function analyzeSpec(content: string): SpecAnalysis;
export declare function parseSpec(content: string): ParsedSpec;
export declare function hasPlaceholder(value: string): boolean;
export declare function inferRisk(spec: Spec, body: string): Risk;
export declare function effectiveRisk(spec: Spec, body: string): Risk;
export declare function requiresAdversarial(spec: Spec, body: string, strict: boolean): boolean;
export declare function lintSpec(parsed: ParsedSpec, strict: boolean): Diagnostic[];
export declare function findCycle(tasks: TaskSpec[]): string[] | undefined;
export declare function verifySpecPaths(spec: Spec, workspace: string): Promise<Diagnostic[]>;
export declare function assertValidSpec(parsed: ParsedSpec, strict: boolean): void;
export declare function computeSourceHashes(spec: Spec, workspace: string): Promise<Record<string, string>>;
