# Forgejo Issues for Herdr

A compact, read-only Forgejo browser for Herdr's side panel, with separate Issues, Pull Requests and Actions mods.

![Forgejo Issues](preview.png)

- Follows the focused terminal's repository, including worktrees and remote Unix spaces.
- Open, closed and all issues; text search; 20 issues per page.
- Sort by issue number, creation date or modification date, ascending or descending. Defaults to most recently modified; sorting applies before pagination.
- Click a tag to cycle **✓ include → ✕ exclude → unfiltered**. Filters combine.
- Ready labels are green, In Progress blue and Refinement red.
- Click an issue to open it in your default browser.
- PRs show open/draft/merged/closed states and source/target branches. Actions show workflow, ref and run status.
- Actions status buttons combine with OR (for example running + success + waiting); All clears the selection. Search has its own row. Runs show start/finish timestamps in UTC and duration or running elapsed time. Blue means running, green success, red failure/cancelled and yellow waiting. Successful CI alone does not establish that a PR is mergeable.
- Related-item buttons switch panels and filter to linked issues, PRs or runs. Clear link restores the full list.
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

For the full suite, install all three folders under `mods/` and add panel blocks and toggles for `forgejo-issues`, `forgejo-prs` and `forgejo-actions`. Each companion mod is self-contained. No full layout or custom editor is bundled. Existing mods with the same name must be renamed or backed up before installation.

## Linking and limits

PR title/body references to existing issues create bidirectional links, labelled “mentioned in PR”; these do not claim a closing relationship. Runs link to PRs through API event metadata or an exact head/merge commit match. Issue-to-run links are then derived through that PR. Branch name similarity never creates links. Foreign-repository references are not treated as local issue numbers. Timeline-only and comment-only references are not currently indexed.

Links cover fetched records only: at most 5,000 issues, 5,000 PRs and the latest 500 runs. The footer shows `+` when that panel's result limit is reached. Some older servers or tokens cannot list Actions; partial failures are shown while the other data stays usable. Separate datasets fetch in parallel. No merge/rerun/cancel buttons are provided.

Initial loading first shows up to 100 recently updated items from the selected panel. History and links load separately in the background. Until that finishes, sorting/filtering covers the initial subset and the footer shows `+`. A failed or timed-out history lookup keeps the loaded list, shows an error and waits for manual Refresh instead of restarting on every redraw.

## Access and storage

The mod runs Git and a Python helper, reads `.env` outside its own folder, and makes authenticated read-only HTTPS requests to Forgejo. Remote execution goes through Herdr. Credentials stay inside the helper, are not passed in command arguments, and are not printed or cached. HTTP redirects are refused. Issue data is cached in memory only. Browsing launches the local default browser; no issues are edited or posted.

A refresh failure can display cached results. Tokens with missing permissions, absent Python, offline machines and non-Git folders produce an error in the panel. The token also needs read access to Actions to populate the workflow panel.

## Development

```sh
python -m unittest discover -s tests
herdr-app check mods/forgejo-issues
herdr-app check mods/forgejo-prs
herdr-app check mods/forgejo-actions
```

Run `python sync_panels.py` after modifying the shared Issues view or backend; it regenerates the self-contained companion copies.

License: MIT. UI editing workflow was inspired by community Herdr mods; this package contains the Forgejo mod only, with no copied tab-bar code or icons.
