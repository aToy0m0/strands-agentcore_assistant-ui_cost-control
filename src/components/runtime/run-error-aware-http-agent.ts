import {
  HttpAgent,
  type AgentSubscriber,
  type RunAgentResult,
} from "@ag-ui/client";

export function bridgeRunErrorSubscriber(subscriber?: AgentSubscriber): AgentSubscriber | undefined {
  if (!subscriber || subscriber.onRunErrorEvent) return subscriber;

  return {
    ...subscriber,
    onRunErrorEvent: async ({ event, ...params }) => {
      const error = new Error(event.message || "Agent run failed") as Error & { code?: string };
      if (event.code) error.code = event.code;
      return subscriber.onRunFailed?.({ ...params, error });
    },
  };
}

export class RunErrorAwareHttpAgent extends HttpAgent {
  override runAgent(
    parameters?: Parameters<HttpAgent["runAgent"]>[0],
    subscriber?: AgentSubscriber,
  ): Promise<RunAgentResult> {
    return super.runAgent(parameters, bridgeRunErrorSubscriber(subscriber));
  }
}
