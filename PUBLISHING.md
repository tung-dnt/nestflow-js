# Publishing nestflow-js

The [Release workflow](.github/workflows/release.yml) publishes to the npm registry on pushes to `main`. It determines the version bump from Conventional Commits. To choose a patch, minor, or major bump, run **Release** manually in GitHub Actions and select `version_type`.

## Check the release locally

Use Node.js 26 and pnpm as described in the [development setup](CONTRIBUTING.md#development-setup). From the repository root, run:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm verify:package
pnpm verify:lambda
```

The package ships `dist/`, `README.md`, and `LICENSE`. The `core`, `adapter`, and `exception` subpaths include ESM output and TypeScript declarations. The published library supports Node.js 22.12 or later with NestJS 12.

## Verify publication

The workflow updates `package.json` and `CHANGELOG.md`, pushes the release tag, publishes the package, and creates a GitHub release. Check the workflow run and confirm the version appears on the [npm registry](https://www.npmjs.com/package/nestflow-js).

To install the published version in a NestJS project, follow the [installation instructions](README.md#installation).
