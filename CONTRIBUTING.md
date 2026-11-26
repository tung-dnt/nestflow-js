# Contributing to nestflow-js

## Development setup

Use Node.js 26 at the version pinned in [`.node-version`](.node-version). Use pnpm 12.23.0, pinned in `package.json`.

1. **Clone the repository**
   ```bash
   git clone https://github.com/tung-dnt/nestflow-js.git
   cd nestflow-js
   ```

2. **Install dependencies for the library, docs, and Lambda example from the repository root**
   ```bash
   pnpm install --frozen-lockfile
   ```

3. **Run tests**
   ```bash
   pnpm test
   ```

4. **Build the package**
   ```bash
   pnpm build
   ```

Run `pnpm --dir docs dev` from the repository root to preview the docs.

## Project Structure

```
nestflow-js/
├── packages/               # Library source
│   ├── core/              # Core workflow module
│   ├── adapter/           # Runtime adapters
│   └── exception/         # Custom exceptions
├── test/                   # Test files
├── examples/              # Example implementations
├── docs/                  # Documentation
└── scripts/               # Build and utility scripts
```

## Making Changes

### 1. Create a Branch

```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/your-bug-fix
```

### 2. Code Style

- Use TypeScript for all new code
- Follow existing code style and conventions
- Use descriptive variable and function names
- Add JSDoc comments for public APIs

### 3. Testing

- Write tests for new features
- Ensure all tests pass before submitting PR
- Aim for >80% code coverage

```bash
# Run tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run tests with coverage
pnpm test:cov

# Run end-to-end tests
pnpm test:e2e
```

### 4. Documentation

- Update documentation for API changes
- Add examples for new features
- Keep README.md up to date

### 5. Commit Messages

Use conventional commit messages:

```
feat: add new workflow decorator
fix: resolve timeout issue in lambda adapter
docs: update getting started guide
test: add tests for retry logic
chore: update dependencies
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `test`: Test changes
- `chore`: Maintenance tasks
- `refactor`: Code refactoring
- `perf`: Performance improvements

## Pull Request Process

1. **Update your branch**
   ```bash
   git fetch origin
   git rebase origin/main
   ```

2. **Run the CI checks from the repository root**
   ```bash
   pnpm check
   pnpm test
   pnpm build
   pnpm verify:package
   pnpm verify:lambda
   ```

3. **Create Pull Request**
   - Provide a clear description of changes
   - Reference any related issues
   - Include examples if applicable
   - Update CHANGELOG.md

4. **Review Process**
   - Address review comments
   - Keep PR focused and atomic
   - Ensure CI passes

## Package Development

### Building

Build the ESM package and TypeScript declarations with:

```bash
pnpm build
```

Output structure:
```
dist/
├── core/
│   ├── index.js
│   └── index.d.ts
├── adapter/
│   ├── index.js
│   └── index.d.ts
└── exception/
    ├── index.js
    └── index.d.ts
```

### Verify build artifacts

From the repository root, run:

```bash
pnpm verify:package
pnpm verify:lambda
```

`pnpm verify:package` packs the built library and loads its public subpaths in Node.js. `pnpm verify:lambda` builds and loads the example handler in isolation.

## Adding New Modules

When adding a new module:

1. Create the module directory under `packages/`
2. Add an `index.ts` file with exports
3. Update `package.json` exports field
4. Update `package.json` typesVersions
5. Add documentation in `docs/`
6. Add tests in `test/`
7. Add examples in `examples/`

Example:

```json
// package.json
{
  "exports": {
    "./your-module": {
      "types": "./dist/your-module/index.d.ts",
      "import": "./dist/your-module/index.js",
      "default": "./dist/your-module/index.js"
    }
  },
  "typesVersions": {
    "*": {
      "your-module": ["./dist/your-module/index.d.ts"]
    }
  }
}
```

## Release Process

See the [publishing guide](PUBLISHING.md) for the GitHub Actions release process.

## Getting Help

- Open an issue for bugs or feature requests
- Join discussions for questions
- Check existing issues and PRs

## Code of Conduct

- Be respectful and inclusive
- Provide constructive feedback
- Focus on the best solution for users

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

