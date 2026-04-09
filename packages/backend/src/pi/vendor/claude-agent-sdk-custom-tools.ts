/**
 * JSON Schema → Zod conversion for custom tool schemas.
 *
 * The Claude Agent SDK's `createSdkMcpServer` expects Zod schemas (raw shapes),
 * but Reins custom tools use TypeBox (JSON Schema). This module bridges the gap
 * by converting JSON Schema property definitions into Zod types, preserving
 * `required` fields, descriptions, and basic type information.
 */

import { z, type ZodType } from "zod";

type JsonSchemaProperty = {
	type?: string;
	description?: string;
	enum?: unknown[];
	items?: JsonSchemaProperty;
	properties?: Record<string, JsonSchemaProperty>;
	required?: string[];
	default?: unknown;
};

type JsonSchema = {
	type?: string;
	properties?: Record<string, JsonSchemaProperty>;
	required?: string[];
};

/**
 * Convert a single JSON Schema property definition to a Zod type.
 */
function jsonSchemaPropertyToZod(prop: JsonSchemaProperty): ZodType {
	let schema: ZodType;

	// Handle enums first (before type-based dispatch)
	if (prop.enum && Array.isArray(prop.enum) && prop.enum.length > 0) {
		const [first, ...rest] = prop.enum.map(String);
		schema = z.enum([first, ...rest]);
	} else {
		switch (prop.type) {
			case "string":
				schema = z.string();
				break;
			case "number":
			case "integer":
				schema = z.number();
				break;
			case "boolean":
				schema = z.boolean();
				break;
			case "array":
				if (prop.items) {
					schema = z.array(jsonSchemaPropertyToZod(prop.items));
				} else {
					schema = z.array(z.any());
				}
				break;
			case "object":
				if (prop.properties) {
					const nestedShape = jsonSchemaToZodShape({
						type: "object",
						properties: prop.properties,
						required: prop.required,
					});
					schema = z.object(nestedShape);
				} else {
					schema = z.record(z.string(), z.any());
				}
				break;
			default:
				schema = z.any();
				break;
		}
	}

	if (prop.description) {
		schema = schema.describe(prop.description);
	}

	return schema;
}

/**
 * Convert a JSON Schema object definition to a Zod raw shape.
 *
 * Properties listed in the `required` array become required Zod fields;
 * all others are wrapped with `.optional()`.
 */
export function jsonSchemaToZodShape(
	schema: JsonSchema | null | undefined,
): Record<string, ZodType> {
	if (!schema || !schema.properties) {
		return {};
	}

	const requiredSet = new Set(schema.required ?? []);
	const shape: Record<string, ZodType> = {};

	for (const [key, prop] of Object.entries(schema.properties)) {
		let zodType = jsonSchemaPropertyToZod(prop);

		if (!requiredSet.has(key)) {
			zodType = zodType.optional();
		}

		shape[key] = zodType;
	}

	return shape;
}
