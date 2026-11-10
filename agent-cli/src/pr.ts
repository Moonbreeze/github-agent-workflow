import { AgentError } from "./error.js";
import type { Request } from "./auth.js";
import type { Repository } from "./git.js";

export interface PublishText { title: string; body?: string; }

export async function createOrUpdatePullRequest(repo: Repository, branch: string, base: string, text: PublishText, token: string, request: Request): Promise<"created" | "updated"> {
  const repositoryPath = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  const found = await request("GET", `${repositoryPath}/pulls?state=open&head=${encodeURIComponent(`${repo.owner}:${branch}`)}`, token);
  if (!Array.isArray(found) || found.some(item => !item || typeof item !== "object")) throw new AgentError("GitHub pull request response is invalid");
  if (found.length > 1) throw new AgentError("Multiple open pull requests exist for the agent branch");
  if (found.length === 0) {
    await request("POST", `${repositoryPath}/pulls`, token, { title: text.title, body: text.body ?? "", head: branch, base, draft: true });
    return "created";
  }
  const number = (found[0] as Record<string, unknown>).number;
  if (!Number.isSafeInteger(number) || (number as number) <= 0) throw new AgentError("GitHub pull request response is invalid");
  await request("PATCH", `${repositoryPath}/pulls/${number}`, token, { title: text.title, body: text.body ?? "" });
  return "updated";
}
