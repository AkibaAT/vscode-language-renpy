// Based on https://raw.githubusercontent.com/Microsoft/vscode/master/extensions/python/src/pythonMain.ts from Microsoft vscode
//
// Licensed under MIT License. See LICENSE in the project root for license information.

import * as cp from "child_process";
import * as fs from "fs";
import {
    CancellationToken,
    commands,
    debug,
    DebugConfiguration,
    DebugConfigurationProviderTriggerKind,
    DebugSession,
    Event as VSCodeEvent,
    EventEmitter,
    ExtensionContext,
    ExtensionMode,
    InlineValue,
    InlineValueContext,
    InlineValuesProvider,
    InlineValueVariableLookup,
    languages,
    LogLevel,
    Position,
    ProviderResult,
    Range,
    Selection,
    tasks,
    TextDocument,
    TextEditorRevealType,
    ThemeIcon,
    TreeDataProvider,
    TreeItem,
    TreeItemCollapsibleState,
    Uri,
    window,
    workspace,
} from "vscode";

import { cleanUpPath, getAudioFolder, getImagesFolder, getNavigationJsonFilepath, getWorkspaceFolder, stripWorkspaceFromFile } from "src/utilities";

import { registerDebugDecorator, unregisterDebugDecorator } from "./tokenizer/debug-decorator";
import { Tokenizer } from "./tokenizer/tokenizer";
import { registerColorProvider } from "./color";
import { registerCompletionProvider } from "./completion";
import { Configuration } from "./configuration";
import { RenpyAdapterDescriptorFactory, RenpyConfigurationProvider } from "./debugger";
import { registerDefinitionProvider } from "./definition";
import { diagnosticsInit } from "./diagnostics";
import { registerHoverProvider } from "./hover";
import { initializeLoggingSystems, logMessage, logToast, updateStatusBar } from "./logger";
import { getStatusBarText, NavigationData } from "./navigation-data";
import { registerSymbolProvider } from "./outline";
import { registerReferencesProvider } from "./references";
import { registerSemanticTokensProvider } from "./semantics";
import { registerSignatureProvider } from "./signature";
import { RenpyTaskProvider } from "./task-provider";

let extensionMode: ExtensionMode = null!;

export function isShippingBuild(): boolean {
    return extensionMode !== ExtensionMode.Development;
}

/**
 * Inline Values Provider for Ren'Py debugging.
 * Shows variable values inline in the editor while debugging.
 */
