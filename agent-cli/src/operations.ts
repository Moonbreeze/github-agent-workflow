import { readFileSync } from "node:fs";
import { AgentError } from "./error.js";
import { apiRequest, createAppJwt, mintCommandToken, type Request } from "./auth.js";
import { currentBranch, ensureClean, inspectRepository, pushBranch, setLocalIdentity, switchAgentBranch, taskBranch, type Runner, runProcess } from "./git.js";
import { loadConfig } from "./config.js";
import { createOrUpdatePullRequest } from "./pr.js";

export interface Dependencies { runner?: Runner; request?: Request; cwd?: string; }

export async function prepare(task: string, configPath?: string, deps: Dependencies = {}): Promise<void> {
  const runner = deps.runner ?? runProcess;
  const config = loadConfig(configPath, deps.cwd);
  const repo = await inspectRepository(config, runner, deps.cwd);
  const branch = taskBranch(task);
  await switchAgentBranch(repo, branch, runner);
  const jwt = createAppJwt(config);
  const app = await (deps.request ?? apiRequest)("GET", "/app", jwt);
  if (!app || typeof app !== "object") throw new AgentError("GitHub App response is invalid");
  const data = app as Record<string, unknown>;
  const owner = data.owner;
  if (data.id !== config.appId || typeof data.slug !== "string" || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(data.slug) || !owner || typeof owner !== "object" || (owner as Record<string, unknown>).login !== config.expectedOwner) throw new AgentError("GitHub App identity does not match configuration");
  await setLocalIdentity(repo, data.slug, config.appId, runner);
}

export async function publish(title: string, body: string | undefined, configPath?: string, deps: Dependencies = {}): Promise<"created" | "updated"> {
  const runner = deps.runner ?? runProcess;
  const request = deps.request ?? apiRequest;
  const config = loadConfig(configPath, deps.cwd);
  const repo = await inspectRepository(config, runner, deps.cwd);
  await ensureClean(repo, runner);
  const branch = await currentBranch(repo, runner);
  const jwt = createAppJwt(config);
  const token = await mintCommandToken(config, jwt, request);
  await pushBranch(repo, branch, token, runner);
  const metadata = await request("GET", `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`, token);
  const base = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>).default_branch : undefined;
  if (typeof base !== "string" || !base) throw new AgentError("GitHub repository metadata has no valid default branch");
  return createOrUpdatePullRequest(repo, branch, base, { title, body }, token, request);
}

export function readBodyFile(value: string): string {
  try { return readFileSync(value, "utf8"); } catch { throw new AgentError("Body file is not readable"); }
}
