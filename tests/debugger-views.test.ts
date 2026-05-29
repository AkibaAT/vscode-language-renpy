import { expect } from "chai";

import { ADVANCED_DEBUGGER_CUSTOM_REQUESTS } from "src/debugger-views";

describe("advanced debugger views", () => {
    it("keeps custom DAP request names stable", () => {
        expect(ADVANCED_DEBUGGER_CUSTOM_REQUESTS).to.deep.equal([
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
        ]);
    });
});
