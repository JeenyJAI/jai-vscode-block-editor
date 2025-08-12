// dslParser.ts - DSL Parser for block editor commands

import { DSLInstruction, OperationType, InsertPosition, Block, BlockType, ScopeSpec, ParseError } from './types.js';

const DSL_BEGIN_RE = /^---BEGIN(:[\w_]+)?---$/;
const DSL_TO_MARKER = '---TO---';

export class DSLParser {
  parse(dslContent: string): DSLInstruction {
    const lines = dslContent.trim().split('\n');
    if (lines.length === 0) {
      throw new ParseError('DSL content is empty', 0, 0);
    }

    let currentIdx = 0;

    // Parse operation
    const { operation, insertPosition, nextIdx } = this.parseOperation(lines, currentIdx);
    currentIdx = nextIdx;

    // Parse target block
    const { targetBlock, nextIdx: targetIdx } = this.parseTargetBlock(lines, currentIdx, operation, insertPosition);
    currentIdx = targetIdx;

    // Parse replacement block
    const { replacementBlock, nextIdx: replIdx } = this.parseReplacementBlock(lines, currentIdx, operation);
    currentIdx = replIdx;

    // Parse scope
    const { scope, nextIdx: scopeIdx } = this.parseScope(lines, currentIdx);
    currentIdx = scopeIdx;

    // Create instruction
    const instruction: DSLInstruction = {
      operation,
      targetBlock,
      replacementBlock,
      insertPosition,
      scope,
    };

    this.validateInstruction(instruction);
    return instruction;
  }

  private parseOperation(
    lines: string[],
    idx: number,
  ): {
    operation: OperationType;
    insertPosition?: InsertPosition;
    nextIdx: number;
  } {
    const firstLine = lines[idx]?.trim().toLowerCase();
    if (!firstLine) {
      throw new ParseError('Empty line at operation position', idx, 0);
    }

    if (firstLine.startsWith('replace block')) {
      return { operation: OperationType.REPLACE, nextIdx: idx + 1 };
    }

    if (firstLine.startsWith('delete block')) {
      return { operation: OperationType.DELETE, nextIdx: idx + 1 };
    }

    if (firstLine.startsWith('insert')) {
      return this.parseInsertPosition(firstLine, idx);
    }

    throw new ParseError(`Unknown operation: '${firstLine}'. Use 'replace block', 'delete block', or 'insert'`, idx, 0);
  }

  private parseInsertPosition(
    firstLine: string,
    idx: number,
  ): {
    operation: OperationType;
    insertPosition: InsertPosition;
    nextIdx: number;
  } {
    if (firstLine === 'insert before') {
      return { operation: OperationType.INSERT, insertPosition: InsertPosition.BEFORE, nextIdx: idx + 1 };
    }
    if (firstLine === 'insert after') {
      return { operation: OperationType.INSERT, insertPosition: InsertPosition.AFTER, nextIdx: idx + 1 };
    }
    if (firstLine === 'insert at start') {
      return { operation: OperationType.INSERT, insertPosition: InsertPosition.AT_START, nextIdx: idx + 1 };
    }
    if (firstLine === 'insert at end') {
      return { operation: OperationType.INSERT, insertPosition: InsertPosition.AT_END, nextIdx: idx + 1 };
    }

    throw new ParseError(
      `Invalid insert position: '${firstLine}'. Use 'insert before', 'insert after', 'insert at start', or 'insert at end'`,
      idx,
      0,
    );
  }

  private parseTargetBlock(
    lines: string[],
    currentIdx: number,
    operation: OperationType,
    insertPosition?: InsertPosition,
  ): { targetBlock: Block; nextIdx: number } {
    if (
      operation === OperationType.INSERT &&
      (insertPosition === InsertPosition.AT_START || insertPosition === InsertPosition.AT_END)
    ) {
      // No target block for INSERT AT START/END
      return {
        targetBlock: { content: '', blockType: BlockType.EXACT },
        nextIdx: currentIdx,
      };
    }

    const { block, nextIdx } = this.parseBlock(lines, currentIdx, 'target');
    return { targetBlock: block, nextIdx };
  }

  private parseReplacementBlock(
    lines: string[],
    currentIdx: number,
    operation: OperationType,
  ): { replacementBlock?: Block | undefined; nextIdx: number } {
    if (operation !== OperationType.REPLACE && operation !== OperationType.INSERT) {
      return { replacementBlock: undefined, nextIdx: currentIdx };
    }

    // Check for 'with' keyword
    const currentLine = lines[currentIdx];
    if (currentIdx >= lines.length || !currentLine?.trim().startsWith('with')) {
      throw new ParseError(`Missing 'with' keyword for ${operation.toUpperCase()} operation`, currentIdx, 0);
    }

    currentIdx++;
    const { block, nextIdx } = this.parseBlock(lines, currentIdx, 'replacement');
    return { replacementBlock: block, nextIdx };
  }

