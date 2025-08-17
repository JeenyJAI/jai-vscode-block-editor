import * as vscode from 'vscode';
import { FileResolver } from './utils/fileResolver.js';
import { BlockEditor, ExecutionMode } from './blockEditor/index.js';
import { readFileWithInfo, writeFilePreservingFormat, FileReadResult, FileInfo } from './utils/fileHelpers.js';
import type { OperationsResult, OperationResult } from './blockEditor/types.js';

export class TextInserterPanel {
  public static currentPanel: TextInserterPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private replacer: BlockEditor;

  public static createOrShow(extensionUri: vscode.Uri): void {
    // If panel already exists, show it
    if (TextInserterPanel.currentPanel) {
      TextInserterPanel.currentPanel._panel.reveal(vscode.ViewColumn.Two);
      return;
    }

    // Create new panel
    const panel = vscode.window.createWebviewPanel(
      'blockEditorTerminal',
      'Block Editor',
      {
        viewColumn: vscode.ViewColumn.Two,
        preserveFocus: true,
      },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    TextInserterPanel.currentPanel = new TextInserterPanel(panel, extensionUri);
  }

  private constructor(panel: vscode.WebviewPanel, _extensionUri: vscode.Uri) {
    this._panel = panel;
    
    // Read configuration from VS Code settings
    const config = vscode.workspace.getConfiguration('blockEditor');
    
    this.replacer = new BlockEditor({
      validatePaths: config.get<boolean>('validatePaths', true),
      mixedEolPolicy: config.get<'ignore' | 'skip' | 'warn' | 'normalize'>('mixedEolPolicy', 'warn'),
      enableVerboseLogging: config.get<boolean>('enableVerboseLogging', false),
    });

    // console.log('TextInserterPanel constructor called');
    // console.log('Path validation is DISABLED for debugging');

    // Set HTML content
    this._update();

    // Handle messages from webview
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        console.log('Received message:', message);
        switch (message.type) {
          case 'executeCommands':
            console.log('Execute commands with mode:', message.mode);
            if (message.mode === 'preview-and-apply') {
              await this._previewAndApply(message.value);
            }
            break;
          case 'showMessage':
            vscode.window.showInformationMessage(message.value);
            break;
        }
      },
      null,
      this._disposables,
    );

    console.log('Message handler registered');

    // Handle panel disposal
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  private async _previewAndApply(commandsText: string): Promise<void> {
    console.log('=== _previewAndApply called ===');
    console.log('Commands:', commandsText);

    try {
      // Add IDs to blocks
      const { commandsWithIds, idMap } = this._addIdsToCommands(commandsText);

      // Update text in WebView
      this._panel.webview.postMessage({
        type: 'updateCommands',
        value: commandsWithIds,
      });

      // Split commands
      const commands = this._splitDSLCommands(commandsWithIds);

      if (commands.length === 0) {
        vscode.window.showWarningMessage('No DSL commands found');
        return;
      }

      // Get workspace folder
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
      }

      // Extract all files from commands using parser
      const fileUris = await this._extractFilesFromCommands(commands);

      // Fallback to active document if no files specified
      if (fileUris.length === 0) {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
          vscode.window.showErrorMessage('No active file and no files specified in commands');
          return;
        }
        fileUris.push(activeEditor.document.uri);
      }

      // File reader/writer working with Uri
      const readFile = async (uri: vscode.Uri): Promise<FileReadResult> => {
        return await readFileWithInfo(uri);
      };

      const writeFile = async (uri: vscode.Uri, content: string, info: FileInfo): Promise<void> => {
        await writeFilePreservingFormat(uri, content, info);
      };

      // First do preview
      const previewResult = await this.replacer.applyToFilesUri(
        commands,
        fileUris,
        readFile,
        async () => {}, // Don't write in preview
        'preview'
      );

      // Show statistics and ask for confirmation
      const confirmMessage = this._createConfirmMessage(previewResult, idMap);

