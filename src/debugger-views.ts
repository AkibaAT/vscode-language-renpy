import {
    commands,
    debug,
    DebugSession,
    Disposable,
    Event as VSCodeEvent,
    EventEmitter,
    ExtensionContext,
    Position,
    ProviderResult,
    Range,
    Selection,
    TextEditorRevealType,
    ThemeIcon,
    TreeDataProvider,
    TreeItem,
    TreeItemCollapsibleState,
    Uri,
    window,
    workspace,
} from "vscode";

export const ADVANCED_DEBUGGER_CUSTOM_REQUESTS = [
    "getRollbackHistory",
    "gotoCheckpoint",
    "findVariableChanges",
    "getRecordingStatus",
    "getPlaybackStatus",
    "listRecordings",
    "startRecording",
    "stopRecording",
    "captureScreenshot",
    "addAssertion",
    "playRecording",
    "stopPlayback",
    "deleteRecording",
    "exportRecording",
    "listSaves",
    "getPersistentData",
    "getSaveDetails",
    "compareSaves",
    "setPersistent",
    "deletePersistent",
    "getLayeredImages",
    "getShownLayeredImages",
    "getLayeredImageDetails",
    "setLayeredImageAttribute",
    "previewLayeredImage",
] as const;

/**
 * Checkpoint data from the debugger.
 */
interface CheckpointData {
    index: number;
    identifier: [number, number];
    is_checkpoint: boolean;
    is_hard_checkpoint: boolean;
    is_current: boolean;
    filename: string | null;
    line: number;
    label: string | null;
    node_type: string | null;
    statement_text: string | null;
    variable_changes: { [store: string]: { [variable: string]: string } };
}

/**
 * Tree item representing an element in the Rollback Visualizer.
 */
class RollbackItem extends TreeItem {
    public readonly itemType: "category" | "checkpoint" | "variable" | "info";
    public readonly checkpoint: CheckpointData | undefined;
    public readonly children: RollbackItem[] | undefined;
    public readonly variableName: string | undefined;
    public readonly storeName: string | undefined;

    constructor(
        label: string,
        collapsibleState: TreeItemCollapsibleState,
        itemType: "category" | "checkpoint" | "variable" | "info",
        options?: {
            description?: string | undefined;
            checkpoint?: CheckpointData | undefined;
            children?: RollbackItem[] | undefined;
            variableName?: string | undefined;
            storeName?: string | undefined;
        }
    ) {
        super(label, collapsibleState);
        this.itemType = itemType;
        this.checkpoint = options?.checkpoint;
        this.children = options?.children;
        this.variableName = options?.variableName;
        this.storeName = options?.storeName;

        if (options?.description) {
            this.description = options.description;
        }

        // Set icons and context based on type
        switch (itemType) {
            case "category":
                this.iconPath = new ThemeIcon("folder");
                break;
            case "checkpoint": {
                if (options?.checkpoint?.is_current) {
                    this.iconPath = new ThemeIcon("debug-stackframe");
                    this.contextValue = "checkpoint,current";
                } else if (options?.checkpoint?.is_hard_checkpoint) {
                    this.iconPath = new ThemeIcon("circle-filled");
                    this.contextValue = "checkpoint,hard";
                } else {
                    this.iconPath = new ThemeIcon("circle-outline");
                    this.contextValue = "checkpoint";
                }

                // Click to go to checkpoint location in source
                if (options?.checkpoint?.filename && options.checkpoint.line > 0) {
                    this.command = {
                        command: "renpy.rollbackVisualizer.goToSource",
                        title: "Go to Source",
                        arguments: [options.checkpoint.filename, options.checkpoint.line],
                    };
                }

                // Build tooltip
                this.tooltip = this.buildCheckpointTooltip(options?.checkpoint);
                break;
            }
            case "variable":
                this.iconPath = new ThemeIcon("symbol-variable");
                this.contextValue = options?.variableName ? "variable,trackable" : "variable";
                break;
            case "info":
                this.iconPath = new ThemeIcon("info");
                break;
        }
    }

    private buildCheckpointTooltip(checkpoint?: CheckpointData): string {
        if (!checkpoint) return "";

        const lines: string[] = [];
        if (checkpoint.statement_text) {
            lines.push(checkpoint.statement_text);
        }
        if (checkpoint.label) {
            lines.push(`Label: ${checkpoint.label}`);
        }
        if (checkpoint.filename && checkpoint.line) {
            lines.push(`${checkpoint.filename}:${checkpoint.line}`);
        }
        if (checkpoint.is_hard_checkpoint) {
            lines.push("Hard checkpoint (can rollback to)");
        }
        if (checkpoint.is_current) {
            lines.push("Current position");
        }

        const varChangeCount = Object.values(checkpoint.variable_changes).reduce((sum, store) => sum + Object.keys(store).length, 0);
        if (varChangeCount > 0) {
            lines.push(`${varChangeCount} variable change(s)`);
        }

        return lines.join("\n");
    }
}

/**
 * TreeView data provider for the Rollback Visualizer panel.
 * Shows rollback history during debugging.
 */
