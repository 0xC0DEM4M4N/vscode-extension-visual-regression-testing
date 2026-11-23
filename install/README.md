# Visual Regression Testing - Installation Files

This folder contains pre-built VSIX files ready to install into VS Code.

## Quick Install

1. Download the latest `.vsix` file from this folder
2. In VS Code, open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
3. Select `Extensions: Install from VSIX...`
4. Choose the downloaded `.vsix` file
5. Reload VS Code

## Building a New VSIX File

**Quick Method (Recommended):**

From the parent directory, run:

```bash
npm run build-install
```

This will:
1. Build the extension with webpack
2. Clean the install folder
3. Generate the VSIX package
4. Copy it to the `install/` folder automatically

**Manual Method:**

```bash
cd ..
npm install
npm run package
npm run vsce-package
```

Then copy the generated `.vsix` file to this `install/` folder.

## File Format

- `vscode-extension-visual-regression-testing-X.X.X.vsix` - The compiled extension package

## Notes

- VSIX files in this folder are committed to the repository for easy distribution
- Always build from the latest source code in the parent directory
- Update this folder when releasing new versions
