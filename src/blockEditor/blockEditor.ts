// blockEditor.ts - Main BlockEditor engine with EOL preservation and path safety

import * as vscode from 'vscode';
import { OperationsResult, OperationResult, DSLInstruction, BlockNotFoundError, ParseError } from './types.js';
import { DSLParser } from './dslParser.js';
import { DSLProcessor } from './dslProcessor.js';
import { TextProcessor } from './textProcessor.js';
import { FileInfo, FileReadResult, normalizeLineEndings, normalizeToEol } from '../utils/fileHelpers.js';
import { FileResolver } from '../utils/fileResolver.js';

export type ExecutionMode = 'apply' | 'preview';

export interface BlockEditorConfig {
  maxLineLength?: number;
  validatePaths?: boolean; // Enable path validation (default: true)
  mixedEolPolicy?: 'ignore' | 'skip' | 'warn' | 'normalize'; // How to handle mixed line endings (default: 'warn')
  enableVerboseLogging?: boolean; // Enable verbose console logging (default: false)
}

export class BlockEditor {
  private parser: DSLParser;
  private textProcessor: TextProcessor;
  protected processor: DSLProcessor;
  private config: Required<BlockEditorConfig>;


  constructor(config: BlockEditorConfig = {}) {
    this.parser = new DSLParser();
    this.textProcessor = new TextProcessor();
    this.processor = new DSLProcessor(this.textProcessor);
    this.config = {
      maxLineLength: config.maxLineLength ?? 100000,
      validatePaths: config.validatePaths ?? true,
      mixedEolPolicy: config.mixedEolPolicy ?? 'warn',
      enableVerboseLogging: config.enableVerboseLogging ?? false,
    };

    // if (!this.config.validatePaths) {
    //   console.warn('Path validation is DISABLED. Enable it in production!');
    // }
  }

  /**
   * Parse a DSL command and return the instruction.
   * Public method to avoid direct access to private parser.
   */
  public parseCommand(command: string): DSLInstruction {
    return this.parser.parse(command);
  }

  /**
   * Apply list of DSL commands to content.
   */
  apply(commands: string[], content: string, mode: ExecutionMode = 'apply'): OperationsResult {
    const startTime = Date.now();

    const result: OperationsResult = {
      totalCommands: commands.length,
      totalBlocks: 0,
      totalOperations: 0,
      successful: 0,
      skipped: 0,
      errors: 0,
      duration: 0,
      isPreview: mode === 'preview',
      content: content,
      operations: [],
    };

    if (commands.length === 0) {
      result.duration = Date.now() - startTime;
      return result;
    }

    // Normalize content for processing
    let currentContent = normalizeLineEndings(content);

    for (const command of commands) {
      const truncatedCommand = this.truncateCommand(command);

      try {
        const instruction = this.parser.parse(command);
        currentContent = this.processSingleCommand(instruction, currentContent, mode, result, truncatedCommand);
      } catch (error) {
        if (error instanceof ParseError) {
          this.handleParseError(error, mode, result, truncatedCommand);
        } else if (error instanceof BlockNotFoundError) {
          this.handleBlockNotFound(error, command, mode, result, truncatedCommand);
        } else {
          this.handleGeneralError(error as Error, command, mode, result, truncatedCommand);
        }
      }
    }

    result.content = currentContent;
    result.duration = Date.now() - startTime;

    return result;
  }

