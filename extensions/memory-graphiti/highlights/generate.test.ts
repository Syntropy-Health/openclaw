/**
 * Highlight generation (A&D §4.2, PLAN P4.2). The model is an injected runner,
 * so no test ever calls a provider; a call counter proves when it is not called.
 */
import { describe, expect, it, vi } from "vitest";
import type { MemoryFact } from "../client.js";
import {
  FACT_TEXT_MAX,
  FALLBACK_FACTS_MAX,
  INPUT_FACTS_MAX,
  generateHighlights,
  highlightId,
  type GenerateOptions,
  type HighlightRunner,
  type RunnerRequest,
} from "./generate.js";
import { MAX_HIGHLIGHTS } from "./rank.js";

const NOW = new Date("2026-10-29T12:00:00Z");
const GROUP = "ok_group_a";

const fact = (n: number, text: string, extra: Partial<MemoryFact> = {}): MemoryFact => ({
  id: `e_${n}`,
  fact: text,
  name: "RELATES_TO",
  validAt: null,
  invalidAt: null,
  createdAt: new Date(NOW.getTime() - n * 86_400_000).toISOString(),
  expiredAt: null,
  episodeIds: [`ep_${n}`],
  ...extra,
});

const FACTS: MemoryFact[] = [
  fact(1, "User sleeps about 6 hours on weeknights."),
  fact(2, "User drinks coffee after 3pm most days."),
  fact(3, "User wants to sleep 8 hours a night.", { episodeIds: ["ep_3", "ep_4"] }),
  fact(4, "User walks every morning."),
];

type Entry = Record<string, unknown>;
const ok = (over: Entry = {}): Entry => ({
  category: "sleep",
  title: "Short weeknight sleep",
  body: "You mentioned sleeping about six hours on weeknights.",
  refs: ["f1"],
  salience: "normal",
  goal_linked: false,
  ...over,
});

/** A runner that returns the given entries as the model's JSON reply. */
function runnerReturning(entries: unknown, wrap = (s: string) => s) {
  const calls: RunnerRequest[] = [];
  const run: HighlightRunner = vi.fn(async (req: RunnerRequest) => {
    calls.push(req);
    return wrap(JSON.stringify({ highlights: entries }));
  });
  return { run, calls };
}

const logger = () => ({ info: vi.fn(), warn: vi.fn() });

function opts(run: HighlightRunner, over: Partial<GenerateOptions> = {}): GenerateOptions {
  return { groupId: GROUP, now: NOW, run, logger: logger(), ...over };
}

