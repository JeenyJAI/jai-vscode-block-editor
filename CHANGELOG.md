# Changelog

All notable changes to the **JAI Block Editor** extension are documented in this file.

## [Unreleased]

### Added
- ...

### Changed
- ...

### Fixed
- ...

---

## [0.2.0] - 2025-08-16

### Critical Bug Fixes

- **Files in workspace root are now properly detected** ([#1](https://github.com/JeenyJAI/jai-vscode-block-editor/issues/1))
  - Root-level files (README.md, package.json, etc.) were invisible to the extension
  - Dotfiles (.env, .gitignore, etc.) were silently ignored when using directory patterns like `["./"]`
  - Multi-root workspace support was broken - only first workspace folder was searched

### Major Improvements

- **Complete rewrite of file resolution system**
  - Replaced legacy `pathResolver.ts` with new `fileResolver.ts` using native `vscode.Uri` API
  - All workspace folders are now searched (not just the first one)
  - Proper support for remote workspaces (SSH, WSL, Codespaces)
  - Glob patterns like `*.md` now correctly search only in root (use `**/*.md` for recursive)

### New Features

- **Configuration options for file handling**
  - `blockEditor.files.respectSearchExclude` - Respect VS Code's exclude settings (default: true)
  - `blockEditor.files.includeDotfiles` - Control dotfile handling: `inherit`/`always`/`never` (default: inherit)
  
- **Operational improvements**
  - Cancellation support for long-running searches via `CancellationToken`
  - Detailed resolution reports with statistics (enable `blockEditor.enableVerboseLogging` to see them)
  - Better error messages explaining why files were skipped

### Technical Changes

- Minimum VS Code version: `^1.87.0` (was `^1.85.0`)
- TypeScript upgraded to `^5.4.0`
- File operations now use `vscode.Uri` instead of string paths
- New public method: `BlockEditor.parseCommand()` for API access
- New method `applyToFilesUri()` replaces string-based file operations

### Migration Note

For programmatic API usage, migrate from string paths to URIs:
```typescript
// Old: await blockEditor.applyToFiles(commands, filePaths, ...)
// New: await blockEditor.applyToFilesUri(commands, fileUris, ...)
```

---

## [0.1.1] - 2025-08-14

### Changed
- Updated extension icon
- Improved marketplace categories to better reflect AI integration capabilities
- Enhanced keywords for better discoverability of AI-related features
- Cleaned up README.md to avoid duplication with CHANGELOG

---

## [0.1.0] - 2025-08-12

### Added
- DSL commands for block replacement (`REPLACE`, `DELETE`, `INSERT`)
- Support for multiple file patterns with glob syntax
- Pre-execution analysis with detailed statistics
- Boundary blocks support with `---TO---` separator
- Cross-platform line ending preservation (CRLF/LF)
- Mixed line endings detection and handling
- Secure path validation (workspace boundaries)
- Multiple commands support with `---NEXT_BLOCK---`

#### Supported operations
- `replace block` - replace all block occurrences
- `delete block` - delete all block occurrences
- `insert before` - insert before each block
- `insert after` - insert after each block
- `insert at start` - insert at file beginning
- `insert at end` - insert at file end