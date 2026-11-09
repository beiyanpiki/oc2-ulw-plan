export interface JsonStore {
    get(key: string): Promise<unknown | undefined>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
    scan(prefix: string, limit?: number): Promise<Array<{
        key: string;
        value: unknown;
    }>>;
}
export declare class MemoryStore implements JsonStore {
    private readonly values;
    get(key: string): Promise<unknown | undefined>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
    scan(prefix: string, limit?: number): Promise<Array<{
        key: string;
        value: unknown;
    }>>;
}
export declare class WorkspaceStore {
    private readonly store;
    private readonly workspaceKey;
    constructor(store: JsonStore, workspaceKey: string);
    specPrefix(): string;
    specKey(id: string): string;
    runPrefix(): string;
    runKey(id: string): string;
    invocationKey(id: string): string;
    reportKey(id: string): string;
    bindingKey(sessionID: string): string;
    planKey(sessionID: string): string;
    activeKey(sessionID: string): string;
    getActive<T>(sessionID: string): Promise<T | undefined>;
    setActive(sessionID: string, value: unknown): Promise<void>;
    removeActive(sessionID: string): Promise<void>;
    getPlan<T>(sessionID: string): Promise<T | undefined>;
    setPlan(sessionID: string, value: unknown): Promise<void>;
    evidencePrefix(runID: string): string;
    evidenceKey(runID: string, evidenceID: string): string;
    getSpec<T>(id: string): Promise<T | undefined>;
    setSpec(id: string, value: unknown): Promise<void>;
    getRun<T>(id: string): Promise<T | undefined>;
    setRun(id: string, value: unknown): Promise<void>;
    getInvocation<T>(id: string): Promise<T | undefined>;
    setInvocation(id: string, value: unknown): Promise<void>;
    setBudgetGrant(id: string, value: unknown): Promise<void>;
    listBudgetGrants<T>(): Promise<Array<{
        id: string;
        value: T;
    }>>;
    getReport<T>(id: string): Promise<T | undefined>;
    setReport(id: string, value: unknown): Promise<void>;
    getBinding<T>(sessionID: string): Promise<T | undefined>;
    setBinding(sessionID: string, value: unknown): Promise<void>;
    listSpecs<T>(): Promise<Array<{
        id: string;
        value: T;
    }>>;
    listRuns<T>(): Promise<Array<{
        id: string;
        value: T;
    }>>;
    listInvocations<T>(): Promise<Array<{
        id: string;
        value: T;
    }>>;
    listReports<T>(): Promise<Array<{
        id: string;
        value: T;
    }>>;
    setEvidence(runID: string, evidenceID: string, value: unknown): Promise<void>;
    listEvidence<T>(runID: string): Promise<Array<{
        id: string;
        value: T;
    }>>;
}
