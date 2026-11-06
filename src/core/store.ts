export interface JsonStore {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  scan(prefix: string, limit?: number): Promise<Array<{ key: string; value: unknown }>>;
}

export class MemoryStore implements JsonStore {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<unknown | undefined> {
    const value = this.values.get(key);
    return value === undefined ? undefined : (JSON.parse(value) as unknown);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, JSON.stringify(value));
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }

  async scan(prefix: string, limit = 1000): Promise<Array<{ key: string; value: unknown }>> {
    return [...this.values.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .slice(0, limit)
      .map(([key, value]) => ({ key, value: JSON.parse(value) as unknown }));
  }
}

export class WorkspaceStore {
  constructor(
    private readonly store: JsonStore,
    private readonly workspaceKey: string,
  ) {}

  specPrefix(): string {
    return `v1/spec/${this.workspaceKey}/`;
  }

  specKey(id: string): string {
    return `${this.specPrefix()}${id}`;
  }

  runPrefix(): string {
    return `v1/run/${this.workspaceKey}/`;
  }

  runKey(id: string): string {
    return `${this.runPrefix()}${id}`;
  }

  invocationKey(id: string): string {
    return `v1/invocation/${id}`;
  }

  reportKey(id: string): string {
    return `v1/report/${id}`;
  }

  bindingKey(sessionID: string): string {
    return `v1/binding/${this.workspaceKey}/${sessionID}`;
  }

  planKey(sessionID: string): string {
    return `v1/plan/${this.workspaceKey}/${sessionID}`;
  }

  activeKey(sessionID: string): string {
    return `v1/active/${this.workspaceKey}/${sessionID}`;
  }

  async getActive<T>(sessionID: string): Promise<T | undefined> {
    return (await this.store.get(this.activeKey(sessionID))) as T | undefined;
  }

  async setActive(sessionID: string, value: unknown): Promise<void> {
    await this.store.set(this.activeKey(sessionID), value);
  }

  async removeActive(sessionID: string): Promise<void> {
    await this.store.remove(this.activeKey(sessionID));
  }

  async getPlan<T>(sessionID: string): Promise<T | undefined> {
    return (await this.store.get(this.planKey(sessionID))) as T | undefined;
  }

  async setPlan(sessionID: string, value: unknown): Promise<void> {
    await this.store.set(this.planKey(sessionID), value);
  }

  evidencePrefix(runID: string): string {
    return `v1/evidence/${this.workspaceKey}/${runID}/`;
  }

  evidenceKey(runID: string, evidenceID: string): string {
    return `${this.evidencePrefix(runID)}${evidenceID}`;
  }

  async getSpec<T>(id: string): Promise<T | undefined> {
    return (await this.store.get(this.specKey(id))) as T | undefined;
  }

  async setSpec(id: string, value: unknown): Promise<void> {
    await this.store.set(this.specKey(id), value);
  }

  async getRun<T>(id: string): Promise<T | undefined> {
    return (await this.store.get(this.runKey(id))) as T | undefined;
  }

  async setRun(id: string, value: unknown): Promise<void> {
    await this.store.set(this.runKey(id), value);
  }

  async getInvocation<T>(id: string): Promise<T | undefined> {
    return (await this.store.get(this.invocationKey(id))) as T | undefined;
  }

  async setInvocation(id: string, value: unknown): Promise<void> {
    await this.store.set(this.invocationKey(id), value);
  }

  async getReport<T>(id: string): Promise<T | undefined> {
    return (await this.store.get(this.reportKey(id))) as T | undefined;
  }

  async setReport(id: string, value: unknown): Promise<void> {
    await this.store.set(this.reportKey(id), value);
  }

  async getBinding<T>(sessionID: string): Promise<T | undefined> {
    return (await this.store.get(this.bindingKey(sessionID))) as T | undefined;
  }

  async setBinding(sessionID: string, value: unknown): Promise<void> {
    await this.store.set(this.bindingKey(sessionID), value);
  }

  async listSpecs<T>(): Promise<Array<{ id: string; value: T }>> {
    const entries = await this.store.scan(this.specPrefix());
    return entries.map((entry) => ({
      id: entry.key.slice(this.specPrefix().length),
      value: entry.value as T,
    }));
  }

  async listRuns<T>(): Promise<Array<{ id: string; value: T }>> {
    const entries = await this.store.scan(this.runPrefix());
    return entries.map((entry) => ({
      id: entry.key.slice(this.runPrefix().length),
      value: entry.value as T,
    }));
  }

  async listInvocations<T>(): Promise<Array<{ id: string; value: T }>> {
    const entries = await this.store.scan("v1/invocation/", 10_000);
    return entries.map((entry) => ({
      id: entry.key.slice("v1/invocation/".length),
      value: entry.value as T,
    }));
  }

  async listReports<T>(): Promise<Array<{ id: string; value: T }>> {
    const entries = await this.store.scan("v1/report/", 10_000);
    return entries.map((entry) => ({
      id: entry.key.slice("v1/report/".length),
      value: entry.value as T,
    }));
  }

  async setEvidence(runID: string, evidenceID: string, value: unknown): Promise<void> {
    await this.store.set(this.evidenceKey(runID, evidenceID), value);
  }

  async listEvidence<T>(runID: string): Promise<Array<{ id: string; value: T }>> {
    const prefix = this.evidencePrefix(runID);
    const entries = await this.store.scan(prefix, 10_000);
    return entries.map((entry) => ({ id: entry.key.slice(prefix.length), value: entry.value as T }));
  }
}
