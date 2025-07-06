import * as vscode from "vscode";
import * as net from "net";
import { DebugSession, TerminatedEvent, InitializedEvent, StoppedEvent, BreakpointEvent, OutputEvent } from "@vscode/debugadapter";
import { DebugProtocol } from "@vscode/debugprotocol";
import { getWorkspaceFolder } from "./workspace";
import { Configuration } from "./configuration";
import { logToast } from "./logger";
import { isValidExecutable } from "./extension";

function getTerminal(name: string): vscode.Terminal {
    let i: number;
    for (i = 0; i < vscode.window.terminals.length; i++) {
        if (vscode.window.terminals[i].name === name) {
            return vscode.window.terminals[i];
        }
    }
    return vscode.window.createTerminal(name);
}

export class RenpyAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
    createDebugAdapterDescriptor(session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        if (session.configuration.type === "renpy-dap") {
            // Use DAP debugging with breakpoint support
            return new vscode.DebugAdapterInlineImplementation(new RenpyDAPDebugSession());
        } else {
            // Use original terminal debugging
            return new vscode.DebugAdapterInlineImplementation(new RenpyDebugSession(session.configuration.command, session.configuration.args));
        }
    }
}

class RenpyDebugSession extends DebugSession {
    private command = "run";
    private args?: string[];

    public constructor(command: string, args?: string[]) {
        super();
        this.command = command;
        if (args) {
            this.args = args;
        }
    }

    protected override initializeRequest(): void {
        const terminal = getTerminal("Ren'py Debug");
        terminal.show();
        let program = Configuration.getRenpyExecutablePath();

        if (!isValidExecutable(program)) {
            logToast(vscode.LogLevel.Error, "Ren'Py executable location not configured or is invalid.");
            return;
        }

        program += " " + getWorkspaceFolder();
        if (this.command) {
            program += " " + this.command;
        }
        if (this.args) {
            program += " " + this.args.join(" ");
        }
        terminal.sendText(program);
        this.sendEvent(new TerminatedEvent());
    }
}

// New DAP-based debug session with breakpoint support
class RenpyDAPDebugSession extends DebugSession {
    private socket?: net.Socket;
    private isConnected = false;
    private sequenceNumber = 1;
    private pendingRequests = new Map<number, (response: any) => void>();
    private breakpoints = new Map<string, DebugProtocol.SourceBreakpoint[]>();
    private renpyProcess?: vscode.Terminal;
    private buffer = "";

    protected override initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
        // Set capabilities
        response.body = response.body || {};
        response.body.supportsBreakpointLocationsRequest = true;
        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsEvaluateForHovers = true;
        response.body.supportsStepBack = false;
        response.body.supportsDataBreakpoints = false;
        response.body.supportsCompletionsRequest = false;
        response.body.supportsCancelRequest = false;
        response.body.supportsBreakpointLocationsRequest = true;
        response.body.supportsStepInTargetsRequest = false;
        response.body.supportsGotoTargetsRequest = false;
        response.body.supportsModulesRequest = false;
        response.body.supportsRestartRequest = false;
        response.body.supportsExceptionOptions = false;
        response.body.supportsValueFormattingOptions = false;
        response.body.supportsExceptionInfoRequest = false;
        response.body.supportTerminateDebuggee = true;
        response.body.supportsDelayedStackTraceLoading = false;
        response.body.supportsLoadedSourcesRequest = false;
        response.body.supportsLogPoints = false;
        response.body.supportsTerminateThreadsRequest = false;
        response.body.supportsSetVariable = false;
        response.body.supportsRestartFrame = false;
        response.body.supportsSteppingGranularity = false;
        response.body.supportsInstructionBreakpoints = false;
        response.body.supportsReadMemoryRequest = false;
        response.body.supportsDisassembleRequest = false;

