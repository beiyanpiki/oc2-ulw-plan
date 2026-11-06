#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc, modify, applyEdits } from "jsonc-parser";
import { analyzeSpec, lintSpec, verifySpecPaths } from "./core/spec.js";
import { readDiagnostics, formatDiagnostics } from "./io/diagnostics.js";
import { pidAlive, readLock } from "./io/lock.js";
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_NAMES = ["ulw-plan", "ulw-exec", "ulw-readonly", "ulw-verifier", "ulw-worker"];
const DEFAULT_PLUGIN = "oc2-ulw-plan";
function home() {
    return process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
}
function scopeFor(global, project) {
    if (global) {
        const configHome = process.env.XDG_CONFIG_HOME ?? join(home(), ".config");
        const configDir = join(configHome, "opencode");
        return {
            configPath: join(configDir, "opencode.jsonc"),
            profileDir: join(configDir, "agents"),
            manifestPath: join(configDir, "ulw-install.json"),
        };
    }
    return {
        configPath: join(project, ".opencode", "opencode.jsonc"),
        profileDir: join(project, ".opencode", "agents"),
        manifestPath: join(project, ".opencode", "ulw", "install.json"),
    };
}
function hash(value) {
    return createHash("sha256").update(value).digest("hex");
}
async function exists(path) {
    try {
        await stat(path);
        return true;
    }
    catch {
        return false;
    }
}
async function readOptional(path) {
    try {
        return await readFile(path, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
function parseConfig(text) {
    const errors = [];
    const value = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
    return { value: (value ?? {}), errors };
}
function pluginEntries(value) {
    const plugins = value.plugins;
    if (plugins === undefined)
        return [];
    if (!Array.isArray(plugins))
        throw new Error("opencode config `plugins` must be an array");
    return plugins;
}
function containsPlugin(entries, plugin) {
    return entries.some((entry) => entry === plugin || (entry !== null && typeof entry === "object" && entry.package === plugin));
}
function addPluginToConfig(text, plugin) {
    const parsed = parseConfig(text);
    if (parsed.errors.length > 0)
        throw new Error(`cannot parse config: ${JSON.stringify(parsed.errors)}`);
    const plugins = pluginEntries(parsed.value);
    if (containsPlugin(plugins, plugin))
        return { text, added: false };
    const next = [...plugins, plugin];
    const edits = modify(text, ["plugins"], next, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes("\r\n") ? "\r\n" : "\n" },
    });
    return { text: applyEdits(text, edits), added: true };
}
function removePluginFromConfig(text, plugin) {
    const parsed = parseConfig(text);
    if (parsed.errors.length > 0)
        throw new Error(`cannot parse config: ${JSON.stringify(parsed.errors)}`);
    const plugins = pluginEntries(parsed.value).filter((entry) => !(entry === plugin || (entry !== null && typeof entry === "object" && entry.package === plugin)));
    const edits = modify(text, ["plugins"], plugins, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes("\r\n") ? "\r\n" : "\n" },
    });
    return applyEdits(text, edits);
}
function profileContent(name) {
    return readFile(join(PACKAGE_ROOT, "assets", "agents", `${name}.md`), "utf8");
}
async function init(input) {
    const scope = scopeFor(input.global, input.project);
    const existingManifest = await readOptional(scope.manifestPath);
    let previous;
    if (existingManifest !== undefined) {
        const parsed = JSON.parse(existingManifest);
        if (parsed.schema !== "oc2-ulw-install/v1")
            throw new Error(`unknown install manifest: ${scope.manifestPath}`);
        previous = parsed;
    }
    await mkdir(scope.profileDir, { recursive: true });
    await mkdir(dirname(scope.configPath), { recursive: true });
    await mkdir(dirname(scope.manifestPath), { recursive: true });
    const manifest = {
        schema: "oc2-ulw-install/v1",
        configPath: scope.configPath,
        profileDir: scope.profileDir,
        pluginEntry: input.plugin,
        addedPlugin: previous?.pluginEntry === input.plugin ? previous.addedPlugin : false,
        createdConfig: previous?.createdConfig === true,
        profiles: {},
    };
    for (const name of PROFILE_NAMES) {
        const target = join(scope.profileDir, `${name}.md`);
        const content = await profileContent(name);
        const digest = hash(content);
        const current = await readOptional(target);
        const previouslyOwned = previous?.profiles[target]?.owned === true && previous.profiles[target]?.hash === digest;
        if (current === undefined) {
            await writeFile(target, content, { mode: 0o644 });
            manifest.profiles[target] = { hash: digest, owned: true };
            console.log(`created ${target}`);
        }
        else if (hash(current) === digest) {
            manifest.profiles[target] = { hash: digest, owned: previouslyOwned };
            console.log(`unchanged ${target}`);
        }
        else {
            throw new Error(`refusing to overwrite existing user agent profile: ${target}`);
        }
    }
    const existingConfig = await readOptional(scope.configPath);
    const baseConfig = existingConfig ?? '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
    const updated = addPluginToConfig(baseConfig, input.plugin);
    if (existingConfig === undefined)
        manifest.createdConfig = true;
    manifest.addedPlugin = manifest.addedPlugin || updated.added;
    if (updated.added || existingConfig === undefined) {
        await writeFile(scope.configPath, updated.text, "utf8");
        console.log(`updated ${scope.configPath}`);
    }
    else {
        console.log(`plugin already configured in ${scope.configPath}`);
    }
    await writeFile(scope.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const pluginBin = join(PACKAGE_ROOT, "dist", "cli.js");
    if (await exists(pluginBin))
        await chmod(pluginBin, 0o755);
    console.log(`\noc2-ulw-plan installed for ${input.global ? "this user" : input.project}`);
    console.log("Restart or reload OpenCode, then run: oc2-ulw-plan doctor");
}
async function doctor(input) {
    const scope = scopeFor(input.global, input.project);
    const errors = [];
    const warnings = [];
    const manifestText = await readOptional(scope.manifestPath);
    if (manifestText === undefined) {
        errors.push(`install manifest missing: ${scope.manifestPath}`);
    }
    else {
        const manifest = JSON.parse(manifestText);
        const expectedPlugin = input.plugin ?? manifest.pluginEntry;
        for (const name of PROFILE_NAMES) {
            const target = join(scope.profileDir, `${name}.md`);
            const content = await readOptional(target);
            if (content === undefined) {
                errors.push(`agent profile missing: ${target}`);
                continue;
            }
            const expected = await profileContent(name);
            if (content !== expected)
                warnings.push(`agent profile differs from package defaults: ${target}`);
        }
        const config = await readOptional(scope.configPath);
        if (config === undefined)
            errors.push(`config missing: ${scope.configPath}`);
        else {
            const parsed = parseConfig(config);
            if (parsed.errors.length > 0)
                errors.push(`config has parse errors: ${JSON.stringify(parsed.errors)}`);
            else if (expectedPlugin !== undefined && !containsPlugin(pluginEntries(parsed.value), expectedPlugin)) {
                errors.push(`plugin entry missing: ${expectedPlugin}`);
            }
        }
        if (manifest.schema !== "oc2-ulw-install/v1")
            errors.push("install manifest has an unknown schema");
    }
    const git = await exists(join(input.project, ".git"));
    if (!git)
        warnings.push("project is not a Git worktree; /ulw-execute will refuse execution");
    const assets = ["skills/ulw-plan/SKILL.md", "skills/ulw-execute/SKILL.md", "agents/ulw-plan.md"];
    for (const asset of assets) {
        if (!(await exists(join(PACKAGE_ROOT, "assets", asset))))
            errors.push(`package asset missing: ${asset}`);
    }
    console.log("oc2-ulw-plan doctor");
    console.log(`scope: ${input.global ? "global" : "project"}`);
    console.log(`config: ${scope.configPath}`);
    console.log(`profiles: ${scope.profileDir}`);
    console.log(`project git: ${git ? "yes" : "no"}`);
    for (const warning of warnings)
        console.log(`warning: ${warning}`);
    for (const error of errors)
        console.error(`error: ${error}`);
    if (errors.length > 0)
        process.exitCode = 1;
    else
        console.log("ok");
}
async function diagnose(input) {
    const root = join(input.project, ".opencode", "ulw");
    const specsDir = join(root, "specs");
    const draftsDir = join(root, "drafts");
    const listMarkdown = async (directory) => {
        try {
            return (await readdir(directory)).filter((entry) => entry.endsWith(".md")).map((entry) => entry.slice(0, -3)).sort();
        }
        catch (error) {
            if (error.code === "ENOENT")
                return [];
            throw error;
        }
    };
    const specIDs = await listMarkdown(specsDir);
    const draftIDs = await listMarkdown(draftsDir);
    console.log("oc2-ulw-plan diagnose");
    console.log(`project: ${input.project}`);
    console.log(`artifacts: ${root}`);
    let specErrors = 0;
    console.log("\n## Specs");
    if (specIDs.length === 0)
        console.log("- none");
    for (const id of specIDs) {
        const path = join(specsDir, `${id}.md`);
        const content = await readFile(path, "utf8");
        const analysis = analyzeSpec(content);
        const diagnostics = [...analysis.diagnostics];
        if (analysis.parsed !== undefined) {
            diagnostics.push(...lintSpec(analysis.parsed, false));
            diagnostics.push(...(await verifySpecPaths(analysis.parsed.spec, input.project)));
        }
        const errors = diagnostics.filter((entry) => entry.severity === "error");
        const warnings = diagnostics.filter((entry) => entry.severity === "warning");
        specErrors += errors.length;
        console.log(`- ${id}: ${errors.length === 0 ? "valid" : `INVALID (${errors.length} errors)`}${warnings.length === 0 ? "" : `, ${warnings.length} warnings`}${draftIDs.includes(id) ? " [draft copy]" : ""}`);
        for (const entry of errors.slice(0, 6))
            console.log(`    error ${entry.code}: ${entry.message}`);
        for (const entry of warnings.slice(0, 3))
            console.log(`    warning ${entry.code}: ${entry.message}`);
    }
    console.log("\n## Drafts");
    const draftOnly = draftIDs.filter((id) => !specIDs.includes(id));
    if (draftOnly.length === 0)
        console.log("- none");
    for (const id of draftOnly)
        console.log(`- ${id}: draft (not an executable spec yet)`);
    const lock = await readLock(input.project);
    console.log("\n## Lock");
    if (lock === undefined) {
        console.log("- none");
    }
    else {
        const alive = pidAlive(lock.pid);
        console.log(`- run ${lock.runID} session ${lock.sessionID} pid ${lock.pid} (${alive ? "process alive" : "process gone"}) since ${new Date(lock.acquiredAt).toISOString()}`);
        if (!alive)
            console.log("  warning: stale lock; /ulw-execute --resume or --recover can reclaim it");
    }
    const count = async (directory) => {
        try {
            return (await readdir(directory)).length;
        }
        catch {
            return 0;
        }
    };
    console.log("\n## Artifacts");
    console.log(`- reports: ${await count(join(root, "reports"))}`);
    console.log(`- evidence runs: ${await count(join(root, "evidence"))}`);
    const entries = await readDiagnostics(input.project, input.limit);
    console.log("\n## Recent diagnostics");
    if (entries.length === 0)
        console.log("- none");
    for (const line of formatDiagnostics(entries, input.limit))
        console.log(line);
    if (specErrors > 0) {
        console.error(`\n${specErrors} spec error(s); invalid specs cannot be published or executed`);
        process.exitCode = 1;
    }
    else {
        console.log("\nok");
    }
}
async function uninstall(input) {
    const scope = scopeFor(input.global, input.project);
    const manifestText = await readOptional(scope.manifestPath);
    if (manifestText === undefined)
        throw new Error(`no install manifest; refusing to guess what to remove: ${scope.manifestPath}`);
    const manifest = JSON.parse(manifestText);
    for (const [path, entry] of Object.entries(manifest.profiles)) {
        if (!entry.owned)
            continue;
        const content = await readOptional(path);
        if (content === undefined)
            continue;
        if (hash(content) !== entry.hash) {
            console.log(`kept modified profile ${path}`);
            continue;
        }
        await rm(path);
        console.log(`removed ${path}`);
    }
    if (manifest.addedPlugin) {
        const config = await readOptional(scope.configPath);
        if (config !== undefined) {
            await writeFile(scope.configPath, removePluginFromConfig(config, manifest.pluginEntry), "utf8");
            console.log(`removed plugin ${manifest.pluginEntry} from ${scope.configPath}`);
        }
    }
    if (manifest.createdConfig) {
        const remaining = await readOptional(scope.configPath);
        if (remaining !== undefined) {
            const parsed = parseConfig(remaining);
            const plugins = pluginEntries(parsed.value);
            if (plugins.length === 0) {
                const cleaned = remaining.replace(/,?\s*"plugins"\s*:\s*\[\s*\]\s*/g, "").replace(/,\s*}/g, "}");
                await writeFile(scope.configPath, cleaned, "utf8");
            }
        }
    }
    await rm(scope.manifestPath);
    console.log("uninstalled; ulw specs, runs, evidence and reports were preserved");
}
function usage() {
    console.error(`usage: oc2-ulw-plan <init|doctor|diagnose|uninstall> [options]

options:
  --global            use ~/.config/opencode instead of the project
  --project <dir>     project directory (default: cwd)
  --plugin <name>     plugin entry (default: ${DEFAULT_PLUGIN})
  --limit <n>         number of diagnostics shown by diagnose (default: 20)
`);
    process.exit(2);
}
async function main(argv) {
    const command = argv[0];
    let global = false;
    let project = process.cwd();
    let plugin;
    let limit = 20;
    for (let index = 1; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === undefined)
            usage();
        if (arg === "--global")
            global = true;
        else if (arg === "--project") {
            const value = argv[++index];
            if (value === undefined)
                usage();
            project = resolve(value);
        }
        else if (arg.startsWith("--project="))
            project = resolve(arg.slice("--project=".length));
        else if (arg === "--limit") {
            const value = argv[++index];
            if (value === undefined)
                usage();
            limit = Number(value);
        }
        else if (arg.startsWith("--limit="))
            limit = Number(arg.slice("--limit=".length));
        else if (arg === "--plugin") {
            const value = argv[++index];
            if (value === undefined)
                usage();
            plugin = value;
        }
        else if (arg.startsWith("--plugin="))
            plugin = arg.slice("--plugin=".length);
        else
            usage();
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
        usage();
    if (command === "init")
        await init({ global, project, plugin: plugin ?? DEFAULT_PLUGIN });
    else if (command === "doctor")
        await doctor({ global, project, ...(plugin === undefined ? {} : { plugin }) });
    else if (command === "diagnose")
        await diagnose({ project, limit });
    else if (command === "uninstall")
        await uninstall({ global, project });
    else
        usage();
}
main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
//# sourceMappingURL=cli.js.map