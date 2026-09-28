// mcp-aftereffects resident agent — the PULL path.
//
// Lives inside one After Effects instance for the whole session and serves
// that instance's own mailbox, <runtime>/instances/<id>/, from a scheduled
// task. It gets there through the user-level Scripts/Startup folder: the
// stub that `mcp-aftereffects install-agent` drops there $.evalFile's this
// file at startup, in EVERY instance — including the ones started with
// `AfterFX.exe -m`, which the push path (`-r`) can never reach: `-r` is handed
// to whichever AE registered as THE running instance, `-m` instances never
// register, and with none registered the launched AfterFX.exe boots a
// throwaway instance of its own, runs the script on an empty project and
// quits. (Verified on AE 26.3.)
//
// Identity. The instance id is, in order:
//   1. AE_MCP_INSTANCE from the AE process's own environment — `$.getenv`
//      reads the launching shell's variable, so `set AE_MCP_INSTANCE=shotA`
//      before `AfterFX.exe -m` names the instance deterministically;
//   2. otherwise a random `ae-xxxxxx`. The heartbeat carries the open
//      project's path, so the Node side can still address such an instance
//      by project name.
//
// Each tick (250 ms): refresh the heartbeat (every second, or on any state
// change), then serve at most ONE pending request through AE_MCP.serveRequest
// (jsx/serve.jsx — the same code the dispatcher uses). The heartbeat is
// flagged `busy` around a request so a stale timestamp during a long call
// (ticks do not fire while a script runs) is not mistaken for a dead instance.
//
// SECURITY: same trust boundary as the shared mailbox — whoever can write
// into <runtime>/instances/<id>/ executes code inside this AE. The directory
// sits under the per-user temp dir like the rest of the runtime. Two things
// differ from the dispatcher, and both come from being resident:
//   - this code runs for the whole session, server or no server, so the
//     directory is live the entire time After Effects is, not just while a
//     call is in flight;
//   - the mailbox is PINNED by the install stub and runtime-dir.txt is never
//     followed. The dispatcher follows that pointer because the server that
//     launched it wrote it moments before; a resident poller following it
//     would let any local writer plant a pointer and redirect every instance
//     to a mailbox of their own, silently, for the rest of the session.
//
// Keep this file ES3: var only, no arrow functions, no Array.prototype.map.

#include "json2.jsx"
#include "helpers.jsx"
#include "export.jsx"
#include "import.jsx"
#include "toolkit.jsx"
#include "serve.jsx"

