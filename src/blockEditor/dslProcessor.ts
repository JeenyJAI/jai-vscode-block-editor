// dslProcessor.ts - DSL command processor for text transformations

import {
  DSLInstruction,
  OperationType,
  InsertPosition,
  BlockSearchResult,
  Block,
  BlockType,
  BlockNotFoundError,
  ModificationError,
} from './types.js';
import { TextProcessor } from './textProcessor.js';

export class DSLProcessor {
  constructor(private textProcessor: TextProcessor) {}

  findAllBlocks(content: string, block: Block): BlockSearchResult[] {
    console.log('Finding all blocks:', {
      type: block.blockType,
      startPattern: block.startPattern,
      endPattern: block.endPattern,
      content: block.content?.substring(0, 50),
    });

    let results: BlockSearchResult[];

    if (block.blockType === BlockType.EXACT) {
      results = this.textProcessor.findAllBlocksExact(content, block);
    } else {
      results = this.textProcessor.findAllBlocksBoundary(content, block);
    }

    console.log(`Found ${results.length} blocks`);
    return results;
  }

  applyInstruction(instruction: DSLInstruction, content: string): string {
    // Apply operation to entire content
    return this.applySingleOperation(instruction, content);
  }

  private applySingleOperation(instruction: DSLInstruction, content: string): string {
    switch (instruction.operation) {
      case OperationType.REPLACE:
        return this.applyReplace(instruction, content);
      case OperationType.DELETE:
        return this.applyDelete(instruction, content);
      case OperationType.INSERT:
        return this.applyInsert(instruction, content);
      default:
        throw new Error(`Unknown operation: ${instruction.operation}`);
    }
  }

  private applyReplace(instruction: DSLInstruction, content: string): string {
    const results = this.findAllBlocks(content, instruction.targetBlock);

    if (results.length === 0) {
      throw new BlockNotFoundError(this.getBlockDescription(instruction.targetBlock));
    }

    if (!instruction.replacementBlock) {
      throw new ModificationError('REPLACE', 'Replacement block is required for REPLACE operation');
    }

    // Sort from end to beginning to preserve positions
    results.sort((a, b) => (b.startPos || 0) - (a.startPos || 0));

    // Get replacement content
    const replacement = instruction.replacementBlock.content;
    let modifiedContent = content;

    // Replace all occurrences
    for (const result of results) {
      if (instruction.targetBlock.blockType === BlockType.BOUNDARY) {
        if (result.startLine === undefined || result.endLine === undefined) {
          continue;
        }

        const lines = modifiedContent.split('\n');
        const before = lines.slice(0, result.startLine - 1);
        const after = lines.slice(result.endLine);
        const replacementLines = replacement.split('\n');

        modifiedContent = [...before, ...replacementLines, ...after].join('\n');
      } else {
        // For EXACT blocks
        if (result.startPos === undefined || result.endPos === undefined) {
          continue;
        }

        const before = modifiedContent.substring(0, result.startPos);
        const after = modifiedContent.substring(result.endPos + 1);
        modifiedContent = before + replacement + after;
      }
    }

    return modifiedContent;
  }

  private applyDelete(instruction: DSLInstruction, content: string): string {
    const results = this.findAllBlocks(content, instruction.targetBlock);

    if (results.length === 0) {
      throw new BlockNotFoundError(this.getBlockDescription(instruction.targetBlock));
    }

    // Sort from end to beginning to preserve line numbers
    results.sort((a, b) => (b.startLine || 0) - (a.startLine || 0));

    const lines = content.split('\n');

    // Delete all found blocks
    for (const result of results) {
      if (result.startLine === undefined || result.endLine === undefined) {
        continue;
      }

      lines.splice(result.startLine - 1, result.endLine - result.startLine + 1);
    }

    return lines.join('\n');
  }

  private applyInsert(instruction: DSLInstruction, content: string): string {
    if (!instruction.replacementBlock) {
      throw new ModificationError('INSERT', 'Replacement block is required for INSERT operation');
    }

    if (!instruction.insertPosition) {
      throw new ModificationError('INSERT', 'Insert position is required for INSERT operation');
    }

    if (this.isEdgeInsertion(instruction.insertPosition)) {
      return this.applyInsertAtEdge(instruction, content);
    }

    return this.applyInsertRelative(instruction, content);
  }

  private isEdgeInsertion(position: InsertPosition): boolean {
    return position === InsertPosition.AT_START || position === InsertPosition.AT_END;
  }

  private applyInsertAtEdge(instruction: DSLInstruction, content: string): string {
    if (!instruction.replacementBlock) {
      throw new ModificationError('INSERT', 'Replacement block is required');
    }

    const insertion = instruction.replacementBlock.content;

    if (instruction.insertPosition === InsertPosition.AT_START) {
      return content ? insertion + '\n' + content : insertion;
    }

    // AT_END
    return content ? content + '\n' + insertion : insertion;
  }

  private applyInsertRelative(instruction: DSLInstruction, content: string): string {
    if (!instruction.replacementBlock || !instruction.insertPosition) {
      throw new ModificationError('INSERT', 'Replacement block and position are required');
    }

    const results = this.findAllBlocks(content, instruction.targetBlock);

    if (results.length === 0) {
      throw new BlockNotFoundError(this.getBlockDescription(instruction.targetBlock));
    }

    // Sort from end to beginning to preserve line numbers
    results.sort((a, b) => (b.startLine || 0) - (a.startLine || 0));

    const lines = content.split('\n');
    const insertion = instruction.replacementBlock.content;
    const insertionLines = insertion.split('\n');

    // Insert relative to ALL found blocks
    for (const result of results) {
      if (result.startLine === undefined || result.endLine === undefined) {
        continue;
      }

      // Calculate insert position for each block
      const insertLine = instruction.insertPosition === InsertPosition.BEFORE ? result.startLine - 1 : result.endLine;

      lines.splice(insertLine, 0, ...insertionLines);
    }

    return lines.join('\n');
  }

  private getBlockDescription(block: Block): string {
    if (block.blockType === BlockType.EXACT) {
      // Truncate long content
      const content = block.content;
      if (content.length > 50) {
        return content.substring(0, 47) + '...';
      }
      return content;
    }

    return `${block.startPattern} ... ${block.endPattern}`;
  }
}
