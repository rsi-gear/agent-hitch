import type test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { RemoteWorkerHttpClient, RemoteWorkerProtocol, RemoteWorkerRegistry, remoteExecutionBindingDigest } from "../src/control-plane/index.js";
import { handleWorkerOwnershipRoute } from "../src/daemon/worker-ownership.js";
import { handleWorkerProtocolRoute, handleRemoteWorkRoute } from "../src/daemon/worker-routes.js";
import type { RemoteWorkerExecutionOwnership, RemoteWorkerHostIdentityV1 } from "../src/domain/index.js";
import { sha256JSON } from "../src/foundation/index.js";

export async function workerAdmissionFixture(t: test.TestContext, options: { hostIdentity?: RemoteWorkerHostIdentityV1 } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-worker-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = { cpu_millis: 1000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 0 };
  const zero = { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 };
  const registration = { schema_version: "1", worker_id: "worker_admission", provider: "remote-docker", collision_domain_id: "docker:admission",
    platforms: ["linux/amd64"], backends: [{ id: "harbor", version: "0.21.0" }],
    features: { docker: true, buildkit: false, model_proxy: false, isolated_same_task_attempts: false }, task_membership: ["known"],
    capacity: { total: resources, allocatable: resources, reserved_for_system: zero } };
  class ObservedRegistry extends RemoteWorkerRegistry {
    beforePublication?: () => Promise<void>;
    onAuthenticated?: () => void;
    override async withGeneration<T>(workerId: string, generation: number, publish: () => Promise<T>): Promise<T> {
      const callback = this.beforePublication; delete this.beforePublication; await callback?.();
      return super.withGeneration(workerId, generation, publish);
    }
    override async authenticatedGeneration(workerId: string, token: string) {
      const result = await super.authenticatedGeneration(workerId, token); this.onAuthenticated?.(); return result;
    }
  }
  const registry = new ObservedRegistry({ root }); await registry.initialize(); const registered = await registry.register(registration);
  const protocol = new RemoteWorkerProtocol({ root, registry }); await protocol.initialize();
  const work = { schema_version: "1" as const, work_id: `work_${"b".repeat(32)}`, eval_id: `eval_${"c".repeat(32)}`, backend: "harbor" as const,
    logical_attempt: 1, task_ids: ["one"], slots: [`slot_${"d".repeat(32)}`], opaque_membership: false, requested_parallelism: 1, reservation: resources, provider: registration.provider };
  const lease = { schema_version: "1" as const, lease_id: `lease_${"e".repeat(32)}`, work_id: work.work_id, eval_id: work.eval_id,
    worker_id: registration.worker_id, provider: registration.provider, collision_domain_id: registration.collision_domain_id, reservation: resources,
    state: "offered" as const, epoch: 1, resource_epochs: [1], issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString() };
  const offer = await protocol.createOffer(registration.worker_id, lease, work);
  const identity = { pid: 1001, start_identity: sha256JSON("original worker"), observed_at: new Date().toISOString() };
  const executionProcess = { ...identity, pid: 1002, start_identity: sha256JSON("original supervisor") };
  const fields = { binding_digest: remoteExecutionBindingDigest(offer), root_id: "a".repeat(24), root_digest: sha256JSON("private root"),
    docker_engine_id: "docker-admission", worker_process: identity };
  const ownership: RemoteWorkerExecutionOwnership = options.hostIdentity
    ? { ...fields, schema_version: "3", host_identity: options.hostIdentity, boot_digest: sha256JSON(options.hostIdentity) }
    : { ...fields, schema_version: "2", boot_digest: sha256JSON("boot") };
  const receipt = { schema_version: "1", offer_id: offer.offer_id, nonce: offer.nonce, generation: offer.generation, accepted: true, sent_at: new Date().toISOString() };
  const accept = () => protocol.acceptOffer(registration.worker_id, receipt, ownership);
  const admission = () => protocol.executionAdmission(registration.worker_id, offer.offer_id);
  const authorize = () => protocol.authorizeExecutionProcess(registration.worker_id, offer.offer_id, 1, sha256JSON(ownership), executionProcess);
  const server = http.createServer((request, response) => {
    (async () => {
      const input = { request, response, url: new URL(request.url!, "http://localhost"), registry, protocol, adminToken: "a".repeat(64) };
      return await handleWorkerOwnershipRoute(input) || await handleWorkerProtocolRoute(input) || await handleRemoteWorkRoute(input);
    })()
      .then(handled => { if (!handled) { response.writeHead(404); response.end(); } })
      .catch(error => { response.writeHead(409, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { code: error.code, message: error.message } })); });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = new RemoteWorkerHttpClient({ baseUrl, credential: { schema_version: "1", worker_id: registration.worker_id, generation: 1, token: registered.token } });
  return { root, registry, registration, registered, protocol, offer, lease, ownership, executionProcess, receipt, accept, admission, authorize, baseUrl, client };
}
