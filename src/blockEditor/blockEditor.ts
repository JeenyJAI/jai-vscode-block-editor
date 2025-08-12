// blockEditor.ts - Main BlockEditor engine with EOL preservation and path safety

import { OperationsResult, OperationResult, DSLInstruction, BlockNotFoundError, ParseError } from './types.js';
import { DSLParser } from './dslParser.js';
import { DSLProcessor } from './dslProcessor.js';
import { TextProcessor } from './textProcessor.js';
import { FileInfo, FileReadResult, normalizeLineEndings, normalizeToEol } from '../utils/fileHelpers.js';
import { isPathSafe, resolveFilesFromPatterns } from '../utils/pathResolver.js';

export type ExecutionMode = 'apply' | 'preview';

export interface BlockEditorConfig {
  maxLineLength?: number;
  validatePaths?: boolean; // Enable path validation (default: false for debugging)
  mixedEolPolicy?: 'ignore' | 'skip' | 'warn' | 'normalize'; // How to handle mixed line endings (default: 'warn')
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
      validatePaths: config.validatePaths ?? true, // Temporarily disabled for debugging
      mixedEolPolicy: config.mixedEolPolicy ?? 'warn',
    };

    // if (!this.config.validatePaths) {
    //   console.warn('Path validation is DISABLED. Enable it in production!');
    // }
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
   * Apply list of DSL commands to multiple files with EOL preservation and path safety.
   */
  async applyToFiles(
    commands: string[],
    filePaths: string[],
    readFile: (path: string) => Promise<FileReadResult>,
    writeFile: (path: string, content: string, info: FileInfo) => Promise<void>,
    mode: ExecutionMode = 'apply',
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

    if (commands.length === 0 || filePaths.length === 0) {
      result.duration = Date.now() - startTime;
      return result;
    }

    // Parse all commands and determine their target files
    const parsedCommands = await Promise.all(
      commands.map(async (cmd) => {
        const truncated = this.truncateCommand(cmd);
        try {
          const instruction = this.parser.parse(cmd);
          let targetFiles: Set<string> | undefined;

          // If command has scope with files, resolve them
          if (instruction.scope?.files?.length) {
            const resolved = await resolveFilesFromPatterns(instruction.scope.files);
            targetFiles = new Set(resolved.files.map((u) => u.fsPath.toLowerCase()));
          }

          return { 
            ok: true as const, 
            cmd, 
            instruction, 
            targetFiles, 
            truncated 
          };
        } catch (error) {
          return { 
            ok: false as const, 
            cmd, 
            error: error as Error, 
            truncated 
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
    for (const filePath of filePaths) {
      // Path safety check
      if (this.config.validatePaths && !isPathSafe(filePath)) {
        console.error(`Path validation failed for: ${filePath}`);
        const operation: OperationResult = {
          operationType: 'SECURITY',
          status: mode === 'preview' ? 'WOULD_ERROR' : 'ERROR',
          isPreview: mode === 'preview',
          filePath,
          errorMessage: `Path validation failed: ${filePath}`,
          reasonCode: 'OUTSIDE_WORKSPACE',
          reasonDetails: 'File path may be outside workspace. Check if file exists and is accessible.',
        };
        result.operations.push(operation);
        result.errors++;
        continue;
      }

      const filePathLower = filePath.toLowerCase();

      // Process only commands intended for this file
      for (let cmdIndex = 0; cmdIndex < parsedCommands.length; cmdIndex++) {
        const parsed = parsedCommands[cmdIndex];
        if (!parsed) continue; // Guard against undefined
        if (!parsed.ok) continue; // Already processed error

        // If command has target files and current file is not in the list - skip
        if (parsed.targetFiles && !parsed.targetFiles.has(filePathLower)) {
          continue; // Command not for this file - don't create unnecessary SKIPPED
        }

        const operation = await this.applyToSingleFile(
          parsed.cmd, 
          filePath, 
          readFile, 
          writeFile, 
          mode
        );

        // Add command index for proper identification
        // @ts-expect-error - adding additional field for debugging
        (operation as Record<string, unknown>).commandIndex = cmdIndex;
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

  private async applyToSingleFile(
    dslCommand: string,
    filePath: string,
    readFile: (path: string) => Promise<FileReadResult>,
    writeFile: (path: string, content: string, info: FileInfo) => Promise<void>,
    mode: ExecutionMode
  ): Promise<OperationResult> {
    const truncatedCommand = this.truncateCommand(dslCommand);

    console.log('Processing command for file:', filePath);
    console.log('Command preview:', dslCommand.substring(0, 100));

    try {
      // Parse command
      const instruction = this.parser.parse(dslCommand);

      // Read file with format info
      const fileData = await readFile(filePath);

      // Handle mixed line endings according to policy
      if (fileData.info.isMixed) {
        const handleResult = await this.handleMixedEol(filePath, fileData.info, mode);
        if (handleResult.skip) {
          return {
            operationType: 'MIXED_EOL',
            status: mode === 'preview' ? 'WOULD_SKIP' : 'SKIPPED',
            isPreview: mode === 'preview',
            filePath,
            errorMessage: `File has mixed line endings (${fileData.info.mixedEolDetails?.crlfCount} CRLF, ${fileData.info.mixedEolDetails?.lfCount} LF)`,
            sourceCommand: truncatedCommand,
            reasonCode: 'MIXED_EOL',
          };
        }
        if (handleResult.normalize && fileData.info.mixedEolDetails) {
          // Normalize content to predominant EOL
          fileData.content = normalizeToEol(fileData.content, fileData.info.mixedEolDetails.predominant);
          // IMPORTANT: Also update fileInfo to write with predominant EOL, not VSCode's detected one
          fileData.info = {
            ...fileData.info,
            lineEnding: fileData.info.mixedEolDetails.predominant,
            isMixed: false, // After normalization, it's no longer mixed
          };
        }
        // For 'warn' policy: use predominant EOL for writing (without content normalization)
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
        return this.previewOperation(instruction, normalizedContent, filePath, truncatedCommand);
      }

      return await this.executeFileOperation(
        instruction,
        normalizedContent,
        filePath,
        fileData.info,
        writeFile,
        truncatedCommand,
      );
    } catch (error) {
      return this.createErrorResult(error as Error, dslCommand, mode, filePath, truncatedCommand);
    }
  }

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

  private async executeFileOperation(
    instruction: DSLInstruction,
    normalizedContent: string,
    filePath: string,
    fileInfo: FileInfo,
    writeFile: (path: string, content: string, info: FileInfo) => Promise<void>,
    truncatedCommand: string,
  ): Promise<OperationResult> {
    try {
      const modifiedContent = this.processor.applyInstruction(instruction, normalizedContent);

      // Write file with original format preservation
      await writeFile(filePath, modifiedContent, fileInfo);

      // Create diff
      const diff = this.textProcessor.createUnifiedDiff(normalizedContent, modifiedContent, filePath);

      // Find changed lines
      const { startLine, endLine } = this.findChangedLines(normalizedContent, modifiedContent);

      return {
        operationType: instruction.operation.toUpperCase(),
        status: 'SUCCESS',
        isPreview: false,
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
          status: 'SKIPPED',
          isPreview: false,
          filePath,
          errorMessage: error.message,
          sourceCommand: truncatedCommand,
          reasonCode: 'NOT_FOUND',
        };
      }

      return {
        operationType: instruction.operation.toUpperCase(),
        status: 'ERROR',
        isPreview: false,
        filePath,
        errorMessage: (error as Error).message,
        sourceCommand: truncatedCommand,
      };
    }
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

  private async handleMixedEol(
    filePath: string,
    fileInfo: FileInfo,
    mode: ExecutionMode,
  ): Promise<{ skip: boolean; normalize: boolean }> {
    switch (this.config.mixedEolPolicy) {
      case 'ignore':
        // Silently continue
        return { skip: false, normalize: false };

      case 'skip':
        // Skip file, log to console
        console.log(`Skipping ${filePath}: mixed line endings detected`);
        return { skip: true, normalize: false };

      case 'normalize':
        // Normalize to predominant EOL
        console.log(`Normalizing ${filePath} to ${fileInfo.mixedEolDetails?.predominant}`);
        return { skip: false, normalize: true };

      case 'warn':
      default:
        // Show warning in preview mode only
        if (mode === 'preview') {
          // In preview, we just note it will be processed
          console.warn(
            `Warning: ${filePath} has mixed line endings ` +
              `(${fileInfo.mixedEolDetails?.crlfCount} CRLF, ${fileInfo.mixedEolDetails?.lfCount} LF). ` +
              `File will be normalized to ${fileInfo.mixedEolDetails?.predominant} on save.`,
          );
        }
        // For 'warn', we don't normalize content but still want to write with predominant EOL
        // This will be handled in applyToSingleFile by updating fileInfo.lineEnding
        return { skip: false, normalize: false };
    }
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

  private createErrorResult(
    error: Error,
    dslCommand: string,
    mode: ExecutionMode,
    filePath: string,
    truncatedCommand: string,
  ): OperationResult {
    let opType = 'UNKNOWN';
    try {
      const parsed = this.parser.parse(dslCommand);
      opType = parsed.operation.toUpperCase();
    } catch {
      // Ignore parse errors
    }

    let status: OperationResult['status'];
    let reasonCode: OperationResult['reasonCode'];

    if (error instanceof BlockNotFoundError) {
      status = mode === 'preview' ? 'WOULD_SKIP' : 'SKIPPED';
      reasonCode = 'NOT_FOUND';
    } else {
      status = mode === 'preview' ? 'WOULD_ERROR' : 'ERROR';
    }

    return {
      operationType: opType,
      status,
      isPreview: mode === 'preview',
      filePath,
      errorMessage: error.message,
      sourceCommand: truncatedCommand,
      reasonCode,
    };
  }

  private guessOperationType(command: string): string {
    const commandLower = command.toLowerCase();
    if (commandLower.includes('replace')) return 'REPLACE';
    if (commandLower.includes('delete')) return 'DELETE';
    if (commandLower.includes('insert')) return 'INSERT';
    return 'UNKNOWN';
  }
}