class RollbackVisualizerProvider implements TreeDataProvider<RollbackItem> {
    private _onDidChangeTreeData: EventEmitter<RollbackItem | undefined | null | void> = new EventEmitter<RollbackItem | undefined | null | void>();
    readonly onDidChangeTreeData: VSCodeEvent<RollbackItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private checkpoints: CheckpointData[] = [];
    private activeSession: DebugSession | null = null;
    private showAllEntries = false;
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
                this.checkpoints = [];
                this.stopAutoRefresh();
                this._onDidChangeTreeData.fire();
            }
        });

        // Refresh when active debug session changes
        debug.onDidChangeActiveDebugSession((session) => {
            if (session?.type === "renpy") {
                this.activeSession = session;
                this.refresh();
            }
        });
    }

    private startAutoRefresh(): void {
        // Refresh rollback history every 1 second while debugging
        this.refreshInterval = setInterval(() => {
            if (this.activeSession) {
                this.refresh();
            }
        }, 1000);
        // Also do an initial refresh
        this.refresh();
    }

    private stopAutoRefresh(): void {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
    }

    async refresh(): Promise<void> {
        if (!this.activeSession) {
            this.checkpoints = [];
            this._onDidChangeTreeData.fire();
            return;
        }

        try {
            const response = await this.activeSession.customRequest("getRollbackHistory", {
                includeNonCheckpoints: this.showAllEntries,
            });
            this.checkpoints = (response.checkpoints || []) as CheckpointData[];
            this._onDidChangeTreeData.fire();
        } catch (error) {
            console.log(`[Renpy Debug] getRollbackHistory error: ${error}`);
            // Don't clear checkpoints on error - keep previous state
        }
    }

    toggleShowAll(): void {
        this.showAllEntries = !this.showAllEntries;
        this.refresh();
    }

    async gotoCheckpoint(index: number): Promise<void> {
        if (!this.activeSession) return;

        try {
            await this.activeSession.customRequest("gotoCheckpoint", { index });
            // Refresh after rollback
            setTimeout(() => this.refresh(), 100);
        } catch (error) {
            window.showErrorMessage(`Failed to go to checkpoint: ${error}`);
        }
    }

    async trackVariable(variableName: string, storeName: string = "store"): Promise<void> {
        if (!this.activeSession) return;

        try {
            const response = await this.activeSession.customRequest("findVariableChanges", {
                variableName,
                storeName,
            });

            const changes = response.changes || [];
            if (changes.length === 0) {
                window.showInformationMessage(`No changes found for variable '${variableName}'`);
                return;
            }

            // Show quick pick with all changes
            interface ChangeItem {
                label: string;
                description: string;
                detail: string;
                checkpointIndex: number;
            }

            const items: ChangeItem[] = changes.map((c: { checkpointIndex: number; oldValue: string; newValue: string }) => ({
                label: `Checkpoint ${c.checkpointIndex}`,
                description: `${c.oldValue} → ${c.newValue}`,
                detail: `Changed from ${c.oldValue} to ${c.newValue}`,
                checkpointIndex: c.checkpointIndex,
            }));

            const selected = await window.showQuickPick(items, {
                placeHolder: `Select a checkpoint where '${variableName}' changed`,
            });

            if (selected) {
                await this.gotoCheckpoint(selected.checkpointIndex);
            }
        } catch (error) {
            window.showErrorMessage(`Failed to track variable: ${error}`);
        }
    }

    getTreeItem(element: RollbackItem): TreeItem {
        return element;
    }

    getChildren(element?: RollbackItem): ProviderResult<RollbackItem[]> {
        if (!this.activeSession) {
            return [new RollbackItem("No active debug session", TreeItemCollapsibleState.None, "info")];
        }

        if (this.checkpoints.length === 0) {
            return [new RollbackItem("No rollback history available", TreeItemCollapsibleState.None, "info")];
        }

        if (!element) {
            // Root level - return checkpoints in reverse order (newest first)
            return this.checkpoints
                .slice()
                .reverse()
                .map((cp) => {
                    const label = cp.statement_text || cp.node_type || `Checkpoint ${cp.index}`;
                    const hasVariables = Object.keys(cp.variable_changes).length > 0;

                    return new RollbackItem(label, hasVariables ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None, "checkpoint", {
                        description: cp.label || undefined,
                        checkpoint: cp,
                        children: hasVariables ? this.getVariableItems(cp) : undefined,
                    });
                });
        }

        // Return children of the element
        return element.children || [];
    }

    private getVariableItems(checkpoint: CheckpointData): RollbackItem[] {
        const items: RollbackItem[] = [];

        for (const [storeName, variables] of Object.entries(checkpoint.variable_changes)) {
            for (const [varName, value] of Object.entries(variables)) {
                const displayStore = storeName === "store" ? "" : `${storeName}.`;
                items.push(
                    new RollbackItem(`${displayStore}${varName}`, TreeItemCollapsibleState.None, "variable", {
                        description: String(value),
                        variableName: varName,
                        storeName: storeName,
                    })
                );
            }
        }

        return items;
    }
}

/**
 * Recording data from the debugger.
 */
interface RecordingInfo {
    name: string;
    created: string;
    description: string;
    duration_ms: number;
    event_count: number;
    assertion_count: number;
}

/**
 * Tree item for the Test Recorder panel.
 */
class RecordingItem extends TreeItem {
    public readonly itemType: "recording" | "status" | "action";
    public readonly recording: RecordingInfo | undefined;

    constructor(
        label: string,
        collapsibleState: TreeItemCollapsibleState,
        itemType: "recording" | "status" | "action",
        options?: {
            description?: string | undefined;
            recording?: RecordingInfo | undefined;
            command?: {
                command: string;
                title: string;
                arguments?: unknown[];
            };
            iconId?: string;
            contextValue?: string;
        }
    ) {
        super(label, collapsibleState);
        this.itemType = itemType;
        this.recording = options?.recording;

        if (options?.description) {
            this.description = options.description;
        }
        if (options?.command) {
            this.command = options.command;
        }
        if (options?.iconId) {
            this.iconPath = new ThemeIcon(options.iconId);
        }
        if (options?.contextValue) {
            this.contextValue = options.contextValue;
        }
    }
}

