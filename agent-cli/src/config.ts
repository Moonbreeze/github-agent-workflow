import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { AgentError } from "./error.js";

export const EXPECTED_OWNER = "Moonbreeze";
export const EXPECTED_REPOSITORIES = ["github-agent-workflow"] as const;
const CONFIG_KEYS = ["allowed_repositories", "app_id", "expected_owner", "installation_id", "private_key_path"];

export interface Config {
  appId: number;
  installationId: number;
  expectedOwner: string;
  allowedRepositories: string[];
  privateKeyPath: string;
  path: string;
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "github-agent-workflow", "config.json");
}

function absoluteLexical(value: string, cwd = process.cwd()): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return `${homedir()}${path.sep}${value.slice(2)}`;
  return path.isAbsolute(value) ? value : `${cwd}${path.sep}${value}`;
}

function rejectSymlinkComponents(value: string, kind: string): void {
  const parsed = path.parse(value);
  let current = parsed.root;
  for (const component of value.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let info;
    try { info = lstatSync(current); } catch { throw new AgentError(`Required local ${kind} is unavailable`); }
    if (info.isSymbolicLink()) throw new AgentError(`Local ${kind} path must not contain symbolic links`);
  }
}

function credentialStat(value: string, mode: number, kind: string, directory: boolean): void {
  let info;
  try { info = lstatSync(value); } catch { throw new AgentError(`Required local ${kind} is unavailable`); }
  if (info.isSymbolicLink()) throw new AgentError(`Local ${kind} must not be a symbolic link`);
  if (directory ? !info.isDirectory() : !info.isFile()) throw new AgentError(`Local ${kind} must be a ${directory ? "directory" : "regular file"}`);
  if (!directory && info.nlink !== 1) throw new AgentError(`Local ${kind} must not have multiple hard links`);
  const actual = info.mode & 0o7777;
  if (actual !== mode) throw new AgentError(`Insecure ${kind} mode: expected ${mode.toString(8).padStart(4, "0")}, found ${actual.toString(8).padStart(4, "0")}`);
}

function gitRootContaining(value: string): string | undefined {
  let current = value;
  try { if (!lstatSync(current).isDirectory()) current = path.dirname(current); } catch { current = path.dirname(current); }
  for (;;) {
    try {
      lstatSync(path.join(current, ".git"));
      return current;
    } catch { /* continue */ }
    try {
      if (lstatSync(path.join(current, "HEAD")).isFile() && lstatSync(path.join(current, "objects")).isDirectory() && lstatSync(path.join(current, "refs")).isDirectory()) return current;
    } catch { /* continue */ }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function validateOutsideGit(value: string, label: string, currentRoot?: string): void {
  if (currentRoot && (value === currentRoot || value.startsWith(currentRoot + path.sep))) throw new AgentError(`${label} must not be inside the current Git worktree`);
  if (gitRootContaining(value)) throw new AgentError(`${label} must be outside all Git repositories`);
}

export function loadConfig(value?: string, cwd = process.cwd()): Config {
  const configPath = absoluteLexical(value ?? defaultConfigPath(), cwd);
  const currentRoot = gitRootContaining(realpathSync(cwd));
  rejectSymlinkComponents(configPath, "config file");
  credentialStat(path.dirname(configPath), 0o700, "credential directory", true);
  credentialStat(configPath, 0o600, "config file", false);
  const canonicalConfig = realpathSync(configPath);
  validateOutsideGit(configPath, "Config file", currentRoot);
  validateOutsideGit(canonicalConfig, "Config file", currentRoot);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(configPath, "utf8")); } catch { throw new AgentError("Config file is not readable valid JSON"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || JSON.stringify(Object.keys(raw).sort()) !== JSON.stringify(CONFIG_KEYS)) throw new AgentError("Config must contain exactly the documented fields");
  const data = raw as Record<string, unknown>;
  for (const name of ["app_id", "installation_id"]) {
    if (!Number.isSafeInteger(data[name]) || (data[name] as number) <= 0) throw new AgentError(`Config field ${name} must be a positive integer`);
  }
  if (data.expected_owner !== EXPECTED_OWNER) throw new AgentError(`Config expected_owner must be ${EXPECTED_OWNER}`);
  if (!Array.isArray(data.allowed_repositories) || JSON.stringify(data.allowed_repositories) !== JSON.stringify(EXPECTED_REPOSITORIES)) throw new AgentError("Config allowed_repositories must contain only github-agent-workflow");
  if (typeof data.private_key_path !== "string" || !data.private_key_path || !path.isAbsolute(data.private_key_path)) throw new AgentError("Config private_key_path must be a non-empty absolute path");
  const keyPath = absoluteLexical(data.private_key_path);
  rejectSymlinkComponents(keyPath, "private key");
  credentialStat(path.dirname(keyPath), 0o700, "private-key directory", true);
  credentialStat(keyPath, 0o600, "private key", false);
  const canonicalKey = realpathSync(keyPath);
  validateOutsideGit(keyPath, "Private key", currentRoot);
  validateOutsideGit(canonicalKey, "Private key", currentRoot);
  return { appId: data.app_id as number, installationId: data.installation_id as number, expectedOwner: data.expected_owner, allowedRepositories: [...EXPECTED_REPOSITORIES], privateKeyPath: canonicalKey, path: canonicalConfig };
}
