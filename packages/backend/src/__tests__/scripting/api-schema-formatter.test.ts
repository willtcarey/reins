import { describe, test, expect } from "bun:test";
import { Type } from "@sinclair/typebox";
import {
  formatSchema,
  formatFunctionSignature,
  formatApiInterfaces,
  formatTypeDeclaration,
  type SchemaNameMap,
} from "../../scripting/api-schema-formatter.js";

describe("formatSchema", () => {
  test("formats a simple object", () => {
    const schema = Type.Object({
      id: Type.Number(),
      name: Type.String(),
    });
    const result = formatSchema(schema, "MyType");
    expect(result).toContain("MyType");
    expect(result).toContain("id: number");
    expect(result).toContain("name: string");
  });

  test("formats nullable fields", () => {
    const schema = Type.Object({
      description: Type.Union([Type.String(), Type.Null()]),
    });
    const result = formatSchema(schema, "Thing");
    expect(result).toContain("description: string | null");
  });

  test("formats literal union (enum-like)", () => {
    const schema = Type.Object({
      status: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
    });
    const result = formatSchema(schema, "Task");
    expect(result).toContain(`status: "open" | "closed"`);
  });

  test("formats arrays", () => {
    const schema = Type.Object({
      tags: Type.Array(Type.String()),
    });
    const result = formatSchema(schema, "Item");
    expect(result).toContain("tags: string[]");
  });

  test("formats optional fields", () => {
    const schema = Type.Object({
      title: Type.String(),
      description: Type.Optional(Type.String()),
    });
    const result = formatSchema(schema, "Opts");
    expect(result).toContain("title: string");
    expect(result).toContain("description?: string");
  });

  test("formats nested objects inline", () => {
    const schema = Type.Object({
      diff: Type.Object({
        added: Type.Number(),
        removed: Type.Number(),
      }),
    });
    const result = formatSchema(schema, "Stats");
    expect(result).toContain("diff: { added: number, removed: number }");
  });

  test("formats without a name for anonymous schemas", () => {
    const schema = Type.Object({
      id: Type.Number(),
    });
    const result = formatSchema(schema);
    expect(result).toContain("id: number");
    expect(result).not.toContain("undefined");
  });

  test("formats primitive schemas", () => {
    expect(formatSchema(Type.String())).toBe("string");
    expect(formatSchema(Type.Number())).toBe("number");
    expect(formatSchema(Type.Boolean())).toBe("boolean");
    expect(formatSchema(Type.Null())).toBe("null");
  });

  test("formats array of objects", () => {
    const schema = Type.Array(
      Type.Object({ id: Type.Number(), name: Type.String() }),
    );
    const result = formatSchema(schema);
    expect(result).toContain("{ id: number, name: string }[]");
  });
});

describe("formatFunctionSignature", () => {
  test("formats a no-param function", () => {
    const result = formatFunctionSignature("tasks.list", Type.Object({}), Type.Array(Type.String()));
    expect(result).toBe("tasks.list(): string[]");
  });

  test("formats params inline for simple objects", () => {
    const result = formatFunctionSignature(
      "tasks.get",
      Type.Object({ taskId: Type.Number() }),
      Type.Union([Type.String(), Type.Null()]),
    );
    expect(result).toBe("tasks.get(taskId: number): string | null");
  });

  test("formats multiple params", () => {
    const result = formatFunctionSignature(
      "tasks.update",
      Type.Object({
        taskId: Type.Number(),
        updates: Type.Object({
          title: Type.Optional(Type.String()),
          description: Type.Optional(Type.String()),
        }),
      }),
      Type.Union([
        Type.Object({ id: Type.Number() }),
        Type.Null(),
      ]),
    );
    expect(result).toContain("tasks.update(");
    expect(result).toContain("taskId: number");
    expect(result).toContain("updates:");
  });

  test("handles async (Promise) returns", () => {
    const result = formatFunctionSignature(
      "tasks.create",
      Type.Object({ title: Type.String() }),
      Type.Object({ id: Type.Number() }),
      { async: true },
    );
    expect(result).toContain("Promise<");
  });
});

describe("formatApiInterfaces", () => {
  const TaskDocSchema = Type.Object({
    id: Type.Number(),
    title: Type.String(),
  });
  const names = new Map([[TaskDocSchema, "Task"]]);

  test("renders a root Api interface and namespace interface", () => {
    const result = formatApiInterfaces([
      {
        name: "tasks.list",
        description: "List tasks.",
        parameters: Type.Object({ status: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("closed")])) }),
        returns: Type.Array(TaskDocSchema),
        tags: ["tasks"],
        execute: () => [],
      },
    ], { names });

    expect(result).toContain("interface Api {");
    expect(result).toContain("tasks: TasksApi;");
    expect(result).toContain("interface TasksApi {");
    expect(result).toContain("/** List tasks. */");
    expect(result).toContain("list(status?: \"open\" | \"closed\"): Task[];");
    expect(result).not.toContain("tasks.list(");
  });

  test("renders positional method params and async returns", () => {
    const result = formatApiInterfaces([
      {
        name: "tasks.update",
        description: "Update a task.",
        parameters: Type.Object({
          taskId: Type.Number(),
          updates: Type.Object({ title: Type.Optional(Type.String()) }),
        }),
        returns: TaskDocSchema,
        tags: ["tasks"],
        execute: () => ({ id: 1, title: "Updated" }),
      },
      {
        name: "tasks.reopen",
        description: "Reopen a task.",
        parameters: Type.Object({ taskId: Type.Number() }),
        returns: TaskDocSchema,
        async: true,
        tags: ["tasks"],
        execute: async () => ({ id: 1, title: "Updated" }),
      },
    ], { names });

    expect(result).toContain("update(taskId: number, updates: { title?: string }): Task;");
    expect(result).toContain("reopen(taskId: number): Promise<Task>;");
  });
});

describe("formatTypeDeclaration", () => {
  test("renders object schemas as TypeScript interfaces", () => {
    const schema = Type.Object({
      id: Type.Number(),
      description: Type.Union([Type.String(), Type.Null()]),
      status: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
      tags: Type.Array(Type.String()),
      notes: Type.Optional(Type.String()),
    });

    const result = formatTypeDeclaration(schema, "Task");

    expect(result).toContain("interface Task {");
    expect(result).toContain("id: number;");
    expect(result).toContain("description: string | null;");
    expect(result).toContain("status: \"open\" | \"closed\";");
    expect(result).toContain("tags: string[];");
    expect(result).toContain("notes?: string;");
  });

  test("renders non-object schemas as type aliases", () => {
    const result = formatTypeDeclaration(Type.Array(Type.String()), "Names");
    expect(result).toBe("type Names = string[];");
  });

  test("does not render named union declarations as self aliases", () => {
    const CatSchema = Type.Object({ meows: Type.Boolean() });
    const DogSchema = Type.Object({ barks: Type.Boolean() });
    const PetSchema = Type.Union([CatSchema, DogSchema]);
    const names: SchemaNameMap = new Map();
    names.set(CatSchema, "Cat");
    names.set(DogSchema, "Dog");
    names.set(PetSchema, "Pet");

    const result = formatTypeDeclaration(PetSchema, "Pet", names);

    expect(result).toBe("type Pet = Cat | Dog;");
  });
});