/**
 * TreeView data provider for the Test Recorder panel.
 */
class TestRecorderProvider implements TreeDataProvider<RecordingItem> {
    private _onDidChangeTreeData: EventEmitter<RecordingItem | undefined | null | void> = new EventEmitter<RecordingItem | undefined | null | void>();
    readonly onDidChangeTreeData: VSCodeEvent<RecordingItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private recordings: RecordingInfo[] = [];
    private activeSession: DebugSession | null = null;
    private isRecording = false;
    private isPlaying = false;
    private recordingName = "";
    private playbackProgress = { played: 0, total: 0 };

    constructor() {
        debug.onDidStartDebugSession((session) => {
            if (session.type === "renpy") {
                this.activeSession = session;
                this.refresh();
            }
        });

        debug.onDidTerminateDebugSession((session) => {
            if (session === this.activeSession) {
                this.activeSession = null;
                this.isRecording = false;
                this.isPlaying = false;
                this._onDidChangeTreeData.fire();
            }
        });
    }

    async refresh(): Promise<void> {
        if (!this.activeSession) {
            this.recordings = [];
            this._onDidChangeTreeData.fire();
            return;
        }

        try {
            // Get recording status
            const recStatus = await this.activeSession.customRequest("getRecordingStatus");
            this.isRecording = recStatus.isRecording || false;
            this.recordingName = recStatus.name || "";

            // Get playback status
            const playStatus = await this.activeSession.customRequest("getPlaybackStatus");
            this.isPlaying = playStatus.isPlaying || false;
            this.playbackProgress = {
                played: playStatus.eventsPlayed || 0,
                total: playStatus.eventsTotal || 0,
            };

            // Get recordings list
            const response = await this.activeSession.customRequest("listRecordings");
            this.recordings = (response.recordings || []) as RecordingInfo[];

            this._onDidChangeTreeData.fire();
        } catch {
            // Silently ignore
        }
    }

    async startRecording(): Promise<void> {
        if (!this.activeSession) return;

        const name = await window.showInputBox({
            prompt: "Enter a name for this recording",
            placeHolder: "test_route_a",
            validateInput: (value) => {
                if (!value || value.trim() === "") {
                    return "Name is required";
                }
                if (!/^[\w-]+$/.test(value)) {
                    return "Name can only contain letters, numbers, underscores, and hyphens";
                }
                return null;
            },
        });

        if (!name) return;

        try {
            await this.activeSession.customRequest("startRecording", { name });
            this.refresh();
            window.showInformationMessage(`Started recording: ${name}`);
        } catch (error) {
            window.showErrorMessage(`Failed to start recording: ${error}`);
        }
    }

    async stopRecording(): Promise<void> {
        if (!this.activeSession) return;

        try {
            const result = await this.activeSession.customRequest("stopRecording", { save: true });
            this.refresh();
            window.showInformationMessage(`Recording saved: ${result.name} (${result.eventCount} events, ${result.assertionCount} assertions)`);
        } catch (error) {
            window.showErrorMessage(`Failed to stop recording: ${error}`);
        }
    }

    async captureScreenshot(): Promise<void> {
        if (!this.activeSession || !this.isRecording) return;

        const name = await window.showInputBox({
            prompt: "Enter a name for this screenshot (optional)",
            placeHolder: "after_choice_1",
        });

        try {
            await this.activeSession.customRequest("captureScreenshot", {
                name: name || undefined,
                threshold: 1.0,
            });
            window.showInformationMessage("Screenshot captured");
        } catch (error) {
            window.showErrorMessage(`Failed to capture screenshot: ${error}`);
        }
    }

    async addAssertion(): Promise<void> {
        if (!this.activeSession || !this.isRecording) return;

        const variable = await window.showInputBox({
            prompt: "Enter the variable name to assert",
            placeHolder: "affection",
        });

        if (!variable) return;

        try {
            await this.activeSession.customRequest("addAssertion", {
                variable,
                store: "store",
            });
            window.showInformationMessage(`Assertion added for: ${variable}`);
        } catch (error) {
            window.showErrorMessage(`Failed to add assertion: ${error}`);
        }
    }

    async playRecording(name: string): Promise<void> {
        if (!this.activeSession) return;

        try {
            await this.activeSession.customRequest("playRecording", { name, mode: "verify" });
            this.refresh();
            window.showInformationMessage(`Started playback: ${name}`);
        } catch (error) {
            window.showErrorMessage(`Failed to start playback: ${error}`);
        }
    }

    async stopPlayback(): Promise<void> {
        if (!this.activeSession) return;

        try {
            const result = await this.activeSession.customRequest("stopPlayback");
            this.refresh();

            if (result.success) {
                window.showInformationMessage(
                    `Playback complete: ${result.assertions_passed} passed, ${result.assertions_failed} failed, ` +
                        `${result.screenshots_passed} screenshots passed, ${result.screenshots_failed} screenshots failed`
                );
            } else {
                window.showWarningMessage(
                    `Playback failed: ${result.assertions_failed} assertions failed, ${result.screenshots_failed} screenshots failed`
                );
            }
        } catch (error) {
            window.showErrorMessage(`Failed to stop playback: ${error}`);
        }
    }

