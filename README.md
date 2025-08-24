# JAI Block Editor - DSL Commands

## 100% AI Code · Human Reviewed

[![Version](https://img.shields.io/visual-studio-marketplace/v/JeenyJAI.block-editor)](https://marketplace.visualstudio.com/items?itemName=JeenyJAI.block-editor)
[![Downloads](https://img.shields.io/visual-studio-marketplace/d/JeenyJAI.block-editor)](https://marketplace.visualstudio.com/items?itemName=JeenyJAI.block-editor)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/JeenyJAI.block-editor)](https://marketplace.visualstudio.com/items?itemName=JeenyJAI.block-editor)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![AI Generated](https://img.shields.io/badge/AI%20Generated-100%25-purple.svg)](https://github.com/JeenyJAI/jai-vscode-block-editor)

#### [Repository](https://github.com/JeenyJAI/jai-vscode-block-editor)&nbsp;&nbsp;|&nbsp;&nbsp;[Issues](https://github.com/JeenyJAI/jai-vscode-block-editor/issues)&nbsp;&nbsp;|&nbsp;&nbsp;[Documentation](https://github.com/JeenyJAI/jai-vscode-block-editor/wiki)

Bridge between AI code generation and your IDE. Execute AI-suggested changes with simple DSL commands (REPLACE, DELETE, INSERT) across multiple files.

## Features

- **Smart Replace** – Replace code blocks across multiple files simultaneously
- **Bulk Delete** – Remove unwanted code patterns everywhere at once
- **Precision Insert** – Add code at exact positions (before/after blocks, start/end of files)
- **Boundary Blocks** – Define complex replacements with start/end boundaries using `---TO---`
- **Multi-file Operations** – Use glob patterns to target specific file groups
- **Pre-execution Analysis** – independent analysis of each command (not a preview of cascading changes)
- **Format Preservation** – Maintains original file encoding and line endings

## Quick Start

1. Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Run `JAI: Block Editor (DSL)`
3. Enter your DSL commands
4. Press `Ctrl+Enter` to apply changes

## Supported Operations

- `replace block` – replace all block occurrences
- `delete block` – delete all block occurrences
- `insert before` – insert before each block occurrence
- `insert after` – insert after each block occurrence
- `insert at start` – insert at file start
- `insert at end` – insert at file end

> **DSL notes**
> - Full-line `//` comments **outside** `---BEGIN---/---END---` blocks are ignored
> - Comments **inside** blocks are preserved as literal content

## Examples

### Replace Block
```dsl
replace block
---BEGIN---
DEBUG = True
---END---
with
---BEGIN---
DEBUG = False
---END---
in files ["config.py", "settings/*.py"]
```

### Delete Block
```dsl
delete block
---BEGIN---
# TODO: Remove after migration
def legacy_function():
    pass
---END---
in files ["src/**/*.py"]
```

### Insert Block
```dsl
insert after
---BEGIN---
class User:
---END---
with
---BEGIN---
    def __init__(self, name, email):
        self.name = name
        self.email = email
---END---
in files ["models.py"]
```

### Boundary Blocks (with ---TO---)
```dsl
replace block
---BEGIN---
def process_data(data):
    # Start of function
---TO---
    return result
    # End of function
---END---
with
---BEGIN---
def process_data(data):
    # Optimized implementation
    if not data:
        return None
    
    result = optimize(data)
    log_performance(result)
    return result
    # End of function
---END---
```

### Multiple Operations

Use `---NEXT_BLOCK---` to execute multiple operations at once:

```dsl
replace block
---BEGIN---
VERSION = "1.0.0"
---END---
with
---BEGIN---
VERSION = "2.0.0"
---END---
in files ["version.py"]

---NEXT_BLOCK---

insert after
---BEGIN---
VERSION = "2.0.0"
---END---
with
---BEGIN---
RELEASE_DATE = "2024-01-01"
---END---
in files ["version.py"]
```

## Pre-execution Analysis

Before applying changes, the extension performs analysis and shows:

```
PRE-EXECUTION ANALYSIS
──────────────────────────────
Total commands: 34
Matches found: 30
No matches for: 4 commands
Parse errors: 0

Details:
- Commands 0003, 0004, 0005, 0006 will be skipped (blocks not found)

Continue with applying changes?
[Apply]  [Cancel]
```

**Important**: Preview analyzes each command independently. When applied sequentially, commands may affect each other, so final result may differ from pre-analysis.

## File Patterns

```dsl
in files ["config.py"]                        # single file
in files ["config.py", "settings.py"]         # multiple files
in files ["src/"]                             # all files in directory (recursive)
in files ["*.py"]                             # pattern in current directory
in files ["src/*.py"]                         # pattern in specific directory
in files ["**/test_*.py"]                     # recursive pattern
in files ["config.py", "src/", "tests/*.py"]  # combination
```

**Pattern Rules:**
- Paths ending with `/` – directories (recursive search)
- `*` – any characters within single level
- `**` – recursive search in all subdirectories
- All patterns are processed as glob patterns
- If no files specified – uses current active file

## Configuration

This extension contributes the following settings:

* `blockEditor.validatePaths`: Enable path validation for security (default: `true`)
* `blockEditor.mixedEolPolicy`: How to handle mixed line endings (`warn`, `ignore`, `skip`, `normalize`)
* `blockEditor.enableVerboseLogging`: Enable verbose logging for debugging (default: `false`)
* `blockEditor.files.respectSearchExclude`: Respect VS Code's exclude settings when resolving files (default: `true`)
* `blockEditor.files.includeDotfiles`: Control dotfile handling – `inherit`/`always`/`never` (default: `inherit`)

## Requirements

- VS Code 1.87.0 or higher

## Behavior Notes

- Binary files are automatically skipped for safety
- Mixed line endings in files will trigger a warning (configurable via `blockEditor.mixedEolPolicy`)

## Release Notes

See [CHANGELOG.md](CHANGELOG.md) for release history.

## Security

Block Editor operates only within your workspace boundaries:
- Automatic validation that files are within workspace
- Protection against path traversal attacks
- No access to files outside the project

## Contributing

Found a bug or have a feature request? Please open an issue on [GitHub](https://github.com/JeenyJAI/jai-vscode-block-editor/issues).

## Acknowledgments

- Special thanks to [Al-Shamal](https://github.com/Al-Shamal) for testing, editing, and bringing this extension closer to humans

## License

This extension is licensed under the [MIT License](LICENSE).

---

🚀 **Created by [Claude Opus 4.1](https://claude.ai), [ChatGPT 5 Pro](https://chat.openai.com) · Reviewed by [Gemini 2.5 Pro](https://gemini.google.com), [DeepSeek V3](https://www.deepseek.com)**