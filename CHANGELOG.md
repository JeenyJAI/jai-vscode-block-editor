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

## [0.3.0] - 2025-08-17
**Highlights:** New secure webview architecture, improved accessibility, live debug mode.

### Added
- Webview architecture with separate HTML/CSS/JS (maintainability)
- Dynamic version in header (from `package.json`)
- Debug mode toggled via `blockEditor.debug`, live switching without reload
- Native VS Code dialog for input clearing
- Auto-disabling Apply button when input is empty
- ARIA attributes (`aria-label`, `aria-busy`, `role="status"`) and `:focus-visible`
- `prefers-reduced-motion` support
- Details/summary expansion state persistence
- Input validation for incoming webview messages
- Command category **JAI** in Command Palette

### Changed
- Migrated from inline to modular webview (HTML/CSS/JS)
- Stronger CSP with cryptographically secure nonce
- Idempotent DOM-ready initialization
- Replaced browser `confirm()` with native VS Code dialogs
- State management uses fresh snapshots to prevent races
- Status handling via `classList` (no `className` overwrite)
- Textarea hardened with `autocomplete="off"`, `autocapitalize="off"`, `autocorrect="off"`
- Restricted resource loading with `localResourceRoots`

### Fixed
- Logger capturing stale debug state
- Button state not updating after programmatic changes
- Potential state overwrites under concurrency
- Missing `type="button"` on Apply button
- Incomplete CSP directives in fallback HTML
- Input focus after initialization

### Security
- Strict CSP with protective directives
- Escaped error messages in fallback HTML
- `enableCommandUris: false`
- Allowed message types validated

---

## [0.2.1] - 2025-08-17

### Added
- AI category to marketplace categories for better discoverability

---

## [0.2.0] - 2025-08-16

### Added
- Configuration option `blockEditor.files.respectSearchExclude` — respect VS Code exclude settings (default: true)
- Configuration option `blockEditor.files.includeDotfiles` — dotfiles policy: `inherit`/`always`/`never` (default: inherit)
- Public API method `applyToFilesUri()` for URI-based operations
- Public API method `BlockEditor.parseCommand()` for programmatic usage
- Cancellation support for long-running operations via `CancellationToken`

### Changed
- ⚠️ Breaking: File operations now use `vscode.Uri` instead of string paths
  Migration: Use `applyToFilesUri()` instead of `applyToFiles()`
- Rewrote file resolution system using `vscode.Uri` with proper multi-root and remote workspace support
- Replaced legacy path resolver with new `fileResolver.ts`
- Glob patterns: `*.md` searches only at workspace root; use `**/*.md` for recursive search
- Minimum VS Code engine updated to `^1.87.0`
- TypeScript upgraded to `^5.4.0`
- Improved diagnostics with detailed resolution reports and clearer skip reasons

### Fixed
- Files in workspace root (including dotfiles) are now detected correctly ([#1](https://github.com/JeenyJAI/jai-vscode-block-editor/issues/1))
- Multi-root workspace search now covers all workspace folders

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