import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect } from "react";

import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { threadRetractionCompletions } from "../../state/retractionCompletions";
import {
  type FirstMessageRetractionCompletion,
  handoffCompletedFirstMessageRetraction,
  type PendingRetractionRecovery,
} from "./lastUserMessageRecovery";

export function RetractionRecoveryHandoff(props: {
  environmentId: EnvironmentId;
  recovery: PendingRetractionRecovery;
  projectedCompletion: FirstMessageRetractionCompletion | null;
  navigate: (input: {
    to: "/draft/$draftId";
    params: { draftId: DraftId };
    replace: true;
  }) => unknown;
}) {
  const result = useAtomValue(
    threadRetractionCompletions({
      environmentId: props.environmentId,
      input: { threadId: props.recovery.sourceThreadRef.threadId, turnLimit: 1 },
    }),
  );
  const liveCompletion = Option.getOrNull(AsyncResult.value(result));
  const completion = liveCompletion ?? props.projectedCompletion;
  const recoveryDraftReady = useComposerDraftStore(
    (store) => store.getDraftSession(props.recovery.draftId) !== null,
  );

  useEffect(() => {
    if (!completion || !recoveryDraftReady) return;
    handoffCompletedFirstMessageRetraction({
      capabilityEnabled: true,
      environmentId: props.environmentId,
      completion,
      navigate: props.navigate,
    });
  }, [completion, props.environmentId, props.navigate, recoveryDraftReady]);

  return null;
}