  /**
   * Apply list of DSL commands to multiple files using vscode.Uri
   * This is the preferred method for VSCode extension integration
   */
  async applyToFilesUri(
    commands: string[],
    fileUris: vscode.Uri[],
    readFile: (uri: vscode.Uri) => Promise<FileReadResult>,
    writeFile: (uri: vscode.Uri, content: string, info: FileInfo) => Promise<void>,
    mode: ExecutionMode = 'apply',
    token?: vscode.CancellationToken,
  ): Promise<OperationsResult> {
    const startTime = Date.now();

    const result: OperationsResult = {
      totalCommands: commands.length,
      totalBlocks: 0,
      totalOperations: 0,
      successful: 0,
      skipped: 0,
      errors: 0,
      duration: 0,
      isPreview: mode === 'preview',
      operations: [],
    };

    if (commands.length === 0 || fileUris.length === 0) {
      result.duration = Date.now() - startTime;
      return result;
    }

    // Parse all commands once and determine their target files
    const parsedCommands = await Promise.all(
      commands.map(async (cmd, cmdIndex) => {
        const truncated = this.truncateCommand(cmd);
        try {
          const instruction = this.parser.parse(cmd);
          let targetFiles: Set<string> | undefined;

          // If command has scope with files, resolve them using new FileResolver
          if (instruction.scope?.files?.length) {
            const resolved = await FileResolver.resolveTargets(
              instruction.scope.files, 
              token ? { token } : undefined
            );
            // Store as URI strings to preserve scheme and avoid case issues
            targetFiles = new Set(resolved.uris.map((u) => u.toString()));
          }

          return { 
            ok: true as const, 
            cmd, 
            instruction, 
            targetFiles, 
            truncated,
            index: cmdIndex 
          };
        } catch (error) {
          return { 
            ok: false as const, 
            cmd, 
            error: error as Error, 
            truncated,
            index: cmdIndex 
          };
        }
      }),
    );

    // Handle parsing errors
    for (const parsed of parsedCommands) {
      if (!parsed.ok) {
        if (parsed.error instanceof ParseError) {
          this.handleParseError(parsed.error, mode, result, parsed.truncated);
        } else {
          this.handleGeneralError(parsed.error, parsed.cmd, mode, result, parsed.truncated);
        }
      }
    }

    // Process each file
    for (const fileUri of fileUris) {
      // Check for cancellation
      if (token?.isCancellationRequested) {
        break;
      }

      // Check if URI belongs to workspace using built-in API
      if (this.config.validatePaths && !vscode.workspace.getWorkspaceFolder(fileUri)) {
        if (this.config.enableVerboseLogging) {
          console.error(`URI outside workspace: ${fileUri.toString()}`);
        }
        const workspaceFolders = vscode.workspace.workspaceFolders?.map(f => f.uri.toString()).join(', ') || 'none';
        const operation: OperationResult = {
          operationType: 'SECURITY',
          status: mode === 'preview' ? 'WOULD_ERROR' : 'ERROR',
          isPreview: mode === 'preview',
          fileUri,
          fileUriString: fileUri.toString(),
          errorMessage: `Path validation failed: ${fileUri.fsPath}`,
          reasonCode: 'OUTSIDE_WORKSPACE',
          reasonDetails: `File is outside workspace. Check if file exists and is accessible.`,
          meta: {
            uri: fileUri.toString(),
            workspaceFolders,
            details: 'File path may be outside workspace boundaries'
          }
        };
        result.operations.push(operation);
        result.errors++;
        continue;
      }

      const fileUriString = fileUri.toString();

      // Process only commands intended for this file
      for (const parsed of parsedCommands) {
        if (!parsed || !parsed.ok) continue;

        // If command has target files and current file is not in the list - skip silently
        if (parsed.targetFiles && !parsed.targetFiles.has(fileUriString)) {
          continue; // Command not for this file - don't create unnecessary SKIPPED
        }

        const operation = await this.applyToSingleFileUri(
          parsed.instruction,
          fileUri, 
          readFile, 
          writeFile, 
          mode,
          parsed.truncated
        );

        // Add metadata for debugging
        operation.meta = { commandIndex: parsed.index };
        result.operations.push(operation);

        // Update counters
        if (operation.status === 'SUCCESS' || operation.status === 'WOULD_SUCCESS') {
          result.successful++;
          result.totalBlocks++;
        } else if (operation.status === 'SKIPPED' || operation.status === 'WOULD_SKIP') {
          result.skipped++;
        } else {
          result.errors++;
        }
      }
    }

    result.totalOperations = result.operations.length;
    result.duration = Date.now() - startTime;
    return result;
  }



  
  private async applyToSingleFileUri(
    instruction: DSLInstruction,
    fileUri: vscode.Uri,
    readFile: (uri: vscode.Uri) => Promise<FileReadResult>,
    writeFile: (uri: vscode.Uri, content: string, info: FileInfo) => Promise<void>,
    mode: ExecutionMode,
    truncatedCommand: string
  ): Promise<OperationResult> {
    const relativePath = vscode.workspace.asRelativePath(fileUri);

    // Log only if verbose logging is enabled
    if (this.config.enableVerboseLogging) {
      console.log('Processing command for file:', relativePath);
      console.log('Operation:', instruction.operation);
    }

    try {
      // Read file with format info
      const fileData = await readFile(fileUri);

      // Handle mixed line endings according to policy
      if (fileData.info.isMixed) {
        const handleResult = await this.handleMixedEolUri(fileUri, fileData.info, mode);
        if (handleResult.skip) {
          return {
            operationType: 'MIXED_EOL',
            status: mode === 'preview' ? 'WOULD_SKIP' : 'SKIPPED',
            isPreview: mode === 'preview',
            fileUri,
            fileUriString: fileUri.toString(),
            filePath: fileUri.fsPath, // For backward compatibility
            errorMessage: `File has mixed line endings (${fileData.info.mixedEolDetails?.crlfCount} CRLF, ${fileData.info.mixedEolDetails?.lfCount} LF)`,
            sourceCommand: truncatedCommand,
            reasonCode: 'MIXED_EOL',
          };
        }
        if (handleResult.normalize && fileData.info.mixedEolDetails) {
          // Normalize content to predominant EOL
          fileData.content = normalizeToEol(fileData.content, fileData.info.mixedEolDetails.predominant);
          fileData.info = {
            ...fileData.info,
            lineEnding: fileData.info.mixedEolDetails.predominant,
            isMixed: false,
          };
        }
        // For 'warn' policy: use predominant EOL for writing
        if (
          !handleResult.skip &&
          !handleResult.normalize &&
          this.config.mixedEolPolicy === 'warn' &&
          fileData.info.mixedEolDetails
        ) {
          fileData.info = {
            ...fileData.info,
            lineEnding: fileData.info.mixedEolDetails.predominant,
          };
        }
      }

      // Normalize content for processing
      const normalizedContent = normalizeLineEndings(fileData.content);

      // Execute or preview operation
      if (mode === 'preview') {
        return this.previewOperationUri(instruction, normalizedContent, fileUri, truncatedCommand);
      }

      return await this.executeFileOperationUri(
        instruction,
        normalizedContent,
        fileUri,
        fileData.info,
        writeFile,
        truncatedCommand,
      );
    } catch (error) {
      return this.createErrorResultUri(error as Error, instruction, mode, fileUri, truncatedCommand);
    }
  }

