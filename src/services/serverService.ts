import { exec, spawn, ChildProcess } from 'node:child_process';
import * as http from 'node:http';
import * as net from 'node:net';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

const execAsync = promisify(exec);

const LOOPBACK_HOSTS = ['127.0.0.1', '::1'];

export interface StartOptions {
  /** Directory to run the start command in (defaults to the workspace root). */
  cwd?: string;
  /** Port to run on (defaults to `visualRegression.serverPort`). */
  port?: number;
  /** If something already answers on the port, use it instead of failing. */
  reuseExisting?: boolean;
}

export interface StartResult {
  port: number;
  /** True when an already-running server was reused (nothing was spawned). */
  reused: boolean;
}

export class ServerService {
  private serverProcess: ChildProcess | null = null;
  private recentOutput = '';

  constructor(private readonly workspaceRoot: string) {}

  /** True if something is accepting TCP connections on the port (IPv4 or IPv6 loopback). */
  static async isPortOpen(port: number): Promise<boolean> {
    const results = await Promise.all(
      LOOPBACK_HOSTS.map(
        (host) =>
          new Promise<boolean>((resolve) => {
            const socket = net.createConnection({ port, host });
            const done = (open: boolean) => {
              socket.destroy();
              resolve(open);
            };
            socket.setTimeout(1000);
            socket.once('connect', () => done(true));
            socket.once('timeout', () => done(false));
            socket.once('error', () => done(false));
          })
      )
    );
    return results.some(Boolean);
  }

  /** True if an HTTP server answers on the port with a non-5xx response. */
  private static async isHttpReady(port: number): Promise<boolean> {
    const results = await Promise.all(
      LOOPBACK_HOSTS.map(
        (host) =>
          new Promise<boolean>((resolve) => {
            const req = http.get({ host, port, path: '/', timeout: 2000 }, (res) => {
              res.resume();
              resolve((res.statusCode ?? 500) < 500);
            });
            req.once('timeout', () => {
              req.destroy();
              resolve(false);
            });
            req.once('error', () => resolve(false));
          })
      )
    );
    return results.some(Boolean);
  }

  static async findFreePort(startAt: number): Promise<number> {
    for (let port = startAt; port < startAt + 100; port++) {
      if (!(await ServerService.isPortOpen(port))) {
        return port;
      }
    }
    throw new Error(`No free port found between ${startAt} and ${startAt + 99}`);
  }

  /**
   * Spawns the dev server. Returns immediately - call `waitUntilReady` to wait for it.
   * `{port}` in `visualRegression.serverStartCommand` is replaced with the port, and the
   * PORT environment variable is set as well.
   */
  async start(options: StartOptions = {}): Promise<StartResult> {
    const config = vscode.workspace.getConfiguration('visualRegression');
    const startCommandTemplate = config.get<string>('serverStartCommand', 'npm run dev');
    const port = options.port ?? config.get<number>('serverPort', 3000);
    const cwd = options.cwd ?? this.workspaceRoot;
    const customEnvVars = config.get<Record<string, string>>('environmentVariables', {});

    if (await ServerService.isPortOpen(port)) {
      if (options.reuseExisting) {
        console.log(`[Server] Reusing server already running on port ${port}`);
        return { port, reused: true };
      }
      throw new Error(
        `Port ${port} is already in use. Please stop the process using this port or configure a different port in settings (visualRegression.serverPort).`
      );
    }

    if (this.serverProcess) {
      await this.stop();
    }

    const startCommand = startCommandTemplate.replaceAll('{port}', String(port));
    // Pass environment variables to the server (critical for NEXT_PUBLIC_* vars)
    const env = { ...process.env, ...customEnvVars, PORT: String(port) };

    console.log(`[Server] Starting "${startCommand}" in ${cwd} on port ${port}`);
    this.recentOutput = '';

    const child = spawn(startCommand, {
      cwd,
      env,
      shell: true,
      // Own process group so we can kill the whole tree (npm -> node -> next ...)
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.serverProcess = child;

    const capture = (data: Buffer) => {
      const text = data.toString();
      this.recentOutput = (this.recentOutput + text).slice(-2000);
      console.log(`Server[${port}]: ${text}`);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.on('error', (error) => {
      this.recentOutput += `\n${error.message}`;
    });

    return { port, reused: false };
  }

  /** Resolves as soon as the server answers HTTP; rejects on timeout, early exit or cancellation. */
  async waitUntilReady(
    port: number,
    timeoutMs: number,
    token?: vscode.CancellationToken
  ): Promise<void> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (token?.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      const child = this.serverProcess;
      if (child && (child.exitCode !== null || child.signalCode !== null)) {
        throw new Error(
          `Dev server exited (${child.exitCode ?? child.signalCode}) before it was ready on port ${port}.\n${this.recentOutput.trim()}`
        );
      }

      if (await ServerService.isHttpReady(port)) {
        console.log(`[Server] Port ${port} ready after ${Date.now() - startedAt}ms`);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    throw new Error(
      `Dev server did not respond on port ${port} within ${Math.round(timeoutMs / 1000)}s. ` +
        'Increase visualRegression.serverStartupTimeout, and make sure serverStartCommand uses {port} (or honours the PORT env var) rather than a hardcoded port.' +
        (this.recentOutput.trim() ? `\n${this.recentOutput.trim()}` : '')
    );
  }

  async stop(): Promise<void> {
    const child = this.serverProcess;
    if (!child) {
      return;
    }
    this.serverProcess = null;

    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    await new Promise<void>((resolve) => {
      const forceTimer = setTimeout(() => {
        this.killTree(child, 'SIGKILL');
        resolve();
      }, 5000);

      child.once('exit', () => {
        clearTimeout(forceTimer);
        resolve();
      });

      this.killTree(child, 'SIGTERM');
    });
  }

  private killTree(child: ChildProcess, signal: NodeJS.Signals): void {
    if (!child.pid) {
      return;
    }
    if (process.platform === 'win32') {
      exec(`taskkill /pid ${child.pid} /T /F`);
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    }
  }

  /** Last-resort cleanup of whatever is listening on a port (macOS/Linux only). */
  async killPort(port: number): Promise<void> {
    if (process.platform === 'win32') {
      return;
    }
    try {
      console.log(`[Server] Killing any process on port ${port}`);
      await execAsync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`);
    } catch {
      // Port already free or command failed - that's fine
    }
  }
}
