#!/bin/bash
# Build Oka'Py Editor - VS Code bundled with the Ren'Py extension
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# VS Code version to bundle
VSCODE_VERSION="${VSCODE_VERSION:-1.107.1}"

# Supported platforms (override with PLATFORMS env var)
# macOS uses universal binary that works on both Intel and Apple Silicon
PLATFORMS="${PLATFORMS:-linux-x64 win32-x64 darwin}"

# Output directory
OUTPUT_DIR="$SCRIPT_DIR/dist-editor"
CACHE_DIR="$OUTPUT_DIR/.cache"
mkdir -p "$OUTPUT_DIR" "$CACHE_DIR"

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

# Get extension info from package.json
PUBLISHER=$(node -p "require('./package.json').publisher")
EXT_NAME=$(node -p "require('./package.json').name")
EXT_VERSION=$(node -p "require('./package.json').version")
EXTENSION_DIR="${PUBLISHER}.${EXT_NAME}-${EXT_VERSION}"

echo "Extension: $EXTENSION_DIR"

# Download and package VS Code for each platform
for PLATFORM in $PLATFORMS; do
    echo ""
    echo "=== Building for $PLATFORM ==="

    case "$PLATFORM" in
        win32-x64)
            DOWNLOAD_EXT="zip"
            ARCHIVE_EXT="zip"
            VSCODE_DIR="VSCode-win32-x64"
            # Windows needs -archive suffix for zip download
            DOWNLOAD_PLATFORM="win32-x64-archive"
            ;;
        darwin)
            DOWNLOAD_EXT="zip"
            ARCHIVE_EXT="tar.gz"
            VSCODE_DIR="Visual Studio Code.app"
            # Universal binary works on both Intel and Apple Silicon
            DOWNLOAD_PLATFORM="darwin"
            ;;
        linux-x64)
            DOWNLOAD_EXT="tar.gz"
            ARCHIVE_EXT="tar.gz"
            VSCODE_DIR="VSCode-linux-x64"
            DOWNLOAD_PLATFORM="$PLATFORM"
            ;;
        linux-arm64)
            DOWNLOAD_EXT="tar.gz"
            ARCHIVE_EXT="tar.gz"
            VSCODE_DIR="VSCode-linux-arm64"
            DOWNLOAD_PLATFORM="$PLATFORM"
            ;;
        *)
            echo "Unknown platform: $PLATFORM"
            continue
            ;;
    esac

    DOWNLOAD_URL="https://update.code.visualstudio.com/${VSCODE_VERSION}/${DOWNLOAD_PLATFORM}/stable"
    DOWNLOAD_FILE="vscode-${DOWNLOAD_PLATFORM}.${DOWNLOAD_EXT}"
    BUNDLE_DIR="$OUTPUT_DIR/bundle-${PLATFORM}"

    # Download VS Code if not already cached
    if [ ! -f "$CACHE_DIR/$DOWNLOAD_FILE" ]; then
        echo "Downloading VS Code ${VSCODE_VERSION} for ${PLATFORM} (from ${DOWNLOAD_PLATFORM})..."
        curl -L "$DOWNLOAD_URL" -o "$CACHE_DIR/$DOWNLOAD_FILE"
    else
        echo "Using cached download: $DOWNLOAD_FILE"
    fi

    # Clean and extract
    rm -rf "$BUNDLE_DIR"
    mkdir -p "$BUNDLE_DIR"

    echo "Extracting..."
    if [[ "$PLATFORM" == "win32-x64" ]]; then
        # Windows archive extracts flat, but we need it in VSCode-win32-x64/ for launcher
        mkdir -p "$BUNDLE_DIR/$VSCODE_DIR"
        unzip -q "$CACHE_DIR/$DOWNLOAD_FILE" -d "$BUNDLE_DIR/$VSCODE_DIR"
        DATA_DIR="$BUNDLE_DIR/$VSCODE_DIR/data"
    elif [[ "$PLATFORM" == darwin* ]]; then
        # macOS archive contains "Visual Studio Code.app/" at root
        unzip -q "$CACHE_DIR/$DOWNLOAD_FILE" -d "$BUNDLE_DIR"
        DATA_DIR="$BUNDLE_DIR/$VSCODE_DIR/Contents/Resources/app/data"
    else
        # Linux archive contains "VSCode-linux-x64/" at root
        tar -xzf "$CACHE_DIR/$DOWNLOAD_FILE" -C "$BUNDLE_DIR"
        DATA_DIR="$BUNDLE_DIR/$VSCODE_DIR/data"
    fi

    # Create portable data directories
    mkdir -p "$DATA_DIR/extensions"
    mkdir -p "$DATA_DIR/user-data/User"

    # Install extension by extracting vsix directly (vsix is just a zip)
    # Extensions are stored as publisher.name-version/
    echo "Installing extension..."
    mkdir -p "$DATA_DIR/extensions/$EXTENSION_DIR"
    unzip -q "$VSIX_PATH" -d "$DATA_DIR/extensions/$EXTENSION_DIR"
    # Move contents from extension/ subfolder to root
    mv "$DATA_DIR/extensions/$EXTENSION_DIR/extension/"* "$DATA_DIR/extensions/$EXTENSION_DIR/"
    rm -rf "$DATA_DIR/extensions/$EXTENSION_DIR/extension"
    rm -f "$DATA_DIR/extensions/$EXTENSION_DIR/\\[Content_Types\\].xml" 2>/dev/null || true

    # Default settings for Ren'Py development
    cat > "$DATA_DIR/user-data/User/settings.json" << 'EOF'
{
    "renpy.excludeCompiledFilesFromWorkspace": true,
    "renpy.diagnostics.diagnosticMode": "openFilesOnly",
    "files.associations": {
        "*.rpy": "renpy",
        "*.rpym": "renpy"
    },
    "editor.tabSize": 4,
    "editor.insertSpaces": true
}
EOF

    # Create distributable archive
    echo "Creating distribution archive..."
    DIST_NAME="vscode-${PLATFORM}"
    cd "$BUNDLE_DIR"
    if [ "$ARCHIVE_EXT" = "zip" ]; then
        rm -f "$OUTPUT_DIR/${DIST_NAME}.zip"
        zip -rq "$OUTPUT_DIR/${DIST_NAME}.zip" .
    else
        rm -f "$OUTPUT_DIR/${DIST_NAME}.tar.gz"
        tar -czf "$OUTPUT_DIR/${DIST_NAME}.tar.gz" .
    fi
    cd "$SCRIPT_DIR"

    echo "Created: $OUTPUT_DIR/${DIST_NAME}.${ARCHIVE_EXT}"

    # Clean up bundle directory
    rm -rf "$BUNDLE_DIR"
