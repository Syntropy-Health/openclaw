import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpToolDescriptor, McpToolListResult } from "../../syntropy/src/client.js";
import { type CatalogOptions, type McpServerConfig, ToolCatalog } from "./catalog.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function descriptor(name: string, annotations?: Record<string, unknown>): McpToolDescriptor {
  const d: McpToolDescriptor = { name, description: `${name} tool` };
  if (annotations) d.annotations = annotations;
  return d;
}

function okResult(tools: McpToolDescriptor[]): McpToolListResult {
  return { ok: true, tools };
}

function server(id: string, token = `${id}_token`): McpServerConfig {
  return {
    id,
    baseUrl: `http://${id}.local`,
    getToken: () => Promise.resolve(token),
  };
}

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// Injectable clock
let nowMs: number;
const now = () => nowMs;

beforeEach(() => {
  nowMs = 1_000_000;
});

const baseOpts = (extra?: Partial<CatalogOptions>): CatalogOptions => ({
  now,
  log: makeLog(),
  ...extra,
});

// ---------------------------------------------------------------------------
// 1. refresh() populates per-server tools
// ---------------------------------------------------------------------------

describe("ToolCatalog refresh + getToolDescriptors", () => {
  it("populates per-server tools from listTools and tags them with serverId", async () => {
    const listTools = vi.fn(async (baseUrl: string): Promise<McpToolListResult> => {
      if (baseUrl === "http://sj.local") return okResult([descriptor("log_food")]);
      return okResult([descriptor("kg_search")]);
    });
    const catalog = new ToolCatalog([server("sj"), server("kg")], baseOpts({ listTools }));

    await catalog.refresh();

    const entries = catalog.getToolDescriptors();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => ({ serverId: e.serverId, name: e.descriptor.name }))).toEqual([
      { serverId: "sj", name: "log_food" },
      { serverId: "kg", name: "kg_search" },
    ]);
    for (const entry of entries) expect(entry.staleness).toBe("fresh");
  });

  it("PR#56: wireName preserves a tool whose natural name starts with '<serverId>:' (no mis-strip)", async () => {
    // Server "kg" exposes a tool literally named "kg:search" with NO collision, so
    // the catalog does not prefix it → surfaced name is "kg:search". The old wire-
    // name inference stripped the "kg:" prefix → "search" (wrong tool on the wire).
    // wireName must preserve the ORIGINAL name.
    const listTools = vi.fn(
      async (): Promise<McpToolListResult> => okResult([descriptor("kg:search")]),
    );
    const catalog = new ToolCatalog([server("kg")], baseOpts({ listTools }));
    await catalog.refresh();
    const [entry] = catalog.getToolDescriptors();
    expect(entry!.descriptor.name).toBe("kg:search"); // surfaced (unprefixed — no collision)
    expect(entry!.wireName).toBe("kg:search"); // original preserved, NOT stripped to "search"
  });

  // -------------------------------------------------------------------------
  // 2. Stale-while-refreshing: failure keeps previous set within maxStale
  // -------------------------------------------------------------------------

  it("keeps serving the previous tool set on refresh failure while within maxStaleSeconds", async () => {
    let fail = false;
    const listTools = vi.fn(async (): Promise<McpToolListResult> => {
      if (fail) return { ok: false, error: "sj tools/list HTTP 500" };
      return okResult([descriptor("log_food")]);
    });
    const catalog = new ToolCatalog(
      [server("sj")],
      baseOpts({ listTools, refreshSeconds: 300, maxStaleSeconds: 900 }),
    );
    const onError = vi.fn();
    catalog.onRefreshError(onError);

    await catalog.refresh();
    fail = true;
    nowMs += 400_000; // 400s: past refreshSeconds, within maxStaleSeconds
    await catalog.refresh();

    const entries = catalog.getToolDescriptors();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.descriptor.name).toBe("log_food");
    expect(entries[0]!.staleness).toBe("stale");
    expect(catalog.lastState("sj").lastError).toContain("HTTP 500");
    expect(onError).toHaveBeenCalledWith("sj", expect.stringContaining("HTTP 500"));
  });

  // -------------------------------------------------------------------------
  // 3. Past maxStaleSeconds: drop mutating tools, keep read tools as stale
  // -------------------------------------------------------------------------

  it("SEC-B1-1: past maxStaleSeconds only PROVABLY read-only tools survive — unannotated tools are dropped (fail-closed)", async () => {
    let fail = false;
    const listTools = vi.fn(async (): Promise<McpToolListResult> => {
      if (fail) return { ok: false, error: "sj tools/list HTTP 500" };
      return okResult([
        descriptor("log_food", { mutates: true }),
        descriptor("confirm_thing", { requires_confirm: true }),
        descriptor("write_note", { readOnlyHint: false }),
        descriptor("get_profile", { readOnlyHint: true }),
        descriptor("list_notes", { mutates: false }),
        descriptor("search"), // no annotations => NOT provably read-only => dropped past maxStale
      ]);
    });
    const catalog = new ToolCatalog(
      [server("sj")],
      baseOpts({ listTools, refreshSeconds: 300, maxStaleSeconds: 900 }),
    );

    await catalog.refresh();
    fail = true;
    nowMs += 1_000_000; // 1000s: past maxStaleSeconds
    await catalog.refresh();

    const entries = catalog.getToolDescriptors();
    // A compromised/unreachable backend must not keep unannotated (not provably
    // read-only) tools alive past the stale horizon by omitting annotations.
    expect(entries.map((e) => e.descriptor.name).sort()).toEqual(["get_profile", "list_notes"]);
    for (const entry of entries) expect(entry.staleness).toBe("stale");
  });

  // -------------------------------------------------------------------------
  // 4. Never-refreshed server contributes zero tools, doesn't affect others
  // -------------------------------------------------------------------------

  it("serves zero tools for a never-successfully-refreshed server without affecting others", async () => {
    const listTools = vi.fn(async (baseUrl: string): Promise<McpToolListResult> => {
      if (baseUrl === "http://sj.local") return okResult([descriptor("log_food")]);
      return { ok: false, error: "kg tools/list failed: ECONNREFUSED" };
    });
    const catalog = new ToolCatalog([server("sj"), server("kg")], baseOpts({ listTools }));

    await catalog.refresh();

    const entries = catalog.getToolDescriptors();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.serverId).toBe("sj");
    expect(catalog.lastState("kg")).toMatchObject({
      fetchedAt: null,
      toolCount: 0,
    });
    expect(catalog.lastState("kg").lastError).toContain("ECONNREFUSED");
  });

  // -------------------------------------------------------------------------
  // 5. Cross-server name collision: later server prefixed, copy not mutated
  // -------------------------------------------------------------------------

  it("prefixes the later server's colliding tool name without mutating the original", async () => {
    const kgSearch = descriptor("search");
    const listTools = vi.fn(async (baseUrl: string): Promise<McpToolListResult> => {
      if (baseUrl === "http://sj.local") return okResult([descriptor("search")]);
      return okResult([kgSearch]);
    });
    const log = makeLog();
    const catalog = new ToolCatalog([server("sj"), server("kg")], baseOpts({ listTools, log }));

    await catalog.refresh();

    const entries = catalog.getToolDescriptors();
    expect(entries.map((e) => e.descriptor.name)).toEqual(["search", "kg:search"]);
    // original descriptor untouched
    expect(kgSearch.name).toBe("search");
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![0]).toContain("search");
  });
});

