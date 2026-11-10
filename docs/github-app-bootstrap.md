# GitHub App bootstrap runbook

This is an owner-operated bootstrap for one private GitHub App. Creation,
installation, repository selection, and private-key download must be performed
by a Moonbreeze owner in GitHub's UI. The scripts in this repository do not
perform those actions.

Never paste an App private key, JWT, installation token, or other secret into
logs, Git, pull requests, issues, or chat. Do not put local credential files in
this or any other Git repository.

## 1. Create the App (Moonbreeze owner)

In **Moonbreeze organization settings → Developer settings → GitHub Apps**, use
**New GitHub App** and configure:

- GitHub App name: start with **moonbreeze-coding-agent**. If that globally
  unique name is unavailable, append a non-secret, unique,
  Moonbreeze-controlled suffix and record the resulting name in Moonbreeze's
  owner records.
- Owner: **Moonbreeze**
- Homepage URL: **https://github.com/Moonbreeze/github-agent-workflow**
- Callback URL: leave blank
- Setup URL: leave blank
- User authorization/request during installation: disabled
- Device flow: disabled
- Visibility: **Only on this account** (private; not public/marketplace)
- Webhooks: **disabled** (`Active` unchecked); do not add a webhook secret
- Repository permissions:
  - Metadata: **Read-only** (mandatory GitHub permission)
  - Contents: **Read and write**
  - Pull requests: **Read and write**
  - Checks: **No access**
- Every account, organization, and repository permission category not
  explicitly approved above: **No access**. In particular, grant no
  Administration, Secrets, Members, or Workflows permission.

Do not grant repository administration, branch-protection bypass, or any role
or permission intended to bypass repository rules. Record the numeric App ID;
it is an identifier, not a private key, but do not substitute guessed values.

## 2. Install the App (Moonbreeze owner)

Install it only on the **Moonbreeze** account. Choose **Only select
repositories**, select exactly **Moonbreeze/github-agent-workflow**, and select
nothing else. Record the numeric installation ID from the installation URL or
installation details.

Return to the App settings and generate/download one private key. Key download
is an owner action. Transfer it to the local operator using an approved secret
channel; never send it through Git, a PR, logs, or chat. Delete unneeded keys
in GitHub after confirming which key is in use.

## 3. Store local credentials (local operator)

The default directory is:

```sh
${XDG_CONFIG_HOME:-$HOME/.config}/github-agent-workflow/
```

It and the key's containing directory must be outside every Git repository.
Create the directory with mode `0700`. Store the downloaded PEM key there with
mode `0600`. Create `config.json` there with mode `0600`, based on the tracked
[`config.example.json`](../config.example.json):

```json
{
  "app_id": 123456,
  "installation_id": 12345678,
  "expected_owner": "Moonbreeze",
  "allowed_repositories": ["github-agent-workflow"],
  "private_key_path": "/home/OPERATOR/.config/github-agent-workflow/github-app.private-key.pem"
}
```

Replace all example values locally. `private_key_path` must be an absolute path.
Do not commit the completed file. A typical setup is:

```sh
chmod 700 "${XDG_CONFIG_HOME:-$HOME/.config}/github-agent-workflow"
chmod 600 "${XDG_CONFIG_HOME:-$HOME/.config}/github-agent-workflow/github-app.private-key.pem"
chmod 600 "${XDG_CONFIG_HOME:-$HOME/.config}/github-agent-workflow/config.json"
```

The config schema is exact: it must contain precisely `app_id`,
`installation_id`, `expected_owner`, `allowed_repositories`, and
`private_key_path`, with no missing or extra fields. In this bootstrap,
`expected_owner` is fixed to `Moonbreeze`, and `allowed_repositories` is fixed
to only `github-agent-workflow`.

Neither the config nor private-key path may contain a symbolic-link component.
The config and key must each be regular files with exactly one hard link and
mode `0600`; their containing directories must have mode `0700`. These checks
are applied to each credential file before that file is read or otherwise used.

The helper accepts an alternate config only through `--config PATH`; the same
location and mode rules apply.

