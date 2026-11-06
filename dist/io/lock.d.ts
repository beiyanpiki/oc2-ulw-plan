export interface LockOwner {
    token: string;
    pid: number;
    serviceId: string;
    sessionID: string;
    runID: string;
    acquiredAt: number;
}
export interface LockInfo extends LockOwner {
    schema: "ulw-lock/v1";
}
export declare function serviceIdentity(): string;
export declare function readLock(workspace: string): Promise<LockInfo | undefined>;
export declare function acquireLock(workspace: string, owner: {
    sessionID: string;
    runID: string;
}): Promise<LockInfo>;
export declare function releaseLock(workspace: string, token: string): Promise<boolean>;
export declare function pidAlive(pid: number): boolean;
export interface RecoveryDecision {
    recoverable: boolean;
    reason: string;
    lock?: LockInfo;
}
export declare function inspectRecoverable(workspace: string, expectedSessionID: string, expectedRunID: string): Promise<RecoveryDecision>;
export declare function transferLock(workspace: string, expected: LockInfo, sessionID: string, runID: string): Promise<LockInfo>;
