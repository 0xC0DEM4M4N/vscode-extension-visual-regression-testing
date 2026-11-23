# Change Log

All notable changes to the "Visual Regression Testing" extension will be documented in this file.

## [Unreleased]

### Migration
See [Migrating to 1.12](README.md#migrating-to-112). Most likely change: use `{port}` in `visualRegression.serverStartCommand` if your script hardcodes a port.

### Changed
- **Baseline captured from a git worktree** instead of checking out `main` in your working tree. Your branch and uncommitted changes are never touched (no more `git checkout -f`). Set `visualRegression.baselineStrategy` to `checkout` for the old behaviour.
- **Baseline cache** keyed by the main branch commit, URLs, env vars and test files. Repeat runs skip the baseline capture entirely (`visualRegression.cacheBaseline`).
- **Dev servers are polled until they respond** instead of sleeping for a fixed time. New `visualRegression.serverStartupTimeout` (default 60s); `serverStartupTime` is deprecated.
- **Already-running dev server on `serverPort` is reused** rather than failing with "port in use".
- Baseline and feature servers boot in parallel; the baseline runs on the next free port. Use `{port}` in `serverStartCommand` (the `PORT` env var is also set).
- Servers are stopped by killing the whole process group (and `taskkill` on Windows).
- Per-step timings in the output summary.
- `mainBranch` falls back to `origin/<mainBranch>` when there is no local branch; works when the workspace folder is a subdirectory of the repo (monorepo).

## [1.5.0] - 2025-12-10

### Added
- **Side Panel Interface** - New dedicated panel in the Activity Bar with camera icon for easy access
- **Saved URL Sets** - Save and manage frequently-used URL combinations for quick re-testing
- **Branch Protection Warning** - Visual alert when on main/base branch to prevent accidental test runs
- **Configuration Display** - View current settings (branch, port, test path) at a glance in the panel
- **Real-time Test Progress** - Running status banner with disabled states during test execution
- **URL Set Management** - Load, edit, run, and delete saved URL sets directly from the panel

### Changed
- Primary interface now uses side panel instead of command palette for better workflow
- Panel icon changed from beaker to camera to better represent visual regression testing
- Improved UI with line-based icons for cleaner appearance
- Running status replaces action buttons during test execution for clearer feedback

### Improved
- Better user experience with persistent URL input between sessions
- Streamlined workflow for repeated testing scenarios
- Enhanced visual feedback during test execution

## [1.1.0] - 2025-12-03

### Added
- Configurable Playwright import path via `visualRegression.testImportPath` setting
- Ability to customize test and expect imports (e.g., use custom fixtures instead of @playwright/test)

### Fixed
- Bug fixes and stability improvements

### Changed
- Improved documentation

## [1.0.0] - 2024-12-02

### Added
- Initial release
- Automatic main branch baseline comparison
- Smart branch switching (main → feature → restore)
- Environment variable support for authentication bypass
- HTML report generation with side-by-side comparisons
- Real-time output logging
- Git repository validation
- Playwright installation validation
- Configurable dev server management
- Temporary snapshot isolation (no git commits needed)

### Features
- **Run Visual Regression Test** - Compare feature branch against main baseline
- **Environment Variables** - Pass custom env vars to server and tests
- **Automatic Cleanup** - Temporary snapshots are automatically cleaned up
- **Progress Notifications** - Visual feedback during test execution
- **HTML Reports** - Interactive comparison reports

### Configuration
- `visualRegression.testPath` - Path to your pages.spec.ts file
- `visualRegression.mainBranch` - Main branch name (default: "main")
- `visualRegression.serverStartCommand` - Dev server start command
- `visualRegression.serverPort` - Dev server port
- `visualRegression.serverStartupTime` - Server startup wait time
- `visualRegression.environmentVariables` - Custom environment variables

### Requirements
- Node.js 16+
- Git repository
- Playwright installed
- pages.spec.ts test file
