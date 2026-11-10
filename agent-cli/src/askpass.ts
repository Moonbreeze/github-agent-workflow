#!/usr/bin/env node
const prompt = process.argv[2] ?? "";
if (prompt === "Username for 'https://github.com': ") process.stdout.write("x-access-token");
else if (prompt === "Password for 'https://x-access-token@github.com': ") {
  const token = process.env.GITHUB_AGENT_INSTALLATION_TOKEN;
  if (token) process.stdout.write(token);
  else process.exitCode = 1;
} else process.exitCode = 1;