class RenpyInlineValuesProvider implements InlineValuesProvider {
    provideInlineValues(
        document: TextDocument,
        viewPort: Range,
        context: InlineValueContext,
        token: CancellationToken
    ): ProviderResult<InlineValue[]> {
        const inlineValues: InlineValue[] = [];

        // Only provide values when stopped at a breakpoint/step
        if (!context.stoppedLocation) {
            return inlineValues;
        }

        // Python keywords and builtins to skip
        const skipWords = new Set([
            "if",
            "else",
            "elif",
            "for",
            "while",
            "in",
            "not",
            "and",
            "or",
            "True",
            "False",
            "None",
            "return",
            "def",
            "class",
            "import",
            "from",
            "try",
            "except",
            "finally",
            "with",
            "as",
            "pass",
            "break",
            "continue",
            "lambda",
            "yield",
            "global",
            "nonlocal",
            "assert",
            "raise",
            "del",
            "print",
            "len",
            "str",
            "int",
            "float",
            "bool",
            "list",
            "dict",
            "set",
            "range",
            "enumerate",
            "zip",
            "map",
            "filter",
            "sorted",
            "reversed",
            "sum",
            "min",
            "max",
            "abs",
            "round",
            "type",
            "isinstance",
            "hasattr",
            "getattr",
            "setattr",
            "renpy",
            "store",
            "persistent",
            "config",
            "self",
            "cls",
            "super",
            "object",
            "staticmethod",
            "classmethod",
            "property",
            "append",
            "extend",
            "insert",
            "remove",
            "pop",
            "clear",
            "index",
            "count",
            "sort",
            "reverse",
            "copy",
            "update",
            "keys",
            "values",
            "items",
            "get",
            "format",
            "join",
            "split",
            "strip",
            "replace",
            "find",
            "startswith",
            "endswith",
            "lower",
            "upper",
            "title",
            "capitalize",
        ]);

        // First pass: find Python block boundaries in the document
        // We need to know which lines are inside python: or init python: blocks
        const pythonBlockLines = new Set<number>();
        let inPythonBlock = false;
        let pythonBlockIndent = 0;

        for (let lineNum = 0; lineNum <= Math.min(viewPort.end.line + 50, document.lineCount - 1); lineNum++) {
            const line = document.lineAt(lineNum);
            const lineText = line.text;
            const trimmed = lineText.trim();

            // Check for python block start
            if (trimmed.match(/^(init\s+)?python(\s+\w+)?:/)) {
                inPythonBlock = true;
                // Get the indentation of the python: line
                pythonBlockIndent = lineText.length - lineText.trimStart().length;
                continue;
            }

            if (inPythonBlock) {
                // Empty lines or comments continue the block
                if (trimmed === "" || trimmed.startsWith("#")) {
                    pythonBlockLines.add(lineNum);
                    continue;
                }

                // Check indentation - if dedented to or before the python: line, block ends
                const currentIndent = lineText.length - lineText.trimStart().length;
                if (currentIndent > pythonBlockIndent) {
                    pythonBlockLines.add(lineNum);
                } else {
                    inPythonBlock = false;
                }
            }
        }

        // Scan visible lines
        for (let lineNum = viewPort.start.line; lineNum <= Math.min(viewPort.end.line, document.lineCount - 1); lineNum++) {
            if (token.isCancellationRequested) {
                break;
            }

            const line = document.lineAt(lineNum);
            const lineText = line.text;
            const trimmed = lineText.trim();

            // Skip comments and empty lines
            if (trimmed.startsWith("#") || trimmed === "") {
                continue;
            }

            // Track which variables we've already added for this line
            const addedVars = new Set<string>();

            // Check if this is a Python line:
            // 1. Starts with $ (single-line Python)
            // 2. Is a python: or init python: declaration
            // 3. Is inside a Python block
            const isPythonLine = trimmed.startsWith("$") || trimmed.match(/^(init\s+)?python(\s+\w+)?:/) || pythonBlockLines.has(lineNum);

            if (isPythonLine) {
                // Extract variable names from Python code
                const varPattern = /\b([a-z_][a-z0-9_]*)\b/gi;
                let match;

                while ((match = varPattern.exec(lineText)) !== null) {
                    const varName = match[1];

                    if (skipWords.has(varName) || addedVars.has(varName)) {
                        continue;
                    }

                    addedVars.add(varName);

                    // Create inline value lookup
                    const varRange = new Range(lineNum, match.index, lineNum, match.index + varName.length);
                    inlineValues.push(new InlineValueVariableLookup(varRange, varName));
                }
            }

            // Check for default/define statements
            const defaultMatch = lineText.match(/(?:default|define)\s+(\w+)\s*=/);
            if (defaultMatch && !addedVars.has(defaultMatch[1])) {
                const varName = defaultMatch[1];
                const startIndex = lineText.indexOf(varName);
                const varRange = new Range(lineNum, startIndex, lineNum, startIndex + varName.length);
                inlineValues.push(new InlineValueVariableLookup(varRange, varName));
                addedVars.add(varName);
            }

            // Check for interpolated variables [var] or {var}
            const interpolationPattern = /[[{](\w+)[}]/g;
            let interpMatch;
            while ((interpMatch = interpolationPattern.exec(lineText)) !== null) {
                const varName = interpMatch[1];
                if (!addedVars.has(varName)) {
                    const varRange = new Range(lineNum, interpMatch.index + 1, lineNum, interpMatch.index + 1 + varName.length);
                    inlineValues.push(new InlineValueVariableLookup(varRange, varName));
                    addedVars.add(varName);
                }
            }
        }

        return inlineValues;
    }
}

/**
 * Tree item representing an element in the Scene Inspector.
 */
class SceneInspectorItem extends TreeItem {
    public readonly itemType: "category" | "image" | "audio" | "location";
    public readonly detail: string | undefined;
    public readonly children: SceneInspectorItem[] | undefined;
    public readonly filePath: string | undefined;
    public readonly definitionLocation: SourceLocation | undefined;
    public readonly showStatementLocation: SourceLocation | undefined;

    constructor(
        label: string,
        collapsibleState: TreeItemCollapsibleState,
        itemType: "category" | "image" | "audio" | "location",
        detail?: string,
        children?: SceneInspectorItem[],
        filePath?: string,
        definitionLocation?: SourceLocation,
        showStatementLocation?: SourceLocation
    ) {
        super(label, collapsibleState);
        this.itemType = itemType;
        this.detail = detail ?? undefined;
        this.children = children ?? undefined;
        this.filePath = filePath ?? undefined;
        this.definitionLocation = definitionLocation ?? undefined;
        this.showStatementLocation = showStatementLocation ?? undefined;

        // Set icons based on type
        switch (itemType) {
            case "category":
                this.iconPath = new ThemeIcon("folder");
                break;
            case "image": {
                this.iconPath = new ThemeIcon("file-media");
                if (detail) this.description = detail;

                // Build contextValue for context menu visibility
                const contextParts: string[] = ["image"];
                if (definitionLocation) contextParts.push("hasDefinition");
                if (showStatementLocation) contextParts.push("hasShowStatement");
                if (filePath) contextParts.push("hasResource");
                this.contextValue = contextParts.join(",");

                // Default click action: definition > show statement > resource
                if (definitionLocation) {
                    this.command = {
                        command: "renpy.sceneInspector.goToDefinition",
                        title: "Go to Definition",
                        arguments: [definitionLocation.file, definitionLocation.line],
                    };
                } else if (showStatementLocation) {
                    this.command = {
                        command: "renpy.sceneInspector.goToShowStatement",
                        title: "Go to Show Statement",
                        arguments: [showStatementLocation.file, showStatementLocation.line],
                    };
                } else if (filePath) {
                    this.command = {
                        command: "renpy.sceneInspector.openFile",
                        title: "Open Resource File",
                        arguments: [filePath],
                    };
                }

                // Build informative tooltip
                this.tooltip = this.buildTooltip();
                break;
            }
            case "audio":
                this.iconPath = new ThemeIcon("unmute");
                if (detail) this.description = detail;
                break;
            case "location":
                this.iconPath = new ThemeIcon("location");
                if (detail) this.description = detail;
                break;
        }
    }

