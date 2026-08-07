// Minimal JSON polyfill for ExtendScript (ES3).
// Installed only when the global JSON is missing. Whether that is the case in
// any given After Effects build is not something to rely on either way: the
// fallback below is written to be safe on untrusted input regardless, because
// everything the dispatcher reads — including caller-supplied project
// documents travelling as `payload` — flows through JSON.parse.
if (typeof JSON === "undefined" || !JSON || typeof JSON.stringify !== "function" || typeof JSON.parse !== "function") {
    (function () {
        var escMap = {
            "\\": "\\\\",
            "\"": "\\\"",
            "\b": "\\b",
            "\f": "\\f",
            "\n": "\\n",
            "\r": "\\r",
            "\t": "\\t"
        };
        function escString(s) {
            var out = "\"";
            for (var i = 0; i < s.length; i++) {
                var ch = s.charAt(i);
                var code = s.charCodeAt(i);
                if (escMap[ch]) {
                    out += escMap[ch];
                } else if (code < 0x20 || code === 0x7f) {
                    var hex = code.toString(16);
                    while (hex.length < 4) hex = "0" + hex;
                    out += "\\u" + hex;
                } else {
                    out += ch;
                }
            }
            return out + "\"";
        }
        function stringify(v) {
            if (v === null || v === undefined) return "null";
            var t = typeof v;
            if (t === "number") {
                return isFinite(v) ? String(v) : "null";
            }
            if (t === "boolean") return v ? "true" : "false";
            if (t === "string") return escString(v);
            if (t === "object") {
                if (v instanceof Array || (typeof v.length === "number" && v.hasOwnProperty && v.hasOwnProperty("length"))) {
                    var parts = [];
                    for (var i = 0; i < v.length; i++) {
                        parts.push(stringify(v[i]));
                    }
                    return "[" + parts.join(",") + "]";
                }
                var kparts = [];
                for (var k in v) {
                    if (!v.hasOwnProperty(k)) continue;
                    var val = v[k];
                    if (typeof val === "function" || typeof val === "undefined") continue;
                    kparts.push(escString(k) + ":" + stringify(val));
                }
                return "{" + kparts.join(",") + "}";
            }
            return "null";
        }
        function parse(text) {
            // eval is the only parser available in ES3, so it is guarded by
            // Crockford's four-stage check from json2.js: after neutralizing
            // escape sequences and whole string literals, whatever remains must
            // consist solely of JSON structural characters. Anything that could
            // execute — a call, an identifier, an assignment — leaves a
            // character the final test rejects.
            //
            // The guard is NOT decoration. Untrusted content reaches here: the
            // dispatcher parses the whole request file with this, and a request
            // carries `payload`, which for ae_project_import_json is the
            // contents of an arbitrary .json file the caller pointed at.
            var t = String(text);
            // U+2028/U+2029 are legal raw inside JSON strings but are line
            // terminators to this ES3 parser — escape before validating.
            t = t.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
            // Three stages, in this order: neutralize escape sequences, then
            // collapse every complete string/number/keyword to a single "]",
            // then drop the opening brackets that legitimately precede a value.
            var probe = t
                .replace(/\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g, "@")
                .replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, "]")
                .replace(/(?:^|:|,)(?:\s*\[)+/g, "");
            if (!/^[\],:{}\s]*$/.test(probe)) {
                throw new Error("JSON.parse: input is not valid JSON");
            }
            return eval("(" + t + ")");
        }
        JSON = { stringify: stringify, parse: parse };
    })();
}
