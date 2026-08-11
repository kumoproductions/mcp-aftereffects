// mcp-aftereffects dispatcher — invoked by `AfterFX.exe -r dispatcher.jsx`.
//
// Contract with the Node side:
//   1. Node writes <runtime>/request-<id>.json:
//      { id, label, code, payload, undoGroup }
//   2. Node spawns `AfterFX.exe -r dispatcher.jsx`
//   3. We locate the mailbox, pick the OLDEST pending request-*.json, DELETE it
//      (consume-on-read), eval `code` with `payload` in scope — inside an undo
//      group unless the request set `undoGroup: false` — and write
//      <runtime>/response-<id>.json atomically.
//   4. Node polls for response-<id>.json — only ever its own.
//
// Per-id files, not a single request.json/response.json pair: two MCP clients
// (or two server processes) share one AE instance and therefore one mailbox.
// With a single pair, one client could delete another's response or overwrite
// an unconsumed request. With per-id files neither is expressible — each
// dispatcher run consumes exactly one request and answers exactly its author.
//
// The id comes from the FILENAME, not the JSON body, so even a corrupt or
// unparseable request still produces a correlated response instead of a
// 60-second timeout on the Node side.
//
// Consume-on-read matters: when a call times out Node-side, its spawned
// dispatcher run may still be queued inside AE. Without consumption that stale
// run would pick up another pending request and execute it — while that
// request's own spawn executes it a second time (double mutation). With
// consumption, exactly one dispatcher run executes each request; a spawn that
// finds no pending request logs and exits WITHOUT writing anything.
//
// All other failure modes must write a response — never let an exception
// escape to AE's modal error dialog. If we crash before writing, Node will
// time out. Two mechanisms enforce that here: `describeError` (never
// concatenate a raw exception — see below) and the top-level guard at the
// bottom of this file.

#include "json2.jsx"
#include "helpers.jsx"
#include "export.jsx"
#include "import.jsx"

