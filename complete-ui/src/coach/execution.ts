/** Cancellation is control flow, never permission to publish a fallback answer. */
import type {QuestionContext} from "./question-context";
import type {Dataset,Period} from "@/engine";
export type CoachExecution={data?:Dataset;period?:Period;signal?:AbortSignal;context?:QuestionContext};
export class CoachCancelledError extends Error {
  constructor() {super("Coach request cancelled");this.name="CoachCancelledError";}
}
export function throwIfCancelled(signal?:AbortSignal):void {
  if(signal?.aborted) throw new CoachCancelledError();
}
