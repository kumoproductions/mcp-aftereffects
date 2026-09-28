// mcp-aftereffects dispatcher — invoked by `AfterFX.exe -r dispatcher.jsx`
// (Windows) or an osascript DoScript bootstrap (macOS). This is the PUSH path.
//
// Contract with the Node side:
//   1. Node writes <runtime>/request-<id>.json:
//      { id, label, code, payload, undoGroup, suppressDialogs }
//   2. Node launches this file inside the running After Effects.
//   3. We locate the mailbox, pick the OLDEST pending request-*.json, and hand
//      it to AE_MCP.serveRequest (jsx/serve.jsx), which deletes it
//      (consume-on-read), evals `code` and writes <runtime>/response-<id>.json.
//   4. Node polls for response-<id>.json — only ever its own.
//
// Per-id files, not a single request.json/response.json pair: two MCP clients
// (or two server processes) share one AE instance and therefore one mailbox.
// With a single pair, one client could delete another's response or overwrite
// an unconsumed request. With per-id files neither is expressible — each
// dispatcher run consumes exactly one request and answers exactly its author.
//
// Consume-on-read matters: when a call times out Node-side, its spawned
// dispatcher run may still be queued inside AE. Without consumption that stale
// run would pick up another pending request and execute it — while that
// request's own spawn executes it a second time (double mutation). With
// consumption, exactly one dispatcher run executes each request; a spawn that
// finds no pending request logs and exits WITHOUT writing anything.
//
// Push cannot address an instance. `-r` is handed to whichever AE registered
// as THE running instance; instances started with `AfterFX.exe -m` never
// receive it, and with no such instance the launched AfterFX.exe boots one of
// its own, runs the script on an empty project, and quits. Multiple instances
// are served by the PULL path instead: jsx/agent.jsx, resident in each
// instance via its Startup folder, polling <runtime>/instances/<id>/. The two
// paths share the serving code and never read each other's mailbox.

#include "json2.jsx"
#include "helpers.jsx"
#include "export.jsx"
#include "import.jsx"
#include "toolkit.jsx"
#include "serve.jsx"

(function dispatcherEntry() {
    // Own copy of the exception formatter (see serve.jsx for why `"" + e` is
    // not safe): the top-level guard must be able to report a failure even
    // when an #include did not take and AE_MCP is missing.
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

    // Published as soon as the mailbox is known so the top-level guard has
    // somewhere to write if anything below it dies.
    var fatalLogPath = null;

    function dispatcherMain() {
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

        var runtimeDir = null;
        var requestFile = null;
        var candidates = candidateRuntimeDirs();
        for (var ci = 0; ci < candidates.length; ci++) {
            var found = AE_MCP.oldestRequestIn(candidates[ci]);
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
                    AE_MCP.appendLog(diagDir + "/dispatcher.log",
                        "no pending request; searched: " + candidates.join(" | "));
                }
            } catch (eDiag) { /* ignore */ }
            return;
        }

        var logPath = runtimeDir + "/dispatcher.log";
        fatalLogPath = logPath;

        // Top-of-dispatcher marker — proves we reached this point even if later
        // steps fail. Always attempted; errors silenced.
        try {
            var startMarker = new File(runtimeDir + "/dispatcher_start.txt");
            startMarker.encoding = "UTF-8";
            startMarker.open("w");
            startMarker.write("start:" + new Date().toString() + " version:" + app.version + " numItems:" + app.project.numItems);
            startMarker.close();
        } catch (eMark) { /* ignore */ }

        AE_MCP.serveRequest(requestFile, runtimeDir, logPath);
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
