import { describe, expect, it } from "vitest";
import { POST } from "../app/api/trpc/[trpc]/route";
import { sampleWorkflow } from "../src/lib/sample-workflow";

describe("/api/trpc route", () => {
  it("handles saveWorkflow request", async () => {
    const request = new Request("http://localhost/api/trpc/saveWorkflow", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-harbor-tenant-id": "tenant",
        "x-harbor-workspace-id": "workspace",
        "x-harbor-actor-id": "actor"
      },
      body: JSON.stringify({
        workflow: sampleWorkflow
      })
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as { result: { data: { blocked: boolean } } };
    expect(payload.result.data.blocked).toBe(false);
  });
});
