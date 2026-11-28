# GitHub Actions Workflows

## CI

[`ci.yml`](ci.yml) runs on pushes and pull requests targeting `main` or `develop`.
One job runs `pnpm check` and `pnpm test`, builds with `pnpm build`, then runs
`pnpm verify:package` and `pnpm verify:lambda`. Every step must pass before CI
uploads `dist/` as `build-output` for seven days.

## Release

[`release.yml`](release.yml) runs on pushes to `main`, except version bump commits,
and on manual dispatch. It runs the same checks as CI before bumping the version,
updating the changelog, committing, and tagging. It publishes the core package
and four scoped validator packages before creating the GitHub release. See
[publishing](../../PUBLISHING.md) for package names and token permissions.

To release manually, open **Actions → Release → Run workflow** and choose
`patch`, `minor`, or `major`.

## Documentation deployment

The release workflow deploys the docs to GitHub Pages after a successful release.
[`deploy-docs.yml`](deploy-docs.yml) also runs after a successful release on
`main` and deploys if `docs/` changed in the last five commits.

Both jobs use `pnpm --dir docs build` and upload `docs/out` to GitHub Pages.

## Toolchain

All jobs that install dependencies use Node.js 24 and the pnpm version in the
root `package.json` `packageManager` field. They run
`pnpm install --frozen-lockfile` at the workspace root.

## 🔧 Setup Instructions

### Step 1: Create NPM Access Token

1. Go to [npmjs.com](https://www.npmjs.com/) and log in
2. Click your profile → **Access Tokens**
3. Click **Generate New Token** → **Granular Access Token**
4. Configure:
   - **Name**: `github-actions-nestflow-js`
   - **Expiration**: 1 year (or longer)
   - **Packages and scopes**: Grant write access to `nestflow-js` and permission to create and publish packages in `@nestflow-js`.
   - **Permissions**: **Read and write**
   - **Automation**: ✅ Enable (bypasses 2FA)
5. Copy the token (starts with `npm_...`)

### Step 2: Add Token to GitHub Secrets

1. Go to your GitHub repository
2. Click **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Name: `NPM_TOKEN`
5. Value: Paste your npm token
6. Click **Add secret**


## 🔍 Monitoring

### View Workflow Runs

Go to: **Actions** tab → Select workflow → View runs

### Check Published Package

```bash
# View on NPM
open https://www.npmjs.com/package/nestflow-js

# Check version
npm view nestflow-js version

# Test installation
npm install nestflow-js@latest
```

### Verify Release

```bash
# List releases
gh release list

# View specific release
gh release view v0.0.2
```

## 🐛 Troubleshooting

### Issue: Publish fails with authentication error

**Solution**: Check NPM_TOKEN secret
```bash
# Verify token works locally
echo "//registry.npmjs.org/:_authToken=YOUR_TOKEN" > ~/.npmrc
npm whoami
```

### Issue: Build fails

**Solution**: Run build locally first
```bash
pnpm install --frozen-lockfile
pnpm build
```

### Issue: Tag already exists

**Solution**: Delete and recreate
```bash
git tag -d v0.0.2
git push origin :refs/tags/v0.0.2
```

### Issue: Permission denied

**Solution**: Check repository settings
- Settings → Actions → General
- Workflow permissions → **Read and write**

## 📊 Badge Status

Add to README.md:

```markdown
![CI](https://github.com/tung-dnt/nestflow-js/actions/workflows/ci.yml/badge.svg)
![npm version](https://img.shields.io/npm/v/nestflow-js.svg)
![npm downloads](https://img.shields.io/npm/dm/nestflow-js.svg)
```

## 🔒 Security Best Practices

1. **Use Granular Tokens**: Only grant necessary permissions
2. **Set Expiration**: Tokens should expire and be rotated
3. **Enable Automation**: Bypasses 2FA for CI/CD
4. **Limit Scope**: Only specific packages
5. **Monitor Usage**: Check npm token activity regularly

## 📝 Changelog Management

Update `CHANGELOG.md` before release:

```markdown
## [0.0.2] - 2024-12-26

### Added
- New feature X
- New feature Y

### Fixed
- Bug fix Z

### Changed
- Updated dependency A
```

## 🎯 Best Practices

1. **Always test locally** before pushing
2. **Update CHANGELOG.md** for each release
3. **Use semantic versioning** (MAJOR.MINOR.PATCH)
4. **Tag releases** for traceability
5. **Monitor Actions** for failures
6. **Keep dependencies updated**

## 📚 References

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [NPM Publishing Guide](https://docs.npmjs.com/packages-and-modules/contributing-packages-to-the-registry)
- [Semantic Versioning](https://semver.org/)
- [pnpm Documentation](https://pnpm.io/)

## 🆘 Support

For issues with workflows:
- Check [Actions logs](https://github.com/tung-dnt/nestflow-js/actions)
- Review [workflow files](./)
- Open an [issue](https://github.com/tung-dnt/nestflow-js/issues)

