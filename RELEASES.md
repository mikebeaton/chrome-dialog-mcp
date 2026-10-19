# Releases

## Package

The only release download is `chrome-dialog-mcp-<version>.tgz`, containing runtime source, the startup page, documentation and dependency shrinkwrap. Users install it with their existing Node.js 24+ and npm, then register the stdio MCP in Codex; see [installation](README.md#install).

Node and dependencies are not bundled: doing so would make the release far bigger and much harder to audit. npm installs the locked runtime dependencies on the user's machine.

## Versioning

Use SemVer for the MCP contract and observable broker behaviour. Continue prerelease increments, then promote to `0.2.0` after acceptance. Before 1.0, increment minor for incompatible changes and patch for compatible fixes; use normal major/minor/patch rules after 1.0.

Tags are `v<package version>`. Never move a published tag or replace an existing version's artifact. `package.json` supplies the MCP version and must match both root version fields in `npm-shrinkwrap.json`; internal IPC compatibility is versioned separately.

## Build and verify

Use Windows, Node.js 24+ and Chrome for the full validation. From the repository root:

```powershell
npm ci --ignore-scripts
npm run check
npm test
npm run release:pack
npm run release:verify
$env:CHROME_DIALOG_PACKAGE_ROOT = "$PWD/.work/release-verify/0.2.0-rc.5 installed package/node_modules/chrome-dialog-mcp"
$env:CHROME_DIALOG_INTEGRATION = '1'
node --test test/integration.test.js
```

Use the current version in the verification path. Packaging enforces an explicit file allowlist and checks package/shrinkwrap versions. Tagged builds require a clean working tree and matching tag. `dist/` receives the `.tgz`, SHA-256 checksum and source commit/dirty-state manifest; generated artifacts are ignored by Git.

Verification checks the checksum, installs the archive with npm into a disposable directory containing spaces, compares the installed runtime with the checked source and starts that installed adapter using the existing Node executable. It verifies the tool schemas and confirms inspection does not implicitly start a broker or browser. Chrome integration then exercises that installed package. No global installation or Codex configuration changes are made.

Existing artifacts and verification directories are not overwritten. Use a new version for another release; remove only disposable validation directories when deliberately repeating a local check. Manual installation and Computer Use acceptance remain separate from automated tests.

## GitHub CI

[build.yml](.github/workflows/build.yml) runs Windows syntax checks, unit/stdio tests, package build, npm installation verification and Chrome integration using that installed package. Successful runs upload the `.tgz`, checksum and build manifest. A matching pushed `v*` tag then creates a **draft** GitHub Release containing those tested files; hyphenated versions are marked prereleases. Review and publish the draft after manual acceptance. Nothing is published to npm.

For example, after updating and committing the package/shrinkwrap version:

```powershell
git tag -a v0.2.0-rc.5 -m "Chrome Dialog MCP 0.2.0-rc.5"
git push origin HEAD
git push origin v0.2.0-rc.5
```

Protect release tags and the main branch in GitHub. A manual workflow run produces downloadable artifacts without creating a release.