    private buildTooltip(): string {
        const lines: string[] = [];
        if (this.definitionLocation) {
            lines.push(`Definition: ${this.definitionLocation.file}:${this.definitionLocation.line}`);
        }
        if (this.showStatementLocation) {
            lines.push(`Show: ${this.showStatementLocation.file}:${this.showStatementLocation.line}`);
        }
        if (this.filePath) {
            lines.push(`Resource: ${this.filePath}`);
        }
        if (lines.length > 0) {
            lines.push("", "Right-click for options");
        }
        return lines.join("\n") || this.label?.toString() || "";
    }
}

/**
 * Source location for definitions.
 */
interface SourceLocation {
    file: string;
    line: number;
    type?: string;
}

/**
 * Component of a layered image.
 */
interface LayeredImageComponent {
    name: string;
    type?: string;
    file?: string;
    group?: string;
    attribute?: string;
    definition?: SourceLocation;
}

/**
 * Scene state data from the debugger.
 */
interface SceneState {
    images: Array<{
        tag: string;
        layer: string;
        attributes: string[];
        position?: { xpos?: number; ypos?: number };
        file?: string;
        is_layered?: boolean;
        components?: LayeredImageComponent[];
        definition?: SourceLocation;
        show_statement?: SourceLocation;
        statement_type?: string; // 'show' or 'scene'
    }>;
    screens: Array<{
        name: string;
        type: string;
        layer?: string;
        definition?: SourceLocation;
        show_statement?: SourceLocation;
    }>;
    audio: { [channel: string]: string };
    current_label: string | null;
    current_line: number;
}

/**
 * TreeView data provider for the Scene Inspector panel.
 * Shows current scene state during debugging.
 */
class SceneInspectorProvider implements TreeDataProvider<SceneInspectorItem> {
    private _onDidChangeTreeData: EventEmitter<SceneInspectorItem | undefined | null | void> = new EventEmitter<
        SceneInspectorItem | undefined | null | void
    >();
    readonly onDidChangeTreeData: VSCodeEvent<SceneInspectorItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private sceneState: SceneState | null = null;
    private activeSession: DebugSession | null = null;
    private refreshInterval: NodeJS.Timeout | null = null;

    constructor() {
        // Listen for debug session changes
        debug.onDidStartDebugSession((session) => {
            if (session.type === "renpy") {
                this.activeSession = session;
                this.startAutoRefresh();
            }
        });

        debug.onDidTerminateDebugSession((session) => {
            if (session === this.activeSession) {
                this.activeSession = null;
                this.sceneState = null;
                this.stopAutoRefresh();
                this._onDidChangeTreeData.fire();
            }
        });

        // Refresh when debug session stops (at breakpoint)
        debug.onDidChangeActiveDebugSession((session) => {
            if (session?.type === "renpy") {
                this.activeSession = session;
                this.refresh();
            }
        });
    }

    private startAutoRefresh(): void {
        // Refresh scene state every 500ms while debugging
        this.refreshInterval = setInterval(() => {
            if (this.activeSession) {
                this.refresh();
            }
        }, 500);
    }

    private stopAutoRefresh(): void {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
    }

    async refresh(): Promise<void> {
        if (!this.activeSession) {
            this.sceneState = null;
            this._onDidChangeTreeData.fire();
            return;
        }

        try {
            const state = await this.activeSession.customRequest("getSceneState");
            this.sceneState = state as SceneState;
            this._onDidChangeTreeData.fire();
        } catch {
            // Silently ignore errors (e.g., if game isn't ready)
        }
    }

    getTreeItem(element: SceneInspectorItem): TreeItem {
        return element;
    }

    getChildren(element?: SceneInspectorItem): ProviderResult<SceneInspectorItem[]> {
        if (!this.sceneState) {
            if (!this.activeSession) {
                return [new SceneInspectorItem("No active debug session", TreeItemCollapsibleState.None, "category")];
            }
            return [new SceneInspectorItem("Loading...", TreeItemCollapsibleState.None, "category")];
        }

        if (!element) {
            // Root level - return categories
            const items: SceneInspectorItem[] = [];

            // Current location
            if (this.sceneState.current_label) {
                items.push(
                    new SceneInspectorItem(
                        `📍 ${this.sceneState.current_label}`,
                        TreeItemCollapsibleState.None,
                        "location",
                        `Line ${this.sceneState.current_line}`
                    )
                );
            }

            // Images category
            const imageCount = this.sceneState.images.length;
            if (imageCount > 0) {
                items.push(
                    new SceneInspectorItem(`Images (${imageCount})`, TreeItemCollapsibleState.Expanded, "category", undefined, this.getImageItems())
                );
            } else {
                items.push(new SceneInspectorItem("Images (0)", TreeItemCollapsibleState.None, "category"));
            }

            // Screens category
            const screenCount = this.sceneState.screens?.length || 0;
            if (screenCount > 0) {
                items.push(
                    new SceneInspectorItem(
                        `Screens (${screenCount})`,
                        TreeItemCollapsibleState.Expanded,
                        "category",
                        undefined,
                        this.getScreenItems()
                    )
                );
            } else {
                items.push(new SceneInspectorItem("Screens (0)", TreeItemCollapsibleState.None, "category"));
            }

            // Audio category
            const audioChannels = Object.keys(this.sceneState.audio).filter((ch) => this.sceneState!.audio[ch]);
            if (audioChannels.length > 0) {
                items.push(
                    new SceneInspectorItem(
                        `Audio (${audioChannels.length})`,
                        TreeItemCollapsibleState.Expanded,
                        "category",
                        undefined,
                        this.getAudioItems()
                    )
                );
            } else {
                items.push(new SceneInspectorItem("Audio (0)", TreeItemCollapsibleState.None, "category"));
            }

            return items;
        }

        // Return children of the element
        return element.children || [];
    }

