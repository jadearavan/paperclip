import { createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { agentTextMutationContentType, agentTextMutationIntegrity } from "./agent-text-mutation-integrity.js";

describe("agentTextMutationContentType", () => {
  it("rejects a Windows-1252 agent body before express.json can return 415 or reach persistence", async () => {
    const app = express();
    let persisted = 0;
    const body = Buffer.from('{"body":"????????"}', "ascii");
    const digest = createHash("sha256").update(body).digest("base64");

    app.use((req, _res, next) => {
      req.actor = { type: "agent", agentId: "agent-1", companyId: "company-1", source: "agent_api_key" } as any;
      next();
    });
    // This is the production order in createApp: auth, content-type gate,
    // JSON parser, then raw-byte and semantic integrity checks.
    app.use(agentTextMutationContentType);
    app.use(express.json({ verify: (req, _res, raw) => { (req as any).rawBody = raw; } }));
    app.use(agentTextMutationIntegrity);
    app.post("/api/issues/1/comments", (_req, res) => {
      persisted += 1;
      res.status(201).json({ body: "unexpected" });
    });

    const response = await request(app)
      .post("/api/issues/1/comments")
      .set("Content-Type", "application/json; charset=windows-1252")
      .set("Content-Digest", `sha-256=:${digest}:`)
      .send(body);

    expect(response.status).toBe(428);
    expect(persisted).toBe(0);
  });
});
