// src/utils/pathResolver.ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';

export interface ResolveResult {
  files: vscode.Uri[];
  skipped: Array<{ pattern: string; reason: string }>;
  errors: Array<{ pattern: string; error: string }>;
}

/**
 * Safely resolves file patterns within workspace boundaries
 * Protection against directory traversal and workspace escapes
 */
export async function resolveFilesFromPatterns(patterns: string[]): Promise<ResolveResult> {
  const result: ResolveResult = {
    files: [],
    skipped: [],
    errors: [],
  };

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    result.errors.push({
      pattern: '*',
      error: 'No workspace folder open',
    });
    return result;
  }

  const firstFolder = workspaceFolders[0];
  if (!firstFolder) {
    result.errors.push({
      pattern: '*',
      error: 'No workspace folder available',
    });
    return result;
  }
  const workspaceRoot = firstFolder.uri.fsPath;
  const fileSet = new Set<string>();

  for (const pattern of patterns) {
    try {
      // Check for absolute paths - forbidden
      if (path.isAbsolute(pattern)) {
        result.skipped.push({
          pattern,
          reason: 'Absolute paths are not allowed',
        });
        continue;
      }

      // Check for workspace escape attempts
      if (pattern.includes('..')) {
        const resolved = path.resolve(workspaceRoot, pattern);
        const normalized = path.normalize(resolved);

        if (!normalized.startsWith(workspaceRoot)) {
          result.skipped.push({
            pattern,
            reason: 'Path traversal outside workspace is not allowed',
          });
          continue;
        }
      }

      // Handle different pattern types
      if (pattern.endsWith('/')) {
        // Directory - find all files recursively
        const dirPath = path.join(workspaceRoot, pattern);

        // Verify directory is within workspace
        if (!dirPath.startsWith(workspaceRoot)) {
          result.skipped.push({
            pattern,
            reason: 'Directory outside workspace',
          });
          continue;
        }

        const files = await findFilesInDirectory(dirPath, workspaceRoot);
        files.forEach((f) => fileSet.add(f));
      } else if (pattern.includes('*')) {
        // Glob pattern - use VSCode API with RelativePattern
        const firstFolder = workspaceFolders[0];
        if (!firstFolder) {
          result.skipped.push({
            pattern,
            reason: 'No workspace folder available',
          });
          continue;
        }
        const relPattern = new vscode.RelativePattern(firstFolder, pattern);
        const files = await vscode.workspace.findFiles(relPattern);

        for (const file of files) {
          // Additional check that file is within workspace
          if (file.fsPath.startsWith(workspaceRoot)) {
            fileSet.add(file.fsPath);
          } else {
            result.skipped.push({
              pattern: file.fsPath,
              reason: 'File outside workspace',
            });
          }
        }
      } else {
        // Regular file
        const filePath = path.join(workspaceRoot, pattern);
        const normalized = path.normalize(filePath);

        // Verify file is within workspace
        if (!normalized.startsWith(workspaceRoot)) {
          result.skipped.push({
            pattern,
            reason: 'File outside workspace',
          });
          continue;
        }

        // Check file existence
        try {
          const stat = await fs.stat(normalized);
          if (stat.isFile()) {
            fileSet.add(normalized);
          } else if (stat.isDirectory()) {
            // If directory specified without slash - treat as directory
            const files = await findFilesInDirectory(normalized, workspaceRoot);
            files.forEach((f) => fileSet.add(f));
          }
        } catch (error) {
          result.errors.push({
            pattern,
            error: `File not found: ${pattern}`,
          });
        }
      }
    } catch (error) {
      result.errors.push({
        pattern,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Convert to Uri
  for (const filePath of fileSet) {
    result.files.push(vscode.Uri.file(filePath));
  }

  return result;
}

/**
 * Recursively finds files in directory with security checks
 */
async function findFilesInDirectory(dirPath: string, workspaceRoot: string): Promise<string[]> {
  const files: string[] = [];

  try {
    // Verify directory is within workspace
    const normalized = path.normalize(dirPath);
    if (!normalized.startsWith(workspaceRoot)) {
      console.warn(`Directory ${dirPath} is outside workspace, skipping`);
      return files;
    }

    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      // Skip hidden files and system directories
      if (entry.name.startsWith('.')) {
        continue;
      }

      // Skip node_modules and other ignored directories
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') {
        continue;
      }

      if (entry.isDirectory()) {
        // Recursively traverse subdirectories
        const subFiles = await findFilesInDirectory(fullPath, workspaceRoot);
        files.push(...subFiles);
      } else if (entry.isFile()) {
        // Verify file is within workspace
        const normalizedFile = path.normalize(fullPath);
        if (normalizedFile.startsWith(workspaceRoot)) {
          files.push(normalizedFile);
        }
      } else if (entry.isSymbolicLink()) {
        // Check symbolic links
        try {
          const realPath = await fs.realpath(fullPath);
          if (realPath.startsWith(workspaceRoot)) {
            const stat = await fs.stat(realPath);
            if (stat.isFile()) {
              files.push(realPath);
            }
          } else {
            console.warn(`Symlink ${fullPath} points outside workspace, skipping`);
          }
        } catch {
          // Broken symbolic link - skip
        }
      }
    }
  } catch (error) {
    console.error(`Error reading directory ${dirPath}:`, error);
  }

  return files;
}

/**
 * Checks if path is safe (within workspace)
 */
export function isPathSafe(filePath: string): boolean {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return false;
  }

  // Normalize file path
  const normalizedFilePath = path.normalize(path.resolve(filePath)).toLowerCase();

  // Check if file is within at least one workspace
  for (const folder of workspaceFolders) {
    const workspaceRoot = path.normalize(folder.uri.fsPath).toLowerCase();

    // On Windows, drive letters may have different case
    if (normalizedFilePath.startsWith(workspaceRoot)) {
      return true;
    }
  }

  // If path is not absolute, check relative to first workspace
  if (!path.isAbsolute(filePath)) {
    // Relative path without .. is considered safe
    if (!filePath.includes('..')) {
      return true;
    }

    // Check if path escapes workspace boundaries
    const firstFolder = workspaceFolders[0];
    if (!firstFolder) {
      return false;
    }
    const workspaceRoot = firstFolder.uri.fsPath;
    const resolved = path.resolve(workspaceRoot, filePath);
    const normalizedResolved = path.normalize(resolved).toLowerCase();
    const normalizedRoot = path.normalize(workspaceRoot).toLowerCase();

    return normalizedResolved.startsWith(normalizedRoot);
  }

  return false;
}