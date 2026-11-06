export function topologicalWaves(tasks) {
    const byID = new Map(tasks.map((task) => [task.id, task]));
    const remaining = new Set(byID.keys());
    const done = new Set();
    const waves = [];
    while (remaining.size > 0) {
        const wave = [...remaining].filter((id) => {
            const task = byID.get(id);
            return task !== undefined && task.dependsOn.every((dependency) => done.has(dependency));
        });
        if (wave.length === 0) {
            throw new Error(`dependency cycle among: ${[...remaining].join(", ")}`);
        }
        wave.sort((left, right) => numericID(left) - numericID(right));
        waves.push(wave);
        for (const id of wave) {
            remaining.delete(id);
            done.add(id);
        }
    }
    return waves;
}
function numericID(id) {
    return Number(id.replace(/^T/, ""));
}
export function readyTasks(tasks, satisfied) {
    return tasks.filter((task) => !satisfied.has(task.id) && task.dependsOn.every((dependency) => satisfied.has(dependency)));
}
export function filesOverlap(left, right) {
    return left.some((a) => right.some((b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}
//# sourceMappingURL=graph.js.map