  private parseBlock(lines: string[], startIdx: number, blockType: string): { block: Block; nextIdx: number } {
    if (startIdx >= lines.length) {
      throw new ParseError(`Expected ---BEGIN--- marker for ${blockType} block`, startIdx, 0);
    }

    const { content, endIdx } = this.extractMultilineContent(lines, startIdx);

    // Check if this is a boundary block (contains ---TO---)
    const toMarker = '\n' + DSL_TO_MARKER + '\n';
    const toMarkerAtStart = DSL_TO_MARKER + '\n';
    const toMarkerAtEnd = '\n' + DSL_TO_MARKER;
    const toMarkerAlone = DSL_TO_MARKER;

    // Check different TO marker positions
    let isBoundaryBlock = false;
    let parts: string[] = [];

    if (content.includes(toMarker)) {
      // Standard case - marker with newlines on both sides
      parts = content.split(toMarker);
      isBoundaryBlock = true;
    } else if (content.startsWith(toMarkerAtStart)) {
      // Marker at the beginning
      parts = ['', content.substring(toMarkerAtStart.length)];
      isBoundaryBlock = true;
    } else if (content.endsWith(toMarkerAtEnd)) {
      // Marker at the end
      parts = [content.substring(0, content.length - toMarkerAtEnd.length), ''];
      isBoundaryBlock = true;
    } else if (content === toMarkerAlone) {
      // Marker alone
      parts = ['', ''];
      isBoundaryBlock = true;
    } else {
      // Check if marker is on a separate line
      const contentLines = content.split('\n');
      for (let i = 0; i < contentLines.length; i++) {
        const contentLine = contentLines[i];
        if (contentLine?.trim() === DSL_TO_MARKER) {
          // Found TO marker on a separate line
          const beforeLines = contentLines.slice(0, i);
          const afterLines = contentLines.slice(i + 1);
          parts = [beforeLines.join('\n'), afterLines.join('\n')];
          isBoundaryBlock = true;
          break;
        }
      }
    }

    if (isBoundaryBlock && parts.length === 2) {
      console.log('Parsed BOUNDARY block:', {
        startPattern: parts[0],
        endPattern: parts[1],
      });

      return {
        block: {
          content: '',
          blockType: BlockType.BOUNDARY,
          startPattern: parts[0],
          endPattern: parts[1],
        },
        nextIdx: endIdx,
      };
    }

    // Exact match block
    return {
      block: {
        content,
        blockType: BlockType.EXACT,
      },
      nextIdx: endIdx,
    };
  }

  private extractMultilineContent(
    lines: string[],
    startIdx: number,
  ): {
    content: string;
    endIdx: number;
  } {
    const beginLine = lines[startIdx]?.trim();
    if (!beginLine) {
      throw new ParseError('Invalid line at begin marker position', startIdx, 0);
    }
    const beginMatch = DSL_BEGIN_RE.exec(beginLine);

    if (!beginMatch) {
      throw new ParseError(`Invalid ---BEGIN--- marker: '${beginLine}'`, startIdx, 0);
    }

    // Extract ID if present
    const markerId = beginMatch[1] || '';
    const endMarker = `---END${markerId}---`;

    const contentLines: string[] = [];
    let currentIdx = startIdx + 1;

    while (currentIdx < lines.length) {
      const currentLine = lines[currentIdx];
      if (currentLine?.trim() === endMarker) {
        return {
          content: contentLines.join('\n'),
          endIdx: currentIdx + 1,
        };
      }
      const line = lines[currentIdx];
      if (line !== undefined) {
        contentLines.push(line);
      }
      currentIdx++;
    }

    throw new ParseError(`Unclosed block: expected '${endMarker}'`, startIdx, 0);
  }

  private parseScope(
    lines: string[],
    startIdx: number,
  ): {
    scope?: ScopeSpec | undefined;
    nextIdx: number;
  } {
    const scope: ScopeSpec = {};
    let currentIdx = startIdx;

    while (currentIdx < lines.length) {
      const line = lines[currentIdx]?.trim();
      if (!line) {
        break;
      }

      // Parse 'in files' scope
      if (line.startsWith('in files')) {
        const filesResult = this.parseFilesScope(line, currentIdx);
        scope.files = filesResult.files;
        currentIdx++;
      } else {
        break;
      }
    }

    // Return scope only if files were specified
    if (scope.files) {
      return { scope, nextIdx: currentIdx };
    }

    return { scope: undefined, nextIdx: currentIdx };
  }

  private parseFilesScope(line: string, lineIdx: number): { files: string[] } {
    const filesPattern = /in\s+files\s*\[(.*?)\]/s;
    const match = line.match(filesPattern);

    if (!match) {
      throw new ParseError('Invalid "in files" format. Expected: in files ["file1", "file2"]', lineIdx, 0);
    }

    const filesList = match[1];

    try {
      // Parse as JSON array
      const files = JSON.parse(`[${filesList}]`);

      // Validate is array
      if (!Array.isArray(files)) {
        throw new Error('Files must be an array');
      }

      // Validate all items are strings
      for (const item of files) {
        if (typeof item !== 'string') {
          throw new Error('All file patterns must be strings');
        }
      }

      return { files };
    } catch (error) {
      throw new ParseError(
        `Invalid file list: ${filesList}. Must be valid JSON array format`,
        lineIdx,
        line.indexOf('['),
      );
    }
  }

  private validateInstruction(instruction: DSLInstruction): void {
    // REPLACE and INSERT require replacement block
    if (
      (instruction.operation === OperationType.REPLACE || instruction.operation === OperationType.INSERT) &&
      !instruction.replacementBlock
    ) {
      throw new ParseError(`${instruction.operation.toUpperCase()} operation requires a 'with' block`, 0, 0);
    }

    // DELETE should not have replacement block
    if (instruction.operation === OperationType.DELETE && instruction.replacementBlock) {
      throw new ParseError("DELETE operation should not have a 'with' block", 0, 0);
    }

    // INSERT requires position
    if (instruction.operation === OperationType.INSERT && !instruction.insertPosition) {
      throw new ParseError('INSERT operation requires a position', 0, 0);
    }
  }
}