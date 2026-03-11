import { Layer } from "effect";
import { AccessHealthRuntimeLive } from "./access-health-runtime-service.ts";
import { AccessProfileSelectionHealthSignalsGatewayLive } from "./access-profile-selection-health-runtime.ts";
import { AccessSelectionHealthSignalsGatewayLive } from "./access-selection-health-runtime.ts";

export const SharedAccessHealthRuntimeLive = AccessHealthRuntimeLive;

export const SharedAccessHealthSignalsLive = Layer.mergeAll(
  SharedAccessHealthRuntimeLive,
  AccessSelectionHealthSignalsGatewayLive.pipe(Layer.provide(SharedAccessHealthRuntimeLive)),
  AccessProfileSelectionHealthSignalsGatewayLive.pipe(Layer.provide(SharedAccessHealthRuntimeLive)),
);
