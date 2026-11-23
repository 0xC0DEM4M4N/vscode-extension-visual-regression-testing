import * as vscode from 'vscode';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { GitService } from './services/gitService';
import { PlaywrightService } from './services/playwrightService';
import { ServerService } from './services/serverService';

const execAsync = promisify(exec);

interface StepResult {
  icon: string;
  message: string;
  success: boolean;
}

export class TestRunner {
  private readonly outputChannel: vscode.OutputChannel;
  private readonly completedSteps: StepResult[] = [];
  private spinnerInterval: NodeJS.Timeout | null = null;
  private readonly spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private spinnerIndex = 0;
  private reportServerProcess: any = null;

  constructor(
    private readonly gitService: GitService,
    private readonly serverService: ServerService,
    private readonly playwrightService: PlaywrightService,
    private readonly config: vscode.WorkspaceConfiguration
  ) {
    this.outputChannel = vscode.window.createOutputChannel('Visual Regression Test');
  }

  private log(message: string): void {
    const timestamp = new Date().toLocaleTimeString();
    this.outputChannel.appendLine(`[${timestamp}] ${message}`);
  }

  private startSpinner(icon: string, message: string): void {
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
    }

    this.spinnerIndex = 0;
    const timestamp = new Date().toLocaleTimeString();

