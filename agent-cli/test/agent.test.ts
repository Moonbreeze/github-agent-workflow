import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import test from "node:test";
import { COMMAND_PERMISSIONS, mintCommandToken } from "../src/auth.js";
import { loadConfig, type Config } from "../src/config.js";
import { AgentError } from "../src/error.js";
import { assertPushableBranch, inspectRepository, parseOrigin, pushBranch, setLocalIdentity, taskBranch, type Repository, type Runner } from "../src/git.js";
import { createOrUpdatePullRequest } from "../src/pr.js";
import { parseArgs } from "../src/cli.js";
import { prepare, publish } from "../src/operations.js";

function fixture(): { root: string; configPath: string; key: string; data: Record<string, unknown> } {
  const root = mkdtempSync(path.join(tmpdir(), "agent-cli-"));
  const credentials = path.join(root, "credentials");
  mkdirSync(credentials, { mode: 0o700 });
  const key = path.join(credentials, "app.pem");
  writeFileSync(key, "key", { mode: 0o600 });
  const configPath = path.join(credentials, "config.json");
  const data = { app_id: 123, installation_id: 456, expected_owner: "Moonbreeze", allowed_repositories: ["github-agent-workflow"], private_key_path: key };
  writeFileSync(configPath, JSON.stringify(data), { mode: 0o600 });
  const cwd = path.join(root, "work"); mkdirSync(cwd);
  return { root: cwd, configPath, key, data };
}

test("strict config accepts only the fixed schema and allowlist", () => {
  const good = fixture();
  assert.equal(loadConfig(good.configPath, good.root).appId, 123);
  for (const changed of [{ ...good.data, extra: true }, { ...good.data, app_id: "123" }, { ...good.data, expected_owner: "Other" }, { ...good.data, allowed_repositories: ["other"] }]) {
    writeFileSync(good.configPath, JSON.stringify(changed), { mode: 0o600 }); chmodSync(good.configPath, 0o600);
    assert.throws(() => loadConfig(good.configPath, good.root), AgentError);
  }
});

test("credential modes, symlinks, and hard links are rejected", () => {
  const insecure = fixture(); chmodSync(insecure.configPath, 0o644);
  assert.throws(() => loadConfig(insecure.configPath, insecure.root), /Insecure/);
  const linked = fixture(); linkSync(linked.configPath, path.join(path.dirname(linked.configPath), "copy.json"));
  assert.throws(() => loadConfig(linked.configPath, linked.root), /hard links/);
  const symlinked = fixture(); const target = path.join(path.dirname(symlinked.configPath), "target.pem");
  writeFileSync(target, "key", { mode: 0o600 }); symlinkSync(target, path.join(path.dirname(symlinked.configPath), "alias.pem"));
  symlinked.data.private_key_path = path.join(path.dirname(symlinked.configPath), "alias.pem"); writeFileSync(symlinked.configPath, JSON.stringify(symlinked.data)); chmodSync(symlinked.configPath, 0o600);
  assert.throws(() => loadConfig(symlinked.configPath, symlinked.root), /symbolic links/);
  for (const special of [0o4000, 0o2000, 0o1000]) {
    const fileMode = fixture(); chmodSync(fileMode.configPath, 0o600 | special);
    assert.throws(() => loadConfig(fileMode.configPath, fileMode.root), /Insecure/);
    const directoryMode = fixture(); chmodSync(path.dirname(directoryMode.configPath), 0o700 | special);
    assert.throws(() => loadConfig(directoryMode.configPath, directoryMode.root), /Insecure/);
  }
});

test("symlink checks preserve relative and tilde dot-dot components", () => {
  const relative = fixture();
  symlinkSync(relative.root, path.join(relative.root, "jump"));
  assert.throws(() => loadConfig("jump/../credentials/config.json", relative.root), /symbolic links/);

  const name = `agent-cli-link-${process.pid}-${Date.now()}`;
  const homeLink = path.join(homedir(), name);
  symlinkSync(relative.root, homeLink);
  try {
    assert.throws(() => loadConfig(`~/${name}/../credentials/config.json`, relative.root), /symbolic links/);
  } finally {
    rmSync(homeLink);
  }
});

const config: Config = { appId: 123, installationId: 456, expectedOwner: "Moonbreeze", allowedRepositories: ["github-agent-workflow"], privateKeyPath: "/secure/key", path: "/secure/config" };

test("origin parsing and repository allowlist are exact", async () => {
  assert.throws(() => parseOrigin("git@github.com:Moonbreeze/github-agent-workflow.git"), /HTTPS/);
  assert.throws(() => parseOrigin("ssh://git@github.com/Moonbreeze/github-agent-workflow.git"), /HTTPS/);
  assert.deepEqual(parseOrigin("https://github.com/Moonbreeze/github-agent-workflow.git"), { owner: "Moonbreeze", name: "github-agent-workflow" });
  assert.throws(() => parseOrigin("https://example.com/Moonbreeze/github-agent-workflow"), AgentError);
  const runner: Runner = async (_command, args) => ({ code: 0, stdout: args[0] === "rev-parse" ? "/repo\n" : "https://github.com/Moonbreeze/other.git\n" });
  await assert.rejects(inspectRepository(config, runner), /allowlist/);
});

