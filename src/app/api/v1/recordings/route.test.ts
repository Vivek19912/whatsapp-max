import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accountId: "acct-A",
  createdBy: "user-minter",
  // contacts visible to the mocked lookup (already account-filtered by the mock).
  contacts: [] as Array<{ id: string; phone_normalized: string }>,
  lastInsert: null as Record<string, unknown> | null,
  uploadBucket: null as string | null,
  // device-path control: null = requireDeviceUser throws 401.
  deviceUser: null as null | {
    userId: string;
    accountId: string;
    role: string;
  },
  // owner policy row for user-authenticated uploads; the route rejects
  // with 403 recording_forbidden when this does not authorize the upload.
  policy: null as null | {
    phone_recording_enabled: boolean;
    phone_recording_number: string | null;
    whatsapp_recording_source: string;
  },
}));

function chainableSelect() {
  const builder: Record<string, (...args: never[]) => unknown> = {};
  builder.select = () => builder;
  builder.eq = () => builder;
  builder.limit = async () => ({ data: h.contacts, error: null });
  builder.maybeSingle = async () => ({
    data: h.contacts.length > 0 ? { id: h.contacts[0].id } : null,
    error: null,
  });
  return builder;
}

function fakeSupabase() {
  return {
    from: (table: string) => {
      if (table === "user_recording_settings") {
        const policyChain: Record<string, (...args: never[]) => unknown> = {};
        policyChain.select = () => policyChain;
        policyChain.eq = () => policyChain;
        policyChain.maybeSingle = async () => ({ data: h.policy, error: null });
        return policyChain;
      }
      if (table === "call_recordings") {
        return {
          insert: (obj: Record<string, unknown>) => {
            h.lastInsert = obj;
            return {
              select: () => ({
                single: async () => ({
                  data: {
                    id: "r-1",
                    created_at: "2026-10-04T12:00:00.000Z",
                    ...obj,
                  },
                  error: null,
                }),
              }),
            };
          },
        };
      }
      return chainableSelect();
    },
    storage: {
      from: (bucket: string) => {
        h.uploadBucket = bucket;
        return {
          upload: async () => ({ error: null }),
          remove: async () => ({}),
        };
      },
    },
  };
}

vi.mock("@/lib/auth/api-context", () => ({
  requireApiKey: async () => ({
    authType: "api_key",
    supabase: fakeSupabase(),
    accountId: h.accountId,
    keyId: "key-1",
    scopes: ["recordings:write"],
    createdBy: h.createdBy,
  }),
}));

vi.mock("@/lib/auth/device", async (importOriginal) => {
  await importOriginal<typeof import("@/lib/auth/device")>();
  const { unauthorized } = await import("@/lib/api/v1/respond");
  return {
    bearerToken: (request: Request) => {
      const header = request.headers.get("authorization");
      if (!header) return null;
      const value = header.startsWith("Bearer ")
        ? header.slice("Bearer ".length).trim()
        : header.trim();
      return value.length > 0 ? value : null;
    },
    requireDeviceUser: async () => {
      if (!h.deviceUser) throw unauthorized("Invalid or expired session");
      return {
        authType: "user",
        supabase: fakeSupabase(),
        service: fakeSupabase(),
        userId: h.deviceUser.userId,
        accountId: h.deviceUser.accountId,
        role: h.deviceUser.role,
        fullName: null,
      };
    },
  };
});

const { POST } = await import("./route");

