export { endpointIdentity, ModelInteractionCapture } from "./capture.js";
export type { CapturedModelExchange, ModelInteractionCaptureOptions } from "./capture.js";
export { normalizeModelCapturePolicy, planModelCapture } from "./policy.js";
export { loadInteractionCapture, parseInteractionCaptureRef, parseModelInteraction } from "./records.js";
export { HostModelProxy } from "./proxy.js";
export type { HostModelProxyOptions, HostModelProxyRuntimeIdentity } from "./proxy.js";
export { LocalModelGateway } from "./local-gateway.js";
export type { LocalModelGatewayOptions, LocalModelGatewayRegistration } from "./local-gateway.js";

export { parseTrainingBinding, trainingProxyIdentity, registerTrainingEndpoint, resolveTrainingEndpoint, readTrainingRegistration } from "./training.js";
export type { RegisteredTrainingEndpoint } from "./training.js";
export { parseRemoteModelBinding, remoteModelBinding, callRemoteModel } from "./remote-model.js";
export type { RemoteModelTargetV2 } from "./remote-model.js";
export { scrubLocalInferenceEnvironment } from "./environment.js";
