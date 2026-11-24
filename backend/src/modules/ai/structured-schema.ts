type Schema = Record<string, unknown>;

/** Strict provider decoding requires closed objects and every property to be required.
 * Represent only originally optional fields as nullable; keep the public schema unchanged. */
export function strictProviderSchema(schema: Schema): Schema {
  const result = structuredClone(schema);
  function visit(node: Schema) {
    delete node.$schema;
    if (node.oneOf) {
      node.anyOf = node.oneOf;
      delete node.oneOf;
    }
    if (node.const !== undefined) {
      node.enum = [node.const];
      delete node.const;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value))
        for (const child of value) {
          if (child && typeof child === "object") visit(child as Schema);
        }
      else if (value && typeof value === "object") visit(value as Schema);
    }
    if (node.type === "object" && node.properties) {
      const properties = node.properties as Record<string, Schema>;
      const required = new Set(node.required as string[] | undefined);
      for (const key of Object.keys(properties)) {
        if (!required.has(key)) properties[key] = { anyOf: [properties[key], { type: "null" }] };
      }
      node.required = Object.keys(properties);
      node.additionalProperties = false;
    }
  }
  visit(result);
  return result;
}

/** Reverse nullable OPTIONAL wire fields only. Never drop required/unknown fields,
 * repair graph references, fabricate values, or remove invalid educational content. */
export function restoreOptionalFields(value: unknown, schema: Schema): unknown {
  if (Array.isArray(value) && schema.items)
    return value.map((item) => restoreOptionalFields(item, schema.items as Schema));
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const object = value as Record<string, unknown>;
  if (Array.isArray(schema.anyOf)) {
    const branch = (schema.anyOf as Schema[]).find((candidate) => {
      const properties = candidate.properties as Record<string, Schema> | undefined;
      return (
        properties &&
        Object.entries(properties).some(
          ([key, property]) =>
            (Array.isArray(property.enum) && property.enum.includes(object[key])) ||
            (property.const !== undefined && property.const === object[key]),
        )
      );
    });
    if (branch) return restoreOptionalFields(value, branch);
  }
  const properties = schema.properties as Record<string, Schema> | undefined;
  if (!properties) return value;
  const required = new Set(schema.required as string[] | undefined);
  const result: [string, unknown][] = [];
  for (const [key, item] of Object.entries(object)) {
    const known = Object.hasOwn(properties, key);
    if (item === null && known && !required.has(key)) continue;
    result.push([key, known ? restoreOptionalFields(item, properties[key]!) : item]);
  }
  return Object.fromEntries(result);
}
