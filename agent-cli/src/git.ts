import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AgentError } from "./error.js";
import type { Config } from "./config.js";

export interface RunResult { code: number; stdout: string; }
export type Runner = (command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<RunResult>;

export const runProcess: Runner = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", () => {});
  child.on("error", () => reject(new AgentError("Unable to execute a required local command")));
  child.on("close", code => resolve({ code: code ?? 1, stdout }));
});

async function git(runner: Runner, cwd: string | undefined, args: string[], allowed = [0]): Promise<RunResult> {
  const result = await runner("git", args, { cwd });
  if (!allowed.includes(result.code)) throw new AgentError("Required local Git operation failed");
  return result;
}

export interface Repository { root: string; owner: string; name: string; }

export function parseOrigin(value: string): { owner: string; name: string } {
  const remote = value.trim();
  let owner: string | undefined;
  let name: string | undefined;
  let parsed: URL;
  try { parsed = new URL(remote); } catch { throw new AgentError("Origin must be an HTTPS GitHub URL"); }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.port || parsed.search || parsed.hash || parsed.username || parsed.password) throw new AgentError("Origin must be an HTTPS GitHub URL");
  const parts = parsed.pathname.replace(/^\//, "").split("/");
  if (parts.length === 2) { owner = parts[0]; name = parts[1].replace(/\.git$/, ""); }
  if (!owner || !name || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) throw new AgentError("Origin is not a supported GitHub repository URL");
  return { owner, name };
}

export async function inspectRepository(config: Config, runner: Runner = runProcess, cwd = process.cwd()): Promise<Repository> {
  const rootResult = await git(runner, cwd, ["rev-parse", "--show-toplevel"]);
  const root = rootResult.stdout.trim();
  if (!root) throw new AgentError("Current directory is not a Git worktree");
  const originOutput = (await git(runner, root, ["remote", "get-url", "--all", "origin"])).stdout;
  const originUrls = (originOutput.endsWith("\n") ? originOutput.slice(0, -1) : originOutput).split("\n");
  if (originUrls.length !== 1) throw new AgentError("Origin must configure exactly one URL");
  const originUrl = originUrls[0];
  const origin = parseOrigin(originUrl);
  if (origin.owner !== config.expectedOwner || !config.allowedRepositories.includes(origin.name)) throw new AgentError("Origin repository is not in the configured allowlist");
  if (originUrl !== `https://github.com/${origin.owner}/${origin.name}.git`) throw new AgentError("Origin must be the exact canonical GitHub HTTPS URL");
  const pushUrls = await git(runner, root, ["config", "--get-all", "remote.origin.pushurl"], [0, 1]);
  if (pushUrls.code === 0 || pushUrls.stdout.trim()) throw new AgentError("Origin must not configure a separate push URL");
  const rewrites = await git(runner, root, ["config", "--get-regexp", "^url\\..*\\.(pushinsteadof|insteadof)$"], [0, 1]);
  if (rewrites.code === 0 || rewrites.stdout.trim()) throw new AgentError("Git URL rewrites are not allowed for publishing");
  return { root, ...origin };
}

export function taskBranch(task: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(task)) throw new AgentError("Task must be a lowercase slug using letters, digits, and hyphens");
  const branch = `agent/${task}`;
  assertPushableBranch(branch);
  return branch;
}

export function assertPushableBranch(branch: string): void {
  if (branch === "main" || branch === "master" || !/^agent\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(branch)) throw new AgentError("Current branch must be a valid agent/<task> branch and cannot be main or master");
}

export async function ensureClean(repo: Repository, runner: Runner = runProcess): Promise<void> {
  if ((await git(runner, repo.root, ["status", "--porcelain"])).stdout.trim()) throw new AgentError("Git worktree must be clean");
}

export async function currentBranch(repo: Repository, runner: Runner = runProcess): Promise<string> {
  const branch = (await git(runner, repo.root, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
  assertPushableBranch(branch);
  return branch;
}

export async function switchAgentBranch(repo: Repository, branch: string, runner: Runner = runProcess): Promise<void> {
  await ensureClean(repo, runner);
  const current = (await git(runner, repo.root, ["symbolic-ref", "--quiet", "--short", "HEAD"], [0, 1])).stdout.trim();
  if (current === branch) return;
  const exists = await git(runner, repo.root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], [0, 1]);
  await git(runner, repo.root, exists.code === 0 ? ["switch", branch] : ["switch", "-c", branch]);
}

export async function setLocalIdentity(repo: Repository, slug: string, appId: number, runner: Runner = runProcess): Promise<void> {
  await git(runner, repo.root, ["config", "--local", "user.name", `${slug}[bot]`]);
  await git(runner, repo.root, ["config", "--local", "user.email", `${appId}+${slug}[bot]@users.noreply.github.com`]);
}

export async function pushBranch(repo: Repository, branch: string, token: string, runner: Runner = runProcess): Promise<void> {
  assertPushableBranch(branch);
  const askpass = fileURLToPath(new URL("./askpass.js", import.meta.url));
  const env = { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: "0", GITHUB_AGENT_INSTALLATION_TOKEN: token };
  const destination = `https://github.com/${repo.owner}/${repo.name}.git`;
  const result = await runner("git", ["-c", "credential.helper=", "-c", "credential.interactive=never", "-c", "credential.useHttpPath=false", "push", "--no-verify", destination, `HEAD:refs/heads/${branch}`], { cwd: repo.root, env });
  if (result.code !== 0) throw new AgentError("Git push failed");
}
