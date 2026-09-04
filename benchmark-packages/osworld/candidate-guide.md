Use `desktop.observe` and `desktop.submit` to complete the native task. The
original task instruction and screenshot come from the native phase controller.
Read the tool schemas and open the returned screenshot with your image viewer.

The shell that launches this bridge runs in a tool-client container. Desktop
applications, task files, and task websites run in a separate VM. Use desktop
actions to interact with them; for guest-side commands, open a terminal on the
desktop and type there. Local `ls`, `find`, and `curl` results describe the
tool-client container.

Stay in this run while working on the task. When the work is complete, submit
`actions: ["DONE"]`. If you cannot complete it, submit `actions: ["FAIL"]`.
Use the latest observed sequence and a valid, unique request ID. Submit the
terminal action by itself. Only after that submission is accepted may you return
a final response; the native controller will perform grading. A final text
reply or an offer to continue later does not close the native episode.

An accepted submission acknowledges receipt, not completed execution. For
nonterminal actions, wait for the next observation before acting again. A
`processing` response means the SDK is still busy. Retry a request with the same
request ID and payload when its acknowledgement is uncertain.

`TYPING` sends literal keystrokes through the native keyboard; it is not an
atomic clipboard paste. Enter long text in short chunks and inspect the next
screenshot before continuing. In particular, confirm that a shell command or
heredoc was fully entered before assuming it is running. Recover from errors in
the current desktop state. Ask the native user simulator for missing task
information through an empty action batch and the `response` field.
