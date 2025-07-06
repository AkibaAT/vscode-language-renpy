
# Ren'Py Language with Debugging Support

An enhanced extension that adds rich support for the [Ren'Py](https://www.renpy.org/) programming language to [Visual Studio Code](https://code.visualstudio.com/) **with full debugging and breakpoint support**.

## 🎯 Key Features

### 🎨 **Rich Language Support** (Original Features)
- **Syntax highlighting** for Ren'Py scripts
- **Code completion** and IntelliSense
- **Diagnostics** and error checking
- **Hover information** for symbols
- **Go to definition** support
- **Symbol outline** and navigation
- **Snippets** for common Ren'Py patterns

### 🐛 **NEW: Full Debugging Support**
- **Breakpoints** in `.rpy` files with line-level precision
- **Step debugging** (step in, step out, step over)
- **Continue/pause** execution control
- **Variable inspection** (coming soon)
- **Call stack** viewing (coming soon)
- **Debug console** integration

### 🔧 **Dual Debugging Modes**
1. **Terminal Mode** (`renpy` type): Simple terminal-based execution (original behavior)
2. **DAP Mode** (`renpy-dap` type): **NEW** - Full debugging with breakpoints via Debug Adapter Protocol

## 🚀 Quick Start

### Prerequisites
1. **Enhanced Ren'Py Engine**: You need a Ren'Py build with DAP debugging support
2. **Configure Ren'Py path** in VSCode settings:
   ```json
   {
     "renpy.renpyExecutableLocation": "/path/to/renpy.sh"
   }
   ```

### Basic Debugging
1. **Open your Ren'Py project** in VSCode
2. **Set breakpoints** by clicking in the gutter next to line numbers in `.rpy` files
3. **Press F5** or go to Run → Start Debugging
4. **Select "Ren'Py: Debug with Breakpoints"** configuration
5. **Your game will start** and pause at breakpoints automatically!

## 📋 Debug Configurations

### Launch Configuration (Recommended)
```json
{
    "name": "Ren'Py: Debug with Breakpoints",
    "type": "renpy-dap",
    "request": "launch",
    "port": 14711,
    "host": "localhost"
}
```

### Attach Configuration
```json
{
    "name": "Ren'Py: Attach to Running Game",
    "type": "renpy-dap",
    "request": "attach",
    "port": 14711,
    "host": "localhost"
}
```

Snippets converted from [Ren'Py language support in Atom](https://github.com/renpy/language-renpy)

Feel free to [contribute](https://github.com/AkibaAT/vscode-language-renpy/blob/master/Contributing.md), fork this and send a pull request. :smile:

## Building 
To build and run the extension locally, see [this section](https://github.com/renpy/vscode-language-renpy/blob/master/Contributing.md#how-to-contribute) on the contributing page.

## Features

### Syntax Highlighting

![syntax](https://user-images.githubusercontent.com/1286535/40073232-9509274a-5876-11e8-98ff-e14b46bfab8a.gif)

> The syntax highlight depending on the syntax theme used. In this case [One Dark Pro](https://marketplace.visualstudio.com/items?itemName=zhuangtongfa.Material-theme).

### Snippets

![snippets](https://user-images.githubusercontent.com/1286535/40073650-b999c5dc-5877-11e8-8910-596f9e94b281.gif)

### Completion

![completion](https://user-images.githubusercontent.com/12246002/137429951-63043065-57c7-4fb2-8bc3-27f69616f439.gif)

> Displays a pop-up auto-complete menu with context-appropriate choices as you type your script or enter screen properties.

### Document Color

![colors](https://user-images.githubusercontent.com/12246002/137429939-a813bc82-e067-4306-9d4b-9d3fa064b1b6.gif)

> Displays a color block next to detected colors in your script and allows you to pick new colors with a click.

### Hover

![hover](https://user-images.githubusercontent.com/12246002/137430452-3ae9e16a-6bd9-474b-837c-f19040a92766.gif)

> Hovering over a Ren'Py or user-defined keyword will display the selected item's source file/location as well as documentation if available. Clicking the filename location will jump to that document and position.

### Go To Definition

> Adds support for right-click Go To Definition (F12), which will jump to the selected keyword's source.

### Signature Help

> Shows the documentation pop-up as you enter a function's arguments.

### Diagnostics

![diagnostics](https://user-images.githubusercontent.com/12246002/137431018-978530fd-4af4-4d10-b72a-fe852a5ddffd.gif)

> Adds support for detection of issues with indentation or invalid filenames/variable names and marks them as errors or warnings in the editor.

### Document Symbols

> Document Symbols are displayed in the Outline window in the sidebar.

## Thanks To

- [language-renpy](https://github.com/renpy/language-renpy). All contributors
- [Koroshiya](https://github.com/koroshiya) ([Sublime-Renpy](https://github.com/koroshiya/Sublime-Renpy))
