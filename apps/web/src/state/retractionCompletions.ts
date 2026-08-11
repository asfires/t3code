import { ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import { connectionAtomRuntime } from "../connection/runtime";

export const threadRetractionCompletions = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:thread-retraction-completions",
    tag: ORCHESTRATION_WS_METHODS.subscribeThread,
    idleTtlMs: 0,
    transform: (stream) =>
      stream.pipe(
        Stream.filterMap((item) =>
          item.kind === "event" &&
          item.event.type === "thread.reverted" &&
          item.event.payload.retraction !== undefined
            ? Result.succeed({
                threadId: item.event.payload.threadId,
                retraction: item.event.payload.retraction,
              })
            : Result.failVoid,
        ),
      ),
  },
);