done

# Copy extension VSIX to output
cp "$VSIX_PATH" "$OUTPUT_DIR/"

# Generate editor-info.json
TIMESTAMP=$(date +%s)
cat > "$OUTPUT_DIR/editor-info.json" << EOF
{
  "version": "$EXT_VERSION",
  "vscode_version": "$VSCODE_VERSION",
  "timestamp": $TIMESTAMP,
  "files": {
    "extension": "language-renpy-okapy.vsix",
    "linux-x64": "vscode-linux-x64.tar.gz",
    "win32-x64": "vscode-win32-x64.zip",
    "darwin": "vscode-darwin.tar.gz"
  }
}
EOF
echo "Created: $OUTPUT_DIR/editor-info.json"

# Generate vscode.py manifest (the launcher downloads and executes this)
cat > "$OUTPUT_DIR/vscode.py" << 'MANIFEST_EOF'
# Oka'Py Editor installer manifest
# This file is downloaded and executed by the Ren'Py launcher
import installer
import renpy

BASE_URL = "https://okapy.li/extensions/vscode"

# Determine platform and archive
if renpy.windows:
    archive = "vscode-win32-x64.zip"
elif renpy.macintosh:
    archive = "vscode-darwin.tar.gz"
else:
    archive = "vscode-linux-x64.tar.gz"

