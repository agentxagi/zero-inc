import type { Request, Response, NextFunction } from "express";
import type { ZodSchema, ZodError } from "zod";

/**
 * Formats a Zod validation error into a user-friendly structure.
 */
function formatZodError(error: ZodError): { message: string; details: Array<{ path: string; message: string }> } {
  const details = error.issues.map((issue) => ({
    path: issue.path.join(".") || "body",
    message: issue.message,
  }));

  // Create a concise summary message
  const summary = details.length === 1
    ? `Validation error: ${details[0].path} ${details[0].message}`
    : `Validation failed with ${details.length} errors`;

  return { message: summary, details };
}

/**
 * Middleware options for validation.
 */
interface ValidateOptions {
  /** Strip unknown properties instead of rejecting them (default: false) */
  stripUnknown?: boolean;
}

/**
 * Validates request body against a Zod schema.
 * Returns a 400 response with formatted error details if validation fails.
 */
export function validate(schema: ZodSchema, _options?: ValidateOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body ?? {});

    if (!result.success) {
      const formatted = formatZodError(result.error);
      res.status(400).json({
        error: formatted.message,
        validationErrors: formatted.details,
      });
      return;
    }

    req.body = result.data;
    next();
  };
}

/**
 * Validates request query parameters against a Zod schema.
 * Returns a 400 response with formatted error details if validation fails.
 * Note: In Express 5.x, req.query is read-only. Validated data is attached to req.validatedQuery.
 */
export function validateQuery(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);

    if (!result.success) {
      const formatted = formatZodError(result.error);
      res.status(400).json({
        error: formatted.message,
        validationErrors: formatted.details,
      });
      return;
    }

    // Attach validated data to req for access in route handlers
    // Using type assertion to extend the request object
    (req as Request & { validatedQuery: unknown }).validatedQuery = result.data;
    next();
  };
}

/**
 * Validates request params against a Zod schema.
 * Returns a 400 response with formatted error details if validation fails.
 * Note: In Express 5.x, req.params is read-only. Validated data is attached to req.validatedParams.
 */
export function validateParams(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.params);

    if (!result.success) {
      const formatted = formatZodError(result.error);
      res.status(400).json({
        error: formatted.message,
        validationErrors: formatted.details,
      });
      return;
    }

    // Attach validated data to req for access in route handlers
    // Using type assertion to extend the request object
    (req as Request & { validatedParams: unknown }).validatedParams = result.data;
    next();
  };
}
