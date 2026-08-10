// Render queue operations.

import { registerOp, jsxVal, jsxCompPreamble } from "../registry.js";

registerOp({
  name: "render.add_to_queue",
  category: "render",
  description: "Add a composition to the render queue. Optionally set output path.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "outputPath",
      type: "string",
      description: "Output file path (optional, sets on the first output module)",
      required: false,
    },
  ],
  toJsx(args) {
    const outputPathJsx = args.outputPath
      ? `
                try {
                    _rqi.outputModules[1].file = new File(${jsxVal(args.outputPath)});
                    _result.outputPath = ${jsxVal(args.outputPath)};
                } catch(e) { _result.outputWarning = "could not set output path: " + AE.errText(e); }
            `
      : "";
    return `
            ${jsxCompPreamble(args)}
            var _rqi = app.project.renderQueue.items.add(_comp);
            var _result = { ok: true, queueIndex: app.project.renderQueue.numItems, compName: _comp.name };
            ${outputPathJsx}
            return _result;
        `;
  },
});

registerOp({
  name: "render.start",
  category: "render",
  description: "Start rendering the render queue. Blocks until complete.",
  params: [],
  toJsx() {
    return `
            var rq = app.project.renderQueue;
            if (rq.numItems === 0) return { ok: false, error: "render queue is empty" };
            rq.render();
            return { ok: true, rendered: rq.numItems };
        `;
  },
});

registerOp({
  name: "render.clear_queue",
  category: "render",
  description: "Remove all items from the render queue.",
  params: [],
  toJsx() {
    return `
            var rq = app.project.renderQueue;
            var removed = 0;
            while (rq.numItems > 0) {
                rq.item(1).remove();
                removed++;
            }
            return { ok: true, removed: removed };
        `;
  },
});

registerOp({
  name: "render.set_output",
  category: "render",
  description:
    "Configure a render-queue item: render-settings template, output-module template, output path, and time span. Discover template names with render.list_templates.",
  params: [
    {
      name: "queueIndex",
      type: "number",
      description: "1-based queue item index (default: last item)",
      required: false,
    },
    {
      name: "renderTemplate",
      type: "string",
      description: 'Render settings template name (e.g. "Best Settings", "Draft Settings")',
      required: false,
    },
    {
      name: "outputTemplate",
      type: "string",
      description: 'Output module template name (e.g. "Lossless", "High Quality")',
      required: false,
    },
    { name: "outputPath", type: "string", description: "Output file path", required: false },
    {
      name: "timeSpanStart",
      type: "number",
      description: "Render span start in seconds (comp time)",
      required: false,
    },
    {
      name: "timeSpanDuration",
      type: "number",
      description: "Render span duration in seconds",
      required: false,
    },
    {
      name: "outputModuleIndex",
      type: "number",
      description: "1-based output module index (default 1)",
      required: false,
      default: 1,
    },
  ],
  toJsx(args) {
    const rqiSets: string[] = [];
    if (args.renderTemplate !== undefined)
      rqiSets.push(
        `try { _rqi.applyTemplate(${jsxVal(args.renderTemplate)}); } catch (eRt) { _w.push("renderTemplate: " + AE.errText(eRt)); }`,
      );
    if (args.timeSpanStart !== undefined)
      rqiSets.push(
        `try { _rqi.timeSpanStart = ${jsxVal(args.timeSpanStart)}; } catch (eTs) { _w.push("timeSpanStart: " + AE.errText(eTs)); }`,
      );
    if (args.timeSpanDuration !== undefined)
      rqiSets.push(
        `try { _rqi.timeSpanDuration = ${jsxVal(args.timeSpanDuration)}; } catch (eTd) { _w.push("timeSpanDuration: " + AE.errText(eTd)); }`,
      );
    const omSets: string[] = [];
    if (args.outputTemplate !== undefined)
      omSets.push(
        `try { _om.applyTemplate(${jsxVal(args.outputTemplate)}); } catch (eOt) { _w.push("outputTemplate: " + AE.errText(eOt)); }`,
      );
    if (args.outputPath !== undefined)
      omSets.push(
        `try { _om.file = new File(${jsxVal(args.outputPath)}); } catch (eOp) { _w.push("outputPath: " + AE.errText(eOp)); }`,
      );
    return `
            var rq = app.project.renderQueue;
            if (rq.numItems === 0) return { ok: false, error: "render queue is empty" };
            var _qi = ${jsxVal(args.queueIndex ?? null)};
            if (_qi === null) _qi = rq.numItems;
            if (_qi < 1 || _qi > rq.numItems) return { ok: false, error: "queue index out of range (1-" + rq.numItems + ")" };
            var _rqi = rq.item(_qi);
            var _w = [];
            ${rqiSets.join("\n")}
            var _om = null;
            try { _om = _rqi.outputModule(${jsxVal(args.outputModuleIndex ?? 1)}); } catch (eOm) {}
            if (!_om) return { ok: false, error: "no output module at index " + ${jsxVal(args.outputModuleIndex ?? 1)} };
            ${omSets.join("\n")}
            return {
                ok: true,
                queueIndex: _qi,
                comp: _rqi.comp.name,
                timeSpanStart: _rqi.timeSpanStart,
                timeSpanDuration: _rqi.timeSpanDuration,
                outputPath: _om.file ? _om.file.fsName.replace(/\\\\/g, "/") : null,
                warnings: _w
            };
        `;
  },
});