        this.sendResponse(response);
        this.sendEvent(new InitializedEvent());
    }

    protected override async launchRequest(response: DebugProtocol.LaunchResponse, args: any): Promise<void> {
        const port = args.port || 14711;
        const host = args.host || "localhost";

        try {
            // Start Ren'Py with DAP debugging
            await this.startRenpyWithDAP(port, args.args || []);

            // Connect to DAP server
            await this.connectToDAP(host, port);

            this.sendResponse(response);
        } catch (error) {
            response.success = false;
            response.message = `Failed to start debugging: ${error}`;
            this.sendResponse(response);
        }
    }

    protected override async attachRequest(response: DebugProtocol.AttachResponse, args: any): Promise<void> {
        const port = args.port || 14711;
        const host = args.host || "localhost";

        try {
            // Connect to existing DAP server
            await this.connectToDAP(host, port);
            this.sendResponse(response);
        } catch (error) {
            response.success = false;
            response.message = `Failed to attach to debugger: ${error}`;
            this.sendResponse(response);
        }
    }

    private async startRenpyWithDAP(port: number, args: string[]): Promise<void> {
        const program = Configuration.getRenpyExecutablePath();
        if (!isValidExecutable(program)) {
            throw new Error("Ren'Py executable location not configured or is invalid.");
        }

        const workspaceFolder = getWorkspaceFolder();
        this.renpyProcess = getTerminal("Ren'Py DAP Debug");
        this.renpyProcess.show();

        // Build command: renpy.sh <game> debug --dap --port <port>
        let command = `"${program}" "${workspaceFolder}" debug --dap --port ${port}`;
        if (args.length > 0) {
            command += " " + args.join(" ");
        }

        this.sendEvent(new OutputEvent(`Starting Ren'Py with DAP debugging: ${command}\n`, "console"));
        this.renpyProcess.sendText(command);

        // Wait a bit for Ren'Py to start
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    private async connectToDAP(host: string, port: number): Promise<void> {
        return new Promise((resolve, reject) => {
            this.socket = new net.Socket();

            this.socket.on('connect', () => {
                this.isConnected = true;
                this.sendEvent(new OutputEvent(`Connected to Ren'Py DAP server at ${host}:${port}\n`, "console"));

                // Send initialize request to DAP server
                this.sendDAPRequest("initialize", {
                    clientID: "vscode-renpy",
                    clientName: "VSCode Ren'Py Extension",
                    adapterID: "renpy",
                    pathFormat: "path",
                    linesStartAt1: true,
                    columnsStartAt1: true
                });

                resolve();
            });

            this.socket.on('error', (error) => {
                this.sendEvent(new OutputEvent(`DAP connection error: ${error.message}\n`, "stderr"));
                reject(error);
            });

            this.socket.on('data', (data) => {
                this.handleDAPMessage(data.toString());
            });

            this.socket.on('close', () => {
                this.isConnected = false;
                this.sendEvent(new OutputEvent("DAP connection closed\n", "console"));
                this.sendEvent(new TerminatedEvent());
            });

            // Connect with timeout
            const timeout = setTimeout(() => {
                reject(new Error(`Connection timeout to ${host}:${port}`));
            }, 10000);

            this.socket.connect(port, host, () => {
                clearTimeout(timeout);
            });
        });
    }

    private sendDAPRequest(command: string, args: any): void {
        if (!this.socket || !this.isConnected) {
            return;
        }

        const request = {
            seq: this.sequenceNumber++,
            type: "request",
            command: command,
            arguments: args
        };

        const jsonStr = JSON.stringify(request);
        const message = `Content-Length: ${jsonStr.length}\r\n\r\n${jsonStr}`;

        this.socket.write(message);
    }

    private handleDAPMessage(data: string): void {
        this.buffer += data;

        while (true) {
            // Look for Content-Length header
            const headerEnd = this.buffer.indexOf('\r\n\r\n');
            if (headerEnd === -1) {
                break; // Need more data
            }

            const header = this.buffer.substring(0, headerEnd);
            const contentLengthMatch = header.match(/Content-Length: (\d+)/);

            if (!contentLengthMatch) {
                this.buffer = this.buffer.substring(headerEnd + 4);
                continue;
            }

            const contentLength = parseInt(contentLengthMatch[1]);
            const messageStart = headerEnd + 4;

            if (this.buffer.length < messageStart + contentLength) {
                break; // Need more data
            }

            const jsonContent = this.buffer.substring(messageStart, messageStart + contentLength);
            this.buffer = this.buffer.substring(messageStart + contentLength);

            try {
                const message = JSON.parse(jsonContent);
                this.processDAPMessage(message);
            } catch (error) {
                this.sendEvent(new OutputEvent(`Failed to parse DAP message: ${error}\n`, "stderr"));
            }
        }
    }

    private processDAPMessage(message: any): void {
        if (message.type === "event") {
            this.handleDAPEvent(message);
        } else if (message.type === "response") {
            this.handleDAPResponse(message);
        }
    }

    private handleDAPEvent(event: any): void {
        switch (event.event) {
            case "stopped":
                this.sendEvent(new StoppedEvent(event.body.reason || "breakpoint", event.body.threadId || 0));
                break;
            case "breakpoint":
                this.sendEvent(new BreakpointEvent(event.body.reason || "changed", event.body.breakpoint));
                break;
            case "output":
                this.sendEvent(new OutputEvent(event.body.output, event.body.category || "console"));
                break;
        }
    }

    private handleDAPResponse(response: any): void {
        const callback = this.pendingRequests.get(response.request_seq);
        if (callback) {
            this.pendingRequests.delete(response.request_seq);
            callback(response);
        }
    }

    protected override setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
        const path = args.source.path;
        if (!path) {
            this.sendResponse(response);
            return;
        }

        this.breakpoints.set(path, args.breakpoints || []);

        // Send breakpoints to DAP server
        this.sendDAPRequest("setBreakpoints", {
            source: args.source,
            breakpoints: args.breakpoints
        });

        // For now, assume all breakpoints are verified
        response.body = {
            breakpoints: (args.breakpoints || []).map(bp => ({
                verified: true,
                line: bp.line
            }))
        };

        this.sendResponse(response);
    }

    protected override configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
        // Send configurationDone to DAP server
        this.sendDAPRequest("configurationDone", {});
        this.sendResponse(response);
    }

    protected override continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
        this.sendDAPRequest("continue", { threadId: args.threadId });
        this.sendResponse(response);
    }

    protected override nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
        this.sendDAPRequest("next", { threadId: args.threadId });
        this.sendResponse(response);
    }

    protected override stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
        this.sendDAPRequest("stepIn", { threadId: args.threadId });
        this.sendResponse(response);
    }

    protected override stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
        this.sendDAPRequest("stepOut", { threadId: args.threadId });
        this.sendResponse(response);
    }

    protected override pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
        this.sendDAPRequest("pause", { threadId: args.threadId });
        this.sendResponse(response);
    }

    protected override disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
        if (this.socket) {
            this.socket.destroy();
        }
        if (this.renpyProcess) {
            this.renpyProcess.dispose();
        }
        this.sendResponse(response);
    }
}

export class RenpyConfigurationProvider implements vscode.DebugConfigurationProvider {
    resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): vscode.ProviderResult<vscode.DebugConfiguration> {
        if (!config.type && !config.request && !config.name) {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.languageId === "renpy") {
                // Default to DAP debugging for better experience
                config.type = "renpy-dap";
                config.request = "launch";
                config.name = "Ren'Py: Debug with Breakpoints";
                config.port = 14711;
                config.host = "localhost";
            }
        }
        return config;
    }
}
