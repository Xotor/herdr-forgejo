# Forgejo Issues for Herdr

A compact, read-only Forgejo issue browser for Herdr's side panel.

![Forgejo Issues](preview.png)

- Follows the focused terminal's repository, including worktrees and remote Unix spaces.
- Open, closed and all issues; text search; 20 issues per page.
- Click a tag to cycle **✓ include → ✕ exclude → unfiltered**. Filters combine.
- Ready labels are green, In Progress blue and Refinement red.
- Click an issue to open it in your default browser.
- Reads the base checkout's `.env`; worktrees share repository-wide issues and credentials.

## Requirements

Herdr app 0.1.16 or newer, Git, and Python 3.10+ (`python` on Windows, `python3` on macOS/Linux and remote Unix machines). The local Windows runtime and remote Unix loading have been exercised during development; macOS/Linux browser opening uses platform commands but has not been live-tested.

## Configuration

In the **base checkout**, create a Git-ignored `.env`:

```dotenv
FORGEJO_TOKEN=your-read-only-token
# Optional: inferred from the Git remote when absent
FORGEJO_URL=https://forge.example
# Optional: select a remote other than origin
FORGEJO_REMOTE=origin
```

Use a token with read access to the repository, issues and labels. The URL must use HTTPS; supply it for SSH host aliases or a reverse-proxy base path. Remote machines read their own base checkout's `.env`. GitHub/GitLab/Bitbucket remotes are rejected when they conflict with the configured Forgejo host.

## Install with your agent

Ask your agent to read `RECIPE.md`, inspect the mod files, and install `mods/forgejo-issues` into your Herdr app home. Add it to your existing side-panel stack beside Files and Changes, with an Issues button. Preserve your existing layout and mods by cloning shipped files before editing. The recipe gives the integration details.

The mod also works in a standalone pane:

```sh
herdr-app do pane.split --direction right --mod forgejo-issues
```

No full layout or custom editor is bundled. Existing mods with the same name must be renamed or backed up before installation.

## Access and storage

The mod runs Git and a Python helper, reads `.env` outside its own folder, and makes authenticated read-only HTTPS requests to Forgejo. Remote execution goes through Herdr. Credentials stay inside the helper, are not passed in command arguments, and are not printed or cached. HTTP redirects are refused. Issue data is cached in memory only. Browsing launches the local default browser; no issues are edited or posted.

Issue fetching is bounded to 100 pages of 50; a `+` suffix on the total indicates the limit. A refresh failure can display cached results. Tokens with missing permissions, absent Python, offline machines and non-Git folders produce an error in the panel.

## Development

```sh
python -m unittest discover -s tests
herdr-app check mods/forgejo-issues
```

License: MIT. UI editing workflow was inspired by community Herdr mods; this package contains the Forgejo mod only, with no copied tab-bar code or icons.
