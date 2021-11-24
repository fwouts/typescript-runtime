import assertNever from "assert-never";
import prettier from "prettier";
import { Type } from "./types";

export function generate(types: Record<string, Type>) {
  const definitions = Object.entries(types)
    .map(
      ([name, type]) => `
    export type ${name} = ${generateTypeDeclaration(type)};

    export const ${name} = Object.freeze({
      name: ${JSON.stringify(name)},
      schema: ${generateSchema(type)},
      create(__value__: ${name}): ${name} {
        if (!${name}.validate(__value__, { allowAdditionalProperties: true })) {
          // This error will never be thrown because
          // validate() already throws.
          throw new ValidationError();
        }
        return ${generateTypeSanitizer(type, "__value__", [name])}
      },
      validate(
        __value__: ${name},
        { errorCatcher, allowAdditionalProperties }: ValidateOptions = {}
      ): __value__ is ${name} {
        try {
          ${generateTypeValidator(type, "__value__", [name])}
          return true;
        } catch (e: any) {
          if (!(e instanceof ValidationError)) {
            throw e;
          }
          if (errorCatcher) {
            errorCatcher.error = e.message;
            return false;
          } else {
            throw e;
          }
        }
      }
    } as const);
    `
    )
    .join("\n");
  const unformatted = `
  ${definitions}

  function fail(message: string, value: unknown): never {
    let debugValue: string;
    try {
      debugValue = JSON.stringify(value, null, 2);
    } catch (e) {
      // Not representable in JSON.
      debugValue = \`\${value}\`;
    }
    throw new ValidationError(message + ':\\n' + debugValue);
  }

  export class ValidationError extends Error {
    constructor(message = "") {
      super(message);
    }
  }

  export function createErrorCatcher(): ErrorCatcher {
    return {
      error: ''
    }
  }

  export interface ErrorCatcher {
    error: string
  }

  export type Type<T> = {
    readonly name: string;
    readonly schema: Schema;
    create<S = T>(value: S): T;
    validate<S = T>(value: S, options?: ValidateOptions): boolean;
  }

  export interface ValidateOptions {
    errorCatcher?: ErrorCatcher,
    allowAdditionalProperties?: boolean | undefined,
  }

  export type Schema =
  | {
      kind: "alias";
      type: () => Type<unknown>;
    }
  | {
      kind: "any";
    }
  | {
      kind: "array";
      schema: Schema;
    }
  | {
      kind: "boolean";
    }
  | {
      kind: "literal";
      value: boolean | number | string;
    }
  | {
      kind: "null";
    }
  | {
      kind: "number";
    }
  | {
      kind: "object";
      properties: Record<string, ObjectSchemaProperty>;
    }
  | {
      kind: "string";
    }
  | {
      kind: "undefined";
    }
  | {
      kind: "union";
      schemas: Schema[];
    };

  export type ObjectSchemaProperty = {
    schema: Schema;
    required: boolean;
  }
  `;
  return prettier.format(unformatted, {
    parser: "babel-ts",
  });
}

function generateSchema(type: Type): string {
  switch (type.kind) {
    case "alias":
      return `{
        kind: "alias",
        type: () => ${type.name}
      }`;
    case "any":
      return `{
        kind: "any"
      }`;
    case "array":
      return `{
        kind: "array",
        schema: ${generateSchema(type.type)}
      }`;
    case "boolean":
      return `{
        kind: "boolean"
      }`;
    case "literal":
      return `{
        kind: "literal",
        value: ${JSON.stringify(type.value)}
      }`;
    case "null":
      return `{
        kind: "null"
      }`;
    case "number":
      return `{
        kind: "number"
      }`;
    case "object":
      return `{
        kind: "object",
        properties: {
          ${Object.entries(type.properties)
            .map(
              ([name, property]) =>
                `["${name}"]: {
                  schema: ${generateSchema(property.type)},
                  required: ${JSON.stringify(property.required)}
                }`
            )
            .join(",")}
        }
      }`;
    case "string":
      return `{
        kind: "string"
      }`;
    case "undefined":
      return `{
        kind: "undefined"
      }`;
    case "union":
      return `{
        kind: "union",
        schemas: [
          ${type.types.map((subtype) => generateSchema(subtype)).join(",")}
        ]
      }`;
    default:
      throw assertNever(type);
  }
}

function generateTypeDeclaration(type: Type): string {
  switch (type.kind) {
    case "alias":
      return type.name;
    case "any":
      return `any`;
    case "array":
      return `Array<${generateTypeDeclaration(type.type)}>`;
    case "boolean":
      return "boolean";
    case "literal":
      return JSON.stringify(type.value);
    case "null":
      return "null";
    case "number":
      return `number`;
    case "object":
      return `
      {
        ${Object.entries(type.properties)
          .map(
            ([name, property]) =>
              `${name}${
                property.required ? "" : "?"
              }: ${generateTypeDeclaration(property.type)}`
          )
          .join(";")}
      }`;
    case "string":
      return `string`;
    case "undefined":
      return "undefined";
    case "union":
      return type.types
        .map((subtype) => `(${generateTypeDeclaration(subtype)})`)
        .join("|");
    default:
      throw assertNever(type);
  }
}

