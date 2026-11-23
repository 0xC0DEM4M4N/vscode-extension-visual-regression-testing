import { exec, execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export class GitService {
  constructor(public readonly workspaceRoot: string) {}

  async getCurrentBranch(): Promise<string> {
    console.log('[Git] Running: git branch --show-current');
    const { stdout } = await execAsync('git branch --show-current', {
      cwd: this.workspaceRoot
    });
    console.log(`[Git] Current branch: ${stdout.trim()}`);
    return stdout.trim();
  }

  async checkout(branch: string): Promise<void> {
    // Clean untracked files that might block checkout (like test-results)
    try {
      console.log('[Git] Running: git clean -fd test-results/ playwright-report/');
      await execAsync('git clean -fd test-results/ playwright-report/', {
        cwd: this.workspaceRoot
      });
    } catch {
      // Ignore if directories don't exist
    }
    
    console.log(`[Git] Running: git checkout -f ${branch}`);
    await execAsync(`git checkout -f ${branch}`, {
      cwd: this.workspaceRoot
    });
    console.log(`[Git] Checked out ${branch}`);
  }

  async clearSnapshots(): Promise<void> {
    try {
      console.log('[Git] Clearing existing snapshots');
      await execAsync('rm -rf tests/visual/*.spec.ts-snapshots', {
        cwd: this.workspaceRoot
      });
      console.log('[Git] Snapshots cleared');
    } catch (error) {
      console.error('[Git] Failed to clear snapshots:', error);
    }
  }

  async saveSnapshotsToTemp(): Promise<string> {
    const tmpDir = `/tmp/visual-regression-baseline-${Date.now()}`;
    try {
      console.log(`[Git] Copying snapshots to ${tmpDir}`);
      await execAsync(`mkdir -p ${tmpDir} && cp -r tests/visual/*.spec.ts-snapshots ${tmpDir}/ 2>/dev/null || true`, {
        cwd: this.workspaceRoot
      });
      console.log('[Git] Baseline snapshots saved to temp');
      return tmpDir;
    } catch (error) {
      console.error('[Git] Failed to save snapshots:', error);
      return tmpDir;
    }
  }

  async restoreSnapshotsFromTemp(tmpDir: string): Promise<void> {
    try {
      console.log(`[Git] Restoring snapshots from ${tmpDir}`);
      await execAsync(`rm -rf tests/visual/*.spec.ts-snapshots && cp -r ${tmpDir}/*.spec.ts-snapshots tests/visual/ 2>/dev/null || true`, {
        cwd: this.workspaceRoot
      });
      console.log('[Git] Baseline snapshots restored');
    } catch (error) {
      console.error('[Git] Failed to restore snapshots:', error);
    }
  }

  async cleanupTemp(tmpDir: string): Promise<void> {
    try {
      console.log(`[Git] Cleaning up ${tmpDir}`);
      await execAsync(`rm -rf ${tmpDir}`, {
        cwd: this.workspaceRoot
      });
    } catch (error) {
      console.error('[Git] Failed to cleanup temp:', error);
    }
  }

  async stageFiles(path: string): Promise<void> {
    try {
      console.log(`[Git] Staging files: ${path}`);
      await execAsync(`git add ${path}`, {
        cwd: this.workspaceRoot
      });
      console.log('[Git] Files staged');
    } catch (error) {
      console.error('[Git] Failed to stage files:', error);
    }
  }

  async hasUncommittedChanges(excludeFile?: string): Promise<boolean> {
    try {
      console.log('[Git] Checking for uncommitted changes');
      const { stdout } = await execAsync('git status --porcelain', {
        cwd: this.workspaceRoot
      });

      if (!stdout.trim()) {
        return false;
      }

      // If we have an exclude file, filter it out
      if (excludeFile) {
        const lines = stdout.trim().split('\n');
        const relevantChanges = lines.filter(line => {
          const filePath = line.substring(3).trim(); // Remove status prefix (e.g., "M  ", "?? ")
          return !filePath.includes(excludeFile);
        });
        return relevantChanges.length > 0;
      }

      return true;
    } catch (error) {
      console.error('[Git] Failed to check uncommitted changes:', error);
      return false;
    }
  }

  async saveSnapshotsToPermanentStorage(label: string): Promise<string> {
    const snapshotBaseDir = `${this.workspaceRoot}/.visual-regression-snapshots`;
    const snapshotDir = `${snapshotBaseDir}/${label}`;

    try {
      console.log(`[Git] Saving snapshots to ${snapshotDir}`);

      // Remove existing directory for this label if it exists
      await execAsync(`rm -rf ${snapshotDir}`, {
        cwd: this.workspaceRoot
      });

      // Create fresh directory
      await execAsync(`mkdir -p ${snapshotDir}`, {
        cwd: this.workspaceRoot
      });

      // Copy snapshot files (baseline images)
      await execAsync(`cp -r tests/visual/*.spec.ts-snapshots ${snapshotDir}/ 2>/dev/null || true`, {
        cwd: this.workspaceRoot
      });

      // Copy test-results (contains actual, expected, diff images)
      await execAsync(`cp -r test-results ${snapshotDir}/ 2>/dev/null || true`, {
        cwd: this.workspaceRoot
      });

      // Copy playwright-report (contains the HTML report and all comparison images)
      await execAsync(`cp -r playwright-report ${snapshotDir}/ 2>/dev/null || true`, {
        cwd: this.workspaceRoot
      });

      console.log('[Git] Snapshots saved to permanent storage');
      return snapshotDir;
    } catch (error) {
      console.error('[Git] Failed to save snapshots:', error);
      return snapshotDir;
    }
  }

  async getLatestSnapshotDirectory(): Promise<string | null> {
    try {
      const snapshotBaseDir = `${this.workspaceRoot}/.visual-regression-snapshots`;
      const { stdout } = await execAsync(`ls -t ${snapshotBaseDir} 2>/dev/null | head -n 1`, {
        cwd: this.workspaceRoot
      });
      const latestDir = stdout.trim();
      return latestDir ? `${snapshotBaseDir}/${latestDir}` : null;
    } catch (error) {
      console.error('[Git] No snapshot directories found:', error);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Baseline worktree + cache
  //
  // Instead of checking out the main branch in the user's working tree, the
  // baseline is captured from a separate, persistent git worktree, and the
  // resulting snapshots are cached by main's commit SHA.
  // ---------------------------------------------------------------------------

  private get snapshotRoot(): string {
    return path.join(this.workspaceRoot, '.visual-regression-snapshots');
  }

  private async git(args: string[], cwd: string = this.workspaceRoot): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  }

  async getCommitSha(ref: string): Promise<string> {
    for (const candidate of [ref, `origin/${ref}`]) {
      try {
        return (await this.git(['rev-parse', '--verify', `${candidate}^{commit}`])).trim();
      } catch {
        // try the next candidate
      }
    }
    throw new Error(`Branch '${ref}' (or 'origin/${ref}') was not found. Check visualRegression.mainBranch.`);
  }

  /** Directory that contains the spec files (`testPath` may be a directory or a single spec). */
  private testDirOf(testPath: string): string {
    return /\.[cm]?[tj]sx?$/.test(testPath) ? path.dirname(testPath) : testPath;
  }

  /** Relative paths (from `root`) of every Playwright `*-snapshots` directory below it. */
  private findSnapshotDirs(root: string): string[] {
    const found: string[] = [];
    const walk = (dir: string, rel: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === 'node_modules') {
          continue;
        }
        const childRel = path.join(rel, entry.name);
        if (entry.name.endsWith('-snapshots')) {
          found.push(childRel);
        } else {
          walk(path.join(dir, entry.name), childRel);
        }
      }
    };
    walk(root, '');
    return found;
  }

  private removeSnapshotDirs(root: string): void {
    for (const rel of this.findSnapshotDirs(root)) {
      fs.rmSync(path.join(root, rel), { recursive: true, force: true });
    }
  }

  /** Keeps the (potentially large) worktree and cache out of `git status` without touching .gitignore. */
  private async excludeSnapshotRoot(): Promise<void> {
    try {
      const rel = (await this.git(['rev-parse', '--git-path', 'info/exclude'])).trim();
      const file = path.resolve(this.workspaceRoot, rel);
      const line = '.visual-regression-snapshots/';
      const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      if (!current.split(/\r?\n/).includes(line)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`);
      }
    } catch (error) {
      console.error('[Git] Could not update info/exclude:', error);
    }
  }

  /**
   * Creates (or fast-forwards) a persistent detached worktree at `sha`, and copies
   * over everything that is typically untracked but required to run the app and tests:
   * node_modules (symlink), .env* files, the test directory and playwright config.
   */
  async prepareBaselineWorktree(sha: string, testPath: string): Promise<string> {
    const worktreeRoot = path.join(this.snapshotRoot, 'baseline-worktree');
    // The workspace folder may be a subdirectory of the repo (monorepo): mirror that inside the worktree
    const prefix = (await this.git(['rev-parse', '--show-prefix'])).trim();
    const repoRoot = (await this.git(['rev-parse', '--show-toplevel'])).trim();
    const worktree = path.resolve(worktreeRoot, prefix);
    await this.excludeSnapshotRoot();

    let ready = false;
    if (fs.existsSync(path.join(worktreeRoot, '.git'))) {
      try {
        await this.git(['checkout', '--detach', '-f', sha], worktreeRoot);
        ready = true;
      } catch (error) {
        console.error('[Git] Existing baseline worktree unusable, recreating:', error);
      }
    }

    if (!ready) {
      try {
        await this.git(['worktree', 'prune']);
      } catch {
        // not fatal
      }
      fs.rmSync(worktreeRoot, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(worktreeRoot), { recursive: true });
      await this.git(['worktree', 'add', '--detach', '--force', worktreeRoot, sha]);
    }

    // Dependencies: share node_modules (hoisted monorepo dependencies live at the repo root)
    if (prefix) {
      const rootModules = path.join(repoRoot, 'node_modules');
      const worktreeRootModules = path.join(worktreeRoot, 'node_modules');
      if (fs.existsSync(rootModules) && !fs.existsSync(worktreeRootModules)) {
        fs.symlinkSync(rootModules, worktreeRootModules, process.platform === 'win32' ? 'junction' : 'dir');
      }
    }
    const nodeModules = path.join(this.workspaceRoot, 'node_modules');
    const worktreeModules = path.join(worktree, 'node_modules');
    if (fs.existsSync(nodeModules) && !fs.existsSync(worktreeModules)) {
      fs.symlinkSync(nodeModules, worktreeModules, process.platform === 'win32' ? 'junction' : 'dir');
    }

    // Untracked env files (.env.local etc.) - never overwrite files tracked on main
    const tracked = new Set(
      (await this.git(['ls-files', '--', '.env*'], worktree)).split('\n').filter(Boolean)
    );
    for (const name of fs.readdirSync(this.workspaceRoot)) {
      const source = path.join(this.workspaceRoot, name);
      if (name.startsWith('.env') && !tracked.has(name) && fs.statSync(source).isFile()) {
        fs.copyFileSync(source, path.join(worktree, name));
      }
    }

    // Tests and config come from the workspace: they may be new/uncommitted, and the
    // same spec must run on both sides of the comparison.
    const testDir = this.testDirOf(testPath);
    this.removeSnapshotDirs(path.join(worktree, testDir));
    const sourceTests = path.join(this.workspaceRoot, testPath);
    if (fs.existsSync(sourceTests)) {
      const destTests = path.join(worktree, testPath);
      fs.mkdirSync(path.dirname(destTests), { recursive: true });
      fs.cpSync(sourceTests, destTests, {
        recursive: true,
        filter: (source) => !source.endsWith('-snapshots') && !source.includes(`${path.sep}node_modules`),
      });
    }
    for (const ext of ['ts', 'js', 'mts', 'mjs', 'cjs']) {
      const config = path.join(this.workspaceRoot, `playwright.config.${ext}`);
      if (fs.existsSync(config)) {
        fs.copyFileSync(config, path.join(worktree, `playwright.config.${ext}`));
      }
    }

    return worktree;
  }

  /** Hash of the spec files and Playwright config, so edits to the tests invalidate the cache. */
  hashTestFiles(testPath: string): string {
    const hash = crypto.createHash('sha1');
    const addFile = (file: string) => {
      hash.update(path.relative(this.workspaceRoot, file));
      hash.update(fs.readFileSync(file));
    };
    const walk = (target: string) => {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(target);
      } catch {
        return;
      }
      if (stat.isFile()) {
        addFile(target);
        return;
      }
      for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.endsWith('-snapshots')) {
          continue;
        }
        walk(path.join(target, entry.name));
      }
    };
    walk(path.join(this.workspaceRoot, testPath));
    for (const ext of ['ts', 'js', 'mts', 'mjs', 'cjs']) {
      walk(path.join(this.workspaceRoot, `playwright.config.${ext}`));
    }
    return hash.digest('hex');
  }

  static computeCacheId(sha: string, inputs: unknown): string {
    const key = crypto.createHash('sha1').update(JSON.stringify(inputs)).digest('hex').slice(0, 10);
    return `${sha.slice(0, 12)}-${key}`;
  }

  private cacheDir(cacheId: string): string {
    return path.join(this.snapshotRoot, 'baseline-cache', cacheId);
  }

  hasBaselineCache(cacheId: string): boolean {
    return fs.existsSync(path.join(this.cacheDir(cacheId), '.complete'));
  }

  /** Copies the snapshots captured in the worktree into the cache. Returns the number of snapshot files. */
  captureWorktreeToCache(worktree: string, testPath: string, cacheId: string): number {
    const sourceRoot = path.join(worktree, this.testDirOf(testPath));
    const dest = this.cacheDir(cacheId);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });

    let fileCount = 0;
    for (const rel of this.findSnapshotDirs(sourceRoot)) {
      fs.cpSync(path.join(sourceRoot, rel), path.join(dest, rel), { recursive: true });
      fileCount += fs.readdirSync(path.join(dest, rel)).length;
    }

    if (fileCount === 0) {
      fs.rmSync(dest, { recursive: true, force: true });
      throw new Error(
        `The baseline run on the main branch produced no snapshots in ${this.testDirOf(testPath)}. Check the test output.`
      );
    }

    fs.writeFileSync(path.join(dest, '.complete'), new Date().toISOString());
    this.pruneBaselineCache(5);
    return fileCount;
  }

  /** Replaces the workspace's snapshots with the cached baseline. */
  restoreBaselineFromCache(cacheId: string, testPath: string): void {
    const source = this.cacheDir(cacheId);
    const destRoot = path.join(this.workspaceRoot, this.testDirOf(testPath));
    this.removeSnapshotDirs(destRoot);
    for (const rel of this.findSnapshotDirs(source)) {
      fs.cpSync(path.join(source, rel), path.join(destRoot, rel), { recursive: true });
    }
    // Mark as recently used so pruning keeps it
    const now = new Date();
    fs.utimesSync(path.join(source, '.complete'), now, now);
  }

  private pruneBaselineCache(keep: number): void {
    const root = path.join(this.snapshotRoot, 'baseline-cache');
    try {
      const entries = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const dir = path.join(root, entry.name);
          const marker = path.join(dir, '.complete');
          const mtime = fs.existsSync(marker) ? fs.statSync(marker).mtimeMs : 0;
          return { dir, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime);
      for (const stale of entries.slice(keep)) {
        fs.rmSync(stale.dir, { recursive: true, force: true });
      }
    } catch {
      // nothing to prune
    }
  }
}