Creating these directories and local files performs no network access. Network
access begins only when the operator invokes one of the scripts in the next
section.

## 4. Verify before use

Run:

```sh
python3 scripts/verify-github-app-installation.py
```

To verify an alternate configuration, use the exact syntax:

```sh
python3 scripts/verify-github-app-installation.py --config PATH
```

The verifier performs one ephemeral installation-token issuance `POST`. That
token requests only Metadata read and deliberately has no repository filter so
extra installed repositories remain visible. It then uses inspection-only
`GET` requests to read the App and installation identity, installation
repository selection, every accessible repository, and returned permission
maps. It changes no App, installation, or repository configuration. It
requires Moonbreeze ownership, `selected` repository mode, exactly the
configured repository, and exactly the three expected permission entries and
levels.

The API observations are a point-in-time check. The owner must still inspect
the GitHub UI to confirm the App visibility remains **Only on this account**
(private), webhooks remain disabled, no organization/repository role or
ruleset grants branch-protection bypass, no extra repositories are set for
future installation, and no separate credential or policy has expanded
access. Private visibility and branch-protection/ruleset bypass cannot be
established by the App and installation endpoints used by the verifier. Re-run
verification after any App or installation change.

Verification is a separately invoked preflight. The command wrapper does not
run it automatically.

To run a command, without printing or persisting its token:

```sh
python3 scripts/with-github-app-token.py -- COMMAND [ARGS...]
```

The command token is explicitly restricted to the configured repository names
and exactly the approved Metadata, Contents, and Pull requests permission
levels.

Invoking either script begins network access to GitHub for token issuance. The
verifier performs its one token-issuance `POST` followed by inspection `GET`
requests. A command run by the wrapper may make additional network requests.
The Python bootstrap remains inspection-oriented and unchanged. It does not
push branches, create pull requests, or merge.

## 5. Prepare and publish an agent branch (optional local CLI)

With Node.js 24 or newer and Git installed, run `npm install` and `npm run
build` in `agent-cli/`. The CLI uses the same documented configuration fields,
fixed values, and credential security rules as the Python bootstrap. The public
reference pilot completed successfully on 2026-11-10 through PR #1. The App bot
authored and pushed the agent branch and opened the PR; the server-side ruleset
rejected a direct `main` update; the owner independently approved; a later App
commit dismissed the stale approval; and the owner re-approved and merged. The
pilot did not use CI: the agreed local checks were visible in the PR body.

```sh
npm run cli -- prepare --task TASK-SLUG [--config PATH]
# make and commit the intended changes
npm run cli -- publish --title "TITLE" [--body "TEXT" | --body-file PATH] [--config PATH]
```

`prepare` requires a clean worktree and performs credential, exact
origin-owner, allowlist, task, and target-branch checks locally before its
authenticated `GET /app`. It works only with `agent/TASK-SLUG` and configures
bot identity with repository-local Git configuration.

`publish` requires an HTTPS GitHub fetch origin and checks the allowlisted
origin, absence of a separate push URL or Git URL rewrites, clean worktree, and current
`agent/TASK-SLUG` locally before minting a token or making an API request. Its
installation token is limited to the configured repository with Metadata read,
Contents write, and Pull requests write. Git receives it only through a
process-scoped askpass environment, not in arguments, remote configuration,
output, or persistent credential storage. The push uses the validated
repository's canonical HTTPS URL, disables credential helpers, bypasses
pre-push hooks, and accepts only expected GitHub HTTPS credential prompts. SSH
fetch origins are rejected. Only the current agent branch is pushed. The CLI
uses the repository `default_branch` as the PR base, creates a draft PR when
none exists, updates only title/body on the sole open PR for the head without
forcibly converting it back to draft, and rejects multiple matches. The branch
push occurs before PR API creation or update, so a later API failure may leave
a pushed branch without a PR; rerun `publish` to recover.

`main` and `master` are valid PR bases but protected from pushes. The CLI has no
merge command or behavior and cannot wrap arbitrary commands.