  // Legacy string-based method for backward compatibility
  // Will be removed in phase C after migration is complete

  private processSingleCommand(
    instruction: DSLInstruction,
    currentContent: string,
    mode: ExecutionMode,
    result: OperationsResult,
    truncatedCommand: string,
  ): string {
    // Count blocks for this command
    const blocks = this.processor.findAllBlocks(currentContent, instruction.targetBlock);
    result.totalBlocks += blocks.length;
    result.totalOperations += blocks.length;

    if (mode === 'preview') {
      const operationResult = this.previewOperation(instruction, currentContent, undefined, truncatedCommand);
      operationResult.blocksFound = blocks.length;
      operationResult.blocksProcessed = blocks.length;
      result.operations.push(operationResult);

      if (operationResult.status === 'WOULD_SUCCESS') {
        result.successful += blocks.length;
        // Apply to see cascading effects
        return this.processor.applyInstruction(instruction, currentContent);
      }

      if (operationResult.status === 'WOULD_SKIP') {
        result.skipped += blocks.length;
      } else {
        result.errors += blocks.length;
      }
      return currentContent;
    }

    // Apply mode
    const modifiedContent = this.processor.applyInstruction(instruction, currentContent);
    const diff = this.textProcessor.createUnifiedDiff(currentContent, modifiedContent, 'content');

    const operationResult: OperationResult = {
      operationType: instruction.operation.toUpperCase(),
      status: 'SUCCESS',
      isPreview: false,
      diff,
      sourceCommand: truncatedCommand,
      blocksFound: blocks.length,
      blocksProcessed: blocks.length,
    };

    result.operations.push(operationResult);
    result.successful += blocks.length;
    return modifiedContent;
  }

  private previewOperation(
    instruction: DSLInstruction,
    content: string,
    filePath?: string,
    truncatedCommand?: string,
  ): OperationResult {
    try {
      const modifiedContent = this.processor.applyInstruction(instruction, content);
      const diff = this.textProcessor.createUnifiedDiff(content, modifiedContent, filePath || 'content');

      const { startLine, endLine } = this.findChangedLines(content, modifiedContent);

      return {
        operationType: instruction.operation.toUpperCase(),
        status: 'WOULD_SUCCESS',
        isPreview: true,
        filePath,
        lineStart: startLine,
        lineEnd: endLine,
        diff,
        sourceCommand: truncatedCommand,
      };
    } catch (error) {
      if (error instanceof BlockNotFoundError) {
        return {
          operationType: instruction.operation.toUpperCase(),
          status: 'WOULD_SKIP',
          isPreview: true,
          filePath,
          errorMessage: error.message,
          sourceCommand: truncatedCommand,
          reasonCode: 'NOT_FOUND',
        };
      }

      return {
        operationType: instruction.operation.toUpperCase(),
        status: 'WOULD_ERROR',
        isPreview: true,
        filePath,
        errorMessage: (error as Error).message,
        sourceCommand: truncatedCommand,
      };
    }
  }

