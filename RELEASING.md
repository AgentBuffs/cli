# Releasing

Every published version is a git tag `vX.Y.Z` with release notes. The `latest`
version on npm is always the newest tag. Every build carries npm provenance, so
anyone can verify which commit and workflow produced it.

Only the release workflow publishes. Do not run `npm publish` for normal
releases.

## Release a version

1. Add release notes to `CHANGELOG.md`. Insert a heading `## [x.y.z] - unreleased`
   above the previous release, followed by `Added`, `Changed` or `Fixed` sections.
   Add the comparison link at the bottom:
   `[x.y.z]: https://github.com/agentbuffs/cli/compare/vPREVIOUS...vx.y.z`.
2. Commit the changes and the notes to `main`. Push `main`.
3. Run:

   ```sh
   pnpm release x.y.z
   ```

   The script verifies that the working tree is clean, the branch is `main` and matches
   `origin/main`, the tag does not exist, `x.y.z` exceeds the version in
   `package.json`, and `CHANGELOG.md` contains an `unreleased` entry for it.
   Then it:

   - replaces the heading with today's date,
   - updates the version in `package.json` (`--version` reads this at build time),
   - runs `pnpm check` and reverts both files if checks fail,
   - commits `chore(release): x.y.z`,
   - creates the annotated tag `vx.y.z`.

   The script does not push.
4. Push the commit and the tag:

   ```sh
   git push origin main --follow-tags
   ```

5. The workflow `.github/workflows/release.yml` triggers on the tag. It verifies
   that the tag matches `v` plus the `package.json` version, installs with the frozen
   lockfile, runs `pnpm check`, publishes with `npm publish --provenance`, and
   creates the GitHub Release using the changelog section. Track progress
   in the Actions tab.
6. Verify the published package:

   ```sh
   npm view agentbuffs version        # x.y.z
   npm view agentbuffs dist-tags      # latest: x.y.z
   ```

   The npm package page shows the provenance badge.
7. Update the installer pin. In the agentbuffs site repository, set `INSTALLER_VERSION`
   in `app/lib/site.ts` to `x.y.z` and deploy. This variable controls which version
   `curl -fsSL https://agentbuffs.com/install | sh` installs. Without this change,
   the script continues to serve the old version.

If the workflow fails after publishing to npm, rerun the job. It detects the
existing npm version, skips the publish step, and creates or updates the
GitHub Release.

## One-time setup: npm trusted publishing

The workflow does not use an `NPM_TOKEN`. npm trusts the repository workflow directly.
Configure this once as a package owner:

1. Open npmjs.com, go to `agentbuffs`, then Settings.
2. Under Trusted publishing, select GitHub Actions.
3. Configure the fields:
   - Organization or user: `AgentBuffs`
   - Repository: `cli`
   - Workflow filename: `release.yml`
   - Environment: leave empty
4. Save.

Trusted publishing requires npm 11.5.1 or newer. The workflow updates npm if
the runner image provides an older version.

Optional, after the first successful release: on the same Settings page, require
two-factor authentication and disable tokens. This restricts publish permissions
to the workflow and users with 2FA.

## If the workflow is down

Publish manually, then create the tag and release.

1. Run `pnpm release x.y.z`. The script runs checks, commits, and tags.
2. Authenticate with `npm login` and publish using your 2FA code:

   ```sh
   npm publish --access public
   ```

   This manual build will lack provenance.
3. Push changes: `git push origin main --follow-tags`. When the workflow recovers, it
   detects the published version on npm, skips publishing, and creates the GitHub
   Release. To create the release manually:

   ```sh
   node scripts/release.mjs notes x.y.z > /tmp/notes.md
   gh release create vx.y.z --verify-tag --title "agentbuffs x.y.z" --notes-file /tmp/notes.md
   ```

4. Complete step 7 above.

## Rules

- Never move or delete a pushed tag. If a release contains errors, fix the
  underlying issue and publish the next patch version. Deprecate the broken version
  with `npm deprecate`.
- Never publish from any branch besides `main`, and never use another dist-tag.
  This ensures `latest` tracks the most recent tag.