    async deleteRecording(name: string): Promise<void> {
        if (!this.activeSession) return;

        const confirm = await window.showWarningMessage(`Delete recording "${name}"?`, { modal: true }, "Delete");

        if (confirm !== "Delete") return;

        try {
            await this.activeSession.customRequest("deleteRecording", { name });
            this.refresh();
            window.showInformationMessage(`Deleted recording: ${name}`);
        } catch (error) {
            window.showErrorMessage(`Failed to delete recording: ${error}`);
        }
    }

    async exportRecording(name: string): Promise<void> {
        if (!this.activeSession) return;

        const format = await window.showQuickPick(
            [
                { label: "Ren'Py Test Script", value: "renpy_test" },
                { label: "JSON", value: "json" },
            ],
            { placeHolder: "Select export format" }
        );

        if (!format) return;

        try {
            const result = await this.activeSession.customRequest("exportRecording", {
                name,
                format: format.value,
            });

            // Show in new document
            const doc = await workspace.openTextDocument({
                content: result.content,
                language: format.value === "renpy_test" ? "renpy" : "json",
            });
            await window.showTextDocument(doc);
        } catch (error) {
            window.showErrorMessage(`Failed to export recording: ${error}`);
        }
    }

    getTreeItem(element: RecordingItem): TreeItem {
        return element;
    }

    getChildren(element?: RecordingItem): ProviderResult<RecordingItem[]> {
        if (!this.activeSession) {
            return [
                new RecordingItem("No active debug session", TreeItemCollapsibleState.None, "status", {
                    iconId: "info",
                }),
            ];
        }

        if (!element) {
            const items: RecordingItem[] = [];

            // Status section
            if (this.isRecording) {
                items.push(
                    new RecordingItem(`Recording: ${this.recordingName}`, TreeItemCollapsibleState.None, "status", {
                        iconId: "record",
                        description: "Click to stop",
                        command: {
                            command: "renpy.testRecorder.stopRecording",
                            title: "Stop Recording",
                        },
                    })
                );
                items.push(
                    new RecordingItem("📸 Capture Screenshot", TreeItemCollapsibleState.None, "action", {
                        iconId: "device-camera",
                        command: {
                            command: "renpy.testRecorder.captureScreenshot",
                            title: "Capture Screenshot",
                        },
                    })
                );
                items.push(
                    new RecordingItem("✓ Add Assertion", TreeItemCollapsibleState.None, "action", {
                        iconId: "check",
                        command: {
                            command: "renpy.testRecorder.addAssertion",
                            title: "Add Assertion",
                        },
                    })
                );
            } else if (this.isPlaying) {
                items.push(
                    new RecordingItem("Playing...", TreeItemCollapsibleState.None, "status", {
                        iconId: "debug-start",
                        description: `${this.playbackProgress.played}/${this.playbackProgress.total}`,
                        command: {
                            command: "renpy.testRecorder.stopPlayback",
                            title: "Stop Playback",
                        },
                    })
                );
            } else {
                items.push(
                    new RecordingItem("Start Recording", TreeItemCollapsibleState.None, "action", {
                        iconId: "record",
                        command: {
                            command: "renpy.testRecorder.startRecording",
                            title: "Start Recording",
                        },
                    })
                );
            }

            // Recordings list
            if (this.recordings.length > 0) {
                items.push(
                    new RecordingItem(`Saved Recordings (${this.recordings.length})`, TreeItemCollapsibleState.Expanded, "status", {
                        iconId: "folder",
                    })
                );
            } else {
                items.push(
                    new RecordingItem("No saved recordings", TreeItemCollapsibleState.None, "status", {
                        iconId: "folder",
                    })
                );
            }

            return items;
        }

        // Children of "Saved Recordings"
        if (element.label?.toString().startsWith("Saved Recordings")) {
            return this.recordings.map(
                (rec) =>
                    new RecordingItem(rec.name, TreeItemCollapsibleState.None, "recording", {
                        description: `${rec.event_count} events`,
                        recording: rec,
                        iconId: "file",
                        contextValue: "recording",
                        command: {
                            command: "renpy.testRecorder.playRecording",
                            title: "Play Recording",
                            arguments: [rec.name],
                        },
                    })
            );
        }

        return [];
    }
}

/**
 * Data structures for Save Inspector
 */
interface SaveSlotInfo {
    slotName: string;
    slotNumber: number | null;
    isAuto: boolean;
    isQuick: boolean;
    timestamp: number;
    formattedTime: string;
    saveName: string | null;
    currentLabel: string | null;
}

interface PersistentVariable {
    name: string;
    value: string;
    valueType: string;
    isDefault: boolean;
}

interface PreferenceVariable {
    name: string;
    displayName: string;
    value: string;
    valueType: string;
}

/**
 * Tree item for the Save Inspector panel.
 */
class SaveInspectorItem extends TreeItem {
    public readonly itemType: "category" | "save" | "persistent" | "preference" | "info";
    public readonly saveSlot: SaveSlotInfo | undefined;
    public readonly persistentVar: PersistentVariable | undefined;
    public readonly preferenceVar: PreferenceVariable | undefined;