registerOp({
  name: "render.list_templates",
  category: "render",
  readOnly: true,
  description:
    "List available render-settings templates and output-module templates. The render queue must have at least one item (templates are read from a queue item).",
  params: [],
  toJsx() {
    return `
            var rq = app.project.renderQueue;
            if (rq.numItems === 0) return { ok: false, error: "add a comp to the render queue first (render.add_to_queue) — templates are read from a queue item" };
            var _rqi = rq.item(1);
            var _render = [];
            var _output = [];
            try { _render = _rqi.templates; } catch (eR) {}
            try { _output = _rqi.outputModule(1).templates; } catch (eO) {}
            return { ok: true, renderTemplates: _render, outputTemplates: _output };
        `;
  },
});

registerOp({
  name: "render.status",
  category: "render",
  readOnly: true,
  description: "Report the render queue state: per-item status, time spans, and output paths.",
  params: [],
  toJsx() {
    return `
            var rq = app.project.renderQueue;
            var _statusNames = {};
            try {
                _statusNames[RQItemStatus.WILL_CONTINUE] = "WILL_CONTINUE";
                _statusNames[RQItemStatus.NEEDS_OUTPUT] = "NEEDS_OUTPUT";
                _statusNames[RQItemStatus.UNQUEUED] = "UNQUEUED";
                _statusNames[RQItemStatus.QUEUED] = "QUEUED";
                _statusNames[RQItemStatus.RENDERING] = "RENDERING";
                _statusNames[RQItemStatus.USER_STOPPED] = "USER_STOPPED";
                _statusNames[RQItemStatus.ERR_STOPPED] = "ERR_STOPPED";
                _statusNames[RQItemStatus.DONE] = "DONE";
            } catch (eSn) {}
            var _items = [];
            for (var _i = 1; _i <= rq.numItems; _i++) {
                var _rqi = rq.item(_i);
                var _outputs = [];
                try {
                    for (var _o = 1; _o <= _rqi.numOutputModules; _o++) {
                        var _f = _rqi.outputModule(_o).file;
                        _outputs.push(_f ? _f.fsName.replace(/\\\\/g, "/") : null);
                    }
                } catch (eOut) {}
                _items.push({
                    index: _i,
                    comp: _rqi.comp ? _rqi.comp.name : null,
                    status: _statusNames[_rqi.status] || String(_rqi.status),
                    render: _rqi.render,
                    timeSpanStart: _rqi.timeSpanStart,
                    timeSpanDuration: _rqi.timeSpanDuration,
                    elapsedSeconds: AE.safeGet(function () { return _rqi.elapsedSeconds; }, null),
                    outputs: _outputs
                });
            }
            return { ok: true, rendering: rq.rendering, numItems: rq.numItems, canQueueInAME: AE.safeGet(function () { return rq.canQueueInAME; }, false), items: _items };
        `;
  },
});

registerOp({
  name: "render.queue_in_ame",
  category: "render",
  description:
    "Send the render queue to Adobe Media Encoder (for H.264/HEVC etc.). Requires AME installed. renderImmediately=true starts the AME queue.",
  params: [
    {
      name: "renderImmediately",
      type: "boolean",
      description: "Start rendering in AME right away (default false)",
      required: false,
      default: false,
    },
  ],
  toJsx(args) {
    return `
            var rq = app.project.renderQueue;
            if (rq.numItems === 0) return { ok: false, error: "render queue is empty" };
            if (typeof rq.queueInAME !== "function") return { ok: false, error: "queueInAME not available (needs AE 14.0 / CC 2017+)" };
            var _can = false;
            try { _can = rq.canQueueInAME; } catch (eC) {}
            if (!_can) return { ok: false, error: "cannot queue in AME — is Adobe Media Encoder installed and at least one item queued?" };
            rq.queueInAME(${jsxVal(!!args.renderImmediately)});
            return { ok: true, sent: rq.numItems, renderImmediately: ${jsxVal(!!args.renderImmediately)} };
        `;
  },
});
