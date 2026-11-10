import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { AgentError } from "./error.js";
import type { Config } from "./config.js";

export const COMMAND_PERMISSIONS = { metadata: "read", contents: "write", pull_requests: "write" } as const;
export type Request = (method: string, path: string, token: string, payload?: object) => Promise<unknown>;

function b64url(value: string | Buffer): string { return Buffer.from(value).toString("base64url"); }

export function createAppJwt(config: Config, now = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: config.appId }));
  const input = `${header}.${payload}`;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(input);
    signer.end();
    return `${input}.${signer.sign(readFileSync(config.privateKeyPath)).toString("base64url")}`;
  } catch { throw new AgentError("Unable to sign the GitHub App JWT"); }
}

export const apiRequest: Request = async (method, apiPath, token, payload) => {
  if (!apiPath.startsWith("/")) throw new AgentError("Invalid internal GitHub API path");
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${apiPath}`, {
      method,
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "github-agent-pr", ...(payload ? { "Content-Type": "application/json" } : {}) },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch { throw new AgentError("GitHub API request failed (network error)"); }
  if (!response.ok) throw new AgentError(`GitHub API request failed (HTTP ${response.status})`);
  try { return await response.json(); } catch { throw new AgentError("GitHub API returned an invalid response"); }
};

export async function mintCommandToken(config: Config, jwt: string, request: Request = apiRequest): Promise<string> {
  const result = await request("POST", `/app/installations/${config.installationId}/access_tokens`, jwt, { repositories: config.allowedRepositories, permissions: COMMAND_PERMISSIONS });
  const token = result && typeof result === "object" ? (result as Record<string, unknown>).token : undefined;
  if (typeof token !== "string" || !token) throw new AgentError("GitHub API did not return an installation token");
  return token;
}