    constructor(
        label: string,
        collapsibleState: TreeItemCollapsibleState,
        itemType: "category" | "save" | "persistent" | "preference" | "info",
        options?: {
            description?: string | undefined;
            saveSlot?: SaveSlotInfo | undefined;
            persistentVar?: PersistentVariable | undefined;
            preferenceVar?: PreferenceVariable | undefined;
            iconId?: string;
            contextValue?: string;
        }
    ) {
        super(label, collapsibleState);
        this.itemType = itemType;
        this.saveSlot = options?.saveSlot;
        this.persistentVar = options?.persistentVar;
        this.preferenceVar = options?.preferenceVar;

        if (options?.description) this.description = options.description;
        if (options?.iconId) this.iconPath = new ThemeIcon(options.iconId);
        if (options?.contextValue) this.contextValue = options.contextValue;
    }
}

/**
 * TreeView data provider for Save Inspector and Persistent Data.
 */
class SaveInspectorProvider implements TreeDataProvider<SaveInspectorItem> {
    private _onDidChangeTreeData: EventEmitter<SaveInspectorItem | undefined | null | void> = new EventEmitter<
        SaveInspectorItem | undefined | null | void
    >();
    readonly onDidChangeTreeData: VSCodeEvent<SaveInspectorItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private saves: SaveSlotInfo[] = [];
    private persistentVars: PersistentVariable[] = [];
    private preferences: PreferenceVariable[] = [];
    private activeSession: DebugSession | null = null;

    constructor() {
        debug.onDidStartDebugSession((session) => {
            if (session.type === "renpy") {
                this.activeSession = session;
                this.refresh();
            }
        });

        debug.onDidTerminateDebugSession((session) => {
            if (session === this.activeSession) {
                this.activeSession = null;
                this.saves = [];
                this.persistentVars = [];
                this.preferences = [];
                this._onDidChangeTreeData.fire();
            }
        });
    }

    async refresh(): Promise<void> {
        if (!this.activeSession) {
            this.saves = [];
            this.persistentVars = [];
            this.preferences = [];
            this._onDidChangeTreeData.fire();
            return;
        }

        try {
            const savesResponse = await this.activeSession.customRequest("listSaves");
            this.saves = (savesResponse.saves || []) as SaveSlotInfo[];

            const persistentResponse = await this.activeSession.customRequest("getPersistentData");
            this.persistentVars = (persistentResponse.persistent || []) as PersistentVariable[];
            this.preferences = (persistentResponse.preferences || []) as PreferenceVariable[];

            this._onDidChangeTreeData.fire();
        } catch {
            // Silently ignore
        }
    }

    async viewSaveDetails(slotName: string): Promise<void> {
        if (!this.activeSession) return;

        try {
            const details = await this.activeSession.customRequest("getSaveDetails", { slotName });

            // Create a virtual document with save details
            const content = JSON.stringify(details, null, 2);
            const doc = await workspace.openTextDocument({ content, language: "json" });
            await window.showTextDocument(doc, { preview: true });
        } catch (error) {
            window.showErrorMessage(`Failed to view save details: ${error}`);
        }
    }

    async compareSaves(): Promise<void> {
        if (!this.activeSession || this.saves.length < 2) {
            window.showWarningMessage("Need at least 2 saves to compare");
            return;
        }

        const items = this.saves.map((s) => ({
            label: s.slotName,
            description: s.formattedTime,
        }));

        const slotA = await window.showQuickPick(items, { placeHolder: "Select first save" });
        if (!slotA) return;

        const slotB = await window.showQuickPick(
            items.filter((i) => i.label !== slotA.label),
            { placeHolder: "Select second save" }
        );
        if (!slotB) return;

        try {
            const comparison = await this.activeSession.customRequest("compareSaves", {
                slotA: slotA.label,
                slotB: slotB.label,
            });

            const content = JSON.stringify(comparison, null, 2);
            const doc = await workspace.openTextDocument({ content, language: "json" });
            await window.showTextDocument(doc, { preview: true });
        } catch (error) {
            window.showErrorMessage(`Failed to compare saves: ${error}`);
        }
    }

    async editPersistent(name: string, currentValue: string): Promise<void> {
        if (!this.activeSession) return;

        const newValue = await window.showInputBox({
            prompt: `Enter new value for ${name}`,
            value: currentValue,
        });

        if (newValue === undefined) return;

        try {
            await this.activeSession.customRequest("setPersistent", {
                name,
                value: newValue,
                valueType: "eval",
            });
            this.refresh();
            window.showInformationMessage(`Updated persistent.${name}`);
        } catch (error) {
            window.showErrorMessage(`Failed to update persistent: ${error}`);
        }
    }

    async deletePersistent(name: string): Promise<void> {
        if (!this.activeSession) return;

        const confirm = await window.showWarningMessage(`Reset persistent.${name} to default?`, { modal: true }, "Reset");
        if (confirm !== "Reset") return;

        try {
            await this.activeSession.customRequest("deletePersistent", { name });
            this.refresh();
            window.showInformationMessage(`Reset persistent.${name}`);
        } catch (error) {
            window.showErrorMessage(`Failed to reset persistent: ${error}`);
        }
    }

    getTreeItem(element: SaveInspectorItem): TreeItem {
        return element;
    }