test("repository inspection rejects push destinations and rewrites before authentication", async () => {
  const inspectWith = async (configResult: (args: string[]) => { code: number; stdout: string }) => inspectRepository(config, async (_command, args) => {
    if (args[0] === "rev-parse") return { code: 0, stdout: "/repo\n" };
    if (args[0] === "remote") return { code: 0, stdout: "https://github.com/Moonbreeze/github-agent-workflow.git\n" };
    return configResult(args);
  });
  await assert.rejects(inspectWith(args => args.includes("remote.origin.pushurl")
    ? { code: 0, stdout: "ssh://attacker.example/repo\n" }
    : { code: 1, stdout: "" }), /push URL/);
  await assert.rejects(inspectWith(args => args.includes("--get-regexp")
    ? { code: 0, stdout: "url.ssh://attacker.example/.pushinsteadof https://github.com/\n" }
    : { code: 1, stdout: "" }), /rewrites/);
});

test("repository inspection rejects an additional SSH origin URL", async () => {
  const calls: string[][] = [];
  const runner: Runner = async (_command, args) => {
    calls.push(args);
    if (args[0] === "rev-parse") return { code: 0, stdout: "/repo\n" };
    if (args[0] === "remote") return { code: 0, stdout: "https://github.com/Moonbreeze/github-agent-workflow.git\ngit@github.com:Moonbreeze/github-agent-workflow.git\n" };
    return { code: 1, stdout: "" };
  };
  await assert.rejects(inspectRepository(config, runner), /exactly one URL/);
  assert.deepEqual(calls[1], ["remote", "get-url", "--all", "origin"]);
});

test("repository inspection detects Git-canonicalized lowercase URL rewrites", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "agent-cli-git-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runGit = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  runGit(["init"]);
  runGit(["remote", "add", "origin", "https://github.com/Moonbreeze/github-agent-workflow.git"]);
  runGit(["config", "--local", "url.ssh://attacker.example/.pushInsteadOf", "https://github.com/"]);
  await assert.rejects(inspectRepository(config, undefined, root), /rewrites/);
});

test("task and protected branch guards reject invalid targets locally", () => {
  assert.equal(taskBranch("issue-123"), "agent/issue-123");
  for (const value of ["Main", "bad/slug", "-bad", "main", "master", "feature/x"]) {
    if (value === "main" || value === "master" || value.includes("/")) assert.throws(() => assertPushableBranch(value), AgentError);
    else assert.throws(() => taskBranch(value), AgentError);
  }
});

test("publish completes repository and branch guards before auth or network", async () => {
  const local = fixture(); let networkCalls = 0;
  const runner: Runner = async (_command, args) => {
    if (args[0] === "rev-parse") return { code: 0, stdout: `${local.root}\n` };
    if (args[0] === "remote") return { code: 0, stdout: "https://github.com/Moonbreeze/github-agent-workflow.git\n" };
    if (args[0] === "config") return { code: 1, stdout: "" };
    if (args[0] === "status") return { code: 0, stdout: "" };
    if (args[0] === "symbolic-ref") return { code: 0, stdout: "main\n" };
    throw new Error("unexpected command");
  };
  await assert.rejects(publish("Title", undefined, local.configPath, { cwd: local.root, runner, request: async () => { networkCalls++; return {}; } }), /valid agent/);
  assert.equal(networkCalls, 0);
});

test("prepare rejects an invalid task before branch changes, auth, or network", async () => {
  const local = fixture(); let networkCalls = 0; const calls: string[][] = [];
  const runner: Runner = async (_command, args) => {
    calls.push(args);
    if (args[0] === "rev-parse") return { code: 0, stdout: `${local.root}\n` };
    if (args[0] === "remote") return { code: 0, stdout: "https://github.com/Moonbreeze/github-agent-workflow.git\n" };
    if (args[0] === "config") return { code: 1, stdout: "" };
    throw new Error("branch command occurred before task validation");
  };
  await assert.rejects(prepare("../main", local.configPath, { cwd: local.root, runner, request: async () => { networkCalls++; return {}; } }), /lowercase slug/);
  assert.equal(networkCalls, 0);
  assert.deepEqual(calls.map(args => args[0]), ["rev-parse", "remote", "config", "config"]);
});

test("bot identity uses repository-local git config only", async () => {
  const calls: string[][] = [];
  const runner: Runner = async (_command, args) => { calls.push(args); return { code: 0, stdout: "" }; };
  await setLocalIdentity({ root: "/repo", owner: "Moonbreeze", name: "github-agent-workflow" }, "agent-app", 123, runner);
  assert.deepEqual(calls, [["config", "--local", "user.name", "agent-app[bot]"], ["config", "--local", "user.email", "123+agent-app[bot]@users.noreply.github.com"]]);
  assert.equal(calls.flat().includes("--global"), false);
});