    private getImageItems(): SceneInspectorItem[] {
        if (!this.sceneState) return [];

        // Group images by layer
        const byLayer = new Map<string, typeof this.sceneState.images>();
        for (const img of this.sceneState.images) {
            const layer = img.layer || "master";
            if (!byLayer.has(layer)) {
                byLayer.set(layer, []);
            }
            byLayer.get(layer)!.push(img);
        }

        const items: SceneInspectorItem[] = [];

        // Helper to create image item (regular or layered)
        const createImageItem = (img: (typeof this.sceneState.images)[0]): SceneInspectorItem => {
            const name = img.attributes.length > 0 ? `${img.tag} ${img.attributes.join(" ")}` : img.tag;
            const pos = img.position ? `(${img.position.xpos?.toFixed(2) ?? "?"}, ${img.position.ypos?.toFixed(2) ?? "?"})` : "";

            // Build description with type info
            const statementType = img.statement_type ? (img.statement_type === "scene" ? "Scene" : "Image") : "";
            const buildDescription = (extra?: string): string => {
                const parts: string[] = [];
                if (statementType) parts.push(statementType);
                if (extra) parts.push(extra);
                return parts.join(" · ");
            };

            if (img.is_layered && img.components && img.components.length > 0) {
                // Layered image - create expandable item with component children
                const componentChildren: SceneInspectorItem[] = img.components.map((comp) => {
                    const compLabel = comp.group ? `${comp.group}: ${comp.attribute || comp.name}` : comp.name;
                    const compDetail = comp.type || "";
                    return new SceneInspectorItem(
                        compLabel,
                        TreeItemCollapsibleState.None,
                        "image",
                        compDetail,
                        undefined,
                        comp.file,
                        comp.definition, // Pass definition location for jump-to-source
                        undefined // No show statement for components
                    );
                });

                // Layered image parent - clicking goes to definition, right-click for show statement
                return new SceneInspectorItem(
                    `🎭 ${name}`,
                    TreeItemCollapsibleState.Expanded,
                    "image",
                    buildDescription(pos || `${img.components.length} layers`),
                    componentChildren,
                    undefined, // No single file for layered images
                    img.definition, // Definition location
                    img.show_statement // Show statement location
                );
            } else {
                // Regular image - pass all locations for context menu
                return new SceneInspectorItem(
                    name,
                    TreeItemCollapsibleState.None,
                    "image",
                    buildDescription(pos),
                    undefined,
                    img.file, // Resource file
                    img.definition, // Definition location (if any)
                    img.show_statement // Show statement location
                );
            }
        };

        // Create items for each layer
        for (const [layer, images] of byLayer) {
            if (images.length === 1 && byLayer.size === 1) {
                // Single image on single layer - show directly
                items.push(createImageItem(images[0]));
            } else {
                // Multiple images or multiple layers - show layer as category
                const layerChildren: SceneInspectorItem[] = images.map(createImageItem);
                items.push(new SceneInspectorItem(`[${layer}]`, TreeItemCollapsibleState.Expanded, "category", undefined, layerChildren));
            }
        }

        return items;
    }

    private getScreenItems(): SceneInspectorItem[] {
        if (!this.sceneState || !this.sceneState.screens) return [];

        const items: SceneInspectorItem[] = [];
        for (const screen of this.sceneState.screens) {
            // Display as "📺 screen_name" with type as description
            const label = `📺 ${screen.name}`;
            const detail = screen.type || "screen";

            items.push(
                new SceneInspectorItem(
                    label,
                    TreeItemCollapsibleState.None,
                    "image", // Use "image" type for consistent context menu handling
                    detail,
                    undefined,
                    undefined, // No resource file for screens
                    screen.definition,
                    screen.show_statement
                )
            );
        }
        return items;
    }