    getChildren(element?: SaveInspectorItem): ProviderResult<SaveInspectorItem[]> {
        if (!this.activeSession) {
            return [new SaveInspectorItem("No active debug session", TreeItemCollapsibleState.None, "info", { iconId: "info" })];
        }

        if (!element) {
            const items: SaveInspectorItem[] = [];

            // Preferences category (volume, text speed, etc.)
            items.push(
                new SaveInspectorItem(`Preferences (${this.preferences.length})`, TreeItemCollapsibleState.Collapsed, "category", {
                    iconId: "settings-gear",
                })
            );

            // Persistent Data category
            items.push(
                new SaveInspectorItem(`Persistent Data (${this.persistentVars.length})`, TreeItemCollapsibleState.Collapsed, "category", {
                    iconId: "database",
                })
            );

            // Save Files category
            items.push(
                new SaveInspectorItem(`Save Files (${this.saves.length})`, TreeItemCollapsibleState.Collapsed, "category", {
                    iconId: "save-all",
                })
            );

            return items;
        }

        // Children of categories
        if (element.label?.toString().startsWith("Preferences")) {
            return this.preferences.map(
                (v) =>
                    new SaveInspectorItem(v.displayName || v.name, TreeItemCollapsibleState.None, "preference", {
                        description: v.value,
                        preferenceVar: v,
                        iconId: this._getPreferenceIcon(v.name),
                        contextValue: "preference",
                    })
            );
        }

        if (element.label?.toString().startsWith("Persistent Data")) {
            return this.persistentVars.map(
                (v) =>
                    new SaveInspectorItem(v.name, TreeItemCollapsibleState.None, "persistent", {
                        description: v.value,
                        persistentVar: v,
                        iconId: v.isDefault ? "circle-outline" : "circle-filled",
                        contextValue: "persistent",
                    })
            );
        }

        if (element.label?.toString().startsWith("Save Files")) {
            return this.saves.map((s) => {
                const icon = s.isAuto ? "history" : s.isQuick ? "zap" : "save";
                return new SaveInspectorItem(s.slotName, TreeItemCollapsibleState.None, "save", {
                    description: s.formattedTime,
                    saveSlot: s,
                    iconId: icon,
                    contextValue: "save",
                });
            });
        }

        return [];
    }

    private _getPreferenceIcon(name: string): string {
        if (name.includes("volume") || name.includes("mute") || name.includes("audio") || name.includes("mono")) {
            return "unmute";
        }
        if (name.includes("text_cps") || name.includes("afm")) {
            return "symbol-text";
        }
        if (name.includes("skip")) {
            return "debug-step-over";
        }
        if (name.includes("fullscreen") || name.includes("transitions") || name.includes("maximized")) {
            return "screen-full";
        }
        if (name.includes("language")) {
            return "globe";
        }
        if (name.includes("font") || name.includes("high_contrast")) {
            return "text-size";
        }
        if (name.includes("voice") || name.includes("self_voicing")) {
            return "comment";
        }
        if (name.includes("gl_") || name.includes("renderer")) {
            return "device-desktop";
        }
        if (name.includes("pad_") || name.includes("mouse")) {
            return "game";
        }
        return "symbol-property";
    }
}

/**
 * Data structures for Layered Image Inspector
 */
interface LayeredImageBasic {
    name: string;
    attributeCount: number;
    groupCount: number;
}

interface LayeredImageAttribute {
    name: string;
    group: string | null;
    isActive: boolean;
    isDefault: boolean;
}

interface ShownLayeredImage {
    tag: string;
    layer: string;
    baseName: string;
    fullName: string;
    activeAttributes: string[];
}

/**
 * Tree item for the Layered Image Inspector panel.
 */
class LayeredImageItem extends TreeItem {
    public readonly itemType: "category" | "image" | "attribute" | "shown" | "info";
    public readonly imageInfo: LayeredImageBasic | undefined;
    public readonly shownImage: ShownLayeredImage | undefined;
    public readonly attribute: LayeredImageAttribute | undefined;
    public readonly imageTag: string | undefined;

    constructor(
        label: string,
        collapsibleState: TreeItemCollapsibleState,
        itemType: "category" | "image" | "attribute" | "shown" | "info",
        options?: {
            description?: string | undefined;
            imageInfo?: LayeredImageBasic | undefined;
            shownImage?: ShownLayeredImage | undefined;
            attribute?: LayeredImageAttribute | undefined;
            imageTag?: string | undefined;
            iconId?: string;
            contextValue?: string;
        }
    ) {
        super(label, collapsibleState);
        this.itemType = itemType;
        this.imageInfo = options?.imageInfo;
        this.shownImage = options?.shownImage;
        this.attribute = options?.attribute;
        this.imageTag = options?.imageTag;

        if (options?.description) this.description = options.description;
        if (options?.iconId) this.iconPath = new ThemeIcon(options.iconId);
        if (options?.contextValue) this.contextValue = options.contextValue;
    }
}

/**
 * TreeView data provider for Layered Image Inspector.
 */
class LayeredImageInspectorProvider implements TreeDataProvider<LayeredImageItem> {
    private _onDidChangeTreeData: EventEmitter<LayeredImageItem | undefined | null | void> = new EventEmitter<
        LayeredImageItem | undefined | null | void
    >();
    readonly onDidChangeTreeData: VSCodeEvent<LayeredImageItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private allImages: LayeredImageBasic[] = [];
    private shownImages: ShownLayeredImage[] = [];
    private activeSession: DebugSession | null = null;

    constructor() {
        debug.onDidStartDebugSession((session) => {
            if (session.type === "renpy") {
                this.activeSession = session;
                this.refresh();
            }
        });

        debug.onDidTerminateDebugSession((session) => {
            if (session === this.activeSession) {
                this.activeSession = null;
                this.allImages = [];
                this.shownImages = [];
                this._onDidChangeTreeData.fire();
            }
        });
    }