  private findChangedLines(
    original: string,
    modified: string,
  ): {
    startLine?: number | undefined;
    endLine?: number | undefined;
  } {
    const originalLines = original.split('\n');
    const modifiedLines = modified.split('\n');

    let startLine: number | undefined;
    let endLine: number | undefined;

    // Find first difference
    for (let i = 0; i < Math.max(originalLines.length, modifiedLines.length); i++) {
      if (originalLines[i] !== modifiedLines[i]) {
        if (startLine === undefined) {
          startLine = i + 1;
        }
        endLine = i + 1;
      }
    }

    return { startLine, endLine };
  }

  private truncateCommand(command: string): string {
    return command.length > 500 ? command.substring(0, 497) + '...' : command;
  }

  private async handleMixedEolUri(
    fileUri: vscode.Uri,
    fileInfo: FileInfo,
    mode: ExecutionMode,
  ): Promise<{ skip: boolean; normalize: boolean }> {
    const relativePath = vscode.workspace.asRelativePath(fileUri);
    
    switch (this.config.mixedEolPolicy) {
      case 'ignore':
        return { skip: false, normalize: false };
      case 'skip':
        if (this.config.enableVerboseLogging) {
          console.log(`Skipping ${relativePath}: mixed line endings detected`);
        }
        return { skip: true, normalize: false };
      case 'normalize':
        if (this.config.enableVerboseLogging) {
          console.log(`Normalizing ${relativePath} to ${fileInfo.mixedEolDetails?.predominant}`);
        }
        return { skip: false, normalize: true };
      case 'warn':
      default:
        if (mode === 'preview') {
          console.warn(
            `Warning: ${relativePath} has mixed line endings ` +
              `(${fileInfo.mixedEolDetails?.crlfCount} CRLF, ${fileInfo.mixedEolDetails?.lfCount} LF). ` +
              `File will be normalized to ${fileInfo.mixedEolDetails?.predominant} on save.`,
          );
        }
        return { skip: false, normalize: false };
    }
  }

  private async executeFileOperationUri(
    instruction: DSLInstruction,
    normalizedContent: string,
    fileUri: vscode.Uri,
    fileInfo: FileInfo,
    writeFile: (uri: vscode.Uri, content: string, info: FileInfo) => Promise<void>,
    truncatedCommand: string,
  ): Promise<OperationResult> {
    try {
      const modifiedContent = this.processor.applyInstruction(instruction, normalizedContent);
      await writeFile(fileUri, modifiedContent, fileInfo);

      const diff = this.textProcessor.createUnifiedDiff(
        normalizedContent, 
        modifiedContent, 
        vscode.workspace.asRelativePath(fileUri)
      );

      const { startLine, endLine } = this.findChangedLines(normalizedContent, modifiedContent);

      return {
        operationType: instruction.operation.toUpperCase(),
        status: 'SUCCESS',
        isPreview: false,
        fileUri,
        fileUriString: fileUri.toString(),
        lineStart: startLine,
        lineEnd: endLine,
        diff,
        sourceCommand: truncatedCommand,
      };
    } catch (error) {
      if (error instanceof BlockNotFoundError) {
        return {
          operationType: instruction.operation.toUpperCase(),
          status: 'SKIPPED',
          isPreview: false,
          fileUri,
          fileUriString: fileUri.toString(),
          filePath: fileUri.fsPath,
          errorMessage: error.message,
          sourceCommand: truncatedCommand,
          reasonCode: 'NOT_FOUND',
        };
      }

      return {
        operationType: instruction.operation.toUpperCase(),
        status: 'ERROR',
        isPreview: false,
        fileUri,
        fileUriString: fileUri.toString(),
        filePath: fileUri.fsPath,
        errorMessage: (error as Error).message,
        sourceCommand: truncatedCommand,
      };
    }
  }