installer.info("Installing Oka'Py Editor (Visual Studio Code)...")

# Download and install VS Code bundle
installer.download(f"{BASE_URL}/{archive}", f"temp:{archive}")
installer.remove("vscode")
installer.unpack(f"temp:{archive}", "vscode")

installer.info("Oka'Py Editor has been installed successfully.")
MANIFEST_EOF
echo "Created: $OUTPUT_DIR/vscode.py"

# Generate upgrade_extension.py manifest (for upgrading just the extension)
cat > "$OUTPUT_DIR/upgrade_extension.py" << 'MANIFEST_EOF'
# Oka'Py Extension upgrade manifest
import installer
import renpy
import os
import glob

BASE_URL = "https://okapy.li/extensions/vscode"
VSIX_FILE = "language-renpy-okapy.vsix"

installer.info("Upgrading Oka'Py Ren'Py extension...")

# Download the extension
installer.download(f"{BASE_URL}/{VSIX_FILE}", f"temp:{VSIX_FILE}")

# Find VS Code data directory
if renpy.windows:
    vscode_dir = "vscode/VSCode-win32-x64"
    ext_dir = f"{vscode_dir}/data/extensions"
elif renpy.macintosh:
    vscode_dir = "vscode/Visual Studio Code.app"
    ext_dir = f"{vscode_dir}/Contents/Resources/app/data/extensions"
else:
    vscode_dir = "vscode/VSCode-linux-x64"
    ext_dir = f"{vscode_dir}/data/extensions"

# Remove old extension versions
for old_ext in glob.glob(installer._path(f"{ext_dir}/okapy.language-renpy-okapy-*")):
    installer.remove(old_ext.replace(installer._path(""), ""))

# Unpack new extension
installer.unpack(f"temp:{VSIX_FILE}", f"temp:extension")
# The vsix extracts with an extension/ subfolder, move contents up
installer.move("temp:extension/extension", f"{ext_dir}/okapy.language-renpy-okapy-new")

installer.info("Oka'Py extension has been upgraded successfully.")
MANIFEST_EOF
echo "Created: $OUTPUT_DIR/upgrade_extension.py"

# Sign manifests if private key is available
if [ -n "$OKAPY_PRIVATE_KEY" ]; then
    echo ""
    echo "=== Signing manifests ==="

    # Write private key to temp file
    PRIVATE_KEY_FILE=$(mktemp)
    echo "$OKAPY_PRIVATE_KEY" > "$PRIVATE_KEY_FILE"

    # Sign using Python with ecdsa
    python3 << SIGN_EOF
import ecdsa
import sys

def sign_file(filepath, key_file):
    with open(key_file, 'r') as f:
        key = ecdsa.SigningKey.from_pem(f.read())

    with open(filepath, 'rb') as f:
        data = f.read()

    signature = key.sign(data)

    with open(filepath + '.sig', 'wb') as f:
        f.write(signature)

    print(f"Signed: {filepath}.sig")

sign_file("$OUTPUT_DIR/vscode.py", "$PRIVATE_KEY_FILE")
sign_file("$OUTPUT_DIR/upgrade_extension.py", "$PRIVATE_KEY_FILE")
SIGN_EOF

    # Clean up
    rm -f "$PRIVATE_KEY_FILE"
else
    echo ""
    echo "Note: OKAPY_PRIVATE_KEY not set, manifests are unsigned."
    echo "Set OKAPY_PRIVATE_KEY environment variable to sign manifests."
fi

echo ""
echo "=== Build complete ==="
echo "Output directory: $OUTPUT_DIR"
ls -la "$OUTPUT_DIR"/*.tar.gz "$OUTPUT_DIR"/*.zip "$OUTPUT_DIR"/*.json "$OUTPUT_DIR"/*.py "$OUTPUT_DIR"/*.vsix 2>/dev/null || true