(function agentEntry() {
    var AGENT_VERSION = 1;
    var TICK_MS = 250;
    var HEARTBEAT_MS = 1000;

    // Own copy of the exception formatter (see serve.jsx): the guard below must
    // be able to report a failure even when an #include did not take.
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

    function normalizePath(p) {
        return String(p).replace(/\\/g, "/");
    }

    /**
     * Instance ids become directory names. Keep them to [A-Za-z0-9._-] (the
     * Node side applies the same rule), collapse runs of anything else into
     * one dash, and cap the length. Returns null for an empty result.
     */
    function sanitizeId(raw) {
        if (raw === null || raw === undefined) return null;
        var s = String(raw).replace(/^\s+|\s+$/g, "");
        if (s.length === 0) return null;
        s = s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
        if (s.length > 64) s = s.substring(0, 64);
        return s.length > 0 ? s : null;
    }

    function randomId() {
        var alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
        var out = "ae-";
        for (var i = 0; i < 6; i++) out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
        return out;
    }

    /** Create every missing segment of `dir` in turn (Folder.create is not mkdir -p). */
    function ensureDir(dir) {
        var parts = normalizePath(dir).split("/");
        var cur = "";
        for (var i = 0; i < parts.length; i++) {
            if (parts[i].length === 0 && i > 0) continue;
            cur = (i === 0) ? parts[i] : cur + "/" + parts[i];
            if (cur.length === 0 || /^[A-Za-z]:$/.test(cur)) continue;
            var f = new Folder(cur);
            if (!f.exists) f.create();
        }
        return new Folder(dir).exists;
    }

    function writeAtomic(p, text) {
        var dest = new File(p);
        var tmp = new File(p + ".tmp");
        tmp.encoding = "UTF-8";
        if (!tmp.open("w")) return false;
        tmp.write(text);
        tmp.close();
        if (dest.exists) {
            try { dest.remove(); } catch (eRm) { /* ignore */ }
        }
        return tmp.rename(dest.name);
    }

    // --- Where the mailbox lives ------------------------------------------
    // Pinned by the install stub: $.global.AE_MCP_AGENT_MAILBOX is the
    // server's RUNTIME_DIR at install time (computed from os.tmpdir(), which
    // need not equal Folder.temp on macOS). Without a stub — this file
    // evaluated some other way — the default both sides compute. Never the
    // runtime-dir.txt pointer (see the SECURITY note above): a server running
    // with a custom AE_MCP_RUNTIME_DIR needs `install-agent` re-run, and
    // `agent-status` reports the stub as stale until then.
    function mailboxDir() {
        try {
            var pinned = $.global.AE_MCP_AGENT_MAILBOX;
            if (pinned) return normalizePath(String(pinned));
        } catch (ePinned) { /* not pinned */ }
        return normalizePath(Folder.temp.fsName) + "/mcp-aftereffects/runtime";
    }

    /** Where the stub's own breadcrumbs go (agent-fatal.log). Not a mailbox. */
    function runtimeRoot() {
        try {
            var injected = $.global.AE_MCP_RUNTIME_ROOT_OVERRIDE;
            if (injected) return normalizePath(String(injected));
        } catch (eInjected) { /* not injected */ }
        return normalizePath(Folder.temp.fsName) + "/mcp-aftereffects";
    }

    function agentMain() {
        // One agent per process. A second evaluation (a `-r` run of this file,
        // a second stub) must not install a second poller: two tasks would
        // race over the same mailbox.
        if ($.global.AE_MCP_AGENT) return;

        var envId = null;
        try { envId = sanitizeId($.getenv("AE_MCP_INSTANCE")); } catch (eEnv) { /* no env access */ }

        var state = {
            id: envId || randomId(),
            idSource: envId ? "env" : "random",
            agentVersion: AGENT_VERSION,
            startedAt: new Date().getTime(),
            ticks: 0,
            served: 0,
            busy: false,
            busySince: null,
            dir: null,
            taskId: null,
            lastHeartbeatAt: 0,
            lastError: null
        };

        function projectInfo() {
            var info = { project: null, projectName: null, dirty: false, numItems: 0 };
            try {
                var proj = app.project;
                info.dirty = !!proj.dirty;
                info.numItems = proj.numItems;
                if (proj.file) {
                    info.project = normalizePath(proj.file.fsName);
                    info.projectName = String(proj.file.displayName);
                }
            } catch (eProj) { /* project unreadable — report what we have */ }
            return info;
        }

        function heartbeat(force) {
            var now = new Date().getTime();
            if (!force && now - state.lastHeartbeatAt < HEARTBEAT_MS) return;
            if (state.dir === null) return;
            var info = projectInfo();
            var hb = {
                id: state.id,
                idSource: state.idSource,
                agentVersion: state.agentVersion,
                aeVersion: app.version,
                project: info.project,
                projectName: info.projectName,
                dirty: info.dirty,
                numItems: info.numItems,
                startedAt: state.startedAt,
                ticks: state.ticks,
                served: state.served,
                busy: state.busy,
                busySince: state.busySince,
                lastError: state.lastError,
                ts: now
            };
            writeAtomic(state.dir + "/heartbeat.json", JSON.stringify(hb));
            state.lastHeartbeatAt = now;
        }

        function tick() {
            try {
                state.ticks++;
                var dir = mailboxDir() + "/instances/" + state.id;
                if (dir !== state.dir) {
                    if (!ensureDir(dir)) return;
                    state.dir = dir;
                    heartbeat(true);
                }
                heartbeat(false);

                var request = AE_MCP.oldestRequestIn(state.dir);
                if (request === null) return;

                state.busy = true;
                state.busySince = new Date().getTime();
                heartbeat(true);
                try {
                    AE_MCP.serveRequest(request, state.dir, state.dir + "/agent.log");
                } finally {
                    state.busy = false;
                    state.busySince = null;
                    state.served++;
                    heartbeat(true);
                }
            } catch (eTick) {
                state.lastError = describeError(eTick);
                try {
                    if (state.dir !== null) AE_MCP.appendLog(state.dir + "/agent.log", "tick failed: " + state.lastError);
                } catch (eLog) { /* ignore */ }
            }
        }

        $.global.AE_MCP_AGENT = {
            state: state,
            tick: tick,
            /** Stop polling (mainly for tests and manual recovery). */
            stop: function () {
                try {
                    if (state.taskId !== null) app.cancelTask(state.taskId);
                } catch (eCancel) { /* ignore */ }
                state.taskId = null;
            }
        };
        // Run once now so the instance is registered before the first
        // scheduled tick, then keep going for the life of the process.
        tick();
        state.taskId = app.scheduleTask("$.global.AE_MCP_AGENT.tick()", TICK_MS, true);
    }

    // --- Top-level guard ---------------------------------------------------
    // A startup script that throws surfaces as a modal at every launch of
    // every instance. Swallow, leave a breadcrumb where we can.
    try {
        agentMain();
    } catch (eTop) {
        try {
            var crumb = new File(runtimeRoot() + "/agent-fatal.log");
            crumb.encoding = "UTF-8";
            if (crumb.open("a")) {
                crumb.writeln("[" + new Date().toString() + "] FATAL: agent threw: " + describeError(eTop));
                crumb.close();
            }
        } catch (eSilent) { /* deliberately silent */ }
    }
})();
