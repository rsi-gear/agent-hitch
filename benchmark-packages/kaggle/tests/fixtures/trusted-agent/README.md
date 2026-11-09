This deterministic fixture exercises the ordinary generic service-call channel without a model API. Its task must bind the trusted tabular service, include `id,x,target` training rows and `id,x` prediction rows, and admit `max_fits: 9`, trusted CV, enforced service fit accounting, and frozen delivery. The expected prediction IDs are `a,b` with labels `0,1`.

It executes five-fold CV, replays it without more fits, registers three-fold CV and executes it, checks quota and mismatched-final-parameter rejection, performs one final refit, replays the final action, and checks that the selected model cannot be changed. The independent task verifier then checks the host-owned execution evidence and exact CSV digest. Total service attempts: nine.

The source fixture builds the `pi` adapter entrypoint. See `docs/evidence/mlebench-trusted-linux-2026-11-09.json` for the real Linux execution and its coverage limits.

After completing the legitimate calls, the fixture continuously writes a forged zero-count host-claiming receipt into the Agent-writable log directory. The verifier and public evidence API must still use the separate protected trial-root receipt with nine attempts. The forged log is intentionally retained as adversarial evidence.
