#!/bin/bash
# Build Oka'Py Editor - VS Code bundled with the Ren'Py extension
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# VS Code version to bundle
VSCODE_VERSION="${VSCODE_VERSION:-1.107.0}"

# Supported platforms (override with PLATFORMS env var)
PLATFORMS="${PLATFORMS:-linux-x64 win32-x64 darwin-x64 darwin-arm64}"

# Output directory
OUTPUT_DIR="$SCRIPT_DIR/dist-editor"
mkdir -p "$OUTPUT_DIR"

# Build the extension first
echo "Building VS Code extension..."
npm ci
npm run vsce:package
VSIX_PATH="$SCRIPT_DIR/language-renpy-okapy.vsix"

if [ ! -f "$VSIX_PATH" ]; then
    echo "Error: Failed to build extension"
    exit 1
fi

echo "Extension built: $VSIX_PATH"

# Download and package VS Code for each platform
for PLATFORM in $PLATFORMS; do
    echo ""
    echo "=== Building for $PLATFORM ==="

    ARCHIVE_EXT="tar.gz"

    case "$PLATFORM" in
        win32-x64)
            ARCHIVE_EXT="zip"
            VSCODE_DIR="VSCode-win32-x64"
            CODE_BIN="bin/code.cmd"
            ;;
        darwin-x64|darwin-arm64)
            VSCODE_DIR="Visual Studio Code.app"
            CODE_BIN="Contents/Resources/app/bin/code"
            ;;
        linux-x64)
            VSCODE_DIR="VSCode-linux-x64"
            CODE_BIN="bin/code"
            ;;
        *)
            echo "Unknown platform: $PLATFORM"
            continue
            ;;
    esac

    DOWNLOAD_URL="https://update.code.visualstudio.com/${VSCODE_VERSION}/${PLATFORM}/stable"
    ARCHIVE_FILE="vscode-${PLATFORM}.${ARCHIVE_EXT}"
    BUNDLE_DIR="$OUTPUT_DIR/okapy-editor-${PLATFORM}"

    # Download VS Code if not already cached
    if [ ! -f "$OUTPUT_DIR/$ARCHIVE_FILE" ]; then
        echo "Downloading VS Code ${VSCODE_VERSION} for ${PLATFORM}..."
        curl -L "$DOWNLOAD_URL" -o "$OUTPUT_DIR/$ARCHIVE_FILE"
    else
        echo "Using cached download: $ARCHIVE_FILE"
    fi

    # Clean and extract
    rm -rf "$BUNDLE_DIR"
    mkdir -p "$BUNDLE_DIR"

    echo "Extracting..."
    cd "$BUNDLE_DIR"

    if [ "$ARCHIVE_EXT" = "zip" ]; then
        unzip -q "$OUTPUT_DIR/$ARCHIVE_FILE"
    else
        tar -xzf "$OUTPUT_DIR/$ARCHIVE_FILE"
    fi

    # Handle macOS .app bundle differently
    if [[ "$PLATFORM" == darwin-* ]]; then
        # Create data directory for portable mode inside .app
        mkdir -p "$BUNDLE_DIR/$VSCODE_DIR/Contents/Resources/app/data/extensions"
        DATA_DIR="$BUNDLE_DIR/$VSCODE_DIR/Contents/Resources/app/data"
    else
        # Create data directory for portable mode (makes VS Code use local settings)
        mkdir -p "$BUNDLE_DIR/$VSCODE_DIR/data/extensions"
        DATA_DIR="$BUNDLE_DIR/$VSCODE_DIR/data"
    fi

    # Copy the extension
    cp "$VSIX_PATH" "$DATA_DIR/extensions/"

    # Install the extension
    echo "Installing extension..."
    "$BUNDLE_DIR/$VSCODE_DIR/$CODE_BIN" --install-extension "$DATA_DIR/extensions/language-renpy-okapy.vsix" --force 2>/dev/null || true

    # Clean up vsix from extensions folder (it's installed now)
    rm -f "$DATA_DIR/extensions/language-renpy-okapy.vsix"

    # Configure default settings for Ren'Py development
    mkdir -p "$DATA_DIR/user-data/User"
    cat > "$DATA_DIR/user-data/User/settings.json" << 'EOF'
{
    "renpy.excludeCompiledFilesFromWorkspace": true,
    "renpy.diagnostics.diagnosticMode": "openFilesOnly",
    "files.associations": {
        "*.rpy": "renpy",
        "*.rpym": "renpy"
    },
    "editor.tabSize": 4,
    "editor.insertSpaces": true,
    "editor.detectIndentation": false,
    "[renpy]": {
        "editor.tabSize": 4,
        "editor.insertSpaces": true
    }
}
EOF

    # Rename directory to Oka'Py Editor
    cd "$BUNDLE_DIR"
    if [[ "$PLATFORM" == darwin-* ]]; then
        mv "$VSCODE_DIR" "Oka'Py Editor.app"
    else
        mv "$VSCODE_DIR" "okapy-editor"
    fi

    cd "$SCRIPT_DIR"

    # Create distributable archive
    echo "Creating distribution archive..."
    cd "$OUTPUT_DIR"

    DIST_NAME="okapy-editor-${PLATFORM}"
    if [ "$ARCHIVE_EXT" = "zip" ]; then
        rm -f "${DIST_NAME}.zip"
        cd "$BUNDLE_DIR"
        zip -rq "../${DIST_NAME}.zip" .
    else
        rm -f "${DIST_NAME}.tar.gz"
        tar -czf "${DIST_NAME}.tar.gz" -C "$BUNDLE_DIR" .
    fi

    echo "Created: $OUTPUT_DIR/${DIST_NAME}.${ARCHIVE_EXT}"
    cd "$SCRIPT_DIR"
done

echo ""
echo "=== Build complete ==="
echo "Output directory: $OUTPUT_DIR"
ls -la "$OUTPUT_DIR"/*.tar.gz "$OUTPUT_DIR"/*.zip 2>/dev/null || true
