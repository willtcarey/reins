# Task Queues

Status: **early thinking** — not ready for implementation.

## Direction

Accept a single-task execution lock: only one session runs at a time per project. This simplifies the execution model and removes most of the need for git worktrees. It also opens the door to **queues** — letting users stack up units of work that the system processes sequentially.

## Key ideas

- **Single-task lock.** One active session at a time. Branch checkout, file mutations, and tool execution all happen in the single working tree without contention.
- **Worktrees deprioritised.** With no concurrent execution, worktrees drop from "needed for correctness" to "nice-to-have for isolation from the user's editor." Can revisit later.
- **Queue as a new primitive.** Users can line up work items and walk away. The system works through them in order, checking out branches and handing off between items.
- **Queue items ≠ tasks.** A task represents a branch of work. A queue item represents a discrete unit of work *on* that branch — something the user can review after it finishes. Multiple queue items can target the same task.
- **Single-turn queue items.** Leaning toward each queue item being a single agent turn to keep context windows fresh. Items should be primed to hand off state via the file system (notes, TODOs, intermediate artifacts) rather than relying on conversation history.

## Open questions

1. **What does "done" mean for a queue item?** Agent self-reports completion? Fixed turn count? User-defined checkpoints?
2. **Cross-task ordering.** If task B depends on task A's output, does the queue handle rebasing/merging between items, or is each item independent against the base branch?
3. **Review flow.** After a queue item finishes, does the system pause for user review before continuing, or keep going? Configurable per item?
4. **Sidebar evolution.** Does the sidebar become the queue view, or do tasks and the queue coexist as separate concepts? How do "scratch" sessions fit in?
5. **Handoff format.** What does file-system-based handoff look like in practice? A conventional notes file? Task-specific scratchpad? Something the agent is prompted to maintain?
6. **Failure/interruption.** What happens when a queue item fails or the agent gets stuck? Skip and continue? Pause the queue? Notify and wait?
