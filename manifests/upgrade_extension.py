# Oka'Py Extension upgrade manifest
# Uses VS Code CLI to install/upgrade the extension from GitHub

import renpy
from installer import _, processing, run, error, download, _path

EXTENSION_URL = "https://github.com/AkibaAT/vscode-language-renpy/releases/latest/download/language-renpy-okapy.vsix"
VSIX_FILE = "temp:language-renpy-okapy.vsix"

processing(_("Downloading Oka'Py extension..."))
download(EXTENSION_URL, VSIX_FILE)

processing(_("Installing Oka'Py extension..."))

if renpy.linux:
    renpy_arch = getattr(renpy, "arch", "x86_64")
    arch = {"armv7l": "arm", "aarch64": "arm64"}.get(renpy_arch, "x64")

    run("vscode/VSCode-linux-{}/code".format(arch), "vscode/VSCode-linux-{}/resources/app/out/cli.js".format(arch),
        "--ms-enable-electron-run-as-node", "--install-extension", _path(VSIX_FILE), "--force",
        environ={"VSCODE_DEV": "", "ELECTRON_RUN_AS_NODE": "1"})

elif renpy.windows:
    run("vscode/VSCode-win32-x64/Code.exe", "vscode/VSCode-win32-x64/resources/app/out/cli.js",
        "--ms-enable-electron-run-as-node", "--install-extension", _path(VSIX_FILE), "--force",
        environ={"VSCODE_DEV": "", "ELECTRON_RUN_AS_NODE": "1"})

elif renpy.macintosh:
    run("vscode/Visual Studio Code.app/Contents/MacOS/Electron", "vscode/Visual Studio Code.app/Contents/Resources/app/out/cli.js",
        "--ms-enable-electron-run-as-node", "--install-extension", _path(VSIX_FILE), "--force",
        environ={"VSCODE_DEV": "", "ELECTRON_RUN_AS_NODE": "1"})

else:
    error(_("Visual Studio Code is not supported on your platform."))

processing(_("Oka'Py extension has been upgraded successfully."))
