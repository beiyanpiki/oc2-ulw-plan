export class MemoryStore {
    values = new Map();
    async get(key) {
        const value = this.values.get(key);
        return value === undefined ? undefined : JSON.parse(value);
    }
    async set(key, value) {
        this.values.set(key, JSON.stringify(value));
    }
    async remove(key) {
        this.values.delete(key);
    }
    async scan(prefix, limit = 1000) {
        return [...this.values.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .slice(0, limit)
            .map(([key, value]) => ({ key, value: JSON.parse(value) }));
    }
}
export class WorkspaceStore {
    store;
    workspaceKey;
    constructor(store, workspaceKey) {
        this.store = store;
        this.workspaceKey = workspaceKey;
    }
    specPrefix() {
        return `v1/spec/${this.workspaceKey}/`;
    }
    specKey(id) {
        return `${this.specPrefix()}${id}`;
    }
    runPrefix() {
        return `v1/run/${this.workspaceKey}/`;
    }
    runKey(id) {
        return `${this.runPrefix()}${id}`;
    }
    invocationKey(id) {
        return `v1/invocation/${id}`;
    }
    reportKey(id) {
        return `v1/report/${id}`;
    }
    bindingKey(sessionID) {
        return `v1/binding/${this.workspaceKey}/${sessionID}`;
    }
    planKey(sessionID) {
        return `v1/plan/${this.workspaceKey}/${sessionID}`;
    }
    activeKey(sessionID) {
        return `v1/active/${this.workspaceKey}/${sessionID}`;
    }
    async getActive(sessionID) {
        return (await this.store.get(this.activeKey(sessionID)));
    }
    async setActive(sessionID, value) {
        await this.store.set(this.activeKey(sessionID), value);
    }
    async removeActive(sessionID) {
        await this.store.remove(this.activeKey(sessionID));
    }
    async getPlan(sessionID) {
        return (await this.store.get(this.planKey(sessionID)));
    }
    async setPlan(sessionID, value) {
        await this.store.set(this.planKey(sessionID), value);
    }
    evidencePrefix(runID) {
        return `v1/evidence/${this.workspaceKey}/${runID}/`;
    }
    evidenceKey(runID, evidenceID) {
        return `${this.evidencePrefix(runID)}${evidenceID}`;
    }
    async getSpec(id) {
        return (await this.store.get(this.specKey(id)));
    }
    async setSpec(id, value) {
        await this.store.set(this.specKey(id), value);
    }
    async getRun(id) {
        return (await this.store.get(this.runKey(id)));
    }
    async setRun(id, value) {
        await this.store.set(this.runKey(id), value);
    }
    async getInvocation(id) {
        return (await this.store.get(this.invocationKey(id)));
    }
    async setInvocation(id, value) {
        await this.store.set(this.invocationKey(id), value);
    }
    async setBudgetGrant(id, value) {
        await this.store.set(`v1/budget-grant/${this.workspaceKey}/${id}`, value);
    }
    async listBudgetGrants() {
        const prefix = `v1/budget-grant/${this.workspaceKey}/`;
        const entries = await this.store.scan(prefix, 10_000);
        return entries.map((entry) => ({ id: entry.key.slice(prefix.length), value: entry.value }));
    }
    async getReport(id) {
        return (await this.store.get(this.reportKey(id)));
    }
    async setReport(id, value) {
        await this.store.set(this.reportKey(id), value);
    }
    async getBinding(sessionID) {
        return (await this.store.get(this.bindingKey(sessionID)));
    }
    async setBinding(sessionID, value) {
        await this.store.set(this.bindingKey(sessionID), value);
    }
    async listSpecs() {
        const entries = await this.store.scan(this.specPrefix());
        return entries.map((entry) => ({
            id: entry.key.slice(this.specPrefix().length),
            value: entry.value,
        }));
    }
    async listRuns() {
        const entries = await this.store.scan(this.runPrefix());
        return entries.map((entry) => ({
            id: entry.key.slice(this.runPrefix().length),
            value: entry.value,
        }));
    }
    async listInvocations() {
        const entries = await this.store.scan("v1/invocation/", 10_000);
        return entries.map((entry) => ({
            id: entry.key.slice("v1/invocation/".length),
            value: entry.value,
        }));
    }
    async listReports() {
        const entries = await this.store.scan("v1/report/", 10_000);
        return entries.map((entry) => ({
            id: entry.key.slice("v1/report/".length),
            value: entry.value,
        }));
    }
    async setEvidence(runID, evidenceID, value) {
        await this.store.set(this.evidenceKey(runID, evidenceID), value);
    }
    async listEvidence(runID) {
        const prefix = this.evidencePrefix(runID);
        const entries = await this.store.scan(prefix, 10_000);
        return entries.map((entry) => ({ id: entry.key.slice(prefix.length), value: entry.value }));
    }
}
//# sourceMappingURL=store.js.map