// types.ts - Core types and models for BlockEditor

// Enums
export enum BlockType {
  EXACT = 'exact',
  BOUNDARY = 'boundary',
}

export enum OperationType {
  REPLACE = 'replace',
  DELETE = 'delete',
  INSERT = 'insert',
}

export enum InsertPosition {
  BEFORE = 'before',
  AFTER = 'after',
  AT_START = 'at_start',
  AT_END = 'at_end',
}

// Core models
export interface Block {
  content: string;
  blockType: BlockType;
  startPattern?: string | undefined;
  endPattern?: string | undefined;
}

export interface ScopeSpec {
  files?: string[]; // List of file patterns from 'in files [...]'
}

export interface DSLInstruction {
  operation: OperationType;
  targetBlock: Block;
  replacementBlock?: Block | undefined;
  insertPosition?: InsertPosition | undefined;
  scope?: ScopeSpec | undefined;
}

export interface BlockSearchResult {
  found: boolean;
  startLine?: number;
  endLine?: number;
  startPos?: number;
  endPos?: number;
  matchedContent?: string;
}

export interface OperationResult {
  operationType: string;
  status: 'SUCCESS' | 'SKIPPED' | 'ERROR' | 'WOULD_SUCCESS' | 'WOULD_SKIP' | 'WOULD_ERROR';
  isPreview: boolean;
  blockId?: string | undefined;
  filePath?: string | undefined;
  lineStart?: number | undefined;
  lineEnd?: number | undefined;
  originalBlock?: string | undefined;
  modifiedBlock?: string | undefined;
  diff?: string | undefined;
  errorMessage?: string | undefined;
  reasonCode?:
    | 'BINARY'
    | 'ENCODING_GARBLED'
    | 'CONTROL_CHARS'
    | 'LINE_TOO_LONG'
    | 'OUTSIDE_WORKSPACE'
    | 'SYMLINK_OUTSIDE'
    | 'EXCLUDED'
    | 'TOO_MANY_FILES'
    | 'TOO_LARGE'
    | 'NOT_FOUND'
    | 'MIXED_EOL'
    | undefined;
  reasonDetails?: string | undefined;
  sourceCommand?: string | undefined;
  blocksFound?: number | undefined;
  blocksProcessed?: number | undefined;
}

export interface OperationsResult {
  totalCommands: number;
  totalBlocks: number;
  totalOperations: number;
  successful: number;
  skipped: number;
  errors: number;
  duration: number;
  isPreview: boolean;
  content?: string;
  operations: OperationResult[];
}

// Errors
export class ParseError extends Error {
  constructor(
    message: string,
    public line: number,
    public column: number,
  ) {
    super(message);
    this.name = 'ParseError';
  }
}

export class BlockNotFoundError extends Error {
  constructor(blockDescription: string, scopeDescription?: string) {
    const message = scopeDescription
      ? `Block '${blockDescription}' not found in ${scopeDescription}`
      : `Block '${blockDescription}' not found`;
    super(message);
    this.name = 'BlockNotFoundError';
  }
}

export class ModificationError extends Error {
  constructor(operation: string, details: string) {
    super(`${operation} operation failed: ${details}`);
    this.name = 'ModificationError';
  }
}
