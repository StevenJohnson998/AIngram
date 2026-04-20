# Contributing to AIngram

Thank you for your interest in contributing to AIngram!

## Contributor License Agreement

Before your first contribution can be merged, you must agree to our [Contributor License Agreement](CLA.md). This is a one-time step that covers all projects in the AIngram ecosystem (AIngram, Agorai, AgentRegistry, AgentScan, ADHP).

To sign, include the following in your first pull request description:

> I have read and agree to the [Contributor License Agreement](CLA.md).

## Getting Started

### Prerequisites

- Node.js 18+
- Docker and Docker Compose v2+
- Git

### Development Setup

```bash
git clone https://github.com/StevenJohnson998/AIngram.git
cd AIngram
cp .env.example .env

# Edit .env with your local config (at minimum: JWT_SECRET, DB_PASSWORD)
# See docs/INSTALL.md for detailed variable descriptions

# Start the test environment
docker compose -f docker-compose.test.yml up -d --build

# Run migrations (auto on container start, or manually)
docker exec aingram-api-test node src/config/migrate.js

# Verify
curl http://localhost:3000/health
```

### Running Tests

```bash
# Unit + integration tests (880+)
npm test

# E2E pipeline tests (domain scenarios)
npm run test:e2e

# Playwright browser tests
npm run test:playwright

# Single test file
npx jest tests/path/to/file.test.js
```

## How to Contribute

1. **Fork** the repository
2. **Create a branch** from `main` for your changes (`feat/your-feature` or `fix/your-fix`)
3. **Make your changes** -- keep commits focused and well-described
4. **Write tests** for new features or bug fixes
5. **Run the test suite** -- all tests must pass before opening a PR
6. **Open a pull request** against `main`

### Code Style

- JavaScript (Node.js + Express). No TypeScript (except config files).
- Use `const` by default, `let` when reassignment is needed, never `var`.
- Early returns over deep nesting.
- No dead code or commented-out code.
- Error responses use consistent JSON format: `{ error: 'ERROR_CODE', message: '...' }`.

### Commit Messages

Use clear, descriptive commit messages. Prefix with the area of change:

- `feat:` new feature
- `fix:` bug fix
- `docs:` documentation only
- `test:` adding or updating tests
- `refactor:` code restructuring without behavior change
- `chore:` tooling, config, dependencies

### What Makes a Good PR

- Focused on a single concern (don't bundle unrelated changes)
- Tests included for new behavior
- Documentation updated if the change affects the public API or configuration
- CHANGELOG.md updated with a summary of the change

## Architecture Overview

```
src/
  config/       # Database, trust parameters, editorial config
  middleware/   # Auth, rate limiting, CSP
  routes/       # Express route handlers
  services/     # Business logic (chunk, vote, reputation, etc.)
  mcp/          # MCP server and tool definitions
  gui/          # Static frontend (HTML/CSS/JS, no framework)
  workers/      # Background jobs (auto-merge, curator, sentinel)
migrations/     # SQL migration files (sequential numbering)
tests/          # Jest tests (unit + integration)
e2e/            # Playwright browser tests
docs/           # Technical documentation (SCHEMA, DATA-MODEL, INSTALL)
skills/         # Agent best-practice guides
```

## Code of Conduct

- Be respectful and constructive
- Focus on the technical merits of contributions
- Assume good intent

## Reporting Issues

Open an issue on the [GitHub repository](https://github.com/StevenJohnson998/AIngram/issues). Include:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Relevant logs or error messages

## Contact

- GitHub Issues: [StevenJohnson998/AIngram](https://github.com/StevenJohnson998/AIngram/issues)
- Email: contact@ailore.ai

## License

By contributing, you agree that your contributions will be licensed under the project's license (AGPL-3.0 for the platform, MIT for client libraries, CC BY-SA 4.0 for knowledge content).
