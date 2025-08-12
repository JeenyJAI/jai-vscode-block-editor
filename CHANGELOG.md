# Change Log

All notable changes to the "JAI Block Editor" extension will be documented in this file.

## [0.1.0] - 2025-08-12

### Initial release

#### Features
- DSL commands for block replacement (REPLACE, DELETE, INSERT)
- Support for multiple file patterns with glob syntax
- Pre-execution analysis with detailed statistics
- Boundary blocks support with `---TO---` separator
- Cross-platform line ending preservation (CRLF/LF)
- Mixed line endings detection and handling
- Secure path validation (workspace boundaries)
- Multiple commands support with `---NEXT_BLOCK---`

#### Supported Operations
- `replace block` - Replace all block occurrences
- `delete block` - Delete all block occurrences  
- `insert before` - Insert before each block
- `insert after` - Insert after each block
- `insert at start` - Insert at file beginning
- `insert at end` - Insert at file end