    async refresh(): Promise<void> {
        if (!this.activeSession) {
            this.allImages = [];
            this.shownImages = [];
            this._onDidChangeTreeData.fire();
            return;
        }

        try {
            const allResponse = await this.activeSession.customRequest("getLayeredImages");
            this.allImages = (allResponse.images || []) as LayeredImageBasic[];

            const shownResponse = await this.activeSession.customRequest("getShownLayeredImages");
            this.shownImages = (shownResponse.images || []) as ShownLayeredImage[];

            this._onDidChangeTreeData.fire();
        } catch {
            // Silently ignore
        }
    }

    async viewImageDetails(imageName: string): Promise<void> {
        if (!this.activeSession) return;

        try {
            const details = await this.activeSession.customRequest("getLayeredImageDetails", { imageName });

            const content = JSON.stringify(details, null, 2);
            const doc = await workspace.openTextDocument({ content, language: "json" });
            await window.showTextDocument(doc, { preview: true });
        } catch (error) {
            window.showErrorMessage(`Failed to get image details: ${error}`);
        }
    }

    async toggleAttribute(imageTag: string, attribute: string, enabled: boolean): Promise<void> {
        if (!this.activeSession) return;

        try {
            await this.activeSession.customRequest("setLayeredImageAttribute", {
                imageTag,
                attribute,
                enabled,
            });
            this.refresh();
        } catch (error) {
            window.showErrorMessage(`Failed to toggle attribute: ${error}`);
        }
    }

    async previewImage(imageName: string): Promise<void> {
        if (!this.activeSession) return;

        try {
            // Get image details to show available attributes
            const details = await this.activeSession.customRequest("getLayeredImageDetails", { imageName });

            if (!details || !details.attributes) {
                window.showWarningMessage("No attributes found for this image");
                return;
            }

            // Let user select attributes
            interface AttrPickItem {
                label: string;
                description: string;
                picked: boolean;
            }

            const attrItems: AttrPickItem[] = details.attributes.map((a: LayeredImageAttribute) => ({
                label: a.name,
                description: a.group || "",
                picked: a.isDefault,
            }));

            const selected = await window.showQuickPick(attrItems, {
                canPickMany: true,
                placeHolder: "Select attributes to preview",
            });

            if (!selected) return;

            const attrs = selected.map((s: AttrPickItem) => s.label);

            await this.activeSession.customRequest("previewLayeredImage", {
                imageName,
                attributes: attrs,
            });

            this.refresh();
        } catch (error) {
            window.showErrorMessage(`Failed to preview image: ${error}`);
        }
    }

    getTreeItem(element: LayeredImageItem): TreeItem {
        return element;
    }

    getChildren(element?: LayeredImageItem): ProviderResult<LayeredImageItem[]> {
        if (!this.activeSession) {
            return [new LayeredImageItem("No active debug session", TreeItemCollapsibleState.None, "info", { iconId: "info" })];
        }

        if (!element) {
            const items: LayeredImageItem[] = [];

            // Currently shown images
            if (this.shownImages.length > 0) {
                items.push(
                    new LayeredImageItem(`On Screen (${this.shownImages.length})`, TreeItemCollapsibleState.Expanded, "category", {
                        iconId: "eye",
                    })
                );
            }

            // All layered images
            items.push(
                new LayeredImageItem(`All Layered Images (${this.allImages.length})`, TreeItemCollapsibleState.Collapsed, "category", {
                    iconId: "file-media",
                })
            );

            return items;
        }

        // Children of "On Screen"
        if (element.label?.toString().startsWith("On Screen")) {
            return this.shownImages.map(
                (img) =>
                    new LayeredImageItem(img.tag, TreeItemCollapsibleState.Collapsed, "shown", {
                        description: img.activeAttributes.join(", "),
                        shownImage: img,
                        iconId: "symbol-color",
                        contextValue: "shownImage",
                    })
            );
        }

        // Children of shown image (attributes that can be toggled)
        if (element.itemType === "shown" && element.shownImage) {
            // Get full image details to show all possible attributes
            // For now, show active attributes with toggle option
            return element.shownImage.activeAttributes.map(
                (attr) =>
                    new LayeredImageItem(attr, TreeItemCollapsibleState.None, "attribute", {
                        description: "Active",
                        attribute: { name: attr, group: null, isActive: true, isDefault: false },
                        imageTag: element.shownImage?.tag,
                        iconId: "check",
                        contextValue: "activeAttribute",
                    })
            );
        }

        // Children of "All Layered Images"
        if (element.label?.toString().startsWith("All Layered Images")) {
            return this.allImages.map(
                (img) =>
                    new LayeredImageItem(img.name, TreeItemCollapsibleState.None, "image", {
                        description: `${img.attributeCount} attrs, ${img.groupCount} groups`,
                        imageInfo: img,
                        iconId: "layers",
                        contextValue: "layeredImage",
                    })
            );
        }

        return [];
    }
}