// ---------------------------------------------------------------------------
// 6. Single-flight per server
// ---------------------------------------------------------------------------

describe("ToolCatalog single-flight", () => {
  it("coalesces concurrent refreshes for the same server into one listTools call", async () => {
    const gate = deferred<McpToolListResult>();
    const listTools = vi.fn(() => gate.promise);
    const catalog = new ToolCatalog([server("sj")], baseOpts({ listTools }));

    const first = catalog.refresh("sj");
    const second = catalog.refresh("sj");
    // Let getToken's microtask settle so discovery has started for both calls.
    await new Promise((resolve) => setImmediate(resolve));
    expect(listTools).toHaveBeenCalledTimes(1);

    gate.resolve(okResult([descriptor("log_food")]));
    await Promise.all([first, second]);

    expect(listTools).toHaveBeenCalledTimes(1);
    expect(catalog.getToolDescriptors()).toHaveLength(1);

    // A refresh after the in-flight one settles issues a new call.
    gate.resolve(okResult([]));
    await catalog.refresh("sj");
    expect(listTools).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 7. Auth
// ---------------------------------------------------------------------------

describe("ToolCatalog auth", () => {
  it("awaits getToken per refresh and passes the token to listTools", async () => {
    const getToken = vi.fn(async () => "sj_supersecret");
    const listTools = vi.fn(async (): Promise<McpToolListResult> => okResult([]));
    const catalog = new ToolCatalog(
      [{ id: "sj", baseUrl: "http://sj.local", getToken }],
      baseOpts({ listTools }),
    );

    await catalog.refresh();
    await catalog.refresh();

    expect(getToken).toHaveBeenCalledTimes(2);
    expect(listTools).toHaveBeenCalledWith("http://sj.local", "sj_supersecret", expect.anything());
  });

  it("treats a getToken rejection as refresh failure (fail-closed) without leaking the token", async () => {
    const listTools = vi.fn(async (): Promise<McpToolListResult> => okResult([]));
    const catalog = new ToolCatalog(
      [
        {
          id: "sj",
          baseUrl: "http://sj.local",
          getToken: () => Promise.reject(new Error("M2M mint failed")),
        },
      ],
      baseOpts({ listTools }),
    );
    const onError = vi.fn();
    catalog.onRefreshError(onError);

    await catalog.refresh();

    expect(listTools).not.toHaveBeenCalled();
    expect(catalog.getToolDescriptors()).toHaveLength(0);
    const state = catalog.lastState("sj");
    expect(state.fetchedAt).toBeNull();
    expect(state.lastError).toContain("M2M mint failed");
    expect(onError).toHaveBeenCalledWith("sj", expect.stringContaining("M2M mint failed"));
  });

  it("never includes the token value in recorded refresh errors", async () => {
    const listTools = vi.fn(
      async (): Promise<McpToolListResult> => ({ ok: false, error: "sj tools/list HTTP 401" }),
    );
    const catalog = new ToolCatalog(
      [server("sj", "sj_supersecret_value")],
      baseOpts({ listTools }),
    );

    await catalog.refresh();

    expect(catalog.lastState("sj").lastError).not.toContain("sj_supersecret_value");
  });
});

// ---------------------------------------------------------------------------
// 8. TTL semantics via the injectable clock — no self-scheduling
// ---------------------------------------------------------------------------

describe("ToolCatalog TTL", () => {
  it("reports needsRefresh once fetchedAt is older than refreshSeconds", async () => {
    const listTools = vi.fn(async (): Promise<McpToolListResult> => okResult([descriptor("t")]));
    const catalog = new ToolCatalog([server("sj")], baseOpts({ listTools, refreshSeconds: 300 }));

    expect(catalog.needsRefresh("sj")).toBe(true); // never fetched

    const fetchTime = nowMs;
    await catalog.refresh();
    expect(catalog.lastState("sj")).toEqual({
      fetchedAt: fetchTime,
      lastError: null,
      toolCount: 1,
    });
    expect(catalog.needsRefresh("sj")).toBe(false);

    nowMs += 299_000;
    expect(catalog.needsRefresh("sj")).toBe(false);

    nowMs += 2_000; // 301s since fetch
    expect(catalog.needsRefresh("sj")).toBe(true);
    // fetchedAt untouched — catalog never self-schedules
    expect(catalog.lastState("sj").fetchedAt).toBe(fetchTime);
  });
});

// ---------------------------------------------------------------------------
// isMutating
// ---------------------------------------------------------------------------

describe("ToolCatalog.isMutating", () => {
  const catalog = new ToolCatalog([], { now });

  it("is false for absent annotations (read-default)", () => {
    expect(catalog.isMutating(descriptor("t"))).toBe(false);
    expect(catalog.isMutating(descriptor("t", {}))).toBe(false);
  });

  it("is true for mutates, requires_confirm, or readOnlyHint === false", () => {
    expect(catalog.isMutating(descriptor("t", { mutates: true }))).toBe(true);
    expect(catalog.isMutating(descriptor("t", { requires_confirm: true }))).toBe(true);
    expect(catalog.isMutating(descriptor("t", { readOnlyHint: false }))).toBe(true);
  });

  it("is false for readOnlyHint === true or falsy annotation values", () => {
    expect(catalog.isMutating(descriptor("t", { readOnlyHint: true }))).toBe(false);
    expect(catalog.isMutating(descriptor("t", { mutates: false }))).toBe(false);
    expect(catalog.isMutating(descriptor("t", { requires_confirm: false }))).toBe(false);
  });
});

describe("ToolCatalog.isProvablyReadOnly (PR#56 fail-closed veto)", () => {
  const catalog = new ToolCatalog([], { now });

  it("is false for absent/empty annotations (not PROVABLY read-only)", () => {
    expect(catalog.isProvablyReadOnly(descriptor("t"))).toBe(false);
    expect(catalog.isProvablyReadOnly(descriptor("t", {}))).toBe(false);
  });

  it("is true only on an affirmative read-only assertion", () => {
    expect(catalog.isProvablyReadOnly(descriptor("t", { readOnlyHint: true }))).toBe(true);
    expect(catalog.isProvablyReadOnly(descriptor("t", { mutates: false }))).toBe(true);
  });

  it("CONTRADICTORY annotations fail closed — a mutation hint vetoes read-only", () => {
    // {readOnlyHint:true, mutates:true}: the old `||` returned true (fail-open) —
    // a compromised backend could keep a write tool alive past the max-stale drop.
    expect(catalog.isProvablyReadOnly(descriptor("t", { readOnlyHint: true, mutates: true }))).toBe(
      false,
    );
    // {readOnlyHint:false, mutates:false}: old `||` returned true via mutates===false
    // despite readOnlyHint:false explicitly asserting non-read-only.
    expect(
      catalog.isProvablyReadOnly(descriptor("t", { readOnlyHint: false, mutates: false })),
    ).toBe(false);
    // requires_confirm also vetoes.
    expect(
      catalog.isProvablyReadOnly(descriptor("t", { readOnlyHint: true, requires_confirm: true })),
    ).toBe(false);
  });

  it("INVARIANT: isProvablyReadOnly ⟹ !isMutating (strictly stronger)", () => {
    for (const ann of [
      { readOnlyHint: true, mutates: true },
      { readOnlyHint: false, mutates: false },
      { readOnlyHint: true },
      { mutates: false },
      { mutates: true },
      {},
    ]) {
      const d = descriptor("t", ann);
      if (catalog.isProvablyReadOnly(d)) {
        expect(catalog.isMutating(d), `${JSON.stringify(ann)} provably-RO but mutating`).toBe(
          false,
        );
      }
    }
  });
});
