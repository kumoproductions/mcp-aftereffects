// mcp-aftereffects request server — turns one request-<id>.json into one
// response-<id>.json. Shared by the two ways a request reaches After Effects:
//
//   dispatcher.jsx  push — launched per call by `AfterFX.exe -r` / DoScript,
//                   finds the oldest request in the shared mailbox
//   agent.jsx       pull — resident in one AE instance, polls that instance's
//                   own mailbox (<runtime>/instances/<id>/) from a scheduled task
//
// Both hand `AE_MCP.serveRequest` a request File and the directory it lives
// in; the response is written next to it. The contract is the same on either
// path:
//
//   - the request is DELETED before it runs (consume-on-read), so no second
//     dispatcher run or tick can execute it again;
//   - the id comes from the FILENAME, not the JSON body, so even a corrupt or
//     unparseable request gets a correlated response instead of stranding the
//     caller for a full timeout;
//   - `code` is evaluated as a function body with `app`, `log` and `payload`
//     in scope, inside an undo group unless the request said `undoGroup:
//     false`, with modal dialogs suppressed unless it said `suppressDialogs:
//     false`;
//   - every failure mode writes a response. An exception escaping to AE's
//     modal error dialog would block scripting for the rest of the session.
//
// Keep this file ES3: var only, no arrow functions, no Array.prototype.map.

var AE_MCP = AE_MCP || {};

// --- Talking about exceptions safely ---------------------------------------
// `"failed: " + e` is not a safe way to report an error in ExtendScript. The
// engine cannot coerce an Error to a primitive, so the concatenation ITSELF
// throws ("Object of type Error found where a Number, Array, or Property is
// needed") — from inside the handler whose whole job was to report the
// original failure. The real error is lost, the replacement escapes, and AE
// raises a modal that blocks all scripting until a human clicks OK; every
// later call then fails as a timeout.
//
// So: nothing here interpolates an exception directly. helpers.jsx exposes the
// same formatter as AE.errText for generated code; this file keeps its own so
// it can report failures even if helpers.jsx did not load.
AE_MCP.describeError = function (e) {
    try {
        if (e === null || e === undefined) return "unknown error";
        if (typeof e === "string") return e;
        var msg = (e.message === undefined || e.message === null) ? "" : String(e.message);
        if (msg.length === 0) msg = "error";
        if (e.line !== undefined && e.line !== null) msg += " (line " + String(e.line) + ")";
        return msg;
    } catch (eFmt) {
        return "unformattable error";
    }
};

AE_MCP.errStack = function (e) {
    try {
        return (e && e.stack) ? String(e.stack) : null;
    } catch (eSt) {
        return null;
    }
};

/** Fire-and-forget append to a log file; errors are swallowed so logging never breaks serving. */
AE_MCP.appendLog = function (logPath, msg) {
    try {
        var lf = new File(logPath);
        lf.encoding = "UTF-8";
        if (lf.open("a")) {
            lf.writeln("[" + new Date().toString() + "] " + msg);
            lf.close();
        }
    } catch (eLog) { /* ignore */ }
};

/**
 * Oldest pending request-*.json directly inside `dir`, or null. Oldest-first
 * keeps a backlog fair. Not recursive: the shared mailbox and every instance
 * mailbox under instances/<id>/ are separate queues.
 */
AE_MCP.oldestRequestIn = function (dir) {
    try {
        var folder = new Folder(dir);
        if (!folder.exists) return null;
        var files = folder.getFiles("request-*.json");
        if (!files || files.length === 0) return null;
        var best = null;
        for (var i = 0; i < files.length; i++) {
            var f = files[i];
            if (!(f instanceof File)) continue;
            if (best === null) { best = f; continue; }
            try {
                if (f.modified < best.modified) best = f;
            } catch (eCmp) { /* unstat-able; keep the incumbent */ }
        }
        return best;
    } catch (eScan) {
        return null;
    }
};

/**
 * Serve one request: consume it, run it, write its response.
 *
 * @param requestFile  File   the request-<id>.json to serve
 * @param mailboxDir   string directory holding it; the response goes next to it
 * @param logPath      string append-only log for this serving path
 */