export function registerAdvancedDebuggerViews(context: ExtensionContext): Disposable[] {
    const disposables: Disposable[] = [];

    const rollbackVisualizerProvider = new RollbackVisualizerProvider();
    disposables.push(
        window.createTreeView("renpyRollbackVisualizer", {
            treeDataProvider: rollbackVisualizerProvider,
            showCollapseAll: true,
        })
    );
    disposables.push(commands.registerCommand("renpy.rollbackVisualizer.refresh", () => rollbackVisualizerProvider.refresh()));
    disposables.push(commands.registerCommand("renpy.rollbackVisualizer.toggleShowAll", () => rollbackVisualizerProvider.toggleShowAll()));
    disposables.push(
        commands.registerCommand("renpy.rollbackVisualizer.gotoCheckpoint", async (item: RollbackItem) => {
            if (item?.checkpoint) {
                await rollbackVisualizerProvider.gotoCheckpoint(item.checkpoint.index);
            }
        })
    );
    disposables.push(
        commands.registerCommand("renpy.rollbackVisualizer.trackVariable", async (item: RollbackItem) => {
            if (item?.variableName) {
                await rollbackVisualizerProvider.trackVariable(item.variableName, item.storeName || "store");
            }
        })
    );
    disposables.push(
        commands.registerCommand("renpy.rollbackVisualizer.goToSource", async (filePath: string, lineNumber: number) => {
            if (!filePath) return;
            try {
                const uri = Uri.file(filePath);
                const doc = await workspace.openTextDocument(uri);
                const editor = await window.showTextDocument(doc);
                const line = Math.max(0, lineNumber - 1);
                const position = new Position(line, 0);
                editor.selection = new Selection(position, position);
                editor.revealRange(new Range(position, position), TextEditorRevealType.InCenter);
            } catch {
                window.showErrorMessage(`Failed to open source: ${filePath}:${lineNumber}`);
            }
        })
    );

    const testRecorderProvider = new TestRecorderProvider();
    disposables.push(
        window.createTreeView("renpyTestRecorder", {
            treeDataProvider: testRecorderProvider,
            showCollapseAll: true,
        })
    );
    disposables.push(commands.registerCommand("renpy.testRecorder.refresh", () => testRecorderProvider.refresh()));
    disposables.push(commands.registerCommand("renpy.testRecorder.startRecording", () => testRecorderProvider.startRecording()));
    disposables.push(commands.registerCommand("renpy.testRecorder.stopRecording", () => testRecorderProvider.stopRecording()));
    disposables.push(commands.registerCommand("renpy.testRecorder.captureScreenshot", () => testRecorderProvider.captureScreenshot()));
    disposables.push(commands.registerCommand("renpy.testRecorder.addAssertion", () => testRecorderProvider.addAssertion()));
    disposables.push(commands.registerCommand("renpy.testRecorder.playRecording", (name: string) => testRecorderProvider.playRecording(name)));
    disposables.push(commands.registerCommand("renpy.testRecorder.stopPlayback", () => testRecorderProvider.stopPlayback()));
    disposables.push(
        commands.registerCommand("renpy.testRecorder.deleteRecording", (item: RecordingItem) => {
            if (item?.recording?.name) {
                testRecorderProvider.deleteRecording(item.recording.name);
            }
        })
    );
    disposables.push(
        commands.registerCommand("renpy.testRecorder.exportRecording", (item: RecordingItem) => {
            if (item?.recording?.name) {
                testRecorderProvider.exportRecording(item.recording.name);
            }
        })
    );

    const saveInspectorProvider = new SaveInspectorProvider();
    disposables.push(
        window.createTreeView("renpySaveInspector", {
            treeDataProvider: saveInspectorProvider,
            showCollapseAll: true,
        })
    );
    disposables.push(commands.registerCommand("renpy.saveInspector.refresh", () => saveInspectorProvider.refresh()));
    disposables.push(
        commands.registerCommand("renpy.saveInspector.viewDetails", (item: SaveInspectorItem) => {
            if (item?.saveSlot?.slotName) {
                saveInspectorProvider.viewSaveDetails(item.saveSlot.slotName);
            }
        })
    );
    disposables.push(commands.registerCommand("renpy.saveInspector.compareSaves", () => saveInspectorProvider.compareSaves()));
    disposables.push(
        commands.registerCommand("renpy.saveInspector.editPersistent", (item: SaveInspectorItem) => {
            if (item?.persistentVar) {
                saveInspectorProvider.editPersistent(item.persistentVar.name, item.persistentVar.value);
            }
        })
    );
    disposables.push(
        commands.registerCommand("renpy.saveInspector.deletePersistent", (item: SaveInspectorItem) => {
            if (item?.persistentVar) {
                saveInspectorProvider.deletePersistent(item.persistentVar.name);
            }
        })
    );

    const layeredImageInspectorProvider = new LayeredImageInspectorProvider();
    disposables.push(
        window.createTreeView("renpyLayeredImageInspector", {
            treeDataProvider: layeredImageInspectorProvider,
            showCollapseAll: true,
        })
    );
    disposables.push(commands.registerCommand("renpy.layeredImageInspector.refresh", () => layeredImageInspectorProvider.refresh()));
    disposables.push(
        commands.registerCommand("renpy.layeredImageInspector.viewDetails", (item: LayeredImageItem) => {
            if (item?.imageInfo?.name) {
                layeredImageInspectorProvider.viewImageDetails(item.imageInfo.name);
            } else if (item?.shownImage?.baseName) {
                layeredImageInspectorProvider.viewImageDetails(item.shownImage.baseName);
            }
        })
    );
    disposables.push(
        commands.registerCommand("renpy.layeredImageInspector.toggleAttribute", async (item: LayeredImageItem) => {
            if (item?.attribute && item?.imageTag) {
                await layeredImageInspectorProvider.toggleAttribute(item.imageTag, item.attribute.name, !item.attribute.isActive);
            }
        })
    );
    disposables.push(
        commands.registerCommand("renpy.layeredImageInspector.previewImage", (item: LayeredImageItem) => {
            if (item?.imageInfo?.name) {
                layeredImageInspectorProvider.previewImage(item.imageInfo.name);
            }
        })
    );

    context.subscriptions.push(...disposables);
    return disposables;
}
