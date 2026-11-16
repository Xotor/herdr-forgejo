# Forgejo Pull Requests

Use the root RECIPE.md for the shared panel design. Install this folder as `mods/forgejo-prs`, add a `forgejo-prs` child to `panel-body`, and add a PRs toggle. Keep all three mods installed for in-app related-item navigation. This panel shows repository-wide PRs, state, source/target refs, labels and links. Filter by open, draft, merged, closed or all; search and sort before pagination. It reads the base checkout's .env and fetches read-only API data. It never merges, edits or reviews a PR. See README.md for link provenance and limits.
