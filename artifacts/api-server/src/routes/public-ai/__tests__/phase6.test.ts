/**
 * Ora → Builder handoff is permanently disabled.
 *
 * Route: POST /api/public-ai/handoff/create
 * Expected: always returns 410 Gone, no token generated.
 */

import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import handoffRouter from "../handoff";

const app = express();
app.use(express.json());
app.use(handoffRouter);

describe("POST /api/public-ai/handoff/create — permanently disabled", () => {
  it("returns 410 Gone for any POST request", async () => {
    const res = await request(app)
      .post("/public-ai/handoff/create")
      .send({ messages: [] });
    expect(res.status).toBe(410);
  });

  it("does not return a token in the response body", async () => {
    const res = await request(app)
      .post("/public-ai/handoff/create")
      .send({ messages: [] });
    expect(res.body).not.toHaveProperty("token");
    expect(res.body).not.toHaveProperty("expiresAt");
  });

  it("returns an error string", async () => {
    const res = await request(app)
      .post("/public-ai/handoff/create")
      .send({ messages: [] });
    expect(typeof res.body.error).toBe("string");
    expect(res.body.error.length).toBeGreaterThan(0);
  });
});
