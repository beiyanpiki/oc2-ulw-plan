export declare const ARTIFACT_SEGMENTS: readonly [".opencode", "ulw"];
export declare function artifactRoot(workspace: string): string;
export declare function artifactPath(workspace: string, ...segments: string[]): string;
export declare function relativeArtifactPath(path: string): string;
export declare function hasSymlinkComponent(from: string, to: string): boolean;
export declare function assertArtifactPath(workspace: string, target: string): string;
export declare function ensureArtifactDir(workspace: string, ...segments: string[]): Promise<string>;
export declare function atomicWriteFile(path: string, content: string | Buffer, mode?: number): Promise<void>;
export declare function readTextFile(path: string, maxBytes?: number): Promise<string>;
export declare function readFilePage(path: string, offset: number, limit: number): Promise<{
    text: string;
    next: number | null;
    total: number;
}>;