    this.spinnerInterval = setInterval(() => {
      this.outputChannel.clear();
      const frame = this.spinnerFrames[this.spinnerIndex];
      this.outputChannel.appendLine('🎨 Visual Regression Testing in progress...');
      this.outputChannel.appendLine('');
      this.outputChannel.appendLine(`[${timestamp}] ${frame} ${icon} ${message}`);

      this.spinnerIndex = (this.spinnerIndex + 1) % this.spinnerFrames.length;
    }, 80);
  }

  private stopSpinner(icon: string, message: string, success: boolean = true): void {
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
    }

    // Record the completed step
    this.completedSteps.push({ icon, message, success });
  }



  private showFinalSummary(): void {
    this.outputChannel.clear();
    const timestamp = new Date().toLocaleTimeString();
    this.outputChannel.appendLine('🎨 Visual Regression Test - Complete');
    this.outputChannel.appendLine('='.repeat(60));
    this.outputChannel.appendLine('');
    
    const hasFailures = this.completedSteps.some(step => !step.success);
    
    for (const step of this.completedSteps) {
      const status = step.success ? '✓' : '✗';
      this.outputChannel.appendLine(`[${timestamp}] ${status} ${step.icon} ${step.message}`);
    }
    
    this.outputChannel.appendLine('');
    this.outputChannel.appendLine('='.repeat(60));
    
    if (hasFailures) {
      this.outputChannel.appendLine('❌ Test run completed with failures');
    } else {
      this.outputChannel.appendLine('✅ All steps completed successfully');
    }
  }

  dispose(): void {
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
    }
    if (this.reportServerProcess) {
      try {
        this.reportServerProcess.kill();
      } catch (error) {
        // Process may already be dead
        console.error('Error killing report server:', error);
      }
      this.reportServerProcess = null;
    }
    this.outputChannel.dispose();
  }

  private colorBranch(branchName: string, isMainBranch: boolean): string {
    // Add descriptive label for clarity
    const label = isMainBranch ? '[BASE]' : '[FEATURE]';
    return `${label} '${branchName}'`;
  }

  private checkCancelled(token?: vscode.CancellationToken): void {
    if (token?.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
  }

  private formatElapsed(ms: number): string {
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  }

  /** Runs one named step with a spinner and records it (with timing) in the summary. */
  private async step<T>(
    icon: string,
    message: string,
    fn: () => Promise<T>,
    doneMessage?: (result: T) => string
  ): Promise<T> {
    const startedAt = Date.now();
    this.startSpinner(icon, message);
    try {
      const result = await fn();
      const text = doneMessage ? doneMessage(result) : message;
      this.stopSpinner(icon, `${text} (${this.formatElapsed(Date.now() - startedAt)})`, true);
      return result;
    } catch (error) {
      this.stopSpinner(icon, message, false);
      throw error;
    }
  }

  async runTest(
    urlPaths: string[],
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    cancellationToken?: vscode.CancellationToken
  ): Promise<void> {
    const strategy = this.config.get<string>('baselineStrategy', 'worktree');
    if (strategy === 'checkout') {
      return this.runTestCheckout(urlPaths, progress, cancellationToken);
    }
    return this.runTestWorktree(urlPaths, progress, cancellationToken);
  }

  /**
   * Default flow. The user's working tree is never touched:
   *  - the baseline is captured from a separate git worktree of the main branch,
   *    on its own port, and cached by main's commit SHA;
   *  - the feature server starts while the baseline is being prepared (or is
   *    reused if it is already running);
   *  - readiness is polled instead of sleeping for a fixed time.
   */
  private async runTestWorktree(
    urlPaths: string[],
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    cancellationToken?: vscode.CancellationToken
  ): Promise<void> {
    const mainBranch = this.config.get<string>('mainBranch', 'main');
    const serverPort = this.config.get<number>('serverPort', 3000);
    const startupTimeout = this.config.get<number>('serverStartupTimeout', 60000);
    const useCache = this.config.get<boolean>('cacheBaseline', true);
    const testPath = this.config.get<string>('testPath', 'tests/visual');
    const customEnvVars = this.config.get<Record<string, string>>('environmentVariables', {});
    const waitForSelector = this.config.get<string>('waitForSelector', '');
    const workspaceRoot = this.gitService.workspaceRoot;
    const runStartedAt = Date.now();

    this.outputChannel.show(true);
    this.checkCancelled(cancellationToken);

    progress.report({ message: 'Validating setup...', increment: 5 });
    try {
      const templateCreated = await this.step('🔍', 'Validating setup', () => this.validateSetup(testPath));
      if (templateCreated) {
        this.log('ℹ️  New test file created (not staged)');
      }
    } catch (error) {
      this.showFinalSummary();
      this.log(`❌ ${error}`);
      throw error;
    }

    const baselineServer = new ServerService(workspaceRoot);
    const featureServer = this.serverService;
    let featureStartedByUs = false;

    try {
      this.checkCancelled(cancellationToken);

      progress.report({ message: `Resolving ${mainBranch}...`, increment: 5 });
      const currentBranch = await this.gitService.getCurrentBranch();
      const mainSha = await this.step(
        '📍',
        `Resolving ${mainBranch}`,
        () => this.gitService.getCommitSha(mainBranch),
        (sha) => `Baseline is ${this.colorBranch(mainBranch, true)} @ ${sha.slice(0, 8)} - you stay on ${this.colorBranch(currentBranch, false)}`
      );

      const cacheId = GitService.computeCacheId(mainSha, {
        urls: [...urlPaths].sort(),
        env: customEnvVars,
        testPath,
        waitForSelector,
        tests: this.gitService.hashTestFiles(testPath),
      });

      // Start the feature server right away; it boots while the baseline is prepared.
      const featureStart = await featureServer.start({ port: serverPort, reuseExisting: true });
      featureStartedByUs = !featureStart.reused;
      if (featureStart.reused) {
        this.log(`♻️  Reusing the dev server already running on port ${serverPort}`);
      }

      const cacheHit = useCache && this.gitService.hasBaselineCache(cacheId);
      if (cacheHit) {
        progress.report({ message: 'Using cached baseline...', increment: 25 });
        await this.step('📦', `Using cached baseline for ${mainBranch} @ ${mainSha.slice(0, 8)}`, async () => {
          this.gitService.restoreBaselineFromCache(cacheId, testPath);
        });
      } else {
        progress.report({ message: `Preparing ${mainBranch} baseline...`, increment: 5 });
        const worktree = await this.step('🌿', `Preparing ${mainBranch} worktree`, async () => {
          try {
            return await this.gitService.prepareBaselineWorktree(mainSha, testPath);
          } catch (error) {
            throw new Error(
              `Could not create the baseline worktree: ${error instanceof Error ? error.message : error}. ` +
                'You can set visualRegression.baselineStrategy to "checkout" to use the old branch-switching flow.'
            );
          }
        });
        this.checkCancelled(cancellationToken);

        const baselinePort = await ServerService.findFreePort(serverPort + 1);
        await baselineServer.start({ cwd: worktree, port: baselinePort, reuseExisting: false });

        progress.report({ message: 'Starting dev servers...', increment: 10 });
        await this.step('🚀', `Starting dev servers (baseline :${baselinePort}, feature :${serverPort})`, () =>
          Promise.all([
            baselineServer.waitUntilReady(baselinePort, startupTimeout, cancellationToken),
            featureServer.waitUntilReady(serverPort, startupTimeout, cancellationToken),
          ])
        );

        progress.report({ message: 'Capturing baseline screenshots...', increment: 20 });
        await this.step('📸', `Capturing baseline screenshots for ${urlPaths.length} URL(s)`, () =>
          this.playwrightService.updateAllSnapshots(urlPaths, baselinePort, cancellationToken, worktree)
        );

        await this.step(
          '💾',
          'Caching baseline snapshots',
          async () => this.gitService.captureWorktreeToCache(worktree, testPath, cacheId),
          (count) => `Cached ${count} baseline snapshot file(s)`
        );
        await baselineServer.stop();
        this.gitService.restoreBaselineFromCache(cacheId, testPath);
      }

      this.checkCancelled(cancellationToken);
      progress.report({ message: 'Waiting for feature dev server...', increment: 10 });
      await this.step(
        '🚀',
        featureStart.reused ? `Dev server on :${serverPort} is ready` : `Starting feature dev server on :${serverPort}`,
        () => featureServer.waitUntilReady(serverPort, startupTimeout, cancellationToken)
      );

      progress.report({ message: 'Running visual regression tests...', increment: 25 });
      const result = await this.step('🧪', `Running visual regression tests for ${urlPaths.length} URL(s)`, () =>
        this.playwrightService.runAllTests(urlPaths, serverPort, cancellationToken)
      );

      progress.report({ message: 'Saving comparison results...', increment: 5 });
      await this.step('💾', 'Saving comparison results to permanent storage', () =>
        this.gitService.saveSnapshotsToPermanentStorage('comparison')
      );

      if (featureStartedByUs) {
        await this.step('🛑', 'Stopping dev server', () => featureServer.stop());
      }

      this.showFinalSummary();
      this.log(`⏱️  Total: ${this.formatElapsed(Date.now() - runStartedAt)}`);
      await this.presentResult(result.success, urlPaths);
    } catch (error) {
      if (this.spinnerInterval) {
        this.stopSpinner('❌', 'Error occurred', false);
      }
      this.showFinalSummary();
      this.log('');
      this.log('❌ Test failed - cleaning up...');
      await baselineServer.stop();
      if (featureStartedByUs) {
        await featureServer.stop();
      }
      throw error;
    } finally {
      if (this.spinnerInterval) {
        clearInterval(this.spinnerInterval);
        this.spinnerInterval = null;
      }
      this.log('');
      this.log('✨ Test run complete');
    }
  }

  private async presentResult(success: boolean, urlPaths: string[]): Promise<void> {
    if (success) {
      this.log('');
      this.log('✨ All tests passed!');
      vscode.window.showInformationMessage(
        `✅ Visual regression tests passed for all ${urlPaths.length} URL(s)!`
      );
      return;
    }

    this.log('');
    this.log('📊 Test Results: Differences detected');
    this.log(`  Tested ${urlPaths.length} URL(s)`);
    for (const url of urlPaths) {
      this.log(`     - ${url}`);
    }

    const action = await vscode.window.showWarningMessage(
      `⚠️ Visual regression tests failed - differences detected!`,
      'Show Report',
      'Dismiss'
    );
    if (action === 'Show Report') {
      await this.showHtmlReport();
    }
  }

  /**
   * Legacy flow (visualRegression.baselineStrategy = "checkout"): switches the working
   * tree to the main branch, captures the baseline, then switches back.
   */
  private async runTestCheckout(
    urlPaths: string[],
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    cancellationToken?: vscode.CancellationToken
  ): Promise<void> {
    const mainBranch = this.config.get<string>('mainBranch', 'main');
    const serverPort = this.config.get<number>('serverPort', 3000);
    const startupTimeout = this.config.get<number>('serverStartupTimeout', 60000);
    const testPath = this.config.get<string>('testPath', 'tests/visual');

    // Show output channel
    this.outputChannel.show(true);

    // Check for cancellation
    if (cancellationToken?.isCancellationRequested) {
      throw new vscode.CancellationError();
    }

    // Validate prerequisites
    progress.report({ message: 'Validating setup...', increment: 5 });
    let templateCreated = false;
    this.startSpinner('🔍', 'Validating setup');
    try {
      templateCreated = await this.validateSetup(testPath);
      this.stopSpinner('🔍', 'Validating setup', true);
    } catch (error) {
      this.stopSpinner('🔍', 'Validating setup', false);
      this.showFinalSummary();
      this.log(`❌ ${error}`);
      throw error;
    }

    // If template was just created, don't stage it
    if (templateCreated) {
      this.log('ℹ️  New test file created (not staged)');
    }

    // Save current branch
    progress.report({ message: 'Checking current branch...', increment: 10 });
    this.startSpinner('📍', 'Getting current branch');
    const originalBranch = await this.gitService.getCurrentBranch();
    this.stopSpinner('📍', `Getting current branch: ${this.colorBranch(originalBranch, false)}`, true);
    
    // Clear any existing snapshots before starting
    this.startSpinner('🧹', 'Clearing existing snapshots');
    await this.gitService.clearSnapshots();
    this.stopSpinner('🧹', 'Clearing existing snapshots', true);
    
    let tmpDir = '';
    try {
      // Check for cancellation
      if (cancellationToken?.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      // Switch to main branch
      progress.report({ message: `Switching to ${mainBranch}...`, increment: 10 });
      this.startSpinner('🔄', `Switching to ${this.colorBranch(mainBranch, true)} branch`);
      await this.gitService.checkout(mainBranch);
      this.stopSpinner('🔄', `Switching to ${this.colorBranch(mainBranch, true)} branch`, true);

      // Start server and capture baseline
      progress.report({ message: 'Starting server on main branch...', increment: 10 });
      this.startSpinner('🚀', `Starting dev server on port ${serverPort}`);
      await this.serverService.start({ reuseExisting: false });
      await this.serverService.waitUntilReady(serverPort, startupTimeout, cancellationToken);
      this.stopSpinner('🚀', `Starting dev server on port ${serverPort}`, true);

      progress.report({ message: 'Capturing baseline screenshots...', increment: 20 });
      this.startSpinner('📸', `Capturing baseline screenshots for ${urlPaths.length} URL(s)`);
      await this.playwrightService.updateAllSnapshots(urlPaths, serverPort, cancellationToken);
      this.stopSpinner('📸', `Capturing baseline screenshots for ${urlPaths.length} URL(s)`, true);

      // Save baseline snapshots to permanent storage
      progress.report({ message: 'Saving baseline snapshots...', increment: 5 });
      this.startSpinner('💾', 'Saving baseline snapshots to permanent storage');
      await this.gitService.saveSnapshotsToPermanentStorage('baseline');
      this.stopSpinner('💾', 'Saving baseline snapshots to permanent storage', true);

      // Copy the baseline snapshots to temp directory
      this.startSpinner('💾', 'Saving baseline snapshots to temp directory');
      tmpDir = await this.gitService.saveSnapshotsToTemp();
      this.stopSpinner('💾', 'Saving baseline snapshots to temp directory', true);

      // Stop server
      this.startSpinner('🛑', 'Stopping server');
      await this.serverService.stop();
      this.stopSpinner('🛑', 'Stopping server', true);

      // Switch back to original branch
      progress.report({ message: `Switching back to ${originalBranch}...`, increment: 10 });
      this.startSpinner('🔄', `Switching back to ${this.colorBranch(originalBranch, false)} branch`);
      await this.gitService.checkout(originalBranch);
      this.stopSpinner('🔄', `Switching back to ${this.colorBranch(originalBranch, false)} branch`, true);

      // Restore baseline snapshots from temp (overwrite feature branch snapshots)
      this.startSpinner('📦', 'Restoring baseline snapshots (from main) to compare against');
      await this.gitService.restoreSnapshotsFromTemp(tmpDir);
      this.stopSpinner('📦', 'Restoring baseline snapshots (from main) to compare against', true);

      // Start server and run comparison tests
      progress.report({ message: 'Starting server on feature branch...', increment: 10 });
      this.startSpinner('🚀', `Starting dev server on ${this.colorBranch(originalBranch, false)}`);
      await this.serverService.start({ reuseExisting: false });
      await this.serverService.waitUntilReady(serverPort, startupTimeout, cancellationToken);
      this.stopSpinner('🚀', `Starting dev server on ${this.colorBranch(originalBranch, false)}`, true);

      progress.report({ message: 'Running visual regression tests...', increment: 20 });
      this.startSpinner('🧪', `Running visual regression tests for ${urlPaths.length} URL(s)`);
      const result = await this.playwrightService.runAllTests(urlPaths, serverPort, cancellationToken);
      this.stopSpinner('🧪', `Running visual regression tests for ${urlPaths.length} URL(s)`, true);

      // Save comparison snapshots (with diffs) to permanent storage
      progress.report({ message: 'Saving comparison results...', increment: 5 });
      this.startSpinner('💾', 'Saving comparison results to permanent storage');
      await this.gitService.saveSnapshotsToPermanentStorage('comparison');
      this.stopSpinner('💾', 'Saving comparison results to permanent storage', true);

      // Stop server
      this.startSpinner('🛑', 'Stopping server');
      await this.serverService.stop();
      this.stopSpinner('🛑', 'Stopping server', true);

      // Show final summary
      this.showFinalSummary();

      // Show results
      if (result.success) {
        this.log('');
        this.log('✨ All tests passed!');
        vscode.window.showInformationMessage(
          `✅ Visual regression tests passed for all ${urlPaths.length} URL(s)!`
        );
      } else {
        this.log('');
        this.log('📊 Test Results: Differences detected');
        this.log(`  Tested ${urlPaths.length} URL(s)`);
        for (const url of urlPaths) {
          this.log(`     - ${url}`);
        }

        const action = await vscode.window.showWarningMessage(
          `⚠️ Visual regression tests failed - differences detected!`,
          'Show Report',
          'Dismiss'
        );
        if (action === 'Show Report') {
          await this.showHtmlReport();
        }
      }

    } catch (error) {
      // Ensure spinner is stopped on error
      if (this.spinnerInterval) {
        this.stopSpinner('❌', 'Error occurred', false);
      }

      // Show summary of steps completed before failure
      this.showFinalSummary();

      // Ensure we're back on original branch and server is stopped
      this.log('');
      this.log('❌ Test failed - cleaning up...');
      await this.serverService.stop();
      await this.serverService.killPort(serverPort);
      try {
        await this.gitService.checkout(originalBranch);
      } catch (checkoutError) {
        // Log but don't throw - we want to show the original error
        console.error('Failed to switch back to original branch:', checkoutError);
      }
      throw error;
    } finally {
      // Cleanup temp directory if it exists
      if (tmpDir) {
        this.startSpinner('🧹', 'Cleaning up temp directory');
        await this.gitService.cleanupTemp(tmpDir);
        this.stopSpinner('🧹', 'Cleaning up temp directory', true);
      }
      this.log('');
      this.log('✨ Test run complete');

      // Final safety check - ensure spinner is cleared
      if (this.spinnerInterval) {
        clearInterval(this.spinnerInterval);
        this.spinnerInterval = null;
      }
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async validateSetup(testPath: string): Promise<boolean> {
    const workspaceRoot = this.gitService['workspaceRoot'];
    const fs = require('node:fs');
    const path = require('node:path');
    let templateCreated = false;

    // Check if Playwright is installed
    this.log('✓ Checking for Playwright installation...');
    try {
      const localPlaywright = path.join(
        workspaceRoot,
        'node_modules',
        '.bin',
        process.platform === 'win32' ? 'playwright.cmd' : 'playwright'
      );
      if (!fs.existsSync(localPlaywright)) await execAsync('npx playwright --version', {
        cwd: workspaceRoot,
        timeout: 30000, // 30 seconds
        maxBuffer: 1024 * 1024 // 1MB
      });
      this.log('✓ Playwright is installed');
    } catch (_error) {
      const message = 'Playwright is not installed. Please run: npm install -D @playwright/test && npx playwright install';
      this.log(`✗ ${message}`);
      throw new Error(message);
    }

    // Check if test file/directory exists
    this.log(`✓ Checking for test file: ${testPath}...`);
    const testFile = path.join(workspaceRoot, testPath);
    
    // Check if it's a directory or file
    let isDirectory = false;
    let testFileExists = false;
    
    if (fs.existsSync(testFile)) {
      const stats = fs.statSync(testFile);
      isDirectory = stats.isDirectory();
      testFileExists = true;
    } else {
      // Check if path ends with a file extension
      isDirectory = !testPath.endsWith('.ts') && !testPath.endsWith('.js');
    }

    if (isDirectory) {
      // Ensure directory exists
      if (!testFileExists) {
        this.log(`📁 Creating directory: ${testPath}`);
        fs.mkdirSync(testFile, { recursive: true });
      }
      
      // Check for test files
      const files = fs.readdirSync(testFile);
      const testFiles = files.filter((f: string) => f.endsWith('.spec.ts') || f.endsWith('.spec.js'));
      
      if (testFiles.length === 0) {
        this.log(`⚠️  No test files found in ${testPath}`);
        
        // Offer to create a template test file
        const action = await vscode.window.showWarningMessage(
          `No test files found in ${testPath}. Would you like to create a template test file?`,
          'Create Template',
          'Cancel'
        );
        
        if (action === 'Create Template') {
          await this.createTemplateTestFile(testFile, testPath);
          this.log(`✓ Created template test file in ${testPath}`);
          templateCreated = true;
        } else {
          throw new Error('No test files found. Please add test files to continue.');
        }
      } else {
        this.log(`✓ Found ${testFiles.length} test file(s)`);
      }
    } else if (testFileExists) {
      this.log(`✓ Test file exists: ${testPath}`);
    } else {
      // File doesn't exist - create it
      this.log(`⚠️  Test file not found: ${testPath}`);
      
      // Create parent directory if needed
      const parentDir = path.dirname(testFile);
      if (!fs.existsSync(parentDir)) {
        this.log(`📁 Creating directory: ${path.dirname(testPath)}`);
        fs.mkdirSync(parentDir, { recursive: true });
      }
      
      const action = await vscode.window.showWarningMessage(
        `Test file not found: ${testPath}. Would you like to create a template test file?`,
        'Create Template',
        'Cancel'
      );
      
      if (action === 'Create Template') {
        await this.createTemplateTestFile(parentDir, path.dirname(testPath));
        this.log(`✓ Created template test file at ${testPath}`);
        templateCreated = true;
      } else {
        throw new Error('Test file not found. Please create the test file to continue.');
      }
    }

    // Check if it's a git repository
    this.log('✓ Checking Git repository...');
    try {
      await execAsync('git rev-parse --git-dir', {
        cwd: workspaceRoot,
        timeout: 10000, // 10 seconds
        maxBuffer: 1024 * 1024 // 1MB
      });
      this.log('✓ Git repository detected');
    } catch (_error) {
      const message = 'Not a Git repository. Please initialize git: git init';
      this.log(`✗ ${message}`);
      throw new Error(message);
    }

    this.log('✅ All prerequisites validated');
    return templateCreated;
  }

  private async createTemplateTestFile(testDir: string, testPath: string): Promise<void> {
    const fs = require('node:fs');
    const path = require('node:path');

    const importPath = this.config.get<string>('testImportPath', '@playwright/test');
    const waitForSelector = this.config.get<string>('waitForSelector', '');

    // Generate the wait logic based on whether a selector is configured
    const waitLogic = waitForSelector
      ? `
  // Wait for loading indicator to disappear (if configured)
  await page.waitForFunction(() => {
    const noLoading = !document.querySelector("${waitForSelector}");
    return document.readyState === 'complete' && noLoading;
  });`
      : `
  // Wait for the page to be fully loaded
  await page.waitForLoadState('networkidle');`;

    const templateContent = `import { test, expect } from '${importPath}';

// Authentication bypass is handled via environment variables
// Example: NEXT_PUBLIC_PLAYWRIGHT=true to bypass Auth0
// Configure in VS Code settings: visualRegression.environmentVariables

// Get URLs from environment variable (comma-separated for multiple URLs)
const testUrls = process.env.TEST_URLS 
  ? process.env.TEST_URLS.split(',')
  : [process.env.TEST_URL || 'http://localhost:3000/'];

// Generate a test for each URL
for (const testUrl of testUrls) {
  test(\`visual test for \${testUrl}\`, async ({ page }) => {
    await page.goto(testUrl);
${waitLogic}

    // Generate unique filename from URL path
    const urlPath = new URL(testUrl).pathname;
    const filename = urlPath
      .replace(/^\\//, '') // Remove leading slash
      .replace(/\\//g, '-') // Replace slashes with hyphens
      .replace(/[^a-zA-Z0-9-_]/g, '_') // Replace special chars with underscores
      || 'homepage'; // Default name for root path

    await expect(page).toHaveScreenshot(\`\${filename}.png\`, { fullPage: true });
  });
}
`;

    const filePath = path.join(testDir, 'pages.spec.ts');
    fs.writeFileSync(filePath, templateContent, 'utf8');
    
    // Also create playwright.config.ts if it doesn't exist
    const workspaceRoot = this.gitService['workspaceRoot'];
    const configPath = path.join(workspaceRoot, 'playwright.config.ts');
    
    if (!fs.existsSync(configPath)) {
      const configContent = `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './${testPath}',
  reporter: [['html', { open: 'never' }]],
  use: {
    baseURL: process.env.TEST_URL || 'http://localhost:3000',
  },
});
`;
      fs.writeFileSync(configPath, configContent, 'utf8');
      this.log('✓ Created playwright.config.ts');
    }
    
    vscode.window.showInformationMessage(
      `Created template test file: ${testPath}/pages.spec.ts`
    );
  }

  private async showHtmlReport(): Promise<void> {
    try {
      const workspaceRoot = this.gitService['workspaceRoot'];

      // Kill any existing report server process we're tracking
      if (this.reportServerProcess) {
        try {
          this.reportServerProcess.kill();
          this.reportServerProcess = null;
          this.log('🧹 Killed existing report server process');
        } catch (killError) {
          // Process may already be dead
          this.log(`⚠️ Error killing existing report server: ${killError}`);
        }
      }

      // Kill any existing report servers on port 9323
      this.log('🔍 Checking for existing report server...');
      try {
        await execAsync('lsof -ti:9323 | xargs kill -9 2>/dev/null || true', {
          cwd: workspaceRoot,
          timeout: 10000, // 10 seconds
          maxBuffer: 1024 * 1024 // 1MB
        });
        this.log('🧹 Cleaned up existing report server');
        await this.wait(500);
      } catch {
        // No existing server, that's fine
      }

      this.log('🌐 Opening Playwright HTML report...');

      // Run in background - don't await
      const { exec } = require('node:child_process');
      const reportProcess = exec('npx playwright show-report', {
        cwd: workspaceRoot,
        detached: false // Changed to false so we can track and kill it
      });

      // Track the process so we can clean it up later
      this.reportServerProcess = reportProcess;

      reportProcess.stdout?.on('data', (data: Buffer) => {
        const output = data.toString().trim();
        if (output) {
          this.log(`[Report] ${output}`);
        }
      });

      reportProcess.stderr?.on('data', (data: Buffer) => {
        const output = data.toString().trim();
        if (output && !output.includes('EADDRINUSE')) {
          this.log(`[Report Error] ${output}`);
        }
      });

      // Give it a moment to start, then open browser
      await this.wait(1500);
      await vscode.env.openExternal(vscode.Uri.parse('http://localhost:9323'));

      this.log('✅ Report opened in browser at http://localhost:9323');
      vscode.window.showInformationMessage('📊 Visual regression report opened in browser');
    } catch (error) {
      this.log(`❌ Failed to open HTML report: ${error}`);
      vscode.window.showErrorMessage(`Failed to open report: ${error}`);
    }
  }
}
