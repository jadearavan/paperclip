import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyGovernancePolicies,
  companyGovernancePolicyRevisions,
  createDb,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { companyGovernancePolicyRoutes } from "../routes/company-governance-policy.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("company governance policy routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-governance-policy-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(companyGovernancePolicyRevisions);
    await db.delete(companyGovernancePolicies);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function setupApp() {
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Governance Co",
      issuePrefix: `G${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Developer",
      role: "developer",
      adapterType: "codex_local",
      adapterConfig: {},
      status: "idle",
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = req.header("x-test-actor") === "board"
        ? { type: "board", source: "local_implicit", userId: "board", companyIds: [], isInstanceAdmin: true }
        : { type: "agent", source: "agent_key", agentId, companyId, runId: null };
      next();
    });
    app.use(companyGovernancePolicyRoutes(db));
    app.use(errorHandler);
    return app;
  }

  const policy = {
    schemaVersion: 1,
    expectedRevision: 0,
    body: "# Company Policy\nThis is loaded outside role instructions.",
    bindings: [{
      id: "all-codex",
      priority: 1,
      effect: "include",
      subject: { type: "all_agents" },
      scopes: ["heartbeat"],
      adapterTypes: ["codex_local"],
      delivery: "required",
    }],
  } as const;

  it("is board-managed, revisioned, and exposes hash, targets, and drift readback", async () => {
    const app = await setupApp();
    await request(app)
      .put(`/companies/${companyId}/governance-policy`)
      .send(policy)
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe("governance_policy_board_required"));
    await request(app)
      .put(`/companies/${companyId}/governance-policy`)
      .set("x-test-actor", "board")
      .send(policy)
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ revision: 1 }));

    await request(app)
      .get(`/companies/${companyId}/governance-policy`)
      .set("x-test-actor", "board")
      .expect(200)
      .expect(({ body }) => {
        expect(body.active).toMatchObject({ revision: 1, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
        expect(body.drift).toEqual({ detected: false, reason: null });
        expect(body.targets).toEqual(expect.arrayContaining([
          expect.objectContaining({ agentId, bindingId: "all-codex", delivery: "required", included: true }),
        ]));
      });
    await request(app)
      .get(`/companies/${companyId}/governance-policy`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.active).toMatchObject({ revision: 1, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
        expect(body.active.body).toBeUndefined();
        expect(body.history[0].bindings).toBeUndefined();
        expect(body.targets).toHaveLength(1);
      });
    expect(await db.select().from(activityLog)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "company.governance_policy_replaced", entityType: "company_governance_policy" }),
    ]));
  });
});
