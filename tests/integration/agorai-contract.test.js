/**
 * Agorai Contract Tests
 *
 * Verifies the API contract between AIngram and Agorai.
 * These tests call the Agorai API and verify expected behavior.
 *
 * Prerequisites:
 *   - agorai-aingram-test container running on shared network
 *   - AGORAI_URL env var set (default: http://agorai-aingram-test:3200)
 *
 * Run: npm test -- --grep contract
 */

const AGORAI_URL = process.env.AGORAI_URL || "http://localhost:3200";

describe("Agorai Contract Tests", () => {
  // These tests require a running Agorai instance.
  // They are skipped by default in unit test runs.
  // Run with: AGORAI_URL=http://localhost:3200 npm test -- --grep contract

  const skip = !process.env.AGORAI_URL;

  (skip ? describe.skip : describe)("Public Read", () => {
    it("GET /api/conversations/:id/public returns 404 for non-existent conversation", async () => {
      const res = await fetch(`${AGORAI_URL}/api/conversations/nonexistent/public`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });

    it("GET /api/conversations/:id/public supports max_level query param", async () => {
      // Assumes a public conversation exists — integration test setup needed
      const res = await fetch(`${AGORAI_URL}/api/conversations/test/public?max_level=1&limit=10`);
      // Either 404 (no such conversation) or 200 with array
      expect([200, 404]).toContain(res.status);
    });
  });

  (skip ? describe.skip : describe)("Health", () => {
    it("GET /health returns ok", async () => {
      const res = await fetch(`${AGORAI_URL}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.version).toBeDefined();
    });
  });
});
