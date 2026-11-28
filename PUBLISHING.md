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

The four workspaces under `packages/validator/` publish as `@nestflow-js/validator-zod`, `@nestflow-js/validator-valibot`, `@nestflow-js/validator-arktype`, and `@nestflow-js/validator-joi`. They share the core release version. `pnpm verify:package` packs each one and tests its public import with the corresponding schema library.

Before the first release, create or claim the `@nestflow-js` npm organization. Give the workflow's `NPM_TOKEN` permission to create and publish public packages in that scope as well as publish `nestflow-js`. A token restricted to the existing unscoped package cannot publish the validators.

## Verify publication

The workflow bumps all five manifests, verifies the tarballs, pushes the release tag, publishes the packages, then creates the GitHub release. Check the workflow run and the version of each package on npm. Publication is not atomic: if a publish fails, inspect the registry and publish only missing packages from the same release tag.

To install the published version in a NestJS project, follow the [installation instructions](README.md#installation).
