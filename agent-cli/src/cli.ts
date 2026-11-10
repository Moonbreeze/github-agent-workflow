import { AgentError } from "./error.js";
import { prepare, publish, readBodyFile } from "./operations.js";

type Parsed = { command: "prepare"; task: string; config?: string } | { command: "publish"; title: string; body?: string; config?: string };

export function parseArgs(args: string[]): Parsed {
  const command = args.shift();
  if (command !== "prepare" && command !== "publish") throw new AgentError("Command must be exactly prepare or publish; merge is not supported");
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    const allowed = command === "prepare" ? ["--task", "--config"] : ["--title", "--body", "--body-file", "--config"];
    if (!allowed.includes(option) || value === undefined || value.startsWith("--") || values.has(option)) throw new AgentError(`Invalid ${command} arguments`);
    values.set(option, value);
  }
  if (command === "prepare") {
    const task = values.get("--task");
    if (!task) throw new AgentError("prepare requires --task <slug>");
    return { command, task, config: values.get("--config") };
  }
  const title = values.get("--title");
  if (!title) throw new AgentError("publish requires --title <text>");
  if (values.has("--body") && values.has("--body-file")) throw new AgentError("Use only one of --body or --body-file");
  const body = values.has("--body-file") ? readBodyFile(values.get("--body-file")!) : values.get("--body");
  return { command, title, body, config: values.get("--config") };
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArgs([...args]);
    if (parsed.command === "prepare") { await prepare(parsed.task, parsed.config); process.stdout.write("Agent branch prepared.\n"); }
    else { const result = await publish(parsed.title, parsed.body, parsed.config); process.stdout.write(`Draft pull request ${result}.\n`); }
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof AgentError ? error.message : "Unexpected failure"}\n`);
    return 1;
  }
}
