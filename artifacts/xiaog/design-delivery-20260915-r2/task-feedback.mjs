// Seed historical snapshots silently; react only to a new terminal transition.
export class TaskFeedback {
  constructor(onResult) {
    this.onResult = onResult;
    this.tasks = new Map();
  }
  observe(task) {
    if (
      !task?.id ||
      ![
        "queued",
        "running",
        "cancelling",
        "succeeded",
        "failed",
        "cancelled",
      ].includes(task.state)
    )
      return false;
    const previous = this.tasks.get(task.id);
    // A task ID describes one attempt. Ignore stale polling and duplicate terminal events.
    if (previous && !["queued", "running", "cancelling"].includes(previous))
      return false;
    if (previous === "running" && task.state === "queued") return false;
    if (previous === "cancelling" && ["queued", "running"].includes(task.state))
      return false;
    this.tasks.set(task.id, task.state);
    if (this.tasks.size > 512)
      this.tasks.delete(this.tasks.keys().next().value);
    if (previous && ["succeeded", "failed"].includes(task.state)) {
      this.onResult(task);
      return true;
    }
    return false;
  }
}
