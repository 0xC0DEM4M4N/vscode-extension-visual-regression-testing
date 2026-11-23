import { exec, ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

const execAsync = promisify(exec);

export interface TestResult {
  success: boolean;
  output: string;
}

export class PlaywrightService {
  private currentProcess: ChildProcess | null = null;

  constructor(private readonly workspaceRoot: string) {}

  private execWithCancellation(
    cmd: string,
    options: any,
    cancellationToken?: vscode.CancellationToken
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      let cancelled = false;

      const childProcess = exec(cmd, options, (error, stdout, stderr) => {
        this.currentProcess = null;

        // If we cancelled, ignore the error from the killed process
        if (cancelled) {
          return;
        }

        if (error) {
          reject(error);
        } else {
          resolve({
            stdout: stdout?.toString() || '',
            stderr: stderr?.toString() || ''
          });
        }
      });

      this.currentProcess = childProcess;

      // Listen for cancellation
      if (cancellationToken) {
        cancellationToken.onCancellationRequested(() => {
          if (childProcess.pid) {
            cancelled = true;
            console.log('[Playwright] Cancellation requested, killing process');
            try {
              process.kill(-childProcess.pid, 'SIGTERM');
            } catch {
              childProcess.kill('SIGTERM');
            }
            this.currentProcess = null;
            reject(new vscode.CancellationError());
          }
        });
      }
    });
  }

  async updateSnapshots(urlPath: string, port: number): Promise<void> {
    const config = vscode.workspace.getConfiguration('visualRegression');
    const testPath = config.get<string>('testPath', 'tests/visual/pages.spec.ts');
    const customEnvVars = config.get<Record<string, string>>('environmentVariables', {});
    
    const url = `http://localhost:${port}${urlPath}`;
    const cmd = `npx playwright test ${testPath} --update-snapshots`;
    
    console.log(`[Playwright] Running: ${cmd}`);
    console.log(`[Playwright] TEST_URL=${url}`);
    
    // Log custom environment variables (except sensitive ones)
    for (const key of Object.keys(customEnvVars)) {
      console.log(`[Playwright] ${key}=${customEnvVars[key]}`);
    }
    
    const env = { 
      ...process.env, 
      TEST_URL: url,
      ...customEnvVars
    };
    
    try {
      await execAsync(cmd, {
        cwd: this.workspaceRoot,
        env,
        timeout: 120000, // 2 minutes
        maxBuffer: 10 * 1024 * 1024 // 10MB
      });
      console.log('[Playwright] Baseline snapshots created');
    } catch (error: any) {
      console.log('[Playwright] ❌ Command failed');
      if (error.stdout) console.log('[Playwright stdout]', error.stdout);
      if (error.stderr) console.log('[Playwright stderr]', error.stderr);
      throw new Error(`Playwright test failed: ${error.message}\n${error.stderr || error.stdout || ''}`);
    }
  }

  async updateAllSnapshots(urlPaths: string[], port: number, cancellationToken?: vscode.CancellationToken, cwd?: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('visualRegression');
    const testPath = config.get<string>('testPath', 'tests/visual/pages.spec.ts');
    const customEnvVars = config.get<Record<string, string>>('environmentVariables', {});
    
    // Create TEST_URLS as comma-separated list
    const testUrls = urlPaths.map(path => `http://localhost:${port}${path}`).join(',');
    const cmd = `npx playwright test ${testPath} --update-snapshots`;
    
    console.log(`[Playwright] Running: ${cmd}`);
    console.log(`[Playwright] TEST_URLS=${testUrls}`);
    
    // Log custom environment variables (except sensitive ones)
    for (const key of Object.keys(customEnvVars)) {
      console.log(`[Playwright] ${key}=${customEnvVars[key]}`);
    }
    
    const env = {
      ...process.env,
      TEST_URLS: testUrls,
      ...customEnvVars
    };

    try {
      await this.execWithCancellation(cmd, {
        cwd: cwd ?? this.workspaceRoot,
        env,
        timeout: 120000, // 2 minutes
        maxBuffer: 10 * 1024 * 1024 // 10MB
      }, cancellationToken);
      console.log('[Playwright] Baseline snapshots created for all URLs');
    } catch (error: any) {
      if (error instanceof vscode.CancellationError) {
        throw error;
      }
      console.log('[Playwright] ❌ Command failed');
      if (error.stdout) console.log('[Playwright stdout]', error.stdout);
      if (error.stderr) console.log('[Playwright stderr]', error.stderr);
      throw new Error(`Playwright test failed: ${error.message}\n${error.stderr || error.stdout || ''}`);
    }
  }

  async runTests(urlPath: string, port: number): Promise<TestResult> {
    const config = vscode.workspace.getConfiguration('visualRegression');
    const testPath = config.get<string>('testPath', 'tests/visual/pages.spec.ts');
    const customEnvVars = config.get<Record<string, string>>('environmentVariables', {});
    
    const url = `http://localhost:${port}${urlPath}`;
    const cmd = `npx playwright test ${testPath} --reporter=html`;
    
    console.log(`[Playwright] Running: ${cmd}`);
    console.log(`[Playwright] TEST_URL=${url}`);
    
    // Log custom environment variables (except sensitive ones)
    for (const key of Object.keys(customEnvVars)) {
      console.log(`[Playwright] ${key}=${customEnvVars[key]}`);
    }
    
    const env = { 
      ...process.env, 
      TEST_URL: url,
      ...customEnvVars
    };
    
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd: this.workspaceRoot,
        env,
        timeout: 120000, // 2 minutes
        maxBuffer: 10 * 1024 * 1024 // 10MB
      });

      console.log('[Playwright] Tests passed ✅');
      return {
        success: true,
        output: stdout + stderr
      };
    } catch (error: any) {
      console.log('[Playwright] Tests failed ❌');
      console.log('[Playwright] HTML report generated at playwright-report/');
      return {
        success: false,
        output: error.stdout + error.stderr
      };
    }
  }

  async runAllTests(urlPaths: string[], port: number, cancellationToken?: vscode.CancellationToken): Promise<TestResult> {
    const config = vscode.workspace.getConfiguration('visualRegression');
    const testPath = config.get<string>('testPath', 'tests/visual/pages.spec.ts');
    const customEnvVars = config.get<Record<string, string>>('environmentVariables', {});
    
    // Run all URLs in a single test execution so the report includes all results
    const cmd = `npx playwright test ${testPath} --reporter=html`;
    
    console.log(`[Playwright] Running tests for ${urlPaths.length} URL(s): ${cmd}`);
    
    // Create TEST_URLS as comma-separated list for the test to parse
    const testUrls = urlPaths.map(path => `http://localhost:${port}${path}`).join(',');
    console.log(`[Playwright] TEST_URLS=${testUrls}`);
    
    // Log custom environment variables (except sensitive ones)
    for (const key of Object.keys(customEnvVars)) {
      console.log(`[Playwright] ${key}=${customEnvVars[key]}`);
    }
    
    const env = {
      ...process.env,
      TEST_URLS: testUrls, // Multiple URLs
      ...customEnvVars
    };

    try {
      const { stdout, stderr } = await this.execWithCancellation(cmd, {
        cwd: this.workspaceRoot,
        env,
        timeout: 120000, // 2 minutes
        maxBuffer: 10 * 1024 * 1024 // 10MB
      }, cancellationToken);

      console.log('[Playwright] All tests passed ✅');
      return {
        success: true,
        output: stdout + stderr
      };
    } catch (error: any) {
      if (error instanceof vscode.CancellationError) {
        throw error;
      }
      console.log('[Playwright] Some tests failed ❌');
      console.log('[Playwright] HTML report generated at playwright-report/');
      return {
        success: false,
        output: error.stdout + error.stderr
      };
    }
  }

  private escapeRegex(str: string): string {
    return str.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  }
}
