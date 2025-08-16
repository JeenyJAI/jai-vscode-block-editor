// src/utils/fileResolver.ts
import * as vscode from 'vscode';
import * as path from 'path';
import type { CancellationToken } from 'vscode';

type IncludeDotfiles = 'inherit' | 'always' | 'never';

export interface FileResolverOptions {
  /**
   * Respect user 'files.exclude' and 'search.exclude' when resolving files.
   * Default: true (can be overridden by settings: blockEditor.files.respectSearchExclude)
   */
  respectSearchExclude?: boolean;

  // Dotfiles policy. Default: 'inherit' (can be overridden by settings: blockEditor.files.includeDotfiles)
  //  - 'inherit': rely entirely on user's excludes
  //  - 'always': do not add our own '**/.*' exclude (still respect user's excludes)
  //  - 'never': add '**/.*' to excludes
  includeDotfiles?: IncludeDotfiles;

  /**
   * Optional cancellation support for long searches
   */
  token?: CancellationToken;
}

export interface ResolutionReport {
  targets: number;
  workspaceFolders: number;
  matched: number;
  unique: number;
  excludedByConfig: number;
  outsideWorkspace: number;
}

export interface ResolveResult {
  uris: vscode.Uri[];
  report: ResolutionReport;
  skipped: Array<{ pattern: string; reason: string }>;
  errors: Array<{ pattern: string; error: string }>;
}

export class FileResolver {
  /**
   * Resolve file targets across all workspace folders with proper semantics
   */
  public static async resolveTargets(
    rawTargets: readonly string[],
    options?: FileResolverOptions
  ): Promise<ResolveResult> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const skipped: Array<{ pattern: string; reason: string }> = [];
    const errors: Array<{ pattern: string; error: string }> = [];
    
    if (folders.length === 0) {
      return {
        uris: [],
        report: {
          targets: rawTargets.length,
          workspaceFolders: 0,
          matched: 0,
          unique: 0,
          excludedByConfig: 0,
          outsideWorkspace: 0,
        },
        skipped: [],
        errors: [{ pattern: '*', error: 'No workspace folder open' }],
      };
    }

    // Read settings
    const cfg = vscode.workspace.getConfiguration('blockEditor');
    const respectSearchExclude = options?.respectSearchExclude ?? cfg.get<boolean>('files.respectSearchExclude', true);
    const includeDotfiles = options?.includeDotfiles ?? cfg.get<IncludeDotfiles>('files.includeDotfiles', 'inherit');
    const token = options?.token;

    // Collect all matched URIs
    const collected: vscode.Uri[] = [];
    let excludedByConfig = 0;
    let outsideWorkspace = 0;