    private getAudioItems(): SceneInspectorItem[] {
        if (!this.sceneState) return [];

        const items: SceneInspectorItem[] = [];
        for (const [channel, file] of Object.entries(this.sceneState.audio)) {
            if (file) {
                items.push(new SceneInspectorItem(channel, TreeItemCollapsibleState.None, "audio", file));
            }
        }
        return items;
    }
}

export async function activate(context: ExtensionContext): Promise<void> {
    extensionMode = context.extensionMode;
    initializeLoggingSystems(context);
    updateStatusBar("$(sync~spin) Loading Ren'Py extension...");

    Configuration.initialize(context);

    // Subscribe to supported language features
    context.subscriptions.push(registerHoverProvider());
    context.subscriptions.push(registerDefinitionProvider());
    context.subscriptions.push(registerSymbolProvider());
    context.subscriptions.push(registerSignatureProvider());
    context.subscriptions.push(registerCompletionProvider());
    context.subscriptions.push(registerColorProvider());
    context.subscriptions.push(registerReferencesProvider());
    context.subscriptions.push(registerSemanticTokensProvider());

    // Register inline values provider for debugging
    context.subscriptions.push(languages.registerInlineValuesProvider("renpy", new RenpyInlineValuesProvider()));

    // Register Scene Inspector TreeView
    const sceneInspectorProvider = new SceneInspectorProvider();
    context.subscriptions.push(
        window.createTreeView("renpySceneInspector", {
            treeDataProvider: sceneInspectorProvider,
            showCollapseAll: true,
        })
    );

    // Register refresh command for Scene Inspector
    context.subscriptions.push(
        commands.registerCommand("renpy.sceneInspector.refresh", () => {
            sceneInspectorProvider.refresh();
        })
    );

    // Register command to open resource file from Scene Inspector
    // Can be invoked from click (filePath) or context menu (treeItem)
    context.subscriptions.push(
        commands.registerCommand("renpy.sceneInspector.openFile", async (arg1: string | SceneInspectorItem) => {
            let filePath: string | undefined;

            // Check if called from context menu (object with filePath property)
            if (arg1 && typeof arg1 === "object" && "filePath" in arg1) {
                filePath = (arg1 as SceneInspectorItem).filePath;
            } else if (typeof arg1 === "string") {
                // Called from click command
                filePath = arg1;
            }

            if (!filePath) {
                return;
            }
            try {
                const uri = Uri.file(filePath);
                // Check if it's an image file - open in preview, otherwise in editor
                const ext = filePath.toLowerCase().split(".").pop();
                if (ext && ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext)) {
                    // Open image in VS Code's built-in image preview
                    await commands.executeCommand("vscode.open", uri);
                } else {
                    // Open in text editor
                    const doc = await workspace.openTextDocument(uri);
                    await window.showTextDocument(doc);
                }
            } catch (error) {
                window.showErrorMessage(`Failed to open file: ${filePath}`);
            }
        })
    );

    // Helper function to navigate to a file and line
    const navigateToLocation = async (filePath: string, lineNumber: number, description: string) => {
        if (!filePath) {
            return;
        }
        try {
            const uri = Uri.file(filePath);
            const doc = await workspace.openTextDocument(uri);
            const editor = await window.showTextDocument(doc);
            // Go to the specific line (line numbers are 1-based from the server)
            const line = Math.max(0, lineNumber - 1);
            const position = new Position(line, 0);
            editor.selection = new Selection(position, position);
            editor.revealRange(new Range(position, position), TextEditorRevealType.InCenter);
        } catch (error) {
            window.showErrorMessage(`Failed to open ${description}: ${filePath}:${lineNumber}`);
        }
    };

    // Register command to go to definition
    // Can be invoked from click (filePath, lineNumber) or context menu (treeItem)
    context.subscriptions.push(
        commands.registerCommand("renpy.sceneInspector.goToDefinition", async (arg1: string | SceneInspectorItem, lineNumber?: number) => {
            // Check if called from context menu (object with definitionLocation property)
            if (arg1 && typeof arg1 === "object" && "definitionLocation" in arg1) {
                const item = arg1 as SceneInspectorItem;
                if (item.definitionLocation) {
                    await navigateToLocation(item.definitionLocation.file, item.definitionLocation.line, "definition");
                }
            } else if (typeof arg1 === "string" && lineNumber !== undefined) {
                // Called from click command
                await navigateToLocation(arg1, lineNumber, "definition");
            }
        })
    );

    // Register command to go to show statement
    context.subscriptions.push(
        commands.registerCommand("renpy.sceneInspector.goToShowStatement", async (arg1: string | SceneInspectorItem, lineNumber?: number) => {
            // Check if called from context menu (object with showStatementLocation property)
            if (arg1 && typeof arg1 === "object" && "showStatementLocation" in arg1) {
                const item = arg1 as SceneInspectorItem;
                if (item.showStatementLocation) {
                    await navigateToLocation(item.showStatementLocation.file, item.showStatementLocation.line, "show statement");
                }
            } else if (typeof arg1 === "string" && lineNumber !== undefined) {
                // Called from click command
                await navigateToLocation(arg1, lineNumber, "show statement");
            }
        })
    );

    // diagnostics (errors and warnings)
    const diagnostics = languages.createDiagnosticCollection("renpy");
    context.subscriptions.push(diagnostics);

