import * as vscode from "vscode";
import { GitService } from "./services/gitService";
import { PlaywrightService } from "./services/playwrightService";
import { ServerService } from "./services/serverService";
import { TestRunner } from "./testRunner";

interface SavedUrlSet {
  name: string;
  urls: string[];
}

export class VisualRegressionPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "visualRegressionPanel";
  private _view?: vscode.WebviewView;
  private _disposables: vscode.Disposable[] = [];
  private readonly _gitService: GitService;
  private _gitHeadWatcher?: vscode.FileSystemWatcher;
  private _testInProgress: boolean = false;
  private _testCancellationTokenSource?: vscode.CancellationTokenSource;
  private _currentLoadedSetName?: string;
  private _currentLoadedSetUrls?: string[];

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _workspaceFolder: vscode.WorkspaceFolder,
    private readonly _context: vscode.ExtensionContext
  ) {
    // Create service instances once and reuse them
    this._gitService = new GitService(this._workspaceFolder.uri.fsPath);

    // Watch for git branch changes
    this._setupGitWatcher();
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Handle messages from the webview - store disposable
    const messageDisposable = webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case "runTest": {
          await this._runTest(data.urls);
          break;
        }
        case "showReport": {
          await vscode.commands.executeCommand("visualRegression.showReport");
          break;
        }
        case "openSettings": {
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "visualRegression"
          );
          break;
        }
        case "saveUrlSet": {
          await this._saveUrlSet(data.name, data.urls);
          break;
        }
        case "loadUrlSet": {
          await this._loadUrlSet(data.name);
          break;
        }
        case "runUrlSet": {
          await this._runUrlSet(data.name);
          break;
        }
        case "deleteUrlSet": {
          await this._deleteUrlSet(data.name);
          break;
        }
        case "requestState": {
          await this._updateWebviewState();
          break;
        }
        case "cancelTest": {
          this._cancelTest();
          break;
        }
        case "checkUnsavedChanges": {
          const hasChanges = this._checkUnsavedSetChanges(data.urls);
          this._sendMessage({
            type: "unsavedChangesStatus",
            hasUnsavedChanges: hasChanges,
            loadedSetName: this._currentLoadedSetName
          });
          break;
        }
        case "checkUrlsChanged": {
          // Check if URLs have changed from the loaded set
          const hasChanges = this._checkUnsavedSetChanges(data.urls);
          if (hasChanges) {
            // Clear the loaded set name since URLs have been modified
            this._currentLoadedSetName = undefined;
            this._currentLoadedSetUrls = undefined;
            await this._updateWebviewState();
          }
          break;
        }
      }
    });

    // Clean up when webview is disposed
    webviewView.onDidDispose(() => {
      this._dispose();
    });

    this._disposables.push(messageDisposable);
  }

  private async _updateWebviewState() {
    const config = vscode.workspace.getConfiguration("visualRegression");
    const mainBranch = config.get<string>("mainBranch", "main");

    let currentBranch = "";
    let isOnMainBranch = false;

    try {
      currentBranch = await this._gitService.getCurrentBranch();
      isOnMainBranch = currentBranch === mainBranch;
    } catch (error) {
      // Not a git repo or git not available
      currentBranch = "unknown";
    }

    const savedUrlSets = this._getSavedUrlSets();

    this._sendMessage({
      type: "stateUpdate",
      currentBranch,
      mainBranch,
      isOnMainBranch,
      testInProgress: this._testInProgress,
      savedUrlSets,
      loadedSetName: this._currentLoadedSetName,
      config: {
        mainBranch: config.get<string>("mainBranch", "main"),
        serverPort: config.get<number>("serverPort", 3000),
        serverStartCommand: config.get<string>("serverStartCommand", "npm run dev"),
        testPath: config.get<string>("testPath", "tests/visual"),
      }
    });
  }

  private _getSavedUrlSets(): SavedUrlSet[] {
    return this._context.workspaceState.get<SavedUrlSet[]>("savedUrlSets", []);
  }

  private async _saveUrlSet(name: string, urlsString: string) {
    const urls = urlsString
      .split(/[,\n]/)
      .map((url) => url.trim())
      .filter((url) => url.length > 0);

    if (urls.length === 0) {
      vscode.window.showErrorMessage("Cannot save empty URL set");
      return;
    }

    const savedSets = this._getSavedUrlSets();
    const existingIndex = savedSets.findIndex((set) => set.name === name);

    if (existingIndex >= 0) {
      savedSets[existingIndex].urls = urls;
    } else {
      savedSets.push({ name, urls });
    }

    await this._context.workspaceState.update("savedUrlSets", savedSets);

    // Update tracking to reflect saved state
    this._currentLoadedSetName = name;
    this._currentLoadedSetUrls = [...urls];

    await this._updateWebviewState();
    vscode.window.showInformationMessage(`Saved URL set: ${name}`);
  }

  private _checkUnsavedSetChanges(currentUrlsString: string): boolean {
    // If no set is loaded, there are no unsaved changes
    if (!this._currentLoadedSetName || !this._currentLoadedSetUrls) {
      return false;
    }

    // Parse current URLs from textarea
    const currentUrls = currentUrlsString
      .split(/[,\n]/)
      .map((url) => url.trim())
      .filter((url) => url.length > 0);

    // Compare arrays
    if (currentUrls.length !== this._currentLoadedSetUrls.length) {
      return true;
    }

    // Check if URLs match (order matters)
    return !currentUrls.every((url, index) => url === this._currentLoadedSetUrls![index]);
  }

  private async _loadUrlSet(name: string) {
    const savedSets = this._getSavedUrlSets();
    const urlSet = savedSets.find((set) => set.name === name);

    if (urlSet) {
      // Track the currently loaded set
      this._currentLoadedSetName = name;
      this._currentLoadedSetUrls = [...urlSet.urls];

      this._sendMessage({
        type: "loadedUrlSet",
        name: name,
        urls: urlSet.urls.join("\n"),
      });
    }
  }

  private async _runUrlSet(name: string) {
    const savedSets = this._getSavedUrlSets();
    const urlSet = savedSets.find((set) => set.name === name);

    if (urlSet) {
      // Track the currently loaded set before running
      this._currentLoadedSetName = name;
      this._currentLoadedSetUrls = [...urlSet.urls];

      // Load URLs into the text field first
      this._sendMessage({
        type: "loadedUrlSet",
        name: name,
        urls: urlSet.urls.join("\n"),
      });

      // Then run the test
      await this._runTest(urlSet.urls.join("\n"));
    }
  }

  private async _deleteUrlSet(name: string) {
    const savedSets = this._getSavedUrlSets();
    const filtered = savedSets.filter((set) => set.name !== name);
    await this._context.workspaceState.update("savedUrlSets", filtered);
    await this._updateWebviewState();
    vscode.window.showInformationMessage(`Deleted URL set: ${name}`);
  }

  private _cancelTest() {
    if (this._testCancellationTokenSource) {
      this._testCancellationTokenSource.cancel();
      vscode.window.showInformationMessage("Cancelling test...");
    }
  }

  private async _runTest(urlInput: string) {
    const urlPaths = urlInput
      .split(/[,\n]/)
      .map((url) => url.trim())
      .filter((url) => url.length > 0);

    if (urlPaths.length === 0) {
      this._sendMessage({ type: "error", message: "Please enter at least one URL path" });
      return;
    }

    // Check for uncommitted changes (excluding page.spec.ts)
    try {
      const hasUncommittedChanges = await this._gitService.hasUncommittedChanges("page.spec.ts");
      if (hasUncommittedChanges) {
        const proceed = await vscode.window.showWarningMessage(
          "You have uncommitted changes in your working directory. Running the test will involve changing branches, which may cause these changes to be lost.",
          "Run Anyway",
          "Cancel"
        );
        if (proceed !== "Run Anyway") {
          this._sendMessage({ type: "testCancelled" });
          return;
        }
      }
    } catch (error) {
      // If we can't check git status, continue anyway
      console.error('[Panel] Failed to check uncommitted changes:', error);
    }

    // Check for unsaved changes to the loaded set
    if (this._checkUnsavedSetChanges(urlInput)) {
      const proceed = await vscode.window.showWarningMessage(
        `You have unsaved changes to the "${this._currentLoadedSetName}" set. These changes will be lost if you continue.`,
        "Save Changes",
        "Run Anyway",
        "Cancel"
      );

      if (proceed === "Save Changes") {
        // Save the changes first, then continue
        if (this._currentLoadedSetName) {
          await this._saveUrlSet(this._currentLoadedSetName, urlInput);
        }
      } else if (proceed !== "Run Anyway") {
        this._sendMessage({ type: "testCancelled" });
        return;
      }
    }

    // Check if on main branch
    const config = vscode.workspace.getConfiguration("visualRegression");
    const mainBranch = config.get<string>("mainBranch", "main");

    try {
      const currentBranch = await this._gitService.getCurrentBranch();
      if (currentBranch === mainBranch) {
        // Update webview to show warning
        await this._updateWebviewState();

        const proceed = await vscode.window.showWarningMessage(
          `You are on the ${mainBranch} branch. Visual regression tests compare against ${mainBranch} and should be run from a feature branch.`,
          "Run Anyway",
          "Cancel"
        );
        if (proceed !== "Run Anyway") {
          this._sendMessage({ type: "testCancelled" });
          return;
        }
      }
    } catch (error) {
      // Not a git repo, continue anyway
    }

    const serverService = new ServerService(this._workspaceFolder.uri.fsPath);
    const playwrightService = new PlaywrightService(this._workspaceFolder.uri.fsPath);

    const testRunner = new TestRunner(
      this._gitService,
      serverService,
      playwrightService,
      config
    );

    try {
      this._testInProgress = true;
      this._testCancellationTokenSource = new vscode.CancellationTokenSource();
      this._sendMessage({ type: "testStarted" });

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Running Visual Regression Test",
          cancellable: true,
        },
        async (progress, token) => {
          // Link external cancellation token to our internal one
          token.onCancellationRequested(() => {
            this._testCancellationTokenSource?.cancel();
          });

          const cancellationToken = this._testCancellationTokenSource?.token;
          await testRunner.runTest(urlPaths, progress, cancellationToken);
        }
      );

      this._sendMessage({ type: "testCompleted", success: true });
      vscode.window.showInformationMessage("Visual regression test completed successfully!");
    } catch (error) {
      if (error instanceof vscode.CancellationError) {
        this._sendMessage({ type: "testCancelled" });
        vscode.window.showWarningMessage("Visual regression test was cancelled");
      } else {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error("[Panel] Full error:", error);
        this._sendMessage({
          type: "testCompleted",
          success: false,
          error: errorMsg
        });
        vscode.window.showErrorMessage(`Visual regression test failed: ${errorMsg}`);
      }
    } finally {
      this._testInProgress = false;
      this._testCancellationTokenSource?.dispose();
      this._testCancellationTokenSource = undefined;
      testRunner.dispose();
      // Update state after test completes to refresh branch info
      await this._updateWebviewState();
    }
  }

  private _sendMessage(message: any) {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const nonce = this._getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Visual Regression Testing</title>
  <style>
    body {
      padding: 16px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
    }
    h2 {
      margin-top: 0;
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 16px;
    }
    h3 {
      font-size: 14px;
      font-weight: 600;
      margin-top: 24px;
      margin-bottom: 12px;
    }
    .section {
      margin-bottom: 24px;
    }
    label {
      display: block;
      margin-bottom: 8px;
      font-size: 13px;
      font-weight: 500;
    }
    textarea, input {
      width: 100%;
      box-sizing: border-box;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      padding: 8px;
      font-family: var(--vscode-font-family);
      font-size: 13px;
    }
    textarea {
      resize: vertical;
      min-height: 100px;
      margin-bottom: 12px;
    }
    input {
      margin-bottom: 8px;
    }
    textarea:focus, input:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 8px 14px;
      cursor: pointer;
      font-size: 13px;
      margin: 0;
      white-space: nowrap;
      line-height: 1.2;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    button:not(:last-child) {
      margin-right: 8px;
    }
    .section button {
      margin-bottom: 8px;
    }
    button:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    button:disabled:hover {
      background: var(--vscode-button-background);
    }
    textarea:disabled, input:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .button-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .button-secondary:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .button-secondary:disabled:hover {
      background: var(--vscode-button-secondaryBackground);
    }
    .button-small {
      padding: 6px 10px;
      font-size: 13px;
      min-height: 28px;
    }
    .icon-button {
      padding: 6px 10px;
      min-width: 28px;
      min-height: 28px;
      font-size: 13px;
    }
    .warning {
      background: var(--vscode-inputValidation-warningBackground);
      border: 1px solid var(--vscode-inputValidation-warningBorder);
      color: var(--vscode-inputValidation-warningForeground);
      padding: 12px;
      border-radius: 4px;
      margin-bottom: 16px;
      font-size: 13px;
    }
    .warning-icon {
      margin-right: 8px;
    }
    .status {
      margin-top: 16px;
      padding: 12px;
      border-radius: 4px;
      font-size: 13px;
      display: flex;
      min-height: 44px;
      box-sizing: border-box;
    }
    .status.running {
      background: var(--vscode-inputValidation-infoBorder);
      color: var(--vscode-inputValidation-infoForeground);
    }
    .status.success {
      background: var(--vscode-testing-iconPassed);
      color: var(--vscode-editor-background);
    }
    .status.error {
      background: var(--vscode-inputValidation-errorBorder);
      color: var(--vscode-inputValidation-errorForeground);
    }
    .help-text {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 12px;
    }
    .info-grid {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 8px 12px;
      font-size: 12px;
      margin-bottom: 16px;
      padding: 12px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 4px;
    }
    .info-label {
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
    }
    .info-value {
      color: var(--vscode-foreground);
    }
    .saved-set {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px;
      margin-bottom: 4px;
      background: var(--vscode-list-hoverBackground);
      border-radius: 4px;
      gap: 8px;
    }
    .saved-set:hover:not(.disabled):not(.loaded) {
      background: var(--vscode-list-activeSelectionBackground);
    }
    .saved-set.disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .saved-set.loaded {
      background: var(--vscode-list-activeSelectionBackground);
      border-left: 4px solid var(--vscode-charts-blue);
      padding: 8px 8px 8px 12px;
    }
    .saved-set.loaded .saved-set-name {
      font-weight: 700;
      color: var(--vscode-charts-blue);
    }
    .saved-set-name {
      flex: 1;
      font-size: 13px;
    }
    .saved-set-count {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .saved-set-buttons {
      display: flex;
      gap: 4px;
      align-items: center;
    }
    .saved-sets-empty {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      padding: 8px;
    }
    .save-controls {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
      align-items: stretch;
    }
    .save-controls input {
      flex: 1;
      margin-bottom: 0;
      height: auto;
    }
    .save-controls button {
      margin: 0;
      padding: 8px 14px;
      height: auto;
      align-self: stretch;
    }
  </style>
</head>
<body>
  <h2>Visual Regression Testing</h2>

  <!-- Test Running Banner -->
  <div id="testRunningBanner" class="status running" style="display: none; align-items: center; justify-content: space-between;">
    <span>⏳ Visual Regression Test in Progress...</span>
    <button id="cancelTestBtn" class="button-secondary button-small" style="margin: 0;">Cancel</button>
  </div>

  <!-- Branch Warning -->
  <div id="branchWarning" class="warning" style="display: none;">
    <span class="warning-icon">⚠️</span>
    <span id="warningText"></span>
  </div>

  <!-- Refresh Branch Button (shown only when on main branch) -->
  <div id="refreshBranchContainer" style="display: none; text-align: center; margin-bottom: 16px;">
    <button id="refreshBranchBtn" class="button-secondary">🔄 I've Changed Branch</button>
  </div>

  <!-- Current Configuration -->
  <div id="configSection" class="section">
    <h3>Configuration</h3>
    <div class="info-grid">
      <span class="info-label">Current Branch:</span>
      <span class="info-value" id="currentBranch">-</span>
      <span class="info-label">Base Branch:</span>
      <span class="info-value" id="mainBranch">-</span>
      <span class="info-label">Server Port:</span>
      <span class="info-value" id="serverPort">-</span>
      <span class="info-label">Test Path:</span>
      <span class="info-value" id="testPath">-</span>
    </div>
    <button id="openSettingsBtn" class="button-secondary">Open Settings</button>
  </div>

  <!-- URL Input -->
  <div id="urlInputSection" class="section">
    <h3>Test URLs</h3>
    <label for="urlInput">URL Paths to Test</label>
    <div class="help-text">Enter one or more paths (one per line or comma-separated)</div>
    <textarea id="urlInput" placeholder="/&#10;/about&#10;/contact">/</textarea>

    <!-- Save URL Set -->
    <div class="save-controls">
      <input type="text" id="setNameInput" placeholder="Set name (e.g., 'Homepage Tests')">
      <button id="saveSetBtn" class="button-secondary">Save Set</button>
    </div>

    <div id="actionButtons">
      <button id="runTestBtn" title="Run Test">▶ Run Test</button>
      <button id="showReportBtn" class="button-secondary" title="Show Report">◉ Show Report</button>
    </div>
  </div>

  <!-- Saved URL Sets -->
  <div id="savedSetsSection" class="section">
    <h3>Saved URL Sets</h3>
    <div id="savedSets" class="saved-sets-empty">No saved URL sets yet</div>
  </div>

  <!-- Status -->
  <div id="status" style="display: none;"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const urlInput = document.getElementById('urlInput');
    const runTestBtn = document.getElementById('runTestBtn');
    const showReportBtn = document.getElementById('showReportBtn');
    const openSettingsBtn = document.getElementById('openSettingsBtn');
    const saveSetBtn = document.getElementById('saveSetBtn');
    const setNameInput = document.getElementById('setNameInput');
    const statusDiv = document.getElementById('status');
    const branchWarning = document.getElementById('branchWarning');
    const warningText = document.getElementById('warningText');
    const savedSetsDiv = document.getElementById('savedSets');
    const actionButtons = document.getElementById('actionButtons');
    const testRunningBanner = document.getElementById('testRunningBanner');
    const cancelTestBtn = document.getElementById('cancelTestBtn');
    const refreshBranchBtn = document.getElementById('refreshBranchBtn');
    const refreshBranchContainer = document.getElementById('refreshBranchContainer');

    let currentLoadedSetName = null;

    // Request initial state
    vscode.postMessage({ type: 'requestState' });

    // Clear loaded set name when URLs are manually changed
    urlInput.addEventListener('input', () => {
      if (currentLoadedSetName) {
        // Check if the URLs still match the loaded set
        const currentUrls = urlInput.value.trim();
        vscode.postMessage({
          type: 'checkUrlsChanged',
          urls: currentUrls
        });
      }
    });

    runTestBtn.addEventListener('click', () => {
      const urls = urlInput.value;
      if (!urls.trim()) {
        showStatus('Please enter at least one URL path', 'error');
        return;
      }
      vscode.postMessage({
        type: 'runTest',
        urls: urls
      });
    });

    showReportBtn.addEventListener('click', () => {
      vscode.postMessage({
        type: 'showReport'
      });
    });

    openSettingsBtn.addEventListener('click', () => {
      vscode.postMessage({
        type: 'openSettings'
      });
    });

    saveSetBtn.addEventListener('click', () => {
      // Auto-populate with loaded set name if available
      let name = setNameInput.value.trim();
      if (!name && currentLoadedSetName) {
        name = currentLoadedSetName;
      }

      const urls = urlInput.value.trim();

      if (!name) {
        showStatus('Please enter a name for the URL set', 'error');
        setTimeout(() => hideStatus(), 3000);
        return;
      }

      if (!urls) {
        showStatus('Please enter at least one URL', 'error');
        setTimeout(() => hideStatus(), 3000);
        return;
      }

      vscode.postMessage({
        type: 'saveUrlSet',
        name: name,
        urls: urls
      });

      // Keep the loaded set name if we're updating the same set
      if (currentLoadedSetName === name) {
        // Keep the name in the input field
        setNameInput.value = name;
      } else {
        setNameInput.value = '';
      }
    });

    refreshBranchBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'requestState' });
    });

    cancelTestBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'cancelTest' });
      // Update banner to show cancelling state
      testRunningBanner.querySelector('span').textContent = '⏳ Cancelling test...';
      cancelTestBtn.style.display = 'none';
    });


    function showStatus(message, type) {
      statusDiv.textContent = message;
      statusDiv.className = 'status ' + type;
      statusDiv.style.display = 'block';
    }

    function hideStatus() {
      statusDiv.style.display = 'none';
    }

    function updateSavedSets(savedSets, loadedSetName) {
      if (!savedSets || savedSets.length === 0) {
        savedSetsDiv.className = 'saved-sets-empty';
        savedSetsDiv.innerHTML = 'No saved URL sets yet';
        return;
      }

      savedSetsDiv.className = '';
      savedSetsDiv.innerHTML = '';

      savedSets.forEach(set => {
        const setDiv = document.createElement('div');
        setDiv.className = 'saved-set';

        // Highlight the loaded set
        if (loadedSetName && set.name === loadedSetName) {
          setDiv.classList.add('loaded');
        }

        const nameSpan = document.createElement('span');
        nameSpan.className = 'saved-set-name';
        nameSpan.textContent = set.name;

        const countSpan = document.createElement('span');
        countSpan.className = 'saved-set-count';
        countSpan.textContent = set.urls.length + ' URL' + (set.urls.length !== 1 ? 's' : '');

        const runBtn = document.createElement('button');
        runBtn.textContent = '▶';
        runBtn.title = 'Run Test';
        runBtn.className = 'button-small icon-button';
        runBtn.onclick = (e) => {
          e.stopPropagation();
          vscode.postMessage({
            type: 'runUrlSet',
            name: set.name
          });
        };

        const loadBtn = document.createElement('button');
        loadBtn.textContent = '✎';
        loadBtn.title = 'Edit/Load';
        loadBtn.className = 'button-secondary button-small icon-button';
        loadBtn.onclick = (e) => {
          e.stopPropagation();
          vscode.postMessage({
            type: 'loadUrlSet',
            name: set.name
          });
        };

        const deleteBtn = document.createElement('button');
        deleteBtn.textContent = '×';
        deleteBtn.title = 'Delete';
        deleteBtn.className = 'button-secondary button-small icon-button';
        deleteBtn.onclick = (e) => {
          e.stopPropagation();
          vscode.postMessage({
            type: 'deleteUrlSet',
            name: set.name
          });
        };

        const buttonsContainer = document.createElement('div');
        buttonsContainer.className = 'saved-set-buttons';
        buttonsContainer.appendChild(runBtn);
        buttonsContainer.appendChild(loadBtn);
        buttonsContainer.appendChild(deleteBtn);

        setDiv.appendChild(nameSpan);
        setDiv.appendChild(countSpan);
        setDiv.appendChild(buttonsContainer);
        savedSetsDiv.appendChild(setDiv);
      });
    }

    function setTestingState(isTesting) {
      urlInput.disabled = isTesting;
      setNameInput.disabled = isTesting;
      saveSetBtn.disabled = isTesting;
      runTestBtn.disabled = isTesting;
      showReportBtn.disabled = isTesting;
      openSettingsBtn.disabled = isTesting;
      refreshBranchBtn.disabled = isTesting;

      // Disable all load/delete/run buttons in saved sets
      const allButtons = savedSetsDiv.querySelectorAll('button');
      allButtons.forEach(btn => {
        btn.disabled = isTesting;
      });

      // Add/remove disabled class on saved-set divs to prevent hover
      const savedSetDivs = savedSetsDiv.querySelectorAll('.saved-set');
      savedSetDivs.forEach(div => {
        if (isTesting) {
          div.classList.add('disabled');
        } else {
          div.classList.remove('disabled');
        }
      });

      // Toggle visibility of test running banner (cancel button stays enabled)
      if (isTesting) {
        testRunningBanner.style.display = 'flex';
        // Reset banner text and show cancel button
        testRunningBanner.querySelector('span').textContent = '⏳ Visual Regression Test in Progress...';
        cancelTestBtn.style.display = 'inline-flex';
      } else {
        testRunningBanner.style.display = 'none';
      }
    }

    // Handle messages from the extension
    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.type) {
        case 'stateUpdate':
          // Update branch info
          document.getElementById('currentBranch').textContent = message.currentBranch;
          document.getElementById('mainBranch').textContent = message.mainBranch;
          document.getElementById('serverPort').textContent = message.config.serverPort;
          document.getElementById('testPath').textContent = message.config.testPath;

          // Show warning if on main branch AND no test is in progress
          // Don't show warning during tests since branch switching is expected
          if (message.isOnMainBranch && !message.testInProgress) {
            warningText.textContent = \`You are on the \${message.mainBranch} branch. Tests should be run from a feature branch to compare against \${message.mainBranch}.\`;
            branchWarning.style.display = 'block';
            refreshBranchContainer.style.display = 'block';
            // Hide all sections when on main branch
            document.getElementById('configSection').style.display = 'none';
            document.getElementById('urlInputSection').style.display = 'none';
            document.getElementById('savedSetsSection').style.display = 'none';
            // Hide status message as well
            statusDiv.style.display = 'none';
          } else {
            branchWarning.style.display = 'none';
            refreshBranchContainer.style.display = 'none';
            // Show all sections when on feature branch or test is running
            document.getElementById('configSection').style.display = 'block';
            document.getElementById('urlInputSection').style.display = 'block';
            document.getElementById('savedSetsSection').style.display = 'block';
          }

          // Update loaded set name tracking
          currentLoadedSetName = message.loadedSetName || null;

          // Update saved sets FIRST before setting testing state
          // This ensures the buttons exist before we try to disable them
          updateSavedSets(message.savedUrlSets, message.loadedSetName);

          // Update testing state if test is in progress
          // This must be called AFTER updateSavedSets so the buttons exist
          if (message.testInProgress) {
            setTestingState(true);
          } else {
            setTestingState(false);
          }
          break;

        case 'testStarted':
          setTestingState(true);
          break;

        case 'testCompleted':
          setTestingState(false);
          if (message.success) {
            showStatus('✅ Test completed successfully!', 'success');
          } else {
            showStatus('❌ Test failed: ' + (message.error || 'Unknown error'), 'error');
          }
          setTimeout(() => hideStatus(), 5000);
          break;

        case 'testCancelled':
          setTestingState(false);
          hideStatus();
          break;

        case 'loadedUrlSet':
          urlInput.value = message.urls;
          currentLoadedSetName = message.name;
          setNameInput.value = message.name;

          // Re-render saved sets to show the loaded state
          vscode.postMessage({ type: 'requestState' });

          showStatus('URL set loaded', 'success');
          setTimeout(() => hideStatus(), 2000);
          break;

        case 'error':
          showStatus(message.message, 'error');
          setTimeout(() => hideStatus(), 5000);
          break;
      }
    });
  </script>
</body>
</html>`;
  }

  private _getNonce() {
    let text = "";
    const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  private _setupGitWatcher() {
    // Watch for changes to .git/HEAD which indicates a branch change
    this._gitHeadWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this._workspaceFolder, '.git/HEAD')
    );

    // Update panel when branch changes
    this._gitHeadWatcher.onDidChange(() => {
      this._updateWebviewState();
    });

    this._disposables.push(this._gitHeadWatcher);
  }

  private _dispose() {
    // Dispose all event listeners
    for (const disposable of this._disposables) {
      disposable.dispose();
    }
    this._disposables = [];

    // Dispose git watcher
    if (this._gitHeadWatcher) {
      this._gitHeadWatcher.dispose();
    }
  }

  public dispose() {
    this._dispose();
  }
}
