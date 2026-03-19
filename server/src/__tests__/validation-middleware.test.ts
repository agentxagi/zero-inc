import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import express, { type Request, type Response } from "express";
import request from "supertest";
import { validate, validateQuery, validateParams } from "../middleware/validate.js";

describe("Validation Middleware", () => {
  describe("validate (body)", () => {
    it("should pass validation with valid body", async () => {
      const app = express();
      app.use(express.json());

      const schema = z.object({
        name: z.string().min(1),
        age: z.number().int().positive(),
      });

      app.post("/test", validate(schema), (req: Request, res: Response) => {
        res.json({ success: true, body: req.body });
      });

      const response = await request(app)
        .post("/test")
        .send({ name: "John", age: 25 });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        body: { name: "John", age: 25 },
      });
    });

    it("should return 400 with formatted error for invalid body", async () => {
      const app = express();
      app.use(express.json());

      const schema = z.object({
        name: z.string().min(1),
        age: z.number().int().positive(),
      });

      app.post("/test", validate(schema), (req: Request, res: Response) => {
        res.json({ success: true, body: req.body });
      });

      const response = await request(app)
        .post("/test")
        .send({ name: "", age: -5 });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty("error");
      expect(response.body).toHaveProperty("validationErrors");
      expect(Array.isArray(response.body.validationErrors)).toBe(true);
    });

    it("should handle missing required fields", async () => {
      const app = express();
      app.use(express.json());

      const schema = z.object({
        email: z.string().email(),
        password: z.string().min(8),
      });

      app.post("/test", validate(schema), (req: Request, res: Response) => {
        res.json({ success: true, body: req.body });
      });

      const response = await request(app)
        .post("/test")
        .send({ email: "test@example.com" }); // missing password

      expect(response.status).toBe(400);
      expect(response.body.validationErrors).toHaveLength(1);
      expect(response.body.validationErrors[0].path).toBe("password");
    });

    it("should handle nested object validation", async () => {
      const app = express();
      app.use(express.json());

      const schema = z.object({
        user: z.object({
          name: z.string(),
          address: z.object({
            city: z.string(),
            zip: z.string(),
          }),
        }),
      });

      app.post("/test", validate(schema), (req: Request, res: Response) => {
        res.json({ success: true, body: req.body });
      });

      const response = await request(app)
        .post("/test")
        .send({
          user: {
            name: "John",
            address: { city: "NYC" }, // missing zip
          },
        });

      expect(response.status).toBe(400);
      expect(response.body.validationErrors[0].path).toBe("user.address.zip");
    });

    it("should handle empty body gracefully", async () => {
      const app = express();
      app.use(express.json());

      const schema = z.object({
        optional: z.string().optional(),
      });

      app.post("/test", validate(schema), (req: Request, res: Response) => {
        res.json({ success: true, body: req.body });
      });

      const response = await request(app).post("/test").send();

      expect(response.status).toBe(200);
      expect(response.body.body).toEqual({});
    });

    it("should reject unknown keys by default", async () => {
      const app = express();
      app.use(express.json());

      const schema = z.object({
        name: z.string(),
      }).strict();

      app.post("/test", validate(schema), (req: Request, res: Response) => {
        res.json({ success: true, body: req.body });
      });

      const response = await request(app)
        .post("/test")
        .send({ name: "John", unknown: "field" });

      expect(response.status).toBe(400);
      expect(response.body.validationErrors[0].message.toLowerCase()).toContain("unrecognized");
    });
  });

  describe("validateQuery", () => {
    it("should validate query parameters", async () => {
      const app = express();

      const schema = z.object({
        page: z.string(),
        limit: z.string(),
      });

      app.get("/test", validateQuery(schema), (req: Request, res: Response) => {
        res.json({ success: true, query: req.query });
      });

      const response = await request(app).get("/test?page=1&limit=10");

      expect(response.status).toBe(200);
      expect(response.body.query).toEqual({ page: "1", limit: "10" });
    });

    it("should return 400 for invalid query parameters", async () => {
      const app = express();

      const schema = z.object({
        status: z.enum(["active", "inactive"]),
      });

      app.get("/test", validateQuery(schema), (req: Request, res: Response) => {
        res.json({ success: true, query: req.query });
      });

      const response = await request(app).get("/test?status=invalid");

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty("validationErrors");
    });

    it("should handle optional query parameters", async () => {
      const app = express();

      const schema = z.object({
        search: z.string().optional(),
        filter: z.string().optional(),
      });

      app.get("/test", validateQuery(schema), (req: Request, res: Response) => {
        res.json({ success: true, query: req.query });
      });

      const response = await request(app).get("/test?search=hello");

      expect(response.status).toBe(200);
      expect(response.body.query.search).toBe("hello");
    });
  });

  describe("validateParams", () => {
    it("should validate route parameters", async () => {
      const app = express();

      const schema = z.object({
        id: z.string().uuid(),
      });

      app.get("/test/:id", validateParams(schema), (req: Request, res: Response) => {
        res.json({ success: true, params: req.params });
      });

      const validUuid = "123e4567-e89b-12d3-a456-426614174000";
      const response = await request(app).get(`/test/${validUuid}`);

      expect(response.status).toBe(200);
      expect(response.body.params.id).toBe(validUuid);
    });

    it("should return 400 for invalid route parameters", async () => {
      const app = express();

      const schema = z.object({
        id: z.string().uuid(),
      });

      app.get("/test/:id", validateParams(schema), (req: Request, res: Response) => {
        res.json({ success: true, params: req.params });
      });

      const response = await request(app).get("/test/not-a-uuid");

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty("validationErrors");
      expect(response.body.validationErrors[0].path).toBe("id");
    });
  });

  describe("Error formatting", () => {
    it("should provide clear error messages for multiple errors", async () => {
      const app = express();
      app.use(express.json());

      const schema = z.object({
        email: z.string().email(),
        age: z.number().min(0).max(120),
        name: z.string().min(2),
      });

      app.post("/test", validate(schema), (req: Request, res: Response) => {
        res.json({ success: true });
      });

      const response = await request(app)
        .post("/test")
        .send({ email: "invalid", age: 200, name: "A" });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain("3 errors");
      expect(response.body.validationErrors.length).toBeGreaterThanOrEqual(3);
    });

    it("should show path for nested errors", async () => {
      const app = express();
      app.use(express.json());

      const schema = z.object({
        items: z.array(
          z.object({
            id: z.string(),
            quantity: z.number().positive(),
          })
        ),
      });

      app.post("/test", validate(schema), (req: Request, res: Response) => {
        res.json({ success: true });
      });

      const response = await request(app)
        .post("/test")
        .send({
          items: [
            { id: "1", quantity: 1 },
            { id: "2", quantity: -1 }, // invalid
          ],
        });

      expect(response.status).toBe(400);
      expect(response.body.validationErrors[0].path).toContain("items");
      expect(response.body.validationErrors[0].path).toContain("quantity");
    });
  });
});