function generateTypeValidator(
  type: Type,
  value: string,
  path: string[]
): string {
  switch (type.kind) {
    case "alias":
      return `
      ${type.name}.validate(${value}, { allowAdditionalProperties });
      `.trim();
    case "any":
      return "";
    case "array":
      return `
      if (!Array.isArray(${value})) {
        fail("${path.join(".")} is not an array", ${value});
      }
      for (const item of ${value}) {
        ${generateTypeValidator(type.type, "item", [...path, "__item__"])}
      }
      `.trim();
    case "boolean":
      return `
      if (typeof(${value}) !== 'boolean') {
        fail("${path.join(".")} is not a boolean", ${value});
      }
      `.trim();
    case "literal":
      return `
      if (${value} !== ${JSON.stringify(type.value)}) {
        fail("${path.join(".")} must equal ${JSON.stringify(
        type.value
      )}", ${value});
      }
      `.trim();
    case "null":
      return `
      if (${value} !== null) {
        fail("${path.join(".")} is not null", ${value});
      }
      `.trim();
    case "number":
      return `
      if (typeof(${value}) !== 'number') {
        fail("${path.join(".")} is not a number", ${value});
      }
      `.trim();
    case "object":
      const variableName = variableNameFromPath(path);
      const allowedKeys = Object.keys(type.properties);
      return `
      if (typeof(${value}) !== 'object' || ${value} === null) {
        fail("${path.join(".")} is not an object", ${value});
      }
      const ${variableName} = ${value} as any;
      if (!allowAdditionalProperties) {
        const allowedKeys = new Set([
          ${allowedKeys.map((value) => JSON.stringify(value)).join(",")}
        ]);
        for (const key of Object.keys(${variableName})) {
          if (!allowedKeys.has(key)) {
            fail("${path.join(".")} does not allow key " + key, ${value});
          }
        }
      }
      ${Object.entries(type.properties)
        .map(([name, property]) => {
          const propertyAccessor = `${variableName}["${name}"]`;
          let checks = generateTypeValidator(property.type, propertyAccessor, [
            ...path,
            name,
          ]);
          if (!property.required) {
            checks = `if (${propertyAccessor} !== undefined) {
            ${checks}
          }`;
          }
          return checks;
        })
        .join("")}
      `.trim();
    case "string":
      return `
      if (typeof(${value}) !== 'string') {
        fail("${path.join(".")} is not a string", ${value});
      }
      `.trim();
    case "undefined":
      return `
      if (${value} !== undefined) {
        fail("${path.join(".")} is not undefined", ${value});
      }
      `.trim();
    case "union":
      // TODO: Improve support for discriminated types, so when we
      // know for sure that it's supposed to be a specific one, we
      // give the error that is most relevant (as opposed to an error
      // related to the last possible type).
      return `union: {
        let error: ValidationError | null = null;
        ${type.types
          .map(
            (subtype, i) => `
        try {
          ${generateTypeValidator(subtype, value, [...path, i.toString(10)])}
          break union;
        } catch (e) {
          if (!(e instanceof ValidationError)) {
            throw e;
          }
          error = e;
        }
        `
          )
          .join("")}
        throw error;
      }`.trim();
    default:
      throw assertNever(type);
  }
}

function generateTypeSanitizer(
  type: Type,
  value: string,
  path: string[]
): string {
  switch (type.kind) {
    case "alias":
      return `${type.name}.create(${value})`;
    case "any":
      return value;
    case "array":
      return `(${value} as Array<any>).map(item => ${generateTypeSanitizer(
        type.type,
        "item",
        [...path, "__item__"]
      )})`;
    case "boolean":
      return value;
    case "literal":
      return value;
    case "null":
      return value;
    case "number":
      return value;
    case "object":
      const localName = variableNameFromPath(path);
      return `(() => {
        const ${localName}: any = ${value};
        const ${localName}_sanitized: any = {};
        ${Object.entries(type.properties)
          .map(([name, property]) => {
            const propertyAccessor = `${localName}["${name}"]`;
            let statement = `${localName}_sanitized["${name}"] = ${generateTypeSanitizer(
              property.type,
              propertyAccessor,
              [...path, name]
            )};`;
            if (!property.required) {
              statement = `if (${propertyAccessor} !== undefined) { ${statement} }`;
            }
            return statement;
          })
          .join("")}
        return ${localName}_sanitized;
      })()`;
    case "string":
      return value;
    case "undefined":
      return value;
    case "union":
      return `(() => {
          ${type.types
            .map(
              (subtype, i) => `
          try {
            ${generateTypeValidator(subtype, value, [
              ...path,
              i.toString(10),
            ])}
            return ${generateTypeSanitizer(subtype, value, [
              ...path,
              i.toString(10),
            ])}
          } catch (e) {
            if (e instanceof ValidationError) {
              // Ignore, another subtype will be fine.
            } else {
              throw e;
            }
          }
          `
            )
            .join("")}
        })()`;
    default:
      throw assertNever(type);
  }
}

function variableNameFromPath(path: string[]) {
  const name = path.join("_");
  return name.charAt(0).toLowerCase() + name.slice(1);
}
