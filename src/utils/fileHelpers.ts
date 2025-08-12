// src/utils/fileHelpers.ts
import * as vscode from 'vscode';

export interface FileInfo {
  encoding: string; // 'auto' - VSCode manages
  lineEnding: '\n' | '\r\n'; // Only LF or CRLF (VSCode normalizes)
  endsWithNewline: boolean;
  hasBOM: boolean; // Always false, VSCode manages
  isMixed: boolean; // Are there mixed line endings
  mixedEolDetails?:
    | {
        // Mixed EOL details
        predominant: '\n' | '\r\n';
        crlfCount: number;
        lfCount: number;
      }
    | undefined;
}

export interface FileReadResult {
  content: string;
  info: FileInfo;
  originalContent: string; // Original content with original EOL
}

/**
 * Reads file preserving formatting information
 */
export async function readFileWithInfo(uri: vscode.Uri): Promise<FileReadResult> {
  try {
    // First read raw bytes to check for mixed EOL
    const buffer = await vscode.workspace.fs.readFile(uri);
    const rawContent = buffer.toString();
    const mixedCheck = detectMixedLineEndings(rawContent);

    // Then open via VSCode API for normalized content
    const document = await vscode.workspace.openTextDocument(uri);
    const content = document.getText();

    // Determine line ending via VSCode API
    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';

    // Check for final newline
    const endsWithNewline = content.length > 0 && (content.endsWith('\n') || content.endsWith('\r\n'));

    return {
      content,
      info: {
        encoding: 'auto', // VSCode manages encoding
        lineEnding: eol,
        endsWithNewline,
        hasBOM: false, // VSCode manages BOM
        isMixed: mixedCheck.isMixed,
        mixedEolDetails: mixedCheck.isMixed
          ? {
              predominant: mixedCheck.predominant,
              crlfCount: mixedCheck.crlfCount,
              lfCount: mixedCheck.lfCount,
            }
          : undefined,
      },
      originalContent: content,
    };
  } catch (error) {
    throw new Error(
      `Cannot open file ${uri.fsPath}: file may be binary or corrupted. ` +
        `VSCode error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Detects file characteristics via VSCode API
 */
export async function detectFileInfo(uri: vscode.Uri): Promise<FileInfo> {
  const document = await vscode.workspace.openTextDocument(uri);
  const text = document.getText();

  // Determine line ending via VSCode API
  const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';

  // Check for final newline
  const endsWithNewline = text.length > 0 && (text.endsWith('\n') || text.endsWith('\r\n'));

  return {
    encoding: 'auto', // VSCode manages encoding
    lineEnding: eol,
    endsWithNewline,
    hasBOM: false, // We don't manage BOM
    isMixed: false, // VSCode normalizes
  };
}

/**
 * Normalizes line endings to LF for processing
 */
export function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Checks for mixed line endings in content
 */
export function detectMixedLineEndings(content: string): {
  isMixed: boolean;
  predominant: '\n' | '\r\n';
  crlfCount: number;
  lfCount: number;
} {
  const crlfCount = (content.match(/\r\n/g) || []).length;
  const lfCount = (content.match(/(?<!\r)\n/g) || []).length;

  const isMixed = crlfCount > 0 && lfCount > 0;
  const predominant = crlfCount >= lfCount ? '\r\n' : '\n';

  return { isMixed, predominant, crlfCount, lfCount };
}

/**
 * Normalizes all line endings to specified type
 */
export function normalizeToEol(content: string, eol: '\n' | '\r\n'): string {
  // First normalize to LF
  const normalized = normalizeLineEndings(content);
  // Then convert to desired format
  return eol === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
}

/**
 * Restores original line endings
 */
export function restoreLineEndings(content: string, lineEnding: '\n' | '\r\n' | '\r'): string {
  if (lineEnding === '\n') {
    return content;
  }

  // First normalize to LF, then replace with desired type
  const normalized = normalizeLineEndings(content);
  return normalized.replace(/\n/g, lineEnding);
}

/**
 * Writes file preserving original formatting
 */
export async function writeFilePreservingFormat(
  uri: vscode.Uri,
  content: string,
  originalInfo: FileInfo,
): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);

  // Restore line endings
  let finalContent = restoreLineEndings(content, originalInfo.lineEnding);

  // Restore final newline
  if (originalInfo.endsWithNewline && !finalContent.endsWith(originalInfo.lineEnding)) {
    finalContent += originalInfo.lineEnding;
  } else if (!originalInfo.endsWithNewline) {
    // Remove final newline if it wasn't there
    const endings = ['\r\n', '\n', '\r'];
    for (const ending of endings) {
      if (finalContent.endsWith(ending)) {
        finalContent = finalContent.slice(0, -ending.length);
        break;
      }
    }
  }

  // Apply changes via VSCode API
  // VSCode will save in original encoding!
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));

  edit.replace(uri, fullRange, finalContent);
  const success = await vscode.workspace.applyEdit(edit);

  if (!success) {
    throw new Error(`Failed to write file: ${uri.fsPath}`);
  }

  // Save document - VSCode uses original encoding
  await document.save();
}