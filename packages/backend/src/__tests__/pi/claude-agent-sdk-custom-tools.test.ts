import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { jsonSchemaToZodShape } from "../../pi/vendor/claude-agent-sdk-custom-tools.js";

describe("jsonSchemaToZodShape", () => {
  test("converts basic string properties", () => {
    const jsonSchema = {
      type: "object",
      properties: {
        name: { type: "string", description: "The name" },
      },
      required: ["name"],
    };

    const shape = jsonSchemaToZodShape(jsonSchema);

    expect(shape).toBeDefined();
    expect(shape.name).toBeDefined();
    // Should be a Zod type (has parse/safeParse)
    expect(typeof shape.name.parse).toBe("function");
    expect(typeof shape.name.safeParse).toBe("function");

    // Verify it accepts strings
    expect(shape.name.parse("hello")).toBe("hello");

    // Required field should NOT be optional
    const obj = z.object(shape);
    const result = obj.safeParse({});
    expect(result.success).toBe(false);
  });

  test("marks non-required properties as optional", () => {
    const jsonSchema = {
      type: "object",
      properties: {
        title: { type: "string", description: "Required title" },
        subtitle: { type: "string", description: "Optional subtitle" },
      },
      required: ["title"],
    };

    const shape = jsonSchemaToZodShape(jsonSchema);
    const obj = z.object(shape);

    // Should pass with only required fields
    const result = obj.safeParse({ title: "hello" });
    expect(result.success).toBe(true);

    // Should fail without required fields
    const result2 = obj.safeParse({});
    expect(result2.success).toBe(false);

    // Should pass with both fields
    const result3 = obj.safeParse({ title: "hello", subtitle: "world" });
    expect(result3.success).toBe(true);
  });

  test("preserves descriptions on properties", () => {
    const jsonSchema = {
      type: "object",
      properties: {
        name: { type: "string", description: "The person's name" },
      },
      required: ["name"],
    };

    const shape = jsonSchemaToZodShape(jsonSchema);
    // Zod v4 stores description in the schema metadata
    expect(shape.name.description).toBe("The person's name");
  });

  test("converts number properties", () => {
    const jsonSchema = {
      type: "object",
      properties: {
        count: { type: "number" },
        age: { type: "integer" },
      },
      required: ["count"],
    };

    const shape = jsonSchemaToZodShape(jsonSchema);
    expect(shape.count.parse(42)).toBe(42);
    expect(shape.age.parse(25)).toBe(25);
  });

  test("converts boolean properties", () => {
    const jsonSchema = {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
      },
      required: ["enabled"],
    };

    const shape = jsonSchemaToZodShape(jsonSchema);
    expect(shape.enabled.parse(true)).toBe(true);
  });

  test("converts array properties", () => {
    const jsonSchema = {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["tags"],
    };

    const shape = jsonSchemaToZodShape(jsonSchema);
    expect(shape.tags.parse(["a", "b"])).toEqual(["a", "b"]);
  });

  test("handles schema with no properties", () => {
    const jsonSchema = {
      type: "object",
      properties: {},
    };

    const shape = jsonSchemaToZodShape(jsonSchema);
    expect(Object.keys(shape)).toEqual([]);
  });

  test("handles schema with no required array", () => {
    const jsonSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
    };

    const shape = jsonSchemaToZodShape(jsonSchema);
    const obj = z.object(shape);

    // All fields should be optional when no required array
    const result = obj.safeParse({});
    expect(result.success).toBe(true);
  });

  test("handles enum string properties", () => {
    const jsonSchema = {
      type: "object",
      properties: {
        color: { type: "string", enum: ["red", "green", "blue"] },
      },
      required: ["color"],
    };

    const shape = jsonSchemaToZodShape(jsonSchema);
    expect(shape.color.parse("red")).toBe("red");
  });

  test("falls back to z.any() for unknown types", () => {
    const jsonSchema = {
      type: "object",
      properties: {
        data: { type: "custom_unknown_type" },
      },
      required: ["data"],
    };

    const shape = jsonSchemaToZodShape(jsonSchema);
    expect(shape.data).toBeDefined();
    expect(typeof shape.data.parse).toBe("function");
  });

  test("handles null/undefined schema gracefully", () => {
    const nullSchema: null = null;
    const shape1 = jsonSchemaToZodShape(nullSchema);
    expect(Object.keys(shape1)).toEqual([]);

    const undefinedSchema: undefined = undefined;
    const shape2 = jsonSchemaToZodShape(undefinedSchema);
    expect(Object.keys(shape2)).toEqual([]);
  });

  test("round-trips through Zod object to preserve required fields in JSON-like output", () => {
    // This tests the core bug: required params must be preserved
    const jsonSchema = {
      type: "object",
      properties: {
        title: { type: "string", description: "Concise task title" },
        description: { type: "string", description: "Brief description" },
        branch_name: { type: "string", description: "Git branch name" },
        prompt: { type: "string", description: "Optional initial prompt" },
      },
      required: ["title", "description"],
    };

    const shape = jsonSchemaToZodShape(jsonSchema);
    const obj = z.object(shape);

    // Required fields must cause validation failure when missing
    const missing = obj.safeParse({});
    expect(missing.success).toBe(false);

    // Optional fields can be omitted
    const partial = obj.safeParse({ title: "Test", description: "A test" });
    expect(partial.success).toBe(true);

    // All fields should work
    const full = obj.safeParse({
      title: "Test",
      description: "A test",
      branch_name: "task/test",
      prompt: "Start work",
    });
    expect(full.success).toBe(true);
  });
});
