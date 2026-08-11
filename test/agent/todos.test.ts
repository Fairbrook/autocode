import { describe, expect, it } from "vitest";
import { extractTodosFromContent } from "../../src/agent/todos.ts";

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