test("command token is repository-scoped with exact permissions", async () => {
  let observed: unknown;
  const token = await mintCommandToken(config, "jwt-secret", async (method, endpoint, auth, payload) => { observed = { method, endpoint, auth, payload }; return { token: "token-secret" }; });
  assert.equal(token, "token-secret");
  assert.deepEqual(observed, { method: "POST", endpoint: "/app/installations/456/access_tokens", auth: "jwt-secret", payload: { repositories: ["github-agent-workflow"], permissions: COMMAND_PERMISSIONS } });
});

test("push uses canonical HTTPS, disables helpers and hooks, and keeps token out of argv", async () => {
  let args: string[] = []; let env: NodeJS.ProcessEnv = {};
  const runner: Runner = async (_command, actual, options) => { args = actual; env = options?.env ?? {}; return { code: 0, stdout: "" }; };
  await pushBranch({ root: "/repo", owner: "Moonbreeze", name: "github-agent-workflow" }, "agent/task", "super-secret", runner);
  assert.deepEqual(args, ["-c", "credential.helper=", "-c", "credential.interactive=never", "-c", "credential.useHttpPath=false", "push", "--no-verify", "https://github.com/Moonbreeze/github-agent-workflow.git", "HEAD:refs/heads/agent/task"]);
  assert.equal(args.join(" ").includes("super-secret"), false);
  assert.equal(env.GITHUB_AGENT_INSTALLATION_TOKEN, "super-secret");
  assert.match(env.GIT_ASKPASS ?? "", /askpass\.js$/);
});

test("askpass fails closed except for exact GitHub HTTPS credential prompts", () => {
  const askpass = path.resolve("dist/askpass.js");
  const run = (prompt: string) => spawnSync(askpass, [prompt], { encoding: "utf8", env: { ...process.env, GITHUB_AGENT_INSTALLATION_TOKEN: "secret" } });
  assert.deepEqual({ status: run("Username for 'https://github.com': ").status, stdout: run("Username for 'https://github.com': ").stdout }, { status: 0, stdout: "x-access-token" });
  assert.deepEqual({ status: run("Password for 'https://x-access-token@github.com': ").status, stdout: run("Password for 'https://x-access-token@github.com': ").stdout }, { status: 0, stdout: "secret" });
  assert.notEqual(run("Password for 'https://attacker.example': ").status, 0);
});

test("built npm-style bin symlink executes from a path containing spaces", () => {
  const root = mkdtempSync(path.join(tmpdir(), "agent cli bin "));
  const binDirectory = path.join(root, "node_modules", ".bin");
  mkdirSync(binDirectory, { recursive: true });
  const bin = path.join(binDirectory, "github-agent-pr");
  symlinkSync(path.resolve("dist/bin.js"), bin);
  const result = spawnSync(bin, ["merge"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /prepare or publish/);
});

test("documented npm CLI script executes the built entry point", () => {
  const result = spawnSync("npm", ["run", "cli", "--", "merge"], { cwd: path.resolve("."), encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /prepare or publish/);
});

const repo: Repository = { root: "/repo", owner: "Moonbreeze", name: "github-agent-workflow" };
test("PR orchestration creates a draft or updates only title and body", async () => {
  const createCalls: Array<{ method: string; endpoint: string; payload?: object }> = [];
  const created = await createOrUpdatePullRequest(repo, "agent/task", "main", { title: "T", body: "B" }, "token", async (method, endpoint, _token, payload) => {
    createCalls.push({ method, endpoint, payload }); return method === "GET" ? [] : {};
  });
  assert.equal(created, "created");
  assert.deepEqual(createCalls[1]?.payload, { title: "T", body: "B", head: "agent/task", base: "main", draft: true });
  const updateCalls: object[] = [];
  const updated = await createOrUpdatePullRequest(repo, "agent/task", "master", { title: "New" }, "token", async (method, _endpoint, _token, payload) => {
    if (payload) updateCalls.push(payload); return method === "GET" ? [{ number: 7, draft: false }] : {};
  });
  assert.equal(updated, "updated");
  assert.deepEqual(updateCalls, [{ title: "New", body: "" }]);
});

test("CLI exposes only prepare and publish", () => {
  assert.deepEqual(parseArgs(["prepare", "--task", "task"]), { command: "prepare", task: "task", config: undefined });
  assert.equal(parseArgs(["publish", "--title", "Title"]).command, "publish");
  for (const args of [["merge"], ["run", "git", "status"], ["prepare", "--unknown", "x"], ["publish", "--title", "T", "--body", "x", "--body-file", "y"]]) assert.throws(() => parseArgs(args), AgentError);
});
