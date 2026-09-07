import type { Sha256 } from "./ids.js";

export type ModelCaptureModeV1 = "off" | "native" | "proxy" | "hybrid";

export interface ModelCapturePolicyV1 {
  mode: ModelCaptureModeV1;
  required: boolean;
}

export interface ModelCapturePlanV1 {
  requested_mode: ModelCaptureModeV1;
  effective_mode: ModelCaptureModeV1;
  required: boolean;
  topology?: "host-side" | "in-sandbox";
  degraded_reason?: string;
}

export interface ModelProxyRouteV1 {
  schema_version: "1";
  mode: "proxy" | "hybrid";
  required: boolean;
  topology: "host-side" | "in-sandbox";
  base_url_template: string;
  health_url_template: string;
  managed_inference?: { inference_id: Sha256; model_id: Sha256 };
}

export interface ModelInteractionV1 {
  schema_version: "1";
  interaction_id: string;
  run_id: string;
  eval_id?: string;
  trial_id?: string;
  sequence: number;
  requested_model: string;
  effective_model?: string;
  endpoint_identity: Sha256;
  started_at: string;
  completed_at?: string;
  latency_ms?: number;
  status: "succeeded" | "failed" | "cancelled";
  http_status?: number;
  retry_of?: string;
  usage?: Record<string, number>;
  request_ref?: string;
  response_ref?: string;
  error?: { code: string; message: string };
}

export interface InteractionCaptureRefV1 {
  schema_version: "1";
  run_id: string;
  mode: "proxy" | "hybrid";
  required: boolean;
  topology: "host-side" | "in-sandbox";
  completeness: "complete" | "partial" | "none";
  interaction_count: number;
  interactions_ref: string;
  redaction: {
    policy: string;
    status: "applied" | "not-needed" | "failed";
    rules: Array<{ rule_id: string; count: number }>;
  };
}