  private previewOperationUri(
    instruction: DSLInstruction,
    content: string,
    fileUri: vscode.Uri,
    truncatedCommand?: string,
  ): OperationResult {
    try {
      const modifiedContent = this.processor.applyInstruction(instruction, content);
      const diff = this.textProcessor.createUnifiedDiff(
        content, 
        modifiedContent, 
        vscode.workspace.asRelativePath(fileUri)
      );

      const { startLine, endLine } = this.findChangedLines(content, modifiedContent);

      return {
        operationType: instruction.operation.toUpperCase(),
        status: 'WOULD_SUCCESS',
        isPreview: true,
        fileUri,
        fileUriString: fileUri.toString(),
        filePath: fileUri.fsPath,
        lineStart: startLine,
        lineEnd: endLine,
        diff,
        sourceCommand: truncatedCommand,
      };
    } catch (error) {
      if (error instanceof BlockNotFoundError) {
        return {
          operationType: instruction.operation.toUpperCase(),
          status: 'WOULD_SKIP',
          isPreview: true,
          fileUri,
          fileUriString: fileUri.toString(),
          filePath: fileUri.fsPath,
          errorMessage: error.message,
          sourceCommand: truncatedCommand,
          reasonCode: 'NOT_FOUND',
        };
      }

      return {
        operationType: instruction.operation.toUpperCase(),
        status: 'WOULD_ERROR',
        isPreview: true,
        fileUri,
        fileUriString: fileUri.toString(),
        filePath: fileUri.fsPath,
        errorMessage: (error as Error).message,
        sourceCommand: truncatedCommand,
      };
    }
  }

  private createErrorResultUri(
    error: Error,
    instruction: DSLInstruction,
    mode: ExecutionMode,
    fileUri: vscode.Uri,
    truncatedCommand: string,
  ): OperationResult {
    let status: OperationResult['status'];
    let reasonCode: OperationResult['reasonCode'];

    if (error instanceof BlockNotFoundError) {
      status = mode === 'preview' ? 'WOULD_SKIP' : 'SKIPPED';
      reasonCode = 'NOT_FOUND';
    } else {
      status = mode === 'preview' ? 'WOULD_ERROR' : 'ERROR';
    }

    return {
      operationType: instruction.operation.toUpperCase(),
      status,
      isPreview: mode === 'preview',
      fileUri,
      fileUriString: fileUri.toString(),
      filePath: fileUri.fsPath,
      errorMessage: error.message,
      sourceCommand: truncatedCommand,
      reasonCode,
    };
  }



  private handleParseError(
    error: ParseError,
    mode: ExecutionMode,
    result: OperationsResult,
    truncatedCommand: string,
  ): void {
    const operationResult: OperationResult = {
      operationType: 'UNKNOWN',
      status: mode === 'preview' ? 'WOULD_ERROR' : 'ERROR',
      isPreview: mode === 'preview',
      errorMessage: error.message,
      sourceCommand: truncatedCommand,
    };
    result.operations.push(operationResult);
    result.errors++;
  }

  private handleBlockNotFound(
    error: BlockNotFoundError,
    command: string,
    mode: ExecutionMode,
    result: OperationsResult,
    truncatedCommand: string,
  ): void {
    const opType = this.guessOperationType(command);
    const operationResult: OperationResult = {
      operationType: opType,
      status: mode === 'preview' ? 'WOULD_SKIP' : 'SKIPPED',
      isPreview: mode === 'preview',
      errorMessage: error.message,
      sourceCommand: truncatedCommand,
      reasonCode: 'NOT_FOUND',
    };
    result.operations.push(operationResult);
    result.skipped++;
  }

  private handleGeneralError(
    error: Error,
    command: string,
    mode: ExecutionMode,
    result: OperationsResult,
    truncatedCommand: string,
  ): void {
    const opType = this.guessOperationType(command);
    const operationResult: OperationResult = {
      operationType: opType,
      status: mode === 'preview' ? 'WOULD_ERROR' : 'ERROR',
      isPreview: mode === 'preview',
      errorMessage: error.message,
      sourceCommand: truncatedCommand,
    };
    result.operations.push(operationResult);
    result.errors++;
  }



  private guessOperationType(command: string): string {
    const commandLower = command.toLowerCase();
    if (commandLower.includes('replace')) return 'REPLACE';
    if (commandLower.includes('delete')) return 'DELETE';
    if (commandLower.includes('insert')) return 'INSERT';
    return 'UNKNOWN';
  }
}