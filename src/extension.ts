import * as vscode from 'vscode';
import { TextInserterPanel } from './textInserterPanel.js';

export function activate(context: vscode.ExtensionContext): void {
  console.log('Block Editor Terminal extension is now active!');

  // Register command to show the panel
  const showPanelCommand = vscode.commands.registerCommand('blockEditorTerminal.showPanel', () => {
    TextInserterPanel.createOrShow(context.extensionUri);
  });

  context.subscriptions.push(showPanelCommand);

  // Automatically show panel on activation
  // TextInserterPanel.createOrShow(context.extensionUri);
}

export function deactivate(): void {
  TextInserterPanel.currentPanel?.dispose();
}