    // A TextDocument was saved
    context.subscriptions.push(
        workspace.onDidSaveTextDocument((document) => {
            if (document.languageId !== "renpy") {
                return;
            }

            if (Configuration.isAutoSaveDisabled()) {
                // only trigger document refreshes if file autoSave is off
                return;
            }

            if (Configuration.compileOnDocumentSave()) {
                if (!NavigationData.isCompiling) {
                    ExecuteRenpyCompile();
                }
            }

            if (!NavigationData.isImporting) {
                updateStatusBar("$(sync~spin) Initializing Ren'Py static data...");
                try {
                    const uri = Uri.file(document.fileName);
                    const filename = stripWorkspaceFromFile(uri.path);
                    NavigationData.clearScannedDataForFile(filename);
                    NavigationData.scanDocumentForClasses(filename, document);
                    updateStatusBar(getStatusBarText());
                } catch (error) {
                    updateStatusBar("Failed to load Ren'Py static data...");
                    logMessage(LogLevel.Error, error as string);
                }
            }
        })
    );

    // diagnostics (errors and warnings)
    diagnosticsInit(context);

    // custom command - refresh data
    const refreshCommand = commands.registerCommand("renpy.refreshNavigationData", async () => {
        updateStatusBar("$(sync~spin) Refreshing Ren'Py navigation data...");
        try {
            await NavigationData.refresh(true);
        } catch (error) {
            logMessage(LogLevel.Error, error as string);
        } finally {
            updateStatusBar(getStatusBarText());
        }
    });
    context.subscriptions.push(refreshCommand);

    // custom command - jump to location
    const gotoFileLocationCommand = commands.registerCommand("renpy.jumpToFileLocation", (args) => {
        const uri = Uri.file(cleanUpPath(args.uri.path));
        const range = new Range(args.range[0].line, args.range[0].character, args.range[0].line, args.range[0].character);
        try {
            window.showTextDocument(uri, { selection: range });
        } catch (error) {
            logToast(LogLevel.Warning, `Could not jump to the location (error: ${error})`);
        }
    });
    context.subscriptions.push(gotoFileLocationCommand);

    const migrateOldFilesCommand = commands.registerCommand("renpy.migrateOldFiles", async () => {
        if (workspace != null) {
            const altURIs = await workspace.findFiles("**/*.rpyc", null, 50);
            altURIs.forEach(async (uri) => {
                const sourceFile = Uri.parse(uri.toString().replace(".rpyc", ".rpy"));
                try {
                    await workspace.fs.stat(sourceFile);
                } catch (error) {
                    const endOfPath = uri.toString().replace("game", "old-game").lastIndexOf("/");
                    const properLocation = Uri.parse(uri.toString().replace("game", "old-game"));
                    const oldDataDirectory = Uri.parse(properLocation.toString().substring(0, endOfPath));
                    workspace.fs.createDirectory(oldDataDirectory);
                    workspace.fs
                        .readFile(uri)
                        .then((data) => workspace.fs.writeFile(properLocation, data))
                        .then(() => workspace.fs.delete(uri));
                }
            });
        }
    });
    context.subscriptions.push(migrateOldFilesCommand);

    // custom command - toggle token debug view
    let isShowingTokenDebugView = false;
    const toggleTokenDebugViewCommand = commands.registerCommand("renpy.toggleTokenDebugView", async () => {
        if (!isShowingTokenDebugView) {
            logToast(LogLevel.Info, "Enabled token debug view");
            Tokenizer.clearTokenCache();
            await registerDebugDecorator(context);
        } else {
            logToast(LogLevel.Info, "Disabled token debug view");
            unregisterDebugDecorator();
        }
        isShowingTokenDebugView = !isShowingTokenDebugView;
    });
    context.subscriptions.push(toggleTokenDebugViewCommand);

    // custom command - call renpy to run workspace
    const runCommand = commands.registerCommand("renpy.runCommand", () => {
        //EsLint recommends config be removed as it has already been declared in a previous scope
        const rpyPath = Configuration.getRenpyExecutablePath();

        if (!isValidExecutable(rpyPath)) {
            logToast(LogLevel.Error, "Ren'Py executable location not configured or is invalid.");
            return;
        }

        //call renpy
        const result = RunWorkspaceFolder();
        if (result) {
            logMessage(LogLevel.Info, "Ren'Py is running successfully");
        } else {
            logToast(LogLevel.Error, "Ren'Py failed to run.");
        }
    });
    context.subscriptions.push(runCommand);

    // custom command - call renpy to compile
    const compileCommand = commands.registerCommand("renpy.compileNavigationData", () => {
        // check Settings has the path to Ren'Py executable
        // Call Ren'Py with the workspace folder and the json-dump argument
        const config = workspace.getConfiguration("renpy");
        if (!config) {
            logToast(LogLevel.Error, "Ren'Py executable location not configured or is invalid.");
        } else {
            if (isValidExecutable(config.renpyExecutableLocation)) {
                // call renpy
                const result = ExecuteRenpyCompile();
                if (result) {
                    logToast(LogLevel.Info, "Ren'Py compilation has completed.");
                }
            } else {
                logToast(LogLevel.Error, "Ren'Py executable location not configured or is invalid.");
            }
        }
    });
    context.subscriptions.push(compileCommand);

