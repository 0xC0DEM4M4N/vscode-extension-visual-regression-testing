# Visual Regression Testing Extension

## Extension Purpose
Enables visual regression testing within VS Code using Playwright, allowing developers to capture and compare UI screenshots across different versions.

## Project Structure

```
src/
├── services/
│   ├── playwrightService.ts    # Playwright browser automation
│   ├── serverService.ts        # Local server for test apps
│   └── gitService.ts           # Git branch/version management
├── visualRegressionController.ts  # Main orchestration logic
├── testRunner.ts               # Test execution and comparison
├── visualRegressionPanelProvider.ts # Webview panel for test UI
└── extension.ts                # Extension activation
```

## Core Concepts

### Test Workflow
1. **Capture** - Take baseline screenshots of UI components
2. **Modify** - Change code (CSS, components, etc.)
3. **Compare** - Capture new screenshots and compare to baseline
4. **Review** - View diffs in webview panel
5. **Approve/Reject** - Accept changes or revert code

### Playwright Integration
- Uses Playwright for cross-browser testing
- Supports chromium, firefox, webkit
- Configuration via `playwright.config.ts`
- Demo app for testing UI components

### Screenshot Management
- Baseline screenshots stored in version control
- Diffs computed pixel-by-pixel
- Visual diff overlay shown in webview

## Key Patterns

### Server Service
- Spins up local server for test application
- Manages lifecycle (start/stop)
- Handles port allocation and cleanup

### Playwright Service
- Browser instance management
- Screenshot capture with consistent sizing
- Viewport configuration for reproducible tests

### Test Runner
- Orchestrates comparison logic
- Generates visual diff reports
- Tracks test pass/fail status

## Important Considerations

### Performance
- Screenshot capture can be slow with many components
- Consider batch operations for efficiency
- Cache browser instances across tests

### Reliability
- Network-dependent (local server)
- Timing issues with dynamic content
- Use `waitForSelector` and similar waits
- Consistent viewport size is critical

### Cross-Platform
- Font rendering varies by OS
- Screenshot diffs may be platform-specific
- Consider running baseline generation on consistent environment

## Testing

### Unit Tests
- Test screenshot comparison logic
- Mock Playwright API calls
- Test diff calculation accuracy

### Integration Tests
- Verify server startup/shutdown
- Test full capture → compare workflow
- Use test fixtures

## Common Tasks

### Adding New Component Tests
1. Add component to demo app
2. Run `capture` command to create baseline
3. Modify component
4. Run `compare` to see visual diff
5. Approve or reject changes

### Updating Baselines
- When intentional UI changes are approved
- Remove old baseline and re-capture
- Commit new baseline to version control

### Debugging Failed Tests
- Check screenshot dimensions
- Verify server is running
- Look for timing issues (animations, lazy loading)
- Compare raw image data

## Build & Configuration

### Development
```bash
npm run compile         # Build TypeScript
npm run watch         # Watch mode
npm run esbuild       # Bundle for distribution
```

### Playwright Config
- Modify `playwright.config.ts` for browser/device settings
- Adjust viewport size for consistency
- Configure timeout values

## Important Files

- **src/services/playwrightService.ts** - Core browser automation
- **src/testRunner.ts** - Diff/comparison engine
- **demo-app/** - Test application for visual testing
- **playwright.config.ts** - Playwright configuration

## Dos & Don'ts

### Do
- Use consistent viewport sizes
- Wait for dynamic content before capturing
- Version control baseline images
- Keep test components isolated

### Don't
- Don't use system-dependent fonts in test UI
- Don't capture with varying window sizes
- Don't mix logical and pixel-based comparisons
- Don't hardcode timeouts for network operations
