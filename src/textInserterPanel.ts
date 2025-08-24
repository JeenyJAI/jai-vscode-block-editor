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
        enableCommandUris: false, // Security: disable command URIs
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
    void this._update(); // Fire-and-forget: intentionally ignore promise

    // Handle messages from webview
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.type) {
          case 'executeCommands':
            if (message.mode === 'preview-and-apply') {
              await this._previewAndApply(message.value);
            }
            break;
          case 'showMessage':
            vscode.window.showInformationMessage(message.value);
            break;
          case 'requestClearConfirmation':
            // Use native VS Code dialog (not browser confirm)
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
            // Set debug mode on webview ready
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

    // Handle panel disposal
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Watch configuration changes to update debug mode
    this._disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('blockEditor.debug')) {
          const config = vscode.workspace.getConfiguration('blockEditor');
          const debugMode = config.get<boolean>('debug', false);
          this._panel.webview.postMessage({
            type: 'setDebugMode',
            value: debugMode
          });
          // Debug mode configuration updated
        }
      })
    );
  }

  /**
   * Parse DSL commands and extract block IDs
   * Returns array of command blocks with their associated IDs
   */
  private _parseCommandBlocks(content: string): Array<{ id: string; content: string }> {
    const blocks: Array<{ id: string; content: string }> = [];
    
    // Remove BOM and split by any line ending
    const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
    
    // Use same regex pattern as parser for consistency
    // IMPORTANT: Must match DSLParser.BEGIN_RE exactly
    const BEGIN_RE = /^---BEGIN(:[\w-]+)?---$/;  // Capturing group for ID
    
    let currentId = '0000';
    let currentContent: string[] = [];
    let insideBlock = false;
    let currentEndMarker: string | null = null;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const trimmedLine = line.trim();
      
      if (!insideBlock) {
        // Check for block start and compute exact END marker
        const beginMatch = BEGIN_RE.exec(trimmedLine);
        if (beginMatch) {
          insideBlock = true;
          // Construct exact END marker from captured ID
          currentEndMarker = `---END${beginMatch[1] ?? ''}---`;
          currentContent.push(line);
          continue;
        }
        
        // Check for separator (only outside blocks)
        if (trimmedLine.startsWith('---NEXT_BLOCK') && trimmedLine.endsWith('---')) {
          // Save previous block if it has content
          const blockContent = currentContent.join('\n').trim();
          if (blockContent) {
            blocks.push({ id: currentId, content: blockContent });
          }
          
          // Extract ID from separator or generate sequential ID
          const idMatch = trimmedLine.match(/---NEXT_BLOCK:(\w+)---/);
          currentId = idMatch?.[1] ?? blocks.length.toString().padStart(4, '0');
          currentContent = [];
          continue;
        }
        
        currentContent.push(line);
      } else {
        // Inside block: only exit on exact END marker match
        if (trimmedLine === currentEndMarker) {
          insideBlock = false;
          currentEndMarker = null;
        }
        // Keep everything inside blocks (including pseudo NEXT_BLOCK markers)
        currentContent.push(line);
      }
    }
    
    // CRITICAL: Flush the last block (if no trailing ---NEXT_BLOCK:0001---)
    const tailContent = currentContent.join('\n').trim();
    if (tailContent) {
      blocks.push({ id: currentId, content: tailContent });
    }
    
    return blocks;
  }

  private async _previewAndApply(commandsText: string): Promise<void> {
    try {
      // Add IDs to blocks without explicit IDs
      const { commandsWithIds } = this._addIdsToCommands(commandsText);

      // Update text in WebView
      this._panel.webview.postMessage({
        type: 'updateCommands',
        value: commandsWithIds,
      });

      // Parse commands and extract their IDs
      const commandBlocks = this._parseCommandBlocks(commandsWithIds);
      const commands = commandBlocks.map(block => block.content);
      const blockIds = commandBlocks.map(block => block.id);

      if (commands.length === 0) {
        vscode.window.showWarningMessage('No DSL commands found');
        return; // Finally block handles busy state cleanup
      }

      // Get workspace folder
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder open');
        return; // Finally block handles busy state cleanup
      }

      // Extract all files from commands using parser
      const fileUris = await this._extractFilesFromCommands(commands);

      // Fallback to active document if no files specified
      if (fileUris.length === 0) {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
          vscode.window.showErrorMessage('No active file and no files specified in commands');
          return; // Finally block handles busy state cleanup
        }
        fileUris.push(activeEditor.document.uri);
      }

      // File I/O using URIs
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
        async () => {}, // No-op writer in preview mode
        'preview'
      );

      // Show analysis summary and request confirmation
      const confirmMessage = this._createConfirmMessage(previewResult, blockIds);
      
      // Signal analysis dialog display
      this._panel.webview.postMessage({ type: 'showing:analysis' });

      const answer = await vscode.window.showInformationMessage(
        confirmMessage,
        { modal: true },
        { title: 'Apply', isCloseAffordance: false },
        { title: 'Cancel', isCloseAffordance: true }
      );

      // Handle all dialog outcomes
      if (answer?.title === 'Apply') {
        // Signal start of Apply Changes operation
        this._panel.webview.postMessage({ type: 'applying:changes' });
        
        // Apply changes to target files
        const result = await this.replacer.applyToFilesUri(
          commands,
          fileUris,
          readFile,
          writeFile,
          'apply'
        );

        // Show operation results to user
        this._showResults(result, 'apply');

        // Offer to clear input on success
        if (result.successful > 0) {
          this._panel.webview.postMessage({ type: 'commandsApplied' });
        } else {
          // Clear busy state regardless of operation outcome
          this._panel.webview.postMessage({ type: 'processing:complete' });
        }
      } else {
        // User cancelled via Cancel button or dialog close
        this._panel.webview.postMessage({ type: 'processing:cancelled' });
      }
      
    } catch (error) {
      // Handle error and clear busy state
      vscode.window.showErrorMessage(`BlockEditor error: ${error}`);
      this._panel.webview.postMessage({ type: 'processing:error', error: String(error) });
      
    } finally {
      // Failsafe: clear busy state in all scenarios
      this._panel.webview.postMessage({ type: 'processing:end' });
    }
  }

  private _addIdsToCommands(commandsText: string): { commandsWithIds: string } {
    // Replace ---NEXT_BLOCK--- with ---NEXT_BLOCK:ID---
    let blockIndex = 0;
    const commandsWithIds = commandsText.replace(/---NEXT_BLOCK---/g, () => {
      blockIndex++;
      const id = blockIndex.toString().padStart(4, '0');
      return `---NEXT_BLOCK:${id}---`;
    });

    return { commandsWithIds };
  }

  private _createConfirmMessage(result: OperationsResult, blockIds: string[]): string {
    let message = `PRE-EXECUTION ANALYSIS\n`;
    message += `${'─'.repeat(30)}\n`;
    message += `Total commands: ${result.totalCommands}\n`;
    message += `Matches found: ${result.successful}\n`;
    message += `No matches for: ${result.skipped} command${result.skipped !== 1 ? 's' : ''}\n`;
    message += `Parse errors: ${result.errors}\n`;

    if (result.skipped > 0 || result.errors > 0) {
      message += '\nDetails:\n';
      
      // Group operations by status for report details
      const skippedIds: string[] = [];
      const errorIds: string[] = [];
      const reasons = new Map<string, string[]>();
      
      result.operations.forEach((op: OperationResult, index: number) => {
        // Use real block ID from parsed blocks instead of sequential index
        const id = blockIds[index] ?? index.toString().padStart(4, '0');
        
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

  private async _extractFilesFromCommands(commands: string[]): Promise<vscode.Uri[]> {
    const byUri = new Map<string, vscode.Uri>();

    for (const command of commands) {
      try {
        // Parse file patterns from DSL command
        const instruction = this.replacer.parseCommand(command);

        if (instruction.scope?.files && instruction.scope.files.length > 0) {
          // Resolve patterns to file URIs
          const resolveResult = await FileResolver.resolveTargets(instruction.scope.files);

          // Deduplicate URIs
          for (const uri of resolveResult.uris) {
            byUri.set(uri.toString(), uri);
          }

          // Show warnings for unresolved patterns
          for (const skipped of resolveResult.skipped) {
            vscode.window.showWarningMessage(`Skipped pattern "${skipped.pattern}": ${skipped.reason}`);
          }

          // Show pattern resolution errors
          for (const errorItem of resolveResult.errors) {
            vscode.window.showErrorMessage(`Error with pattern "${errorItem.pattern}": ${errorItem.error}`);
          }

          // Log detailed resolution report (verbose mode)
          const config = vscode.workspace.getConfiguration('blockEditor');
          if (config.get<boolean>('enableVerboseLogging', false)) {
            const outputChannel = vscode.window.createOutputChannel('JAI Block Editor');
            outputChannel.appendLine('[FILES] File resolution report:');
            outputChannel.appendLine(JSON.stringify(resolveResult.report, null, 2));
          }
        }
      } catch (error) {
        // Skip to next command on parse failure - expected for some DSL variations
      }
    }

    return Array.from(byUri.values());
  }

  private _showResults(result: OperationsResult, mode: ExecutionMode): void {
    const outputChannel = vscode.window.createOutputChannel('JAI Block Editor');
    
    outputChannel.clear();
    outputChannel.appendLine(`[APPLY] === ${mode.toUpperCase()} MODE ===`);
    outputChannel.appendLine(`Total commands: ${result.totalCommands}`);
    outputChannel.appendLine(`Successful: ${result.successful}`);
    outputChannel.appendLine(`Skipped: ${result.skipped}`);
    outputChannel.appendLine(`Errors: ${result.errors}`);
    outputChannel.appendLine(`Duration: ${result.duration}ms`);
    outputChannel.appendLine('');

    // Group operations by file for structured output
    const operationsByFile = new Map<string, OperationResult[]>();
    for (const op of result.operations) {
      // Group by URI string (fallback to file path)
      const key = op.fileUriString ?? op.filePath ?? 'In-memory content';
      if (!operationsByFile.has(key)) {
        operationsByFile.set(key, []);
      }
      const fileOps = operationsByFile.get(key);
      if (fileOps) {
        fileOps.push(op);
      }
    }

    // Output results grouped by file
    for (const [key, ops] of operationsByFile) {
      // Convert to workspace-relative path for readability
      let displayPath = key;
      try {
        if (key.includes('://')) {
          const uri = vscode.Uri.parse(key);
          displayPath = vscode.workspace.asRelativePath(uri);
        }
      } catch {
        // Fall back to original path on parse error
      }
      
      outputChannel.appendLine(`File: ${displayPath}`);
      outputChannel.appendLine('='.repeat(60));
      
      // Count successful operations per file
      const successCount = ops.filter(op => op.status === 'SUCCESS').length;
      if (successCount > 0) {
        outputChannel.appendLine(`  REPLACE: SUCCESS (${successCount} replacement${successCount !== 1 ? 's' : ''})`);
        outputChannel.appendLine('');
      }
      
      // Show details for failed operations only
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

    // Show user feedback based on results
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
    } catch {
      // Panel might be disposed - expected during shutdown
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