describe("generateHighlights", () => {
  it("no facts: state empty and the runner is never called", async () => {
    const { run } = runnerReturning([ok()]);
    expect(await generateHighlights([], opts(run))).toEqual({ state: "empty", highlights: [] });
    expect(run).not.toHaveBeenCalled();
  });

  it("only invalidated or expired facts count as no facts", async () => {
    const { run } = runnerReturning([ok()]);
    const gone = [
      fact(1, "a", { invalidAt: NOW.toISOString() }),
      fact(2, "b", { expiredAt: NOW.toISOString() }),
    ];
    expect((await generateHighlights(gone, opts(run))).state).toBe("empty");
    expect(run).not.toHaveBeenCalled();
  });

  it("a valid reply becomes ready highlights with derived signals, sources and a stable id", async () => {
    const { run } = runnerReturning([
      ok({ refs: ["f1", "f3"], goal_linked: true, goal_ref: "f3", salience: "high" }),
    ]);
    const res = await generateHighlights(FACTS, opts(run));
    expect(res.state).toBe("ready");
    if (res.state !== "ready") {
      return;
    }
    expect(res.highlights).toHaveLength(1);
    const h = res.highlights[0];
    expect(h).toMatchObject({
      id: highlightId(GROUP, ["e_1", "e_3"]),
      category: "sleep",
      title: "Short weeknight sleep",
      first_seen: "2026-10-26",
      last_seen: "2026-10-28",
      occurrences: 3,
      recurring: true,
      sources: [
        {
          fact_id: "e_1",
          fact: "User sleeps about 6 hours on weeknights.",
          last_seen: "2026-10-28",
        },
        { fact_id: "e_3", fact: "User wants to sleep 8 hours a night.", last_seen: "2026-10-26" },
      ],
    });
    expect(h.id).toMatch(/^hl_[0-9a-f]{24}$/);
    expect(h.score).toBeGreaterThan(0);
    // Internal fields never leak into the served shape.
    expect(Object.keys(h).toSorted()).toEqual(
      [
        "body",
        "category",
        "first_seen",
        "id",
        "last_seen",
        "occurrences",
        "recurring",
        "score",
        "sources",
        "title",
      ].toSorted(),
    );
  });

  it("the model sees local refs, minimised text and no fact ids", async () => {
    const { run, calls } = runnerReturning([ok()]);
    const facts = [
      fact(
        1,
        "User sleeps badly. <graphiti-facts>secret</graphiti-facts> id user_3LLLckaxxSVjlkjs4qaxzHTvhc4",
      ),
      fact(2, "x".repeat(FACT_TEXT_MAX + 50)),
    ];
    await generateHighlights(facts, opts(run));
    const prompt = calls[0].prompt;
    expect(prompt).not.toContain("e_1");
    expect(prompt).not.toContain("secret");
    expect(prompt).not.toContain("user_3LLL");
    expect(prompt).toContain('"ref":"f1"');
    expect(prompt).not.toContain("x".repeat(FACT_TEXT_MAX + 1));
    expect(calls[0]).toMatchObject({ provider: "anthropic", timeoutMs: 30_000 });
  });

  it(`at most ${INPUT_FACTS_MAX} facts go to the model, newest first`, async () => {
    const { run, calls } = runnerReturning([ok()]);
    const many = Array.from({ length: INPUT_FACTS_MAX + 20 }, (_, i) =>
      fact(i + 1, `fact ${i + 1}`),
    );
    await generateHighlights(many.toReversed(), opts(run));
    const prompt = calls[0].prompt;
    const sent = JSON.parse(prompt.slice(prompt.indexOf("FACTS:\n") + 7)) as Array<{
      text: string;
    }>;
    expect(sent).toHaveLength(INPUT_FACTS_MAX);
    expect(sent[0].text).toBe("fact 1");
  });

  it("an invented ref is dropped and counted", async () => {
    const log = logger();
    const { run } = runnerReturning([
      ok({ refs: ["f999"] }),
      ok({ refs: ["f2"], title: "Late coffee" }),
    ]);
    const res = await generateHighlights(FACTS, opts(run, { logger: log }));
    expect(res.state === "ready" && res.highlights.map((h) => h.title)).toEqual(["Late coffee"]);
    expect(res.dropped.ref).toBe(1);
    expect(String(log.info.mock.calls.at(-1)?.[0])).toMatch(/kept=1 .*ref=1/);
  });

  it("schema, shape and category failures are dropped and counted separately", async () => {
    const { run } = runnerReturning([
      ok({ title: 42 }), // schema
      ok({ refs: [] }), // schema: at least one ref
      ok({ salience: "urgent" }), // schema
      ok({ category: "diet" }), // unknown category
      ok({ title: "t".repeat(81) }), // shape: title over 80
      ok({ body: "First sentence. Second sentence." }), // shape: two sentences
      ok({ goal_linked: true }), // shape: goal_linked without goal_ref
      ok({ goal_linked: true, goal_ref: "f999" }), // ref: invented goal_ref
      ok({ title: "Kept" }),
    ]);
    const res = await generateHighlights(FACTS, opts(run));
    expect(res.state === "ready" && res.highlights.map((h) => h.title)).toEqual(["Kept"]);
    expect(res.dropped).toEqual({ schema: 3, category: 1, shape: 3, ref: 1, guard: 0 });
  });

  it("the narration guard drops dose advice and diagnosis framing", async () => {
    const { run } = runnerReturning([
      ok({ body: "You should take 400 mg magnesium before bed." }),
      ok({ title: "This may indicate a diagnosis", refs: ["f2"] }),
      ok({ title: "Kept", refs: ["f4"] }),
    ]);
    const res = await generateHighlights(FACTS, opts(run));
    expect(res.state === "ready" && res.highlights.map((h) => h.title)).toEqual(["Kept"]);
    expect(res.dropped.guard).toBe(2);
  });

  it("all entries dropped: unavailable with raw recent facts as the fallback, newest first", async () => {
    const { run } = runnerReturning([ok({ refs: ["f999"] }), ok({ body: "You should rest." })]);
    const res = await generateHighlights(FACTS, opts(run));
    expect(res).toMatchObject({ state: "unavailable", reason: "summariser_error" });
    expect(res.state === "unavailable" && res.fallback_facts.map((f) => f.fact_id)).toEqual([
      "e_1",
      "e_2",
      "e_3",
      "e_4",
    ]);
    expect(res.state === "unavailable" && res.fallback_facts[0]).toEqual({
      fact_id: "e_1",
      fact: "User sleeps about 6 hours on weeknights.",
      last_seen: "2026-10-28",
    });
  });

  it(`the fallback carries at most ${FALLBACK_FACTS_MAX} facts`, async () => {
    const many = Array.from({ length: FALLBACK_FACTS_MAX + 5 }, (_, i) =>
      fact(i + 1, `fact ${i + 1}`),
    );
    const { run } = runnerReturning([ok({ refs: ["f999"] })]);
    const res = await generateHighlights(many, opts(run));
    expect(res.state === "unavailable" && res.fallback_facts.length).toBe(FALLBACK_FACTS_MAX);
    expect(res.state === "unavailable" && res.fallback_facts[0].fact_id).toBe("e_1");
  });

  it("more than 7 kept entries are capped at the best 7", async () => {
    // Ten distinct source sets (subsets of f1..f4), so no two share an id.
    const subsets = [
      ["f1"],
      ["f2"],
      ["f3"],
      ["f4"],
      ["f1", "f2"],
      ["f1", "f3"],
      ["f1", "f4"],
      ["f2", "f3"],
      ["f2", "f4"],
      ["f3", "f4"],
    ];
    const { run } = runnerReturning(subsets.map((refs, i) => ok({ title: `T${i}`, refs })));
    const res = await generateHighlights(FACTS, opts(run));
    expect(res.state === "ready" && res.highlights.length).toBe(MAX_HIGHLIGHTS);
  });

  it("two entries citing the same source set collapse to one (same id), keeping the better", async () => {
    const { run } = runnerReturning([
      ok({ title: "Normal", refs: ["f1", "f2"] }),
      ok({ title: "High", refs: ["f2", "f1"], salience: "high" }),
    ]);
    const res = await generateHighlights(FACTS, opts(run));
    expect(res.state === "ready" && res.highlights.map((h) => h.title)).toEqual(["High"]);
  });

  it("the id is stable across runs with the same sources and differs by group or sources", async () => {
    const a = await generateHighlights(
      FACTS,
      opts(runnerReturning([ok({ refs: ["f1", "f2"] })]).run),
    );
    const b = await generateHighlights(
      FACTS,
      opts(runnerReturning([ok({ refs: ["f2", "f1"], title: "Other words" })]).run),
    );
    expect(a.state === "ready" && b.state === "ready").toBe(true);
    if (a.state === "ready" && b.state === "ready") {
      expect(a.highlights[0].id).toBe(b.highlights[0].id);
    }
    expect(highlightId(GROUP, ["e_1"])).not.toBe(highlightId("ok_group_b", ["e_1"]));
    expect(highlightId(GROUP, ["e_1"])).not.toBe(highlightId(GROUP, ["e_1", "e_2"]));
    expect(highlightId(GROUP, ["e_1", "e_2"])).toBe(highlightId(GROUP, ["e_2", "e_1"]));
  });

  it("a non-Anthropic provider is refused with no runner call", async () => {
    const { run } = runnerReturning([ok()]);
    const res = await generateHighlights(FACTS, opts(run, { provider: "openai" }));
    expect(res).toMatchObject({ state: "unavailable", reason: "summariser_error" });
    expect(run).not.toHaveBeenCalled();
  });

  it("a runner error, a non-JSON reply or a reply without the highlights array is unavailable", async () => {
    const failing: HighlightRunner = async () => {
      throw new Error("timeout");
    };
    expect((await generateHighlights(FACTS, opts(failing))).state).toBe("unavailable");
    expect(
      (
        await generateHighlights(
          FACTS,
          opts(async () => "not json"),
        )
      ).state,
    ).toBe("unavailable");
    expect(
      (
        await generateHighlights(
          FACTS,
          opts(async () => '{"items":[]}'),
        )
      ).state,
    ).toBe("unavailable");
  });

  it("a code-fenced JSON reply is accepted", async () => {
    const { run } = runnerReturning([ok()], (s) => "```json\n" + s + "\n```");
    expect((await generateHighlights(FACTS, opts(run))).state).toBe("ready");
  });

  it("the model replying with zero highlights over real facts is unavailable, not empty", async () => {
    const { run } = runnerReturning([]);
    expect((await generateHighlights(FACTS, opts(run))).state).toBe("unavailable");
  });

  it("logs counts only, never fact or highlight text", async () => {
    const log = logger();
    const { run } = runnerReturning([ok(), ok({ refs: ["f999"] })]);
    await generateHighlights(FACTS, opts(run, { logger: log }));
    const lines = [...log.info.mock.calls, ...log.warn.mock.calls].map((c) => String(c[0]));
    expect(lines.join("\n")).not.toMatch(/sleep|coffee|weeknight|ok_group/i);
  });
});