function uploadRequest(fields: Record<string, string> = {}, token?: string) {
  const form = new FormData();
  form.append(
    "audio",
    new File([new Uint8Array([1, 2, 3, 4])], "call.ogg", {
      type: "audio/ogg",
    }),
  );
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return new Request("https://app.test/api/v1/recordings", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
}

beforeEach(() => {
  h.accountId = "acct-A";
  h.createdBy = "user-minter";
  h.contacts = [];
  h.lastInsert = null;
  h.uploadBucket = null;
  h.deviceUser = null;
  // Owner-authorized by default: device-authenticated tests exercise the
  // upload pipeline, not the policy gate (dedicated 403 tests below set
  // their own policy).
  h.policy = {
    phone_recording_enabled: true,
    phone_recording_number: "917460939319",
    whatsapp_recording_source: "none",
  };
});

describe("POST /api/v1/recordings contact association (Phase 2B)", () => {
  it("1. unique phone match populates contact_id with matched=true", async () => {
    h.contacts = [{ id: "c-raj", phone_normalized: "91916394642516" }];
    const res = await POST(
      uploadRequest({ phone_number: "+91916394642516", direction: "out" }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      data: { contact_id: string | null; direction?: string };
    };
    expect(json.data.contact_id).toBe("c-raj");
    expect((json.data as { matched?: boolean }).matched).toBe(true);
    expect(h.lastInsert?.contact_id).toBe("c-raj");
    expect(h.lastInsert?.direction).toBe("out");
    expect(h.lastInsert?.phone_number).toBe("+91916394642516");
  });

  it("2. unknown phone uploads unlinked with matched=false", async () => {
    h.contacts = [];
    const res = await POST(uploadRequest({ phone_number: "+91111" }));
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      data: { contact_id: string | null; matched?: boolean };
    };
    expect(json.data.contact_id).toBeNull();
    expect(json.data.matched).toBe(false);
  });

  it("3. ambiguous phone uploads unlinked (never guesses)", async () => {
    h.contacts = [
      { id: "c-1", phone_normalized: "91911" },
      { id: "c-2", phone_normalized: "91911" },
    ];
    const res = await POST(uploadRequest({ phone_number: "+91911" }));
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      data: { contact_id: string | null; matched?: boolean };
    };
    expect(json.data.contact_id).toBeNull();
    expect(json.data.matched).toBe(false);
  });

  it("4/5. direction in and out are accepted and stored", async () => {
    for (const direction of ["in", "out"]) {
      const res = await POST(uploadRequest({ direction }));
      expect(res.status).toBe(201);
      expect(h.lastInsert?.direction).toBe(direction);
    }
  });

  it("6. invalid direction is rejected with 400", async () => {
    const res = await POST(uploadRequest({ direction: "missed" }));
    expect(res.status).toBe(400);
  });

  it("7. equivalent number formats match the same contact", async () => {
    h.contacts = [{ id: "c-raj", phone_normalized: "91916394642516" }];
    for (const phone of [
      "+91916394642516",
      "91916394642516",
      "+91 91639 46425 16",
      "+91-916394642516",
    ]) {
      const res = await POST(uploadRequest({ phone_number: phone }));
      expect(res.status).toBe(201);
      const json = (await res.json()) as {
        data: { contact_id: string | null };
      };
      expect(json.data.contact_id).toBe("c-raj");
    }
  });

  it("8. matching is restricted to the API key's account", async () => {
    // The mock only returns contacts "in account A" — the route must
    // scope by ctx.accountId, never globally. Here the account has no
    // such contact, so the row stays unlinked even though a contact
    // with that number exists in account B (unreachable to the mock).
    h.accountId = "acct-A";
    h.contacts = [];
    const res = await POST(uploadRequest({ phone_number: "+91999" }));
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      data: { contact_id: string | null; account_id: string };
    };
    expect(json.data.contact_id).toBeNull();
    expect(json.data.account_id).toBe("acct-A");
  });

  it("9. explicit contact_id from another account is rejected", async () => {
    // accountOwns() finds nothing in this account → 400.
    h.contacts = [];
    const res = await POST(uploadRequest({ contact_id: "c-foreign" }));
    expect(res.status).toBe(400);
  });

  it("10. upload without phone_number still succeeds (Phase 1 compat)", async () => {
    const res = await POST(
      uploadRequest({ recorded_at: "2026-10-04T15:00:00Z", duration_seconds: "10" }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      data: { contact_id: string | null; matched?: boolean };
    };
    expect(json.data.contact_id).toBeNull();
    expect(json.data.matched).toBe(false);
  });

  it("11. explicit contact_id remains authoritative over phone matching", async () => {
    // Explicit c-explicit wins even though the phone would match c-other.
    h.contacts = [{ id: "c-explicit", phone_normalized: "1" }];
    const res = await POST(
      uploadRequest({ contact_id: "c-explicit", phone_number: "+91911" }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      data: { contact_id: string | null; matched?: boolean };
    };
    expect(json.data.contact_id).toBe("c-explicit");
    expect(json.data.matched).toBe(true);
  });

  it("12. phone_number over 64 characters is rejected with 400", async () => {
    const res = await POST(uploadRequest({ phone_number: "1".repeat(65) }));
    expect(res.status).toBe(400);
  });

  it("13. empty phone_number uploads with no match", async () => {
    const res = await POST(uploadRequest({ phone_number: "   " }));
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      data: { contact_id: string | null; matched?: boolean };
    };
    expect(json.data.contact_id).toBeNull();
    expect(json.data.matched).toBe(false);
  });

  it("audio still lands in the private call-recordings bucket", async () => {
    const res = await POST(uploadRequest({ phone_number: "+91911" }));
    expect(res.status).toBe(201);
    expect(h.uploadBucket).toBe("call-recordings");
  });

  it("device session uploads with uploaded_by = the authenticated user", async () => {
    h.deviceUser = { userId: "user-sagar", accountId: "acct-A", role: "agent" };
    h.contacts = [{ id: "c-raj", phone_normalized: "91916394642516" }];
    const res = await POST(
      uploadRequest(
        { phone_number: "+91916394642516", direction: "out" },
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig"
      )
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      data: { contact_id: string | null; matched?: boolean };
    };
    expect(json.data.contact_id).toBe("c-raj");
    expect(json.data.matched).toBe(true);
    expect(h.lastInsert?.account_id).toBe("acct-A");
    expect(h.lastInsert?.uploaded_by).toBe("user-sagar");
  });

  it("device session ignores client-supplied account_id", async () => {
    h.deviceUser = { userId: "user-sagar", accountId: "acct-A", role: "owner" };
    const res = await POST(
      uploadRequest({ account_id: "acct-B" }, "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig")
    );
    expect(res.status).toBe(201);
    expect(h.lastInsert?.account_id).toBe("acct-A");
    expect(h.lastInsert?.uploaded_by).toBe("user-sagar");
  });

  it("invalid device session is 401", async () => {
    h.deviceUser = null;
    const res = await POST(
      uploadRequest({}, "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig")
    );
    expect(res.status).toBe(401);
  });

  it("call_type phone/whatsapp/whatsapp_business are accepted and stored", async () => {
    for (const callType of ["phone", "whatsapp", "whatsapp_business"]) {
      const res = await POST(uploadRequest({ call_type: callType }));
      expect(res.status).toBe(201);
      expect(h.lastInsert?.call_type).toBe(callType);
      const json = (await res.json()) as {
        data: { call_type?: string | null };
      };
      expect(json.data.call_type).toBe(callType);
    }
  });

  it("invalid call_type is rejected with 400", async () => {
    for (const callType of ["voip", "telegram", "unknown", "PHONE"]) {
      const res = await POST(uploadRequest({ call_type: callType }));
      expect(res.status).toBe(400);
    }
  });

  it("absent call_type uploads unclassified (backward compatible)", async () => {
    const res = await POST(uploadRequest({}));
    expect(res.status).toBe(201);
    expect(h.lastInsert?.call_type).toBeNull();
  });
});

