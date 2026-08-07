// Import all operation modules to trigger their registerOp() calls.
// Add new operation files here.

import { evalRunEnabled } from "../policy.js";

import "./layer.js";
import "./keyframe.js";
import "./expression.js";
import "./effect.js";
import "./transform.js";
import "./comp.js";
import "./shape.js";
import "./project.js";
import "./text.js";
import "./mask.js";
import "./command.js";
import "./property.js";
import "./marker.js";
import "./batch.js";
import "./timeline.js";
import "./layer-advanced.js";
import "./render.js";
import "./inspect.js";
import "./footage.js";
import "./item.js";
import "./font.js";
import "./egp.js";
import "./viewer.js";

// eval.run executes arbitrary ExtendScript (file I/O, system.callSystem,
// Socket, …). Opt-in: it enters the registry only when AE_MCP_ENABLE_EVAL=1
// is set and read-only mode is off. `denyOperation` re-checks at call time,
// so policy holds even for a registry that was populated under different env.
if (evalRunEnabled()) {
  await import("./eval.js");
}