    for (const targetRaw of rawTargets) {
      // Check cancellation
      if (token?.isCancellationRequested) {
        skipped.push({
          pattern: targetRaw,
          reason: 'Operation cancelled by user',
        });
        break;
      }

      const target = FileResolver.normalizeInput(targetRaw);
      
      // Security check: prevent path traversal
      if (FileResolver.hasPathTraversal(target)) {
        skipped.push({
          pattern: targetRaw,
          reason: 'Path traversal outside workspace is not allowed',
        });
        outsideWorkspace++;
        continue;
      }

      try {
        // Handle absolute paths
        if (FileResolver.isAbsolutePath(target)) {
          const result = await FileResolver.handleAbsolutePath(
            target, 
            folders, 
            respectSearchExclude, 
            includeDotfiles, 
            token
          );
          if (result.error) {
            skipped.push({ pattern: targetRaw, reason: result.error });
            outsideWorkspace++;
          } else if (result.uris) {
            collected.push(...result.uris);
          }
          continue;
        }

        // Handle directory pattern (ends with /)
        if (FileResolver.isDirectoryPattern(target)) {
          const dirPattern = FileResolver.directoryToGlob(target);
          for (const folder of folders) {
            // Check cancellation before each folder
            if (token?.isCancellationRequested) {
              skipped.push({
                pattern: targetRaw,
                reason: 'Operation cancelled by user',
              });
              break;
            }
            
            const exclude = await FileResolver.buildExcludeGlob(folder, respectSearchExclude, includeDotfiles);
            const found = await vscode.workspace.findFiles(
              new vscode.RelativePattern(folder, dirPattern),
              exclude,
              undefined,
              token  // Pass token to findFiles
            );
            collected.push(...found);
          }
          continue;
        }

        // Handle glob patterns
        if (FileResolver.isGlob(target)) {
          // Determine if pattern should search only at root level
          const isRootOnly = FileResolver.isRootOnlyPattern(target);
          
          for (const folder of folders) {
            // Check cancellation before each folder
            if (token?.isCancellationRequested) {
              skipped.push({
                pattern: targetRaw,
                reason: 'Operation cancelled by user',
              });
              break;
            }
            
            const exclude = await FileResolver.buildExcludeGlob(folder, respectSearchExclude, includeDotfiles);
            
            // For root-only patterns (e.g., "*.md"), search only at workspace root
            const pattern = isRootOnly ? target : target;
            
            const found = await vscode.workspace.findFiles(
              new vscode.RelativePattern(folder, pattern),
              exclude,
              undefined,
              token  // Pass token to findFiles
            );
            
            // For root-only patterns, filter to keep only root-level files
            if (isRootOnly) {
              const rootLevel = found.filter(uri => {
                const relative = path.relative(folder.uri.fsPath, uri.fsPath);
                // Check if file is at root level (no directory separators in relative path)
                return !relative.includes(path.sep);
              });
              collected.push(...rootLevel);
            } else {
              collected.push(...found);
            }
          }
          continue;
        }

        // Handle as specific file path (relative to each workspace folder)
        for (const folder of folders) {
          // Check cancellation before each folder
          if (token?.isCancellationRequested) {
            skipped.push({
              pattern: targetRaw,
              reason: 'Operation cancelled by user',
            });
            break;
          }
          
          const candidate = vscode.Uri.joinPath(folder.uri, target);
          
          try {
            const stat = await vscode.workspace.fs.stat(candidate);
            
            if (stat.type & vscode.FileType.Directory) {
              // It's a directory - treat as recursive search
              const exclude = await FileResolver.buildExcludeGlob(folder, respectSearchExclude, includeDotfiles);
              const dirGlob = FileResolver.directoryToGlob(target);
              const found = await vscode.workspace.findFiles(
                new vscode.RelativePattern(folder, dirGlob),
                exclude,
                undefined,
                token
              );
              collected.push(...found);
            } else {
              // It's a file - add if not excluded
              const shouldInclude = await FileResolver.shouldIncludeFile(
                candidate,
                folder,
                respectSearchExclude,
                includeDotfiles
              );
              if (shouldInclude) {
                collected.push(candidate);
              } else {
                excludedByConfig++;
              }
            }
          } catch {
            // File doesn't exist in this folder - continue to next folder
          }
        }
      } catch (error) {
        errors.push({
          pattern: targetRaw,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Deduplicate and filter
    const { unique: uniqueUris, filtered } = FileResolver.deduplicateUris(collected, folders);
    excludedByConfig += filtered;

    // Sort results
    const sorted = FileResolver.sortUris(uniqueUris, folders);

    const report: ResolutionReport = {
      targets: rawTargets.length,
      workspaceFolders: folders.length,
      matched: collected.length,
      unique: sorted.length,
      excludedByConfig,
      outsideWorkspace,
    };

    return { uris: sorted, report, skipped, errors };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Helper Methods
  // ────────────────────────────────────────────────────────────────────────

  private static normalizeInput(input: string): string {
    let normalized = input.trim();
    // Convert Windows paths to POSIX
    normalized = normalized.replace(/\\/g, '/');
    // Don't remove leading ./ as it's significant for directory detection
    return normalized;
  }

  private static hasPathTraversal(path: string): boolean {
    // Check for .. segments that could escape workspace
    const segments = path.split('/');
    let depth = 0;
    
    for (const segment of segments) {
      if (segment === '..') {
        depth--;
        if (depth < 0) {
          return true; // Escapes root
        }
      } else if (segment !== '.' && segment !== '') {
        depth++;
      }
    }
    
    return false;
  }

  private static isAbsolutePath(path: string): boolean {
    // Unix: /path, Windows: C:/path or C:\path
    return path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path);
  }

  private static isDirectoryPattern(path: string): boolean {
    // Check if path indicates a directory
    return path === '.' || 
           path === './' || 
           path === '..' || 
           path === '../' ||
           path.endsWith('/');
  }

  private static isGlob(pattern: string): boolean {
    // Check for glob special characters
    return /[*?[\]{}]/.test(pattern);
  }

  private static isRootOnlyPattern(pattern: string): boolean {
    // Patterns without path separators and without ** should search only at root
    // e.g., "*.md" searches only at root, but "**/*.md" or "src/*.md" do not
    return !pattern.includes('/') && !pattern.includes('**');
  }

  private static directoryToGlob(dir: string): string {
    // Convert directory path to glob pattern for recursive search
    let normalized = dir;
    
    // Handle special cases
    if (normalized === '.' || normalized === './') {
      return '**/*';
    }
    
    // Remove trailing slash
    if (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
    
    // Return recursive glob
    return normalized.length > 0 ? `${normalized}/**/*` : '**/*';
  }

  private static async handleAbsolutePath(
    targetPath: string,
    folders: readonly vscode.WorkspaceFolder[],
    respectSearchExclude: boolean,
    includeDotfiles: IncludeDotfiles,
    token?: CancellationToken
  ): Promise<{ uris?: vscode.Uri[]; error?: string }> {
    // Check if we're in a remote workspace
    const firstFolder = folders[0];
    if (firstFolder && firstFolder.uri.scheme !== 'file') {
      return { error: 'Absolute paths are not supported in remote workspaces' };
    }
    
    // For absolute paths, we need to check if they're within a workspace folder
    // Note: This only works reliably for file:// scheme
    try {
      const uri = vscode.Uri.file(targetPath);
      const owner = FileResolver.findOwningFolder(uri, folders);
      
      if (!owner) {
        return { error: 'Absolute path is outside workspace' };
      }
      
      const stat = await vscode.workspace.fs.stat(uri);
      
      if (stat.type & vscode.FileType.Directory) {
        // Directory - search recursively
        const exclude = await FileResolver.buildExcludeGlob(owner, respectSearchExclude, includeDotfiles);
        const relative = path.relative(owner.uri.fsPath, uri.fsPath);
        const globPattern = relative.length > 0 ? `${relative}/**/*` : '**/*';
        
        const found = await vscode.workspace.findFiles(
          new vscode.RelativePattern(owner, globPattern),
          exclude,
          undefined,
          token  // Pass token to findFiles
        );
        return { uris: found };
      } else {
        // File - check if should be included
        const shouldInclude = await FileResolver.shouldIncludeFile(
          uri,
          owner,
          respectSearchExclude,
          includeDotfiles
        );
        return shouldInclude ? { uris: [uri] } : { uris: [] };
      }
    } catch {
      return { error: 'Invalid absolute path or file not found' };
    }
  }

  private static findOwningFolder(
    uri: vscode.Uri,
    folders: readonly vscode.WorkspaceFolder[]
  ): vscode.WorkspaceFolder | undefined {
    const uriString = uri.toString();
    
    for (const folder of folders) {
      const folderString = folder.uri.toString();
      const folderWithSlash = folderString.endsWith('/') ? folderString : `${folderString}/`;
      
      if (uriString.startsWith(folderWithSlash) || uriString === folderString) {
        return folder;
      }
    }
    
    return undefined;
  }

  private static async shouldIncludeFile(
    uri: vscode.Uri,
    folder: vscode.WorkspaceFolder,
    respectSearchExclude: boolean,
    includeDotfiles: IncludeDotfiles
  ): Promise<boolean> {
    // Check against exclude patterns
    if (!respectSearchExclude && includeDotfiles === 'inherit') {
      return true; // No filtering
    }
    
    const relative = path.relative(folder.uri.fsPath, uri.fsPath);
    const segments = relative.split(path.sep);
    
    // Check dotfiles policy
    if (includeDotfiles === 'never') {
      const hasDotfile = segments.some(seg => seg.startsWith('.') && seg !== '.');
      if (hasDotfile) return false;
    }
    
    // Check user excludes (simplified - in real implementation would need to evaluate patterns)
    if (respectSearchExclude) {
      const excludePatterns = await FileResolver.getUserExcludePatterns(folder);
      // This is simplified - would need proper glob matching
      for (const pattern of excludePatterns) {
        if (FileResolver.matchesPattern(relative, pattern)) {
          return false;
        }
      }
    }
    
    return true;
  }

  private static async buildExcludeGlob(
    folder: vscode.WorkspaceFolder,
    respectSearchExclude: boolean,
    includeDotfiles: IncludeDotfiles
  ): Promise<string | undefined> {
    const patterns: string[] = [];
    
    if (respectSearchExclude) {
      const userPatterns = await FileResolver.getUserExcludePatterns(folder);
      patterns.push(...userPatterns);
    }
    
    if (includeDotfiles === 'never') {
      // Add dotfile exclusion if not already present
      if (!patterns.some(p => p === '**/.*' || p === '.*')) {
        patterns.push('**/.*');
      }
    }
    
    if (patterns.length === 0) {
      return undefined;
    }
    
    // Return as glob pattern
    return patterns.length === 1 ? patterns[0] : `{${patterns.join(',')}}`;
  }

  private static async getUserExcludePatterns(folder: vscode.WorkspaceFolder): Promise<string[]> {
    const patterns: string[] = [];
    
    // Get files.exclude (can be boolean or {when: string} for conditional excludes)
    const filesExclude = vscode.workspace.getConfiguration('files', folder.uri)
      .get<Record<string, boolean | { when: string }>>('exclude', {});
    for (const [pattern, value] of Object.entries(filesExclude)) {
      // Include pattern if value is truthy (boolean true or any object)
      if (value && (typeof value === 'boolean' ? value : true)) {
        patterns.push(pattern);
      }
    }
    
    // Get search.exclude (same format as files.exclude)
    const searchExclude = vscode.workspace.getConfiguration('search', folder.uri)
      .get<Record<string, boolean | { when: string }>>('exclude', {});
    for (const [pattern, value] of Object.entries(searchExclude)) {
      if (value && (typeof value === 'boolean' ? value : true) && !patterns.includes(pattern)) {
        patterns.push(pattern);
      }
    }
    
    return patterns;
  }

  private static matchesPattern(filePath: string, pattern: string): boolean {
    // Normalize path to use forward slashes for consistent matching
    const normalizedPath = filePath.replace(/\\/g, '/');
    
    // Handle common patterns
    if (pattern === '**/node_modules' || pattern === 'node_modules') {
      return normalizedPath.includes('node_modules');
    }
    if (pattern === '**/.git' || pattern === '.git') {
      return normalizedPath.includes('.git');
    }
    if (pattern === '**/.*') {
      return normalizedPath.split('/').some(seg => seg.startsWith('.') && seg !== '.');
    }
    if (pattern === '**/dist' || pattern === 'dist') {
      return normalizedPath.includes('dist');
    }
    if (pattern === '**/build' || pattern === 'build') {
      return normalizedPath.includes('build');
    }
    if (pattern === '**/coverage' || pattern === 'coverage') {
      return normalizedPath.includes('coverage');
    }
    if (pattern === '**/.vscode' || pattern === '.vscode') {
      return normalizedPath.includes('.vscode');
    }
    
    // Handle file extension patterns
    if (pattern.startsWith('*.')) {
      const ext = pattern.substring(1); // Get extension including dot
      return normalizedPath.endsWith(ext);
    }
    
    // For other complex patterns, would need proper glob matching
    // TODO: Consider using minimatch or VS Code's pattern matching
    return false;
  }

  private static deduplicateUris(
    uris: vscode.Uri[],
    folders: readonly vscode.WorkspaceFolder[]
  ): { unique: vscode.Uri[]; filtered: number } {
    const seen = new Map<string, vscode.Uri>();
    let filtered = 0;
    
    for (const uri of uris) {
      const key = uri.toString();
      
      // Check if URI is within workspace
      const owner = FileResolver.findOwningFolder(uri, folders);
      if (!owner) {
        filtered++;
        continue;
      }
      
      if (!seen.has(key)) {
        seen.set(key, uri);
      }
    }
    
    return { unique: Array.from(seen.values()), filtered };
  }

  private static sortUris(
    uris: vscode.Uri[],
    folders: readonly vscode.WorkspaceFolder[]
  ): vscode.Uri[] {
    return uris.sort((a, b) => {
      // Find owning folders
      const folderA = FileResolver.findOwningFolder(a, folders);
      const folderB = FileResolver.findOwningFolder(b, folders);
      
      // Sort by folder index first
      const indexA = folderA ? folders.indexOf(folderA) : -1;
      const indexB = folderB ? folders.indexOf(folderB) : -1;
      
      if (indexA !== indexB) {
        return indexA - indexB;
      }
      
      // Then by relative path within folder
      if (folderA) {
        const relA = path.relative(folderA.uri.fsPath, a.fsPath);
        const relB = path.relative(folderA.uri.fsPath, b.fsPath);
        return relA.localeCompare(relB);
      }
      
      // Fallback to string comparison
      return a.toString().localeCompare(b.toString());
    });
  }
}