    // Debug command - Run to Line
    const runToLineCommand = commands.registerCommand("renpy.debug.runToLine", async () => {
        const session = debug.activeDebugSession;
        if (!session || session.type !== "renpy") {
            logToast(LogLevel.Warning, "No active Ren'Py debug session.");
            return;
        }

        const editor = window.activeTextEditor;
        if (!editor) {
            return;
        }

        const line = editor.selection.active.line + 1; // VSCode is 0-indexed, DAP is 1-indexed
        const path = editor.document.uri.fsPath;

        try {
            await session.customRequest("runToLine", {
                source: { path },
                line,
            });
        } catch (error) {
            logToast(LogLevel.Error, `Run to line failed: ${error}`);
        }
    });
    context.subscriptions.push(runToLineCommand);

    // Debug command - Jump to Label
    const jumpToLabelCommand = commands.registerCommand("renpy.debug.jumpToLabel", async () => {
        const session = debug.activeDebugSession;
        if (!session || session.type !== "renpy") {
            logToast(LogLevel.Warning, "No active Ren'Py debug session.");
            return;
        }

        const editor = window.activeTextEditor;
        if (!editor) {
            return;
        }

        const line = editor.selection.active.line + 1;
        const path = editor.document.uri.fsPath;

        try {
            // Check if cursor is on a label definition line
            const currentLineText = editor.document.lineAt(editor.selection.active.line).text;
            console.log(`[Renpy Debug] jumpToLabel: Current line: "${currentLineText}"`);

            // Match various label formats:
            // - label name:
            // - label name(params):
            // - label .local_name:
            // - label chapter1.scene1:
            const labelMatch = currentLineText.match(/^\s*label\s+(\.?[\w.]+)/);
            console.log(`[Renpy Debug] jumpToLabel: Label match result: ${JSON.stringify(labelMatch)}`);

            if (labelMatch) {
                // Direct jump to the label on this line
                const labelName = labelMatch[1];
                console.log(`[Renpy Debug] jumpToLabel: Jumping directly to label: "${labelName}"`);
                await session.customRequest("jumpToLabel", {
                    label: labelName,
                });
                return;
            }
            console.log("[Renpy Debug] jumpToLabel: Not on a label line, showing picker");

            // Not on a label line - show picker with all labels
            const response = await session.customRequest("gotoTargets", {
                source: { path },
                line,
            });

            const targets = response.targets || [];
            if (targets.length === 0) {
                logToast(LogLevel.Warning, "No labels found.");
                return;
            }

            // Let user pick a label
            {
                interface LabelItem {
                    label: string;
                    description: string;
                    targetId: number;
                }

                const items: LabelItem[] = targets.map((t: { label: string; line: number; id: number }) => ({
                    label: t.label,
                    description: `Line ${t.line}`,
                    targetId: t.id,
                }));

                const selected = await window.showQuickPick(items, {
                    placeHolder: "Select a label to jump to",
                });

                if (selected) {
                    await session.customRequest("goto", {
                        threadId: 1,
                        targetId: selected.targetId,
                    });
                }
            }
        } catch (error) {
            logToast(LogLevel.Error, `Jump to label failed: ${error}`);
        }
    });
    context.subscriptions.push(jumpToLabelCommand);

    const filepath = getNavigationJsonFilepath();
    const jsonFileExists = fs.existsSync(filepath);
    if (!jsonFileExists) {
        logMessage(LogLevel.Warning, "Navigation.json file is missing.");
    }

    // Detect file system change to the navigation.json file and trigger a refresh
    updateStatusBar("$(sync~spin) Initializing Ren'Py static data...");
    try {
        await NavigationData.init(context.extensionPath);
        updateStatusBar(getStatusBarText());
    } catch (error) {
        updateStatusBar("Failed to load Ren'Py static data...");
        logMessage(LogLevel.Error, error as string);
    }

    try {
        fs.watch(getNavigationJsonFilepath(), async (event, filename) => {
            if (!filename) {
                return;
            }

            logMessage(LogLevel.Debug, `${filename} changed`);
            updateStatusBar("$(sync~spin) Refreshing Ren'Py navigation data...");
            try {
                await NavigationData.refresh();
            } catch (error) {
                logMessage(LogLevel.Error, `${Date()}: error refreshing NavigationData: ${error}`);
            } finally {
                updateStatusBar(getStatusBarText());
            }
        });
    } catch (error) {
        logMessage(LogLevel.Error, `Watch navigation.json file error: ${error}`);
    }

    if (Configuration.shouldWatchFoldersForChanges()) {
        logMessage(LogLevel.Info, "Starting Watcher for images folder.");
        try {
            fs.watch(getImagesFolder(), { recursive: true }, async (event, filename) => {
                if (filename && event === "rename") {
                    logMessage(LogLevel.Debug, `${filename} created/deleted`);
                    await NavigationData.scanForImages();
                }
            });
        } catch (error) {
            logMessage(LogLevel.Error, `Watch image folder error: ${error}`);
        }

        logMessage(LogLevel.Info, "Starting Watcher for audio folder.");
        try {
            fs.watch(getAudioFolder(), { recursive: true }, async (event, filename) => {
                if (filename && event === "rename") {
                    logMessage(LogLevel.Debug, `${filename} created/deleted`);
                    await NavigationData.scanForAudio();
                }
            });
        } catch (error) {
            logMessage(LogLevel.Error, `Watch audio folder error: ${error}`);
        }
    }

