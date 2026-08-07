// A transport that never talks to After Effects. Two uses:
//   - proving a code path rejected a call BEFORE any IPC happened (assert on
//     `calls.length === 0`)
//   - feeding a canned dispatcher response through the tool layer

import type { AeTransport, EvalRequest, EvalResult } from "../../src/transport/AeTransport.js";

export interface NullTransport extends AeTransport {
  calls: EvalRequest[];
}

export function nullTransport(next?: Partial<EvalResult>): NullTransport {
  const calls: EvalRequest[] = [];
  return {
    calls,
    async execute(req: EvalRequest): Promise<EvalResult> {
      calls.push(req);
      return {
        ok: true,
        result: null,
        error: null,
        errorCode: null,
        stack: null,
        logs: [],
        durationMs: 0,
        ...next,
      };
    },
  };
}
