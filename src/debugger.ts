import * as cp from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as vscode from "vscode";

import { Configuration } from "./configuration";
import { logMessage } from "./logger";
import { cleanUpPath, getWorkspaceFolder } from "./utilities";

interface RenpyLaunchConfig extends vscode.DebugConfiguration {
    command?: string;
    args?: string[];
    debugServer?: boolean;
    debugPort?: number;
    waitForClient?: boolean;
}

interface RenpyAttachConfig extends vscode.DebugConfiguration {
    host?: string;
    port?: number;
}

export class RenpyAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
    private childProcess: cp.ChildProcessWithoutNullStreams | null = null;

    async createDebugAdapterDescriptor(session: vscode.DebugSession): Promise<vscode.DebugAdapterDescriptor | undefined> {
        const config = session.configuration;

        logMessage(vscode.LogLevel.Info, `Debug session starting - request type: ${config.request}, config: ${JSON.stringify(config)}`);

        if (config.request === "attach") {
            const attachConfig = config as RenpyAttachConfig;
            const host = attachConfig.host || "localhost";
            const port = attachConfig.port || 5678;

            logMessage(vscode.LogLevel.Info, `Attaching to Ren'Py DAP server at ${host}:${port}`);
            return new vscode.DebugAdapterServer(port, host);
        } else if (config.request === "launch") {
            const launchConfig = config as RenpyLaunchConfig;
            const debugServer = launchConfig.debugServer !== false; // default true
            const debugPort = launchConfig.debugPort || 5678;
            const waitForClient = launchConfig.waitForClient || false;

            const childProcess = this.spawnRenpy(launchConfig, debugServer, debugPort, waitForClient);
            if (!childProcess) {
                const rpyPath = Configuration.getRenpyExecutablePath();
                if (!rpyPath) {
                    throw new Error(
                        "Ren'Py executable not configured. Go to Settings and set 'renpy.renpyExecutableLocation' to your Ren'Py executable path (e.g., /path/to/renpy.sh or renpy.exe)."
                    );
                } else {
                    throw new Error(`Ren'Py executable not found at: ${rpyPath}. Check that the path in 'renpy.renpyExecutableLocation' is correct.`);
                }
            }

            this.childProcess = childProcess;

            childProcess.on("error", (error) => {
                logMessage(vscode.LogLevel.Error, `Ren'Py spawn error: ${error}`);
            });

            childProcess.on("exit", (code) => {
                logMessage(vscode.LogLevel.Info, `Ren'Py exited with code ${code}`);
                this.childProcess = null;
            });

            childProcess.stdout.on("data", (data) => {
                const output = data.toString();
                logMessage(vscode.LogLevel.Info, `Ren'Py: ${output}`);
            });

            childProcess.stderr.on("data", (data) => {
                const output = data.toString();
                logMessage(vscode.LogLevel.Error, `Ren'Py stderr: ${output}`);
            });

            if (debugServer) {
                const connected = await this.waitForDapServer("localhost", debugPort, 30000);
                if (!connected) {
                    childProcess.kill();
                    throw new Error(
                        `Failed to connect to Ren'Py DAP server on port ${debugPort}. Make sure the Ren'Py debugger module is installed.`
                    );
                }

                logMessage(vscode.LogLevel.Info, `Connected to Ren'Py DAP server on port ${debugPort}`);
                return new vscode.DebugAdapterServer(debugPort, "localhost");
            } else {
                throw new Error("Debug server is disabled. Set debugServer: true in launch configuration to enable debugging.");
            }
        } else {
            throw new Error(`Unknown debug request type: ${config.request}. Use 'launch' or 'attach'.`);
        }
    }

    private spawnRenpy(
        config: RenpyLaunchConfig,
        debugServer: boolean,
        debugPort: number,
        waitForClient: boolean
    ): cp.ChildProcessWithoutNullStreams | null {
        const rpyPath = Configuration.getRenpyExecutablePath();

        if (!rpyPath) {
            logMessage(vscode.LogLevel.Error, "Ren'Py executable location not configured. Set renpy.renpyExecutableLocation in settings.");
            return null;
        }

        if (!fs.existsSync(rpyPath)) {
            logMessage(vscode.LogLevel.Error, `Ren'Py executable not found at: ${rpyPath}`);
            return null;
        }

        const renpyPath = cleanUpPath(vscode.Uri.file(rpyPath).path);
        const cwd = renpyPath.substring(0, renpyPath.lastIndexOf("/"));
        const workFolder = getWorkspaceFolder();

        const args: string[] = [workFolder];
        args.push(config.command || "run");

        if (debugServer) {
            args.push("--debug-server");
            args.push("--debug-port", debugPort.toString());
            if (waitForClient) {
                args.push("--debug-wait");
            }
        }

        if (config.args && config.args.length > 0) {
            args.push(...config.args);
        }

        logMessage(vscode.LogLevel.Info, `Spawning: ${rpyPath} ${args.join(" ")}`);

        return cp.spawn(rpyPath, args, {
            cwd: cwd,
            env: { ...process.env },
        });
    }

    private async waitForDapServer(host: string, port: number, timeoutMs: number): Promise<boolean> {
        const startTime = Date.now();
        const retryInterval = 500;

        while (Date.now() - startTime < timeoutMs) {
            try {
                const connected = await this.tryConnect(host, port);
                if (connected) {
                    return true;
                }
            } catch {
                // Will retry
            }
            await this.sleep(retryInterval);
        }

        return false;
    }

    private tryConnect(host: string, port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const socket = new net.Socket();

            socket.setTimeout(1000);

            socket.on("connect", () => {
                socket.destroy();
                resolve(true);
            });

            socket.on("error", () => {
                socket.destroy();
                resolve(false);
            });

            socket.on("timeout", () => {
                socket.destroy();
                resolve(false);
            });

            socket.connect(port, host);
        });
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    dispose(): void {
        if (this.childProcess) {
            this.childProcess.kill();
            this.childProcess = null;
        }
    }
}

export class RenpyConfigurationProvider implements vscode.DebugConfigurationProvider {
    resolveDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration
    ): vscode.ProviderResult<vscode.DebugConfiguration> {
        if (!config.type && !config.request && !config.name) {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.languageId === "renpy") {
                config.type = "renpy";
                config.request = "launch";
                config.name = "Ren'Py: Launch";
                config.debugServer = true;
                config.debugPort = 5678;
            }
        }

        if (config.request === "launch") {
            config.debugServer = config.debugServer !== false;
            config.debugPort = config.debugPort || 5678;
            config.command = config.command || "run";
        }

        if (config.request === "attach") {
            config.host = config.host || "localhost";
            config.port = config.port || 5678;
        }

        return config;
    }

    provideDebugConfigurations(folder: vscode.WorkspaceFolder | undefined): vscode.ProviderResult<vscode.DebugConfiguration[]> {
        return [
            {
                type: "renpy",
                request: "launch",
                name: "Ren'Py: Launch",
                command: "run",
                debugServer: true,
                debugPort: 5678,
            },
            {
                type: "renpy",
                request: "attach",
                name: "Ren'Py: Attach",
                host: "localhost",
                port: 5678,
            },
        ];
    }
}
