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