    const factory = new RenpyAdapterDescriptorFactory();
    context.subscriptions.push(debug.registerDebugAdapterDescriptorFactory("renpy", factory));
    const provider = new RenpyConfigurationProvider();
    context.subscriptions.push(debug.registerDebugConfigurationProvider("renpy", provider));
    context.subscriptions.push(
        debug.registerDebugConfigurationProvider(
            "renpy",
            {
                provideDebugConfigurations(): ProviderResult<DebugConfiguration[]> {
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
                },
            },
            DebugConfigurationProviderTriggerKind.Dynamic
        )
    );

    const taskProvider = new RenpyTaskProvider();
    context.subscriptions.push(tasks.registerTaskProvider("renpy", taskProvider));

    logMessage(LogLevel.Info, "Ren'Py extension activated!");
}

export function deactivate() {
    logMessage(LogLevel.Info, "Ren'Py extension deactivating");
    fs.unwatchFile(getNavigationJsonFilepath());
}

export function getKeywordPrefix(document: TextDocument, position: Position, range: Range): string | undefined {
    if (range.start.character <= 0) {
        return;
    }
    const rangeBefore = new Range(new Position(range.start.line, range.start.character - 1), new Position(range.end.line, range.start.character));
    const spaceBefore = document.getText(rangeBefore);
    if (spaceBefore === ".") {
        const prevPosition = new Position(position.line, range.start.character - 1);
        const prevRange = document.getWordRangeAtPosition(prevPosition);
        if (prevRange) {
            const prevWord = document.getText(prevRange);
            if (prevWord === "music" || prevWord === "sound") {
                // check for renpy.music.* or renpy.sound.*
                const newPrefix = getKeywordPrefix(document, prevPosition, prevRange);
                if (newPrefix === "renpy") {
                    return `${newPrefix}.${prevWord}`;
                }
            }
            if (prevWord !== "store") {
                return prevWord;
            }
        }
    }
    return;
}

export function isValidExecutable(renpyExecutableLocation: string): boolean {
    if (!renpyExecutableLocation || renpyExecutableLocation === "") {
        return false;
    }
    return fs.existsSync(renpyExecutableLocation);
}
// Attempts to run renpy executable through console commands.
export function RunWorkspaceFolder(): boolean {
    const childProcess = ExecuteRunpyRun();
    if (childProcess == null) {
        logToast(LogLevel.Error, "Ren'Py executable location not configured or is invalid.");
        return false;
    }
    childProcess
        .on("spawn", () => {
            updateStatusBar("$(sync~spin) Running Ren'Py...");
        })
        .on("error", (error) => {
            logMessage(LogLevel.Error, `Ren'Py spawn error: ${error}`);
        })
        .on("exit", () => {
            updateStatusBar(getStatusBarText());
        });
    childProcess.stdout.on("data", (data) => {
        logMessage(LogLevel.Info, `Ren'Py stdout: ${data}`);
    });
    childProcess.stderr.on("data", (data) => {
        logMessage(LogLevel.Error, `Ren'Py stderr: ${data}`);
    });

    return true;
}

export function ExecuteRunpyRun(): cp.ChildProcessWithoutNullStreams | null {
    const rpyPath = Configuration.getRenpyExecutablePath();

    if (!isValidExecutable(rpyPath)) {
        return null;
    }

    const renpyPath = cleanUpPath(Uri.file(rpyPath).path);
    const cwd = renpyPath.substring(0, renpyPath.lastIndexOf("/"));
    const workFolder = getWorkspaceFolder();
    const args: string[] = [`${workFolder}`, "run"];
    return cp.spawn(rpyPath, args, {
        cwd: `${cwd}`,
        env: { PATH: process.env.PATH },
    });
}

function ExecuteRenpyCompile(): boolean {
    const rpyPath = Configuration.getRenpyExecutablePath();
    if (isValidExecutable(rpyPath)) {
        const renpyPath = cleanUpPath(Uri.file(rpyPath).path);
        const cwd = renpyPath.substring(0, renpyPath.lastIndexOf("/"));

        let wf = getWorkspaceFolder();
        if (wf.endsWith("/game")) {
            wf = wf.substring(0, wf.length - 5);
        }
        const navData = getNavigationJsonFilepath();
        //const args = `${wf} compile --json-dump ${navData}`;
        const args: string[] = [`${wf}`, "compile", "--json-dump", `${navData}`];
        try {
            NavigationData.isCompiling = true;
            updateStatusBar("$(sync~spin) Compiling Ren'Py navigation data...");
            const result = cp.spawnSync(rpyPath, args, {
                cwd: `${cwd}`,
                env: { PATH: process.env.PATH },
                encoding: "utf-8",
                windowsHide: true,
            });
            if (result.error) {
                logMessage(LogLevel.Error, `renpy spawn error: ${result.error}`);
                return false;
            }
            if (result.stderr && result.stderr.length > 0) {
                logMessage(LogLevel.Error, `renpy spawn stderr: ${result.stderr}`);
                return false;
            }
        } catch (error) {
            logMessage(LogLevel.Error, `renpy spawn error: ${error}`);
            return false;
        } finally {
            NavigationData.isCompiling = false;
            updateStatusBar(getStatusBarText());
        }
        return true;
    }
    return false;
}