      const answer = await vscode.window.showInformationMessage(
        confirmMessage,
        { modal: true },
        { title: 'Apply', isCloseAffordance: false },
        { title: 'Cancel', isCloseAffordance: true }
      );

      if (answer?.title === 'Apply') {
        // Apply changes
        const result = await this.replacer.applyToFilesUri(
          commands,
          fileUris,
          readFile,
          writeFile,
          'apply'
        );

        // Show results
        this._showResults(result, 'apply');

        // If successfully applied changes, offer to clear field
        if (result.successful > 0) {
          this._panel.webview.postMessage({ type: 'commandsApplied' });
        }
      }
    } catch (error) {
      vscode.window.showErrorMessage(`BlockEditor error: ${error}`);
      console.error('BlockEditor error:', error);
    }
  }

  private _addIdsToCommands(commandsText: string): { commandsWithIds: string; idMap: Map<string, number> } {
    const idMap = new Map<string, number>();
    let blockIndex = 0;

    // Replace ---NEXT_BLOCK--- with ---NEXT_BLOCK:ID---
    const commandsWithIds = commandsText.replace(/---NEXT_BLOCK---/g, () => {
      blockIndex++;
      const id = blockIndex.toString().padStart(4, '0');
      idMap.set(id, blockIndex);
      return `---NEXT_BLOCK:${id}---`;
    });

    // Add ID 0000 for first block
    idMap.set('0000', 0);

    return { commandsWithIds, idMap };
  }

  private _createConfirmMessage(result: OperationsResult, _idMap: Map<string, number>): string {
    let message = `PRE-EXECUTION ANALYSIS\n`;
    message += `${'─'.repeat(30)}\n`;
    message += `Total commands: ${result.totalCommands}\n`;
    message += `Matches found: ${result.successful}\n`;
    message += `No matches for: ${result.skipped} command${result.skipped !== 1 ? 's' : ''}\n`;
    message += `Parse errors: ${result.errors}\n`;

    if (result.skipped > 0 || result.errors > 0) {
      message += '\nDetails:\n';
      
      // Collect IDs of skipped and error operations
      const skippedIds: string[] = [];
      const errorIds: string[] = [];
      const reasons = new Map<string, string[]>();
      
      result.operations.forEach((op: OperationResult, index: number) => {
        const id = this._getIdForOperationIndex(index, _idMap);
        
        if (op.status === 'WOULD_SKIP') {
          skippedIds.push(id);
          if (op.reasonCode) {
            if (!reasons.has(op.reasonCode)) {
              reasons.set(op.reasonCode, []);
            }
            const reasonList = reasons.get(op.reasonCode);
            if (reasonList) {
              reasonList.push(id);
            }
          }
        } else if (op.status === 'WOULD_ERROR') {
          errorIds.push(id);
        }
      });

      if (skippedIds.length > 0) {
        const reason = reasons.has('NOT_FOUND') ? ' (blocks not found)' : '';
        message += `- Commands ${skippedIds.join(', ')} will be skipped${reason}\n`;
      }
      
      if (errorIds.length > 0) {
        message += `- Commands ${errorIds.join(', ')} have errors\n`;
      }
    }

    message += '\nContinue with applying changes?';
    return message;
  }

  private _getIdForOperationIndex(index: number, _idMap: Map<string, number>): string {
    // Use operation index directly for ID generation
    // since operations go sequentially by commands
    const id = index.toString().padStart(4, '0');
    return id;
  }

  private _splitDSLCommands(content: string): string[] {
    // Split by ---NEXT_BLOCK--- with ID support
    const commands = content.split(/---NEXT_BLOCK(?::\w+)?---/);

    // Clean empty commands and trim spaces
    return commands.map((cmd) => cmd.trim()).filter((cmd) => cmd.length > 0);
  }

  private async _extractFilesFromCommands(commands: string[]): Promise<vscode.Uri[]> {
    const byUri = new Map<string, vscode.Uri>();

    for (const command of commands) {
      try {
        // Parse command to get file patterns
        const instruction = this.replacer.parseCommand(command);

        if (instruction.scope?.files && instruction.scope.files.length > 0) {
          // Use new unified file resolver
          const resolveResult = await FileResolver.resolveTargets(instruction.scope.files);

          // Collect unique URIs
          for (const uri of resolveResult.uris) {
            byUri.set(uri.toString(), uri);
          }

          // Show warnings for skipped patterns
          for (const skipped of resolveResult.skipped) {
            vscode.window.showWarningMessage(`Skipped pattern "${skipped.pattern}": ${skipped.reason}`);
          }

          // Show errors
          for (const errorItem of resolveResult.errors) {
            vscode.window.showErrorMessage(`Error with pattern "${errorItem.pattern}": ${errorItem.error}`);
          }

          // Log resolution report in verbose mode
          const config = vscode.workspace.getConfiguration('blockEditor');
          if (config.get<boolean>('enableVerboseLogging', false)) {
            console.log('File resolution report:', resolveResult.report);
          }
        }
      } catch (error) {
        // If parsing fails, continue with next command
        console.error('Failed to parse command for files:', error);
      }
    }

    return Array.from(byUri.values());
  }

  private _showResults(result: OperationsResult, mode: ExecutionMode): void {
    const outputChannel = vscode.window.createOutputChannel('BlockEditor Results');
    
    outputChannel.clear();
    outputChannel.appendLine(`=== ${mode.toUpperCase()} MODE ===`);
    outputChannel.appendLine(`Total commands: ${result.totalCommands}`);
    outputChannel.appendLine(`Successful: ${result.successful}`);
    outputChannel.appendLine(`Skipped: ${result.skipped}`);
    outputChannel.appendLine(`Errors: ${result.errors}`);
    outputChannel.appendLine(`Duration: ${result.duration}ms`);
    outputChannel.appendLine('');

    // Group operations by file
    const operationsByFile = new Map<string, OperationResult[]>();
    for (const op of result.operations) {
      // Use fileUriString for grouping, fallback to filePath for backward compatibility
      const key = op.fileUriString ?? op.filePath ?? 'In-memory content';
      if (!operationsByFile.has(key)) {
        operationsByFile.set(key, []);
      }
      const fileOps = operationsByFile.get(key);
      if (fileOps) {
        fileOps.push(op);
      }
    }

    // Show operations by file
    for (const [key, ops] of operationsByFile) {
      // Try to display as relative path
      let displayPath = key;
      try {
        if (key.includes('://')) {
          const uri = vscode.Uri.parse(key);
          displayPath = vscode.workspace.asRelativePath(uri);
        }
      } catch {
        // Keep as-is if parsing fails
      }
      
      outputChannel.appendLine(`File: ${displayPath}`);
      outputChannel.appendLine('='.repeat(60));
      
      // Count successful operations for file
      const successCount = ops.filter(op => op.status === 'SUCCESS').length;
      if (successCount > 0) {
        outputChannel.appendLine(`  REPLACE: SUCCESS (${successCount} replacement${successCount !== 1 ? 's' : ''})`);
        outputChannel.appendLine('');
      }
      
      // Show only SKIPPED and ERROR operations with details
      for (const op of ops) {
        if (op.status === 'SKIPPED' || op.status === 'ERROR') {
          outputChannel.appendLine(`  ${op.operationType}: ${op.status}`);
          
          if (op.errorMessage) {
            outputChannel.appendLine(`  Error: ${op.errorMessage}`);
          }

          if (op.reasonCode) {
            outputChannel.appendLine(`  Reason: ${op.reasonCode}`);
            if (op.reasonDetails) {
              outputChannel.appendLine(`  Details: ${op.reasonDetails}`);
            }
          }
          
          outputChannel.appendLine('');
        }
      }
    }

    outputChannel.show();

    // Show message to user
    const message = `Applied ${result.successful} operations, skipped ${result.skipped}, failed ${result.errors}`;

    if (result.errors > 0) {
      vscode.window.showWarningMessage(message);
    } else if (result.successful > 0) {
      vscode.window.showInformationMessage(message);
    } else {
      vscode.window.showInformationMessage('No changes made');
    }
  }

  private _update(): void {
    this._panel.webview.html = this._getHtmlForWebview();
  }

  private _getHtmlForWebview(): string {
    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Block Editor</title>
            <style>
                body {
                    padding: 20px;
                    font-family: var(--vscode-font-family);
                    background-color: var(--vscode-panel-background);
                    color: var(--vscode-foreground);
                    height: 100vh;
                    display: flex;
                    flex-direction: column;
                }
                .container {
                    display: flex;
                    flex-direction: column;
                    height: 100%;
                    width: 100%;
                    padding: 0 10px;
                }
                .header {
                    margin-bottom: 20px;
                }
                .header h2 {
                    margin: 0 0 10px 0;
                    color: var(--vscode-foreground);
                }
                textarea {
                    flex: 1;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    padding: 12px;
                    font-family: var(--vscode-editor-font-family);
                    font-size: var(--vscode-editor-font-size);
                    resize: none;
                    outline: none;
                    line-height: 1.5;
                }
                textarea:focus {
                    border-color: var(--vscode-focusBorder);
                }
                .button-container {
                    display: flex;
                    gap: 12px;
                    margin-top: 16px;
                }
                button {
                    padding: 10px 20px;
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    cursor: pointer;
                    font-size: 14px;
                    flex: 1;
                }
                button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                button.secondary {
                    background-color: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                }
                button.secondary:hover {
                    background-color: var(--vscode-button-secondaryHoverBackground);
                }
                .hint-container {
                    margin-bottom: 15px;
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 4px;
                    padding: 0;
                }
                .hint-toggle {
                    cursor: pointer;
                    padding: 10px;
                    font-size: 14px;
                    font-weight: 500;
                    color: var(--vscode-foreground);
                    list-style: none;
                    outline: none;
                    user-select: none;
                }
                .hint-toggle:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }
                .hint-toggle::before {
                    content: '▶';
                    display: inline-block;
                    margin-right: 5px;
                    transition: transform 0.2s;
                }
                details[open] .hint-toggle::before {
                    transform: rotate(90deg);
                }
                .hint {
                    font-size: 13px;
                    opacity: 0.9;
                    padding: 15px;
                    color: var(--vscode-descriptionForeground);
                    line-height: 1.6;
                    border-top: 1px solid var(--vscode-panel-border);
                    max-height: 70vh;
                    overflow-y: auto;
                }
                .hint h3 {
                    margin: 15px 0 10px 0;
                    font-size: 14px;
                    font-weight: 600;
                    color: var(--vscode-foreground);
                }
                .hint h3:first-child {
                    margin-top: 0;
                }
                .hint h4 {
                    margin: 12px 0 8px 0;
                    font-size: 13px;
                    font-weight: 500;
                    color: var(--vscode-foreground);
                    opacity: 0.9;
                }
                .hint p {
                    margin: 8px 0;
                }
                .hint code {
                    background-color: var(--vscode-textCodeBlock-background);
                    padding: 2px 4px;
                    border-radius: 3px;
                    font-family: var(--vscode-editor-font-family);
                    font-size: 12px;
                }
                .hint kbd {
                    background-color: var(--vscode-keybindingLabel-background);
                    color: var(--vscode-keybindingLabel-foreground);
                    border: 1px solid var(--vscode-keybindingLabel-border);
                    border-radius: 3px;
                    padding: 2px 4px;
                    font-size: 11px;
                    font-family: var(--vscode-font-family);
                }
                .example {
                    font-family: var(--vscode-editor-font-family);
                    font-size: 12px;
                    margin-top: 10px;
                    background-color: var(--vscode-textCodeBlock-background);
                    padding: 10px;
                    border-radius: 3px;
                    white-space: pre-wrap;
                    border: 1px solid var(--vscode-panel-border);
                }
                .shortcuts {
                    font-size: 12px;
                    opacity: 0.6;
                    margin-top: 8px;
                }
                .status {
                    font-size: 12px;
                    margin-top: 8px;
                    padding: 4px 8px;
                    background-color: var(--vscode-editorInfo-background);
                    border-radius: 3px;
                    display: none;
                }
                .status.show {
                    display: block;
                }
                .status.error {
                    background-color: var(--vscode-editorError-background);
                    color: var(--vscode-editorError-foreground);
                }
                .status.warning {
                    background-color: var(--vscode-editorWarning-background);
                    color: var(--vscode-editorWarning-foreground);
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h2>Block Editor - DSL Commands (0.2.1)</h2>
                    <details class="hint-container">
                        <summary class="hint-toggle">📖 Show/Hide Instructions & Examples</summary>
                        <div class="hint">
                            <h3>Supported Operations</h3>
                            <ul style="margin: 10px 0; padding-left: 20px;">
                                <li><code>replace block</code> - replace all occurrences of a block</li>
                                <li><code>delete block</code> - delete all occurrences of a block</li>
                                <li><code>insert before</code> - insert before each occurrence</li>
                                <li><code>insert after</code> - insert after each occurrence</li>
                                <li><code>insert at start</code> - insert at the beginning of file</li>
                                <li><code>insert at end</code> - insert at the end of file</li>
                            </ul>

                            <h3>Example Commands</h3>
                            
                            <h4>1. REPLACE - Simple replacement</h4>
                            <div class="example">replace block
---BEGIN---
DEBUG = True
---END---
with
---BEGIN---
DEBUG = False
---END---
in files ["config.py", "settings.py"]</div>

                            <h4>2. REPLACE with boundaries (using ---TO---)</h4>
                            <div class="example">replace block
---BEGIN---
def process_data(data):
    # Start of function
---TO---
    return result
    # End of function
---END---
with
---BEGIN---
def process_data(data):
    # Optimized version
    if not data:
        return None
    result = optimize(data)
    log_performance(result)
    return result
    # End of function
---END---
in files ["processor.py"]</div>

                            <h4>3. DELETE - Remove code blocks</h4>
                            <div class="example">delete block
---BEGIN---
# TODO: Remove after migration
def legacy_function():
    pass
---END---
in files ["*.py"]</div>

                            <h4>4. INSERT - Add code at specific positions</h4>
                            <div class="example">insert after
---BEGIN---
class User:
---END---
with
---BEGIN---
    def __init__(self, name, email):
        self.name = name
        self.email = email
---END---
in files ["models.py"]</div>

                            <h3>File Patterns</h3>
                            <div class="example">in files ["config.py"]                        # single file
in files ["config.py", "settings.py"]        # multiple files
in files ["src/"]                             # all files in directory (recursive)
in files ["*.py"]                             # pattern in current directory
in files ["src/*.py"]                         # pattern in specific directory
in files ["**/test_*.py"]                     # recursive pattern
in files ["config.py", "src/", "tests/*.py"]  # combination</div>

                            <h4>Pattern Rules:</h4>
                            <ul style="margin: 10px 0; padding-left: 20px;">
                                <li>Paths ending with <code>/</code> - directories (recursive search)</li>
                                <li><code>*</code> - any characters within single level</li>
                                <li><code>**</code> - recursive search in all subdirectories</li>
                                <li>All patterns are processed as glob patterns</li>
                                <li>If no files specified - uses current active file</li>
                            </ul>

                            <h3>Multiple Commands</h3>
                            <p>Use <code>---NEXT_BLOCK---</code> to execute multiple operations at once:</p>
                            <div class="example">replace block
---BEGIN---
VERSION = "1.0.0"
---END---
with
---BEGIN---
VERSION = "2.0.0"
---END---
in files ["version.py"]

---NEXT_BLOCK---

insert after
---BEGIN---
VERSION = "2.0.0"
---END---
with
---BEGIN---
RELEASE_DATE = "2024-01-01"
---END---
in files ["version.py"]</div>

                            <h3>Tips</h3>
                            <ul style="margin: 10px 0; padding-left: 20px;">
                                <li>Commands are case-sensitive</li>
                                <li>Whitespace and indentation matter</li>
                                <li>Use <kbd>Ctrl</kbd>+<kbd>Enter</kbd> for quick apply</li>
                                <li>⚠️ Preview analyzes each command independently. Actual results may differ as commands are applied sequentially and can affect subsequent operations.</li>
                            </ul>
                        </div>
                    </details>
                </div>
                <textarea 
                    id="commandsInput" 
                    placeholder="Enter your DSL commands here...

Example commands:
- replace block
- delete block
- insert before/after/at start/at end

Use 'in files [...]' to specify target files
Use 'in class' or 'in method' for scope"
                    spellcheck="false"
                ></textarea>
                <div class="button-container">
                    <button id="applyButton">
                        <span class="codicon codicon-check"></span>
                        Apply Changes
                    </button>
                </div>
                <div class="shortcuts">
                    Tip: You can also use Ctrl+Enter to apply changes
                </div>
                <div id="status" class="status"></div>
            </div>

            <script>
                document.addEventListener('DOMContentLoaded', function() {
                    const vscode = acquireVsCodeApi();
                    const commandsInput = document.getElementById('commandsInput');
                    const applyButton = document.getElementById('applyButton');
                    const statusDiv = document.getElementById('status');
                    
                    function showStatus(message, type = 'info') {
                        statusDiv.textContent = message;
                        statusDiv.className = 'status show ' + type;
                        setTimeout(() => {
                            statusDiv.classList.remove('show');
                        }, 5000);
                    }
                    
                    // Apply button
                    applyButton.addEventListener('click', () => {
                        console.log('Apply button clicked');
                        const commands = commandsInput.value.trim();
                        console.log('Commands length:', commands.length);
                        if (commands) {
                            console.log('Sending message with mode: preview-and-apply');
                            showStatus('Processing commands...', 'info');
                            vscode.postMessage({
                                type: 'executeCommands',
                                value: commands,
                                mode: 'preview-and-apply'
                            });
                        } else {
                            console.log('No commands, showing message');
                            showStatus('Please enter DSL commands', 'warning');
                            vscode.postMessage({
                                type: 'showMessage',
                                value: 'Please enter DSL commands'
                            });
                        }
                    });

                    // Keyboard shortcuts
                    commandsInput.addEventListener('keydown', (e) => {
                        if (e.ctrlKey && e.key === 'Enter') {
                            applyButton.click();
                            e.preventDefault();
                        }
                    });

                    // Handle messages from extension
                    window.addEventListener('message', event => {
                        const message = event.data;
                        switch (message.type) {
                            case 'updateCommands':
                                commandsInput.value = message.value;
                                vscode.setState({ commands: message.value });
                                break;
                            case 'commandsApplied':
                                showStatus('Commands applied successfully!', 'info');
                                if (confirm('Commands applied successfully. Clear the input?')) {
                                    commandsInput.value = '';
                                    vscode.setState({ commands: '' });
                                }
                                break;
                            case 'error':
                                showStatus(message.value, 'error');
                                break;
                        }
                    });

                    // Save state on input
                    let saveTimeout;
                    commandsInput.addEventListener('input', (e) => {
                        clearTimeout(saveTimeout);
                        saveTimeout = setTimeout(() => {
                            vscode.setState({ commands: e.target.value });
                        }, 500);
                    });

                    // Restore state
                    const state = vscode.getState();
                    if (state && state.commands) {
                        commandsInput.value = state.commands;
                    }

                    // Focus on input field on load
                    commandsInput.focus();
                });
            </script>
        </body>
        </html>`;
  }

  public dispose(): void {
    TextInserterPanel.currentPanel = undefined;
    this._panel.dispose();

    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }
}