(function dispatcherEntry() {
    // --- Talking about exceptions safely -----------------------------------
    // `"failed: " + e` is not a safe way to report an error in ExtendScript.
    // The engine cannot coerce an Error to a primitive, so the concatenation
    // ITSELF throws ("Object of type Error found where a Number, Array, or
    // Property is needed") — from inside the handler whose whole job was to
    // report the original failure. The real error is lost, the replacement
    // escapes, and AE raises a modal that blocks all scripting until a human
    // clicks OK; every later call then fails as a busy-lock timeout.
    //
    // So: nothing in this file interpolates an exception directly. Everything
    // goes through these two. helpers.jsx exposes the same formatter as
    // AE.errText for generated code; the dispatcher keeps its own copy so it
    // remains able to report failures even if an #include did not take.
    function describeError(e) {
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
    }

    function errStack(e) {
        try {
            return (e && e.stack) ? String(e.stack) : null;
        } catch (eSt) {
            return null;
        }
    }

    // Published as soon as the mailbox is known so the top-level guard has
    // somewhere to write if anything below it dies.
    var fatalLogPath = null;

    function dispatcherMain() {
        var REQUEST_PREFIX = "request-";
        var REQUEST_SUFFIX = ".json";

        function normalizePath(p) {
            return String(p).replace(/\\/g, "/");
        }

        // --- Locate the mailbox --------------------------------------------
        // SECURITY: whatever directory we pick, we execute the `code` string of
        // a request found there. There is no signature to check — the mailbox
        // IS the trust boundary, and the capability policy (AE_MCP_READONLY,
        // AE_MCP_ENABLE_EVAL, category allowlist) lives entirely on the Node
        // side and cannot help here. So the list of places we are willing to
        // read from is kept as short as it can be:
        //
        //   0. $.global.AE_MCP_RUNTIME_DIR_OVERRIDE — set by the macOS
        //      launcher's DoScript bootstrap, which (unlike `-r`) can pass data
        //      in. It names the exact mailbox of the server that launched THIS
        //      run. When it is present it is used ALONE: falling back would mean
        //      executing a request some other party left somewhere else.
        //   1. AE_MCP_RUNTIME_DIR, published by Node as a pointer file (the env
        //      var itself is invisible to us: `-r` is delivered to the
        //      already-running AE process, whose environment is not the
        //      spawner's).
        //   2. <temp>/mcp-aftereffects/runtime — the default both sides compute.
        //
        // The in-package location (<script>/../runtime) is deliberately NOT a
        // candidate: an install directory is far more likely to be writable by
        // other users than a per-user temp dir.
        function candidateRuntimeDirs() {
            var dirs = [];
            try {
                var injected = $.global.AE_MCP_RUNTIME_DIR_OVERRIDE;
                if (injected) {
                    // Authoritative and exclusive — see above.
                    return [normalizePath(String(injected))];
                }
            } catch (eInjected) { /* not injected — a Windows `-r` launch */ }
            var tempRoot = null;
            try {
                tempRoot = normalizePath(Folder.temp.fsName) + "/mcp-aftereffects";
            } catch (eTemp) { /* no temp folder — nothing we are willing to read */ }

            if (tempRoot !== null) {
                try {
                    var pointer = new File(tempRoot + "/runtime-dir.txt");
                    if (pointer.exists) {
                        pointer.encoding = "UTF-8";
                        if (pointer.open("r")) {
                            var pointed = pointer.read();
                            pointer.close();
                            if (pointed) {
                                pointed = normalizePath(pointed).replace(/^\s+|\s+$/g, "");
                                if (pointed.length > 0) dirs.push(pointed);
                            }
                        }
                    }
                } catch (ePtr) { /* unreadable pointer — use the default below */ }
                dirs.push(tempRoot + "/runtime");
            }

            return dirs;
        }

        /** Oldest pending request in `dir`, or null. Oldest-first keeps a backlog fair. */
        function oldestRequestIn(dir) {
            try {
                var folder = new Folder(dir);
                if (!folder.exists) return null;
                var files = folder.getFiles(REQUEST_PREFIX + "*" + REQUEST_SUFFIX);
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
        }

        var runtimeDir = null;
        var requestFile = null;
        var candidates = candidateRuntimeDirs();
        for (var ci = 0; ci < candidates.length; ci++) {
            var found = oldestRequestIn(candidates[ci]);
            if (found !== null) {
                runtimeDir = candidates[ci];
                requestFile = found;
                break;
            }
        }

        if (requestFile === null) {
            // Nothing pending: normally this means another dispatcher run
            // (spawned earlier, executed late by AE) already consumed the
            // request and will write the response — so exit WITHOUT writing
            // anything, or we would clobber it. It can ALSO mean the two sides
            // disagree about where the mailbox is (e.g. AE running as a
            // different user, so a different Folder.temp). Leave a breadcrumb
            // listing what we searched: the Node side can only report a bare
            // timeout for that case.
            try {
                var diagDir = candidates.length > 0 ? candidates[candidates.length - 1] : null;
                for (var di = 0; di < candidates.length; di++) {
                    if (new Folder(candidates[di]).exists) { diagDir = candidates[di]; break; }
                }
                if (diagDir !== null) {
                    var diag = new File(diagDir + "/dispatcher.log");
                    diag.encoding = "UTF-8";
                    if (diag.open("a")) {
                        diag.writeln("[" + new Date().toString() + "] no pending request; searched: " + candidates.join(" | "));
                        diag.close();
                    }
                }
            } catch (eDiag) { /* ignore */ }
            return;
        }

        var logPath = runtimeDir + "/dispatcher.log";
        fatalLogPath = logPath;

        function appendLog(msg) {
            // Fire-and-forget log; swallow errors so logging never breaks dispatch.
            try {
                var lf = new File(logPath);
                lf.encoding = "UTF-8";
                lf.open("a");
                lf.writeln("[" + new Date().toString() + "] " + msg);
                lf.close();
            } catch (e) { /* ignore */ }
        }

        // Top-of-dispatcher marker — proves we reached this point even if later
        // steps fail. Always attempted; errors silenced.
        try {
            var startMarker = new File(runtimeDir + "/dispatcher_start.txt");
            startMarker.encoding = "UTF-8";
            startMarker.open("w");
            startMarker.write("start:" + new Date().toString() + " version:" + app.version + " numItems:" + app.project.numItems);
            startMarker.close();
        } catch (eMark) { /* ignore */ }

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
            stack: null,
            logs: []
        };

        var responsePath = runtimeDir + "/response-" + requestId + ".json";
        var tmpName = ".response-" + requestId + ".json.tmp";
        var tmpPath = runtimeDir + "/" + tmpName;

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
         * what happened immediately instead of waiting out its 60s timeout —
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
            // Consume so no other queued dispatcher run can re-execute it. If the
            // delete fails we proceed anyway (degrades to the old behavior).
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
        var undoOpen = false;
        response.phase = "execute";
        try {
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
        } finally {
            if (undoOpen) {
                try { app.endUndoGroup(); } catch (eEnd) { /* ignore */ }
            }
        }

        writeResponse();
    }

    // --- Top-level guard ---------------------------------------------------
    // Nothing may escape from here into AE's modal error dialog. A modal blocks
    // every subsequent `-r` launch for the rest of the session, which the Node
    // side can only observe as call after call timing out on the busy lock — a
    // symptom that says nothing about the cause. Losing a log line is the
    // cheaper failure, so this catch swallows.
    try {
        dispatcherMain();
    } catch (eTop) {
        try {
            if (fatalLogPath !== null) {
                var fatalLog = new File(fatalLogPath);
                fatalLog.encoding = "UTF-8";
                if (fatalLog.open("a")) {
                    fatalLog.writeln("[" + new Date().toString() + "] FATAL: dispatcher threw: " + describeError(eTop));
                    fatalLog.close();
                }
            }
        } catch (eSilent) { /* deliberately silent — see above */ }
    }
})();
