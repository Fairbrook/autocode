import { describe, expect, it } from "vitest";
import { createTaskListTracker, extractTodosFromContent } from "../../src/agent/todos.ts";

function todoUse(todos: unknown) {
  return { type: "tool_use", id: "toolu_1", name: "TodoWrite", input: { todos } };
}

describe("extractTodosFromContent", () => {
  it("pulls the todo list out of a TodoWrite tool call", () => {
    const todos = extractTodosFromContent([
      { type: "text", text: "Starting on the rate limiter." },
      todoUse([
        { content: "Write the failing test", status: "completed", activeForm: "Writing the failing test" },
        { content: "Implement the limiter", status: "in_progress", activeForm: "Implementing the limiter" },
        { content: "Run the suite", status: "pending", activeForm: "Running the suite" },
      ]),
    ]);

    expect(todos).toHaveLength(3);
    expect(todos?.[1]).toEqual({
      content: "Implement the limiter",
      status: "in_progress",
      activeForm: "Implementing the limiter",
    });
  });

  it("returns null for messages with no TodoWrite call", () => {
    expect(extractTodosFromContent([{ type: "text", text: "hello" }])).toBeNull();
    expect(
      extractTodosFromContent([{ type: "tool_use", name: "Bash", input: { command: "ls" } }])
    ).toBeNull();
    expect(extractTodosFromContent(undefined)).toBeNull();
    expect(extractTodosFromContent("not an array")).toBeNull();
  });

  it("keeps the last TodoWrite when one message contains several", () => {
    const todos = extractTodosFromContent([
      todoUse([{ content: "old", status: "pending", activeForm: "Olding" }]),
      todoUse([{ content: "new", status: "in_progress", activeForm: "Newing" }]),
    ]);
    expect(todos).toEqual([{ content: "new", status: "in_progress", activeForm: "Newing" }]);
  });

  it("falls back to content when activeForm is missing", () => {
    const todos = extractTodosFromContent([todoUse([{ content: "Ship it", status: "pending" }])]);
    expect(todos).toEqual([{ content: "Ship it", status: "pending", activeForm: "Ship it" }]);
  });

  it("ignores a malformed list rather than throwing mid-run", () => {
    expect(extractTodosFromContent([todoUse([{ content: "x", status: "bogus" }])])).toBeNull();
    expect(extractTodosFromContent([todoUse("not-an-array")])).toBeNull();
    expect(extractTodosFromContent([{ type: "tool_use", name: "TodoWrite" }])).toBeNull();
  });

  it("treats an empty list as a real (cleared) list, not as absent", () => {
    expect(extractTodosFromContent([todoUse([])])).toEqual([]);
  });
});

function taskCreateUse(subject: string, activeForm?: string) {
  return {
    type: "tool_use",
    id: `toolu_${subject}`,
    name: "TaskCreate",
    input: { subject, description: `do ${subject}`, ...(activeForm ? { activeForm } : {}) },
  };
}

function taskUpdateUse(taskId: string, patch: Record<string, unknown>) {
  return { type: "tool_use", id: `toolu_u_${taskId}`, name: "TaskUpdate", input: { taskId, ...patch } };
}

describe("createTaskListTracker", () => {
  it("builds the list from TaskCreate calls and their TaskCreated hooks", () => {
    // The tool call carries activeForm, the hook carries the id — this is the
    // real ordering: the model emits the call, then the tool runs.
    const tracker = createTaskListTracker();
    expect(tracker.applyMessageContent([taskCreateUse("Run the suite", "Running the suite")])).toBeNull();

    const todos = tracker.onTaskCreated({ task_id: "1", task_subject: "Run the suite" });
    expect(todos).toEqual([
      { content: "Run the suite", status: "pending", activeForm: "Running the suite" },
    ]);
  });

  it("tracks in_progress, which only the TaskUpdate call carries", () => {
    // There is no TaskUpdated hook, so without reading the tool call an item
    // would jump straight from pending to completed.
    const tracker = createTaskListTracker();
    tracker.onTaskCreated({ task_id: "1", task_subject: "Migrate" });
    tracker.onTaskCreated({ task_id: "2", task_subject: "Test" });

    const todos = tracker.applyMessageContent([taskUpdateUse("1", { status: "in_progress" })]);
    expect(todos?.map((t) => t.status)).toEqual(["in_progress", "pending"]);

    expect(tracker.onTaskCompleted({ task_id: "1" }).map((t) => t.status)).toEqual([
      "completed",
      "pending",
    ]);
  });

  it("applies subject and activeForm edits, and drops deleted tasks", () => {
    const tracker = createTaskListTracker();
    tracker.onTaskCreated({ task_id: "1", task_subject: "Keep" });
    tracker.onTaskCreated({ task_id: "2", task_subject: "Drop" });

    tracker.applyMessageContent([taskUpdateUse("1", { subject: "Kept", activeForm: "Keeping" })]);
    const todos = tracker.applyMessageContent([taskUpdateUse("2", { status: "deleted" })]);
    expect(todos).toEqual([{ content: "Kept", status: "pending", activeForm: "Keeping" }]);
  });

  it("keeps creation order, so the UI list doesn't reshuffle on every update", () => {
    const tracker = createTaskListTracker();
    for (const [id, subject] of [["1", "a"], ["2", "b"], ["3", "c"]] as const) {
      tracker.onTaskCreated({ task_id: id, task_subject: subject });
    }
    tracker.applyMessageContent([taskUpdateUse("3", { status: "in_progress" })]);
    expect(tracker.snapshot().map((t) => t.content)).toEqual(["a", "b", "c"]);
  });

  it("ignores updates for unknown ids and malformed input rather than throwing", () => {
    const tracker = createTaskListTracker();
    expect(tracker.applyMessageContent([taskUpdateUse("99", { status: "completed" })])).toBeNull();
    expect(tracker.applyMessageContent([{ type: "tool_use", name: "TaskUpdate", input: {} }])).toBeNull();
    expect(tracker.applyMessageContent("not an array")).toBeNull();
    expect(tracker.snapshot()).toEqual([]);
  });

  it("lets a TodoWrite list win outright, for older CLI builds", () => {
    const tracker = createTaskListTracker();
    tracker.onTaskCreated({ task_id: "1", task_subject: "From the task tools" });
    const todos = tracker.applyMessageContent([
      todoUse([{ content: "From TodoWrite", status: "in_progress", activeForm: "Doing it" }]),
    ]);
    expect(todos).toEqual([
      { content: "From TodoWrite", status: "in_progress", activeForm: "Doing it" },
    ]);
    expect(tracker.snapshot()).toEqual(todos);
  });
});
