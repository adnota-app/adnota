# Release workflow

`release.yml` builds the extension zip and publishes a GitHub Release whenever a tag matching `v*` is pushed. The zip is the artifact you upload to the Chrome Web Store.

## What it does

1. **Verifies version sync.** Reads `manifest.json` and the tag name (e.g. `v0.9.0`). The numeric parts must match — otherwise the Chrome Web Store will reject the upload, so we catch it here.
2. **Runs `npm ci && npm run build`** to produce a minified copy of the extension under `dist/`. `tools/build.sh` controls exactly what lands there (per-file minified JS + CSS, plus manifest, icons, fonts, HTML, LICENSE), so stray dev files (notes, TODO, screenshots) never ship — they're never in `dist/` in the first place.
3. **Builds a zip** of `dist/` contents at the zip root (Chrome Web Store requires manifest.json at the top level, not nested in a directory).
4. **Creates a GitHub Release** with the zip attached and release notes auto-generated from commit messages since the previous tag.
5. **Pre-release detection.** Any tag containing a `-` (semver pre-release: `v0.9.0-rc.1`, `v1.0.0-beta`) is flagged as a pre-release so it doesn't replace "Latest" on the repo page.

## Cutting a release

```bash
# 1. Make sure manifest.json's "version" matches the tag you're about to create.
#    Edit if needed, commit, push.

# 2. Tag and push.
git tag v0.9.0
git push origin v0.9.0
```

The workflow runs in ~30 seconds. When it finishes:

- A Release appears at `https://github.com/adnota-app/adnota/releases/tag/v0.9.0`
- `adnota-v0.9.0.zip` is attached
- Release notes are populated from your commit messages

Grab the zip and upload it at https://chrome.google.com/webstore/devconsole/.

## Replacing a release

If you tagged something and want to redo it:

```bash
# Delete locally and on the remote
git tag -d v0.9.0
git push origin :refs/tags/v0.9.0

# Delete the GitHub Release: Releases → click the release → ⋯ → Delete release.
# (The tag-delete above already removed the tag the release was attached to,
# but the release record itself can linger as "draft from deleted tag" — clean
# it up via the UI.)

# Re-tag from the new commit and push
git tag v0.9.0
git push origin v0.9.0
```

A cleaner pattern when you expect to iterate: use pre-release tags for builds you might throw away, then the bare version for the keeper.

```
v0.9.0-rc.1   ← pre-release, can replace freely
v0.9.0-rc.2   ← pre-release
v0.9.0        ← "real" 0.9.0 release, marked as Latest
```

Each pre-release tag creates a distinct Release that doesn't compete with "Latest" — you just delete the ones you don't want.

## Version conventions

- `0.x.x` — pre-launch / pre-1.0 builds. Currently we're at `0.9.0`.
- `1.0.0` — reserved for actual launch.
- `1.x.x` — post-launch iteration.
- `-rc.N`, `-beta`, `-alpha` — pre-release suffixes; auto-flagged as pre-release.

Keep `manifest.json`'s `"version"` field in lockstep with the tag's numeric base. The workflow's verify step refuses to build if they drift.

## What's NOT in the zip

`tools/build.sh` is the single source of truth for what ships. Anything it doesn't explicitly copy or minify into `dist/` is excluded. Currently that means:

- `notes.md`, `TODO`, `product_plan.md`, `selection.txt`, `PAINT notes.md`
- `tools/` (build scripts themselves don't ship)
- `README.md` (the top-level project readme)
- `image.png`, `bla` (stray files)
- `.git`, `.github`, `.claude`, `.DS_Store`, `.gitignore`
- `package.json`, `package-lock.json`, `node_modules/`

If you add new top-level directories that should ship (e.g. a future `_locales/`), update `tools/build.sh` to copy or minify them into `dist/`.

## Future: auto-upload to Chrome Web Store

Adding a `chrome-webstore-upload-cli` step after the release-create step would make tag → tagged release → submitted Web Store version fully automatic. Requires a Google API client ID, secret, and refresh token stored as GitHub Actions secrets. Worth doing once we're shipping more than once a month; overkill for now.
