// index.ts - Public API export for BlockEditor

// Main class
export { BlockEditor, ExecutionMode, BlockEditorConfig } from './blockEditor.js';

// Types
export {
  // Enums
  BlockType,
  OperationType,
  InsertPosition,

  // Core interfaces
  Block,
  ScopeSpec,
  DSLInstruction,
  BlockSearchResult,
  OperationResult,
  OperationsResult,

  // Errors
  ParseError,
  BlockNotFoundError,
  ModificationError,
} from './types.js';

// For advanced usage (usually not needed)
export { DSLParser } from './dslParser.js';
export { DSLProcessor } from './dslProcessor.js';
export { TextProcessor } from './textProcessor.js';
