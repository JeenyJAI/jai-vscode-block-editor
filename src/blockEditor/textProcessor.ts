// textProcessor.ts - Text processing utilities for BlockEditor

import { Block, BlockSearchResult } from './types.js';

export class TextProcessor {
  // Helper methods for efficient text processing
  private normalizeEOL(text: string): string {
    return text.replace(/\r\n?/g, '\n');
  }

  private buildLineOffsets(text: string): number[] {
    const offsets: number[] = [0];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) {
        // \n
        offsets.push(i + 1);
      }
    }
    return offsets;
  }

  private indexToLine(index: number, lineOffsets: number[]): number {
    // Returns 1-based line number for position index (0-based)
    let lo = 0,
      hi = lineOffsets.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lineOffsets[mid] !== undefined && lineOffsets[mid] <= index) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return hi + 1; // 1-based
  }
  findAllBlocksExact(content: string, block: Block): BlockSearchResult[] {
    const results: BlockSearchResult[] = [];
    const searchContent = block.content;
    let index = 0;

    while ((index = content.indexOf(searchContent, index)) !== -1) {
      const lines = content.split('\n');
      let currentPos = 0;
      let startLine = 1;
      let endLine = 1;

      // Find line numbers
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) {
          continue;
        }
        const lineLength = line.length + 1; // +1 for newline

        if (currentPos <= index && index < currentPos + lineLength) {
          startLine = i + 1;
          const blockLines = searchContent.split('\n').length;
          endLine = startLine + blockLines - 1;
          break;
        }

        currentPos += lineLength;
      }

      results.push({
        found: true,
        startLine,
        endLine,
        startPos: index,
        endPos: index + searchContent.length - 1,
        matchedContent: searchContent,
      });

      index += searchContent.length;
    }

    return results;
  }

  findAllBlocksBoundary(content: string, block: Block): BlockSearchResult[] {
    if (!block.startPattern || !block.endPattern) {
      return [];
    }

    const results: BlockSearchResult[] = [];

    // Normalize to \n for consistent indexOf search
    const text = this.normalizeEOL(content);
    const startPat = this.normalizeEOL(block.startPattern);
    const endPat = this.normalizeEOL(block.endPattern);

    if (!startPat.length || !endPat.length) return results;

    const lineOffsets = this.buildLineOffsets(text);

    let cursor = 0;
    while (cursor < text.length) {
      // Find start pattern
      const startIdx = text.indexOf(startPat, cursor);
      if (startIdx === -1) break;

      // Find end pattern (non-greedy - first occurrence after start)
      const afterStart = startIdx + startPat.length;
      const endIdx = text.indexOf(endPat, afterStart);
      if (endIdx === -1) break;

      // Convert positions to line numbers
      const startLine = this.indexToLine(startIdx, lineOffsets);
      const endPatternEnd = endIdx + endPat.length - 1;
      const endLine = this.indexToLine(endPatternEnd, lineOffsets);

      // Calculate matched content positions
      const matchStart = startIdx;
      const matchEnd = endIdx + endPat.length - 1;

      results.push({
        found: true,
        startLine: startLine, // 1-based, includes start boundary
        endLine: endLine, // 1-based, includes end boundary
        startPos: matchStart,
        endPos: matchEnd,
        matchedContent: text.slice(matchStart, matchEnd + 1),
      });

      // Skip overlapping matches - continue after this block
      cursor = endIdx + endPat.length;
    }

    return results;
  }

  findBlockExact(content: string, block: Block): BlockSearchResult {
    const searchContent = block.content;
    const index = content.indexOf(searchContent);

    if (index === -1) {
      return { found: false };
    }

    const lines = content.split('\n');
    let currentPos = 0;
    let startLine = 1;
    let endLine = 1;

    // Find line numbers
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) {
        continue;
      }
      const lineLength = line.length + 1; // +1 for newline

      if (currentPos <= index && index < currentPos + lineLength) {
        startLine = i + 1;
        // Calculate end line
        const blockLines = searchContent.split('\n').length;
        endLine = startLine + blockLines - 1;
        break;
      }

      currentPos += lineLength;
    }

    return {
      found: true,
      startLine,
      endLine,
      startPos: index,
      endPos: index + searchContent.length - 1,
      matchedContent: searchContent,
    };
  }

  findBlockBoundary(content: string, block: Block): BlockSearchResult {
    if (!block.startPattern || !block.endPattern) {
      return { found: false };
    }

    // Use findAllBlocksBoundary and return first match
    const results = this.findAllBlocksBoundary(content, block);
    const firstResult = results[0];
    return firstResult !== undefined ? firstResult : { found: false };
  }

  createUnifiedDiff(original: string, modified: string, label: string): string {
    const originalLines = original.split('\n');
    const modifiedLines = modified.split('\n');

    // Simple diff - just show what changed
    const diff: string[] = [];
    diff.push(`--- ${label}`);
    diff.push(`+++ ${label} (modified)`);

    // For simplicity, just show the full before/after if they're different
    if (original !== modified) {
      diff.push('@@ -1,' + originalLines.length + ' +1,' + modifiedLines.length + ' @@');

      // Show removed lines
      for (const line of originalLines) {
        diff.push('-' + line);
      }

      // Show added lines
      for (const line of modifiedLines) {
        diff.push('+' + line);
      }
    }

    return diff.join('\n');
  }
}
