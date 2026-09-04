# Unmodified functions from xlang-ai/OSWorld-V2 lib_run_single.py.
# Commit d578d2d4e0dc82b43e270fdaa7fa89d9708cd154, tag v2026.08.08.
# Licensed under Apache-2.0; see LICENSE in this directory.
# Test infrastructure supplies the runner globals; no real VM is represented.

def _get_task_phases(example):
    getter = getattr(example, "get_phases", None)
    if not callable(getter):
        return []
    phases = getter() or []
    if not isinstance(phases, list):
        raise TypeError("get_phases() must return a list")
    return phases

def _configure_agent_for_task(agent, example):
    task_current_date = None
    if hasattr(example, "get") and callable(getattr(example, "get")):
        task_current_date = example.get("task_current_date")
    if task_current_date is None:
        task_current_date = getattr(example, "task_current_date", None)
    setattr(agent, "task_current_date", task_current_date)

def _run_multi_phase_task_example(agent, env, example, max_steps, args, example_result_dir, scores, runtime_logger):
    phases = _get_task_phases(example)
    if not phases:
        raise ValueError("No phases found for multi-phase task")

    use_proxy = bool(getattr(example, "proxy", False) and getattr(env, "enable_proxy", False))
    phase_results = []
    total_score = 0.0

    env.reset(task_config=example)
    memory_tracer = GuestMemoryTracer(env, example, args, example_result_dir)
    global_action_index = 0
    time.sleep(60)
    env.controller.start_recording()

    try:
        for phase_index, phase in enumerate(phases, start=1):
            phase_name = phase.get("name", f"Phase {phase_index}")
            phase_instruction = phase["instruction"]

            if phase_index > 1:
                env._step_no = 0
                env.action_history.clear()
                env._traj_no += 1
                logger.info("Starting phase %d in trajectory %d", phase_index, env._traj_no)

                phase["setup"](env.setup_controller, use_proxy=use_proxy)
                env.is_environment_used = True
                pause_after_setup = phase.get("pause_after_setup_seconds", 5)
                if pause_after_setup:
                    time.sleep(pause_after_setup)

            env.instruction = phase_instruction
            _configure_agent_for_task(agent, example)
            try:
                agent.reset(runtime_logger)
            except Exception:
                agent.reset()

            obs = env._get_obs()
            memory_tracer.capture(
                "initial_after_reset",
                phase_index=phase_index,
                phase_name=phase_name,
            )
            done = False
            step_idx = 0

            while not done and step_idx < max_steps:
                response, actions = agent.predict(
                    phase_instruction,
                    obs
                )

                if not actions:
                    answer = DEFAULT_USER_RESPONSE
                    if env.user_simulator is not None:
                        answer = env.user_simulator.respond(response if response else "")

                    logger.info(
                        "Phase %d User simulator Q: %s | A: %s",
                        phase_index,
                        response,
                        answer,
                    )
                    action_timestamp = datetime.datetime.now().strftime("%Y%m%d@%H%M%S%f")
                    with open(os.path.join(example_result_dir, "traj.jsonl"), "a") as f:
                        f.write(json.dumps({
                            "phase_index": phase_index,
                            "phase_name": phase_name,
                            "step_num": step_idx + 1,
                            "action_timestamp": action_timestamp,
                            "action": "ASK_USER",
                            "question": response,
                            "user_answer": answer,
                            "screenshot_file": None
                        }))
                        f.write("\n")
                    obs["user_response"] = answer
                    step_idx += 1
                    continue

                for action_index_in_step, action in enumerate(actions, start=1):
                    global_action_index += 1
                    action_timestamp = datetime.datetime.now().strftime("%Y%m%d@%H%M%S%f")
                    logger.info("Phase %d Step %d: %s", phase_index, step_idx + 1, action)
                    action_started = time.perf_counter()
                    obs, reward, done, info = env.step(action, args.sleep_after_execution)
                    step_wall_time_ms = round((time.perf_counter() - action_started) * 1000.0, 2)
                    memory_tracer.capture(
                        "post_action",
                        phase_index=phase_index,
                        phase_name=phase_name,
                        step_num=step_idx + 1,
                        action_index_in_step=action_index_in_step,
                        global_action_index=global_action_index,
                        action_timestamp=action_timestamp,
                        action=action,
                        step_wall_time_ms=step_wall_time_ms,
                    )

                    screenshot_name = f"phase_{phase_index}_step_{step_idx + 1}_{action_timestamp}.png"
                    with open(os.path.join(example_result_dir, screenshot_name), "wb") as _f:
                        _f.write(obs["screenshot"])

                    with open(os.path.join(example_result_dir, "traj.jsonl"), "a") as f:
                        f.write(json.dumps({
                            "phase_index": phase_index,
                            "phase_name": phase_name,
                            "step_num": step_idx + 1,
                            "action_timestamp": action_timestamp,
                            "action": action,
                            "response": response,
                            "reward": reward,
                            "done": done,
                            "info": info,
                            "screenshot_file": screenshot_name
                        }))
                        f.write("\n")
                    if done:
                        logger.info("Phase %d is done.", phase_index)
                        break
                step_idx += 1

            memory_tracer.capture(
                "final_before_evaluate",
                phase_index=phase_index,
                phase_name=phase_name,
            )
            phase_score = float(phase["evaluate"](env))
            total_score += phase_score
            phase_results.append(
                {
                    "phase_index": phase_index,
                    "phase_name": phase_name,
                    "instruction": phase_instruction,
                    "score": phase_score,
                }
            )

            gate_min_score = phase.get("gate_min_score")
            if gate_min_score is not None and phase_score < float(gate_min_score):
                logger.info(
                    "Stopping after phase %d returned %.4f below required %.4f",
                    phase_index,
                    phase_score,
                    float(gate_min_score),
                )
                break
            if phase.get("gate") and phase_score <= 0.0:
                logger.info("Stopping after gated phase %d returned %.4f", phase_index, phase_score)
                break

        final_score = round(max(0.0, min(1.0, total_score)), 4)
        logger.info("Multi-phase result: %.4f", final_score)
        scores.append(final_score)
        with open(os.path.join(example_result_dir, "result.txt"), "w", encoding="utf-8") as f:
            f.write(f"{final_score}\n")
        with open(os.path.join(example_result_dir, "phase_results.json"), "w", encoding="utf-8") as f:
            json.dump(phase_results, f, indent=2, ensure_ascii=False)

        log_task_completion(example, final_score, example_result_dir, args)
    finally:
        env.controller.end_recording(os.path.join(example_result_dir, "recording.mp4"))
