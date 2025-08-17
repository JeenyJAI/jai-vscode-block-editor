import * as vscode from 'vscode';
import { FileResolver } from './utils/fileResolver.js';
import { BlockEditor, ExecutionMode } from './blockEditor/index.js';
import { readFileWithInfo, writeFilePreservingFormat, FileReadResult, FileInfo } from './utils/fileHelpers.js';
import type { OperationsResult, OperationResult } from './blockEditor/types.js';
import { generateBlockEditorHtml } from './webviews/webviewTemplate';

export class TextInserterPanel {
  public static currentPanel: TextInserterPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
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
        enableCommandUris: false,       // Explicitly disable command URIs for security
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      },
    );

    TextInserterPanel.currentPanel = new TextInserterPanel(panel, extensionUri);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    
    // Read configuration from VS Code settings
    const config = vscode.workspace.getConfiguration('blockEditor');
    
    this.replacer = new BlockEditor({
      validatePaths: config.get<boolean>('validatePaths', true),
      mixedEolPolicy: config.get<'ignore' | 'skip' | 'warn' | 'normalize'>('mixedEolPolicy', 'warn'),
      enableVerboseLogging: config.get<boolean>('enableVerboseLogging', false),
    });

    // Set HTML content
    void this._update(); // void for explicit Promise ignoring

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
          case 'requestClearConfirmation':
            // Better than browser confirm - native VS Code dialog
            const answer = await vscode.window.showInformationMessage(
              'Commands applied successfully. Clear the input?',
              'Clear',
              'Keep'
            );
            if (answer === 'Clear') {
              this._panel.webview.postMessage({ type: 'clearInput' });
            }
            break;
          case 'webviewReady':
            // Send debug mode setting when webview is ready
            const config = vscode.workspace.getConfiguration('blockEditor');
            const debugMode = config.get<boolean>('debug', false);
            this._panel.webview.postMessage({ 
              type: 'setDebugMode', 
              value: debugMode 
            });
            break;
        }
      },
      null,
      this._disposables,
    );

    console.log('Message handler registered');

    // Handle panel disposal
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Subscribe to configuration changes for live debug mode updates
    this._disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('blockEditor.debug')) {
          const config = vscode.workspace.getConfiguration('blockEditor');
          const debugMode = config.get<boolean>('debug', false);
          this._panel.webview.postMessage({
            type: 'setDebugMode',
            value: debugMode
          });
          console.log('Debug mode updated to:', debugMode);
        }
      })
    );
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

  private async _update(): Promise<void> {
    try {
      this._panel.webview.html = await this._getHtmlForWebview();
    } catch (error) {
      // Panel might be disposed, log but don't throw
      console.error('Failed to update webview:', error);
    }
  }

  private async _getHtmlForWebview(): Promise<string> {
    return await generateBlockEditorHtml(this._extensionUri, this._panel.webview);
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