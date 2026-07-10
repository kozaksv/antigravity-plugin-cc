/**
 * Minimal, dependency-free JSON-Schema validator.
 *
 * Only supports the subset of draft-2020-12 the plugin's structured-output
 * contracts actually use: `type`, `enum`, `required`, `additionalProperties:
 * false`, `minLength`, `maxLength`, `minimum`, `maximum`, `items`, and nested
 * `properties`. This is intentionally narrow (no `$ref`, `oneOf`, formats,
 * ...) — it exists to make Antigravity's review JSON contract fail-closed
 * without pulling in a network-fetching schema library.
 */

function describeType(value) {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function typeMatches(value, type) {
  switch (type) {
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      // Unknown/unsupported type keyword: do not fail the whole document over it.
      return true;
  }
}

function validateNode(value, schema, pathLabel, errors) {
  if (!schema || typeof schema !== "object") {
    return;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) {
      errors.push(`${pathLabel}: expected type ${types.join(" or ")}, got ${describeType(value)}`);
      // A type mismatch makes every other keyword on this node meaningless
      // (e.g. checking `minLength` on a number) — stop descending here.
      return;
    }
  }

  if (Array.isArray(schema.enum)) {
    const allowed = schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value));
    if (!allowed) {
      errors.push(`${pathLabel}: value ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${pathLabel}: string length ${value.length} is below minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${pathLabel}: string length ${value.length} exceeds maxLength ${schema.maxLength}`);
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${pathLabel}: ${value} is below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${pathLabel}: ${value} exceeds maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => validateNode(item, schema.items, `${pathLabel}[${index}]`, errors));
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};

    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          errors.push(`${pathLabel}: missing required property "${key}"`);
        }
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          errors.push(`${pathLabel}: unexpected additional property "${key}"`);
        }
      }
    }

    for (const key of Object.keys(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        validateNode(value[key], properties[key], pathLabel ? `${pathLabel}.${key}` : key, errors);
      }
    }
  }
}

/**
 * Validate `value` against `schema`. Returns `{ valid, errors }` — never
 * throws on a malformed `value` (a non-object top-level value, for instance,
 * simply produces a type-mismatch error like any other node).
 */
export function validateAgainstSchema(value, schema) {
  const errors = [];
  validateNode(value, schema, "$", errors);
  return { valid: errors.length === 0, errors };
}
