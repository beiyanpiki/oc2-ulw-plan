import type { TaskSpec } from "./types.js";
export declare function topologicalWaves(tasks: TaskSpec[]): string[][];
export declare function readyTasks(tasks: TaskSpec[], satisfied: ReadonlySet<string>): TaskSpec[];
export declare function filesOverlap(left: string[], right: string[]): boolean;