describe("POST /api/v1/recordings owner policy (user-authenticated)", () => {
  const userToken =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig";

  it("phone upload accepted when owner enabled the user (matching source SIM)", async () => {
    h.deviceUser = { userId: "user-sagar", accountId: "acct-A", role: "agent" };
    h.policy = {
      phone_recording_enabled: true,
      phone_recording_number: "917460939319",
      whatsapp_recording_source: "none",
    };
    const res = await POST(
      uploadRequest(
        { source_phone_number: "+91 74609 39319" },
        userToken,
      ),
    );
    expect(res.status).toBe(201);
  });

  it("phone upload rejected when owner disabled recording", async () => {
    h.deviceUser = { userId: "user-sagar", accountId: "acct-A", role: "agent" };
    h.policy = {
      phone_recording_enabled: false,
      phone_recording_number: "917460939319",
      whatsapp_recording_source: "none",
    };
    const res = await POST(uploadRequest({}, userToken));
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("recording_forbidden");
  });

  it("phone upload rejected when source SIM does not match the assigned number", async () => {
    h.deviceUser = { userId: "user-sagar", accountId: "acct-A", role: "agent" };
    h.policy = {
      phone_recording_enabled: true,
      phone_recording_number: "917460939319",
      whatsapp_recording_source: "none",
    };
    const res = await POST(
      uploadRequest({ source_phone_number: "+91 99999 00000" }, userToken),
    );
    expect(res.status).toBe(403);
  });

  it("whatsapp upload accepted only for the owner-selected app", async () => {
    h.deviceUser = { userId: "user-sagar", accountId: "acct-A", role: "agent" };
    h.policy = {
      phone_recording_enabled: false,
      phone_recording_number: null,
      whatsapp_recording_source: "whatsapp",
    };
    const ok = await POST(
      uploadRequest({ call_type: "whatsapp" }, userToken),
    );
    expect(ok.status).toBe(201);
    const denied = await POST(
      uploadRequest({ call_type: "whatsapp_business" }, userToken),
    );
    expect(denied.status).toBe(403);
  });

  it("whatsapp uploads rejected when owner selected none", async () => {
    h.deviceUser = { userId: "user-sagar", accountId: "acct-A", role: "agent" };
    h.policy = {
      phone_recording_enabled: false,
      phone_recording_number: null,
      whatsapp_recording_source: "none",
    };
    for (const callType of ["whatsapp", "whatsapp_business"]) {
      const res = await POST(uploadRequest({ call_type: callType }, userToken));
      expect(res.status).toBe(403);
    }
  });

  it("api-key uploads keep the legacy account-scoped behaviour (no per-user gate)", async () => {
    h.deviceUser = null;
    h.policy = null;
    const res = await POST(uploadRequest({ call_type: "whatsapp" }));
    expect(res.status).toBe(201);
  });
});