AE_MCP.serveRequest = function (requestFile, mailboxDir, logPath) {
    var REQUEST_PREFIX = "request-";
    var REQUEST_SUFFIX = ".json";
    var describeError = AE_MCP.describeError;
    var errStack = AE_MCP.errStack;

    function appendLog(msg) {
        AE_MCP.appendLog(logPath, msg);
    }

    // --- Identify the request from its filename ------------------------
    // Filename is authoritative: a request whose JSON body we cannot parse
    // still gets a correlated response instead of stranding the caller.
    var requestName = String(requestFile.name);
    try { requestName = decodeURI(requestName); } catch (eDec) { /* keep raw */ }
    var requestId = requestName.substring(
        REQUEST_PREFIX.length,
        requestName.length - REQUEST_SUFFIX.length
    );

    var response = {
        id: requestId,
        ok: false,
        phase: "dispatch",
        result: null,
        error: null,
        // 1-based line in the COMPILED function body where execution threw
        // (ExtendScript Error.line). The body = the wrapped request code,
        // and new Function's synthesized header occupies line 1, so this is
        // NOT a line in what the caller wrote — the Node side owns the
        // arithmetic that maps it back (it knows the wrapper layout).
        line: null,
        stack: null,
        logs: []
    };

    var responsePath = mailboxDir + "/response-" + requestId + ".json";
    var tmpName = ".response-" + requestId + ".json.tmp";
    var tmpPath = mailboxDir + "/" + tmpName;

    /** Move the freshly written tmp file into place, replacing any stale answer. */
    function promoteTmp(tmp) {
        var dest = new File(responsePath);
        if (dest.exists) {
            try { dest.remove(); } catch (eRm) { /* ignore */ }
        }
        // File#rename takes a new name (not a path). tmp and dest share a
        // parent dir, so this is effectively atomic on NTFS — the poller
        // never sees a half-written response.
        tmp.rename("response-" + requestId + ".json");
    }

    /**
     * Strip `s` to the printable-ASCII characters that need no JSON escaping.
     * Only used by the fallback below, which has to build its JSON by hand
     * precisely because JSON.stringify is what just failed.
     */
    function jsonSafeAscii(s) {
        var t = String(s);
        var out = "";
        for (var i = 0; i < t.length; i++) {
            var c = t.charAt(i);
            var code = t.charCodeAt(i);
            out += (code >= 0x20 && code < 0x7f && c !== "\"" && c !== "\\") ? c : " ";
        }
        return out;
    }

    /**
     * Last resort when serializing the real response fails. Hand-builds a
     * minimal, provably well-formed error response so the caller learns
     * what happened immediately instead of waiting out its timeout —
     * which is the only thing it could do if we wrote nothing at all.
     */
    function writeFallbackResponse(why) {
        try {
            var phase = (response.phase === "execute") ? "execute" : "dispatch";
            var body = "{\"id\":\"" + jsonSafeAscii(requestId)
                + "\",\"ok\":false,\"phase\":\"" + phase
                + "\",\"result\":null,\"error\":\"" + jsonSafeAscii("could not serialize response: " + why)
                + "\",\"stack\":null,\"logs\":[]}";
            var tmp = new File(tmpPath);
            tmp.encoding = "UTF-8";
            if (!tmp.open("w")) return;
            tmp.write(body);
            tmp.close();
            promoteTmp(tmp);
        } catch (eFb) { /* nothing left to try; the caller will time out */ }
    }

    function writeResponse() {
        try {
            var tmp = new File(tmpPath);
            tmp.encoding = "UTF-8";
            if (!tmp.open("w")) {
                appendLog("FATAL: cannot open tmp response for write: " + tmp.error);
                return;
            }
            tmp.write(JSON.stringify(response));
            tmp.close();
            promoteTmp(tmp);
        } catch (e) {
            var why = describeError(e);
            appendLog("FATAL: writeResponse threw: " + why);
            writeFallbackResponse(why);
        }
    }

    // --- Read request (consume-on-read) --------------------------------
    var request = null;
    try {
        requestFile.encoding = "UTF-8";
        if (!requestFile.open("r")) {
            response.error = "cannot open " + requestName + ": " + requestFile.error;
            writeResponse();
            return;
        }
        var raw = requestFile.read();
        requestFile.close();
        // Consume so no other queued run can re-execute it. If the delete
        // fails we proceed anyway (degrades to the old behavior).
        try {
            if (!requestFile.remove()) appendLog("WARN: could not consume " + requestName);
        } catch (eRm2) {
            appendLog("WARN: consuming " + requestName + " threw: " + describeError(eRm2));
        }
        request = JSON.parse(raw);
    } catch (eReq) {
        response.error = "failed to read request: " + describeError(eReq);
        response.stack = errStack(eReq);
        writeResponse();
        return;
    }

    if (!request || typeof request.code !== "string") {
        response.error = "request missing `code` field";
        writeResponse();
        return;
    }
    if (request.id && String(request.id) !== requestId) {
        // Body and filename disagree — refuse rather than answer under an id
        // the caller is not polling for.
        response.error = "request id mismatch: filename says " + requestId + ", body says " + String(request.id);
        writeResponse();
        return;
    }

    // --- Execute user code, normally inside an undo group --------------
    // `undoGroup: false` marks a request that DRIVES the undo stack (Undo,
    // Redo). AE resolves those against the group that is still open, so
    // wrapping them reverts nothing the caller asked for and leaves the
    // stack describing a step that never happened — such a request runs
    // bare. A missing field means the old contract: group it.
    var undoLabel = "mcp-aftereffects: " + (request.label || "action");
    var wantUndoGroup = (request.undoGroup !== false);
    // Dialog suppression is its OWN request field, not the undo-group
    // condition: project boundary requests (project.open / project.new)
    // run ungrouped yet are exactly the calls most likely to pop a modal
    // (missing footage/fonts on open). Only requests that DRIVE the undo
    // stack — Undo/Redo — must stay unsuppressed: beginSuppressDialogs
    // opens an undo-transaction-like scope of its own, so wrapping them
    // makes AE resolve Undo against THAT scope (nothing reverts, the
    // stack pops unbalanced, "UndoGroup Mismatch" warnings, broken redo).
    // A missing field means the old contract: suppress when grouping.
    var wantSuppress = (typeof request.suppressDialogs === "boolean") ? request.suppressDialogs : wantUndoGroup;
    var undoOpen = false;
    var dialogsSuppressed = false;
    response.phase = "execute";
    try {
        if (wantSuppress) {
            // Suppress modal alerts for the duration of the request.
            // try/catch inside the executed code cannot stop everything:
            // project.open on an AEP with missing footage/fonts, or an
            // effect raising its own warning, pops a modal that blocks
            // every later `-r` launch until a human clicks OK. MUST be
            // undone in the finally below — left on, it would silently
            // eat dialogs for the user's whole session.
            try {
                app.beginSuppressDialogs();
                dialogsSuppressed = true;
            } catch (eSup) { /* unavailable — run with dialogs enabled */ }
        }

        if (wantUndoGroup) {
            app.beginUndoGroup(undoLabel);
            undoOpen = true;
        }

        // User code is a function body. Convention: `return <JSON-serializable>;`
        // `log(msg)` pushes breadcrumbs into response.logs; `payload` carries
        // bulk data that was NOT inlined into the source (see EvalRequest).
        var logs = response.logs;
        var fn = new Function(
            "app", "log", "payload",
            request.code
        );
        var result = fn(
            app,
            function (msg) { logs.push(String(msg)); },
            (typeof request.payload === "undefined") ? null : request.payload
        );

        response.result = (typeof result === "undefined") ? null : result;
        response.ok = true;
    } catch (eExec) {
        response.ok = false;
        response.error = describeError(eExec);
        response.stack = errStack(eExec);
        try {
            if (eExec && eExec.line !== undefined && eExec.line !== null) response.line = Number(eExec.line);
        } catch (eLine) { /* line stays null */ }
    } finally {
        if (undoOpen) {
            try { app.endUndoGroup(); } catch (eEnd) { /* ignore */ }
        }
        if (dialogsSuppressed) {
            // false: do NOT replay the suppressed alerts — that replay is
            // itself a modal, the exact thing being prevented. Whatever was
            // suppressed is already reported through response.error/logs.
            try { app.endSuppressDialogs(false); } catch (eEndSup) { /* ignore */ }
        }
    }

    writeResponse();
};
