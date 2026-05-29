# Oka'Py Editor installer manifest
# Downloads VS Code from Microsoft and installs the Oka'Py extension

import renpy
from installer import _, remove, exists, move, processing, run, mkdir, unpack, error, info, download as installer_download, _path

EXTENSION_URL = "https://github.com/AkibaAT/vscode-language-renpy/releases/latest/download/language-renpy-okapy.vsix"
VSIX_FILE = "temp:language-renpy-okapy.vsix"

def download(url, filename):
    """Downloads url to filename with proper headers for VS Code."""
    import renpy
    import installer
    import requests
    import time
    from renpy.store import interface

    download_file = installer._friendly(filename)
    filename = installer._path(filename)
    progress_time = time.time()

    try:
        response = requests.get(url, stream=True, proxies=renpy.exports.proxies, timeout=60,
            headers={"Referer": "https://code.visualstudio.com/download",
                     "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 renpy/8"})
        response.raise_for_status()
        total_size = int(response.headers.get('content-length', 1))
        downloaded = 0

        with open(filename, "wb") as f:
            for chunk in response.iter_content(65536):
                f.write(chunk)
                downloaded += len(chunk)
                if time.time() - progress_time > 0.1:
                    progress_time = time.time()
                    if not installer.quiet:
                        interface.processing(installer._("Downloading [installer.download_file]..."), complete=downloaded, total=total_size)
    except Exception as e:
        installer.error(installer._("Could not download VS Code: {}".format(e)))

info(_("Visual Studio Code is licensed under {a=https://code.visualstudio.com/license}Microsoft Software License Terms{/a}.\n\nBy installing, you agree to these terms."))

if renpy.linux:
    renpy_arch = getattr(renpy, "arch", "x86_64")
    arch = {"armv7l": "arm", "aarch64": "arm64"}.get(renpy_arch, "x64")

    download("https://code.visualstudio.com/sha/download?build=stable&os=linux-{}".format(arch), "temp:vscode.tar.gz")

    remove("temp:vscode-data")
    if exists("vscode/VSCode-linux-{}/data".format(arch)):
        move("vscode/VSCode-linux-{}/data".format(arch), "temp:vscode-data")

    mkdir("vscode")
    remove("vscode/VSCode-linux-{}".format(arch))
    unpack("temp:vscode.tar.gz", "vscode")

    if exists("temp:vscode-data"):
        move("temp:vscode-data", "vscode/VSCode-linux-{}/data".format(arch))
    else:
        mkdir("vscode/VSCode-linux-{}/data".format(arch))

    processing(_("Downloading Oka'Py extension..."))
    installer_download(EXTENSION_URL, VSIX_FILE)

    processing(_("Installing Oka'Py extension..."))
    run("vscode/VSCode-linux-{}/code".format(arch), "vscode/VSCode-linux-{}/resources/app/out/cli.js".format(arch),
        "--ms-enable-electron-run-as-node", "--install-extension", _path(VSIX_FILE),
        environ={"VSCODE_DEV": "", "ELECTRON_RUN_AS_NODE": "1"})

elif renpy.windows:
    download("https://code.visualstudio.com/sha/download?build=stable&os=win32-x64-archive", "temp:vscode.zip")

    remove("temp:vscode-data")
    if exists("vscode/VSCode-win32-x64/data"):
        move("vscode/VSCode-win32-x64/data", "temp:vscode-data")

    mkdir("vscode/VSCode-win32-x64")
    remove("vscode/VSCode-win32-x64")
    unpack("temp:vscode.zip", "vscode/VSCode-win32-x64")

    if exists("temp:vscode-data"):
        move("temp:vscode-data", "vscode/VSCode-win32-x64/data")
    else:
        mkdir("vscode/VSCode-win32-x64/data")

    processing(_("Downloading Oka'Py extension..."))
    installer_download(EXTENSION_URL, VSIX_FILE)

    processing(_("Installing Oka'Py extension..."))
    run("vscode/VSCode-win32-x64/Code.exe", "vscode/VSCode-win32-x64/resources/app/out/cli.js",
        "--ms-enable-electron-run-as-node", "--install-extension", _path(VSIX_FILE),
        environ={"VSCODE_DEV": "", "ELECTRON_RUN_AS_NODE": "1"})

elif renpy.macintosh:
    download("https://code.visualstudio.com/sha/download?build=stable&os=darwin-universal", "temp:vscode.zip")

    mkdir("vscode")
    remove("vscode/Visual Studio Code.app")
    unpack("temp:vscode.zip", "vscode")
    mkdir("vscode/code-portable-data")

    processing(_("Downloading Oka'Py extension..."))
    installer_download(EXTENSION_URL, VSIX_FILE)

    processing(_("Installing Oka'Py extension..."))
    run("vscode/Visual Studio Code.app/Contents/MacOS/Electron", "vscode/Visual Studio Code.app/Contents/Resources/app/out/cli.js",
        "--ms-enable-electron-run-as-node", "--install-extension", _path(VSIX_FILE),
        environ={"VSCODE_DEV": "", "ELECTRON_RUN_AS_NODE": "1"})

else:
    error(_("Visual Studio Code is not supported on your platform."))
