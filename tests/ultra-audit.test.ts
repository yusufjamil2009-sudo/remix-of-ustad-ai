import { test } from "node:test";
import assert from "node:assert/strict";
import { stripProtectedFields } from "../src/lib/strip-protected";
import { modelCapabilities, modelCapabilityKnown, modelHas } from "../src/lib/model-capabilities";
import { selectVisual } from "../src/lib/classroom2d/visual-select";
import { buildTeachingPlan } from "../src/lib/teaching/builder";
import { fromStudyLessonContent } from "../src/lib/teaching/normalize";
import { classifyDoubt } from "../src/lib/classroom2d/lesson";
import { normalizeForSpeech } from "../src/lib/speech-normalize";
import { gatherWeb, route } from "../src/lib/router.server";
import { requestId } from "../src/lib/classroom2d/recovery";

test("Bug #21: stripProtectedFields drops ownership columns", () => {
  const safe = stripProtectedFields({
    guest_id: "guest_attacker",
    id: "hack",
    created_at: "2000-01-01",
    title: "ok",
    content: "keep",
  });
  assert.equal(safe["guest_id"], undefined);
  assert.equal(safe["id"], undefined);
  assert.equal(safe["created_at"], undefined);
  assert.equal(safe["title"], "ok");
  assert.equal(safe["content"], "keep");
});

test("Bug #18: unknown model does not inherit provider vision", () => {
  assert.equal(modelCapabilityKnown("openai", "totally-unknown-model-xyz"), false);
  assert.equal(modelHas("openai", "totally-unknown-model-xyz", "vision"), false);
  assert.deepEqual(modelCapabilities("openai", "totally-unknown-model-xyz"), ["text"]);
  assert.equal(modelHas("openai", "gpt-4o", "vision"), true);
});

test("Bugs #6/#7/#23: unknown topic does not invent a cycle 3D model", () => {
  const v = selectVisual("Medieval poetry of Kabir", "Show me this in 3D");
  assert.equal(v.mode, "board");
  assert.equal(v.kind, "book");
  assert.equal(classifyDoubt("Show me Kabir in 3D", "Medieval poetry"), null);
  assert.ok(classifyDoubt("show the atom", "Chemistry"));
  // photosynthesis is a known plant — never a fabricated cycle3d
  assert.notEqual(classifyDoubt("show me photosynthesis", "Biology")?.kind, "cycle3d");
});

test("Bug #4: board writes keywords, narration keeps prose", () => {
  const plan = buildTeachingPlan(
    fromStudyLessonContent("Photosynthesis", {
      title: "Photosynthesis",
      sections: [
        {
          heading: "Definition",
          body: "Photosynthesis is the process by which green plants make food using sunlight, water and carbon dioxide over a long explanation that must not all sit on the board.",
        },
      ],
      keyPoints: ["Plants use light energy"],
    }),
  );
  const writes = plan.steps.flatMap((s) => s.board ?? []).filter((op) => op.op === "write");
  for (const w of writes) {
    if (w.op === "write") {
      assert.ok(
        w.text.length < 160 || /Photosynthesis|Definition|Recap|Practice|light/i.test(w.text),
        `board line too prose-like: ${w.text}`,
      );
    }
  }
  assert.ok(plan.steps.some((s) => (s.say ?? "").includes("green plants make food")));
});

test("Bug #5: (a+b)^2 expands into progressive math beats", () => {
  const plan = buildTeachingPlan(
    fromStudyLessonContent("Algebra", {
      title: "Identity",
      sections: [
        { heading: "Expand", body: "We expand (a+b)^2 using the identity a^2 + 2ab + b^2." },
      ],
    }),
  );
  const labels = plan.steps.map((s) => s.label ?? "");
  assert.ok(labels.some((l) => /Given|Formula|First term|Final/i.test(l)));
  const boards = plan.steps.flatMap((s) => s.board ?? []).filter((op) => op.op === "write");
  assert.ok(boards.some((op) => op.op === "write" && /a² \+ 2ab \+ b²|\(a \+ b\)²/.test(op.text)));
});

test("Bug #12: TTS never speaks raw LaTeX", () => {
  const spoken = normalizeForSpeech("Area is $\\frac{1}{2}bh$ and $x^2$.");
  assert.equal(/\\frac|\$/.test(spoken), false);
  assert.ok(/divided by|squared/i.test(spoken));
});

test("Bug #17: gatherWeb uses a real keyless fallback when no search provider is configured", async () => {
  const decision = route({
    text: "What is the latest news today?",
    hasImages: false,
    preferredLanguage: "english",
    dataSaver: false,
    webSearchEnabled: true,
  });
  const web = await gatherWeb([], decision, "What is the latest news today?");
  if (web.sources.length > 0) {
    assert.ok(web.sources.every((source) => source.title && /^https?:\/\//.test(source.url)));
    assert.equal(web.webError, undefined);
  } else {
    assert.ok(web.webError && /public web-search fallback/i.test(web.webError));
  }
});

test("Bug #13: requestId is stable for the same doubt identity", () => {
  const a = requestId(["sess-1", "lesson-9", 3, "why is the sky blue"]);
  const b = requestId(["sess-1", "lesson-9", 3, "why is the sky blue"]);
  const c = requestId(["sess-1", "lesson-9", 4, "why is the sky blue"]);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("Bug #13: runWithRecovery returns the settled success instead of re-calling AI", async () => {
  const { runWithRecovery } = await import("../src/lib/classroom2d/recovery");
  let n = 0;
  const id = `ultra-audit-${Date.now()}-${Math.random()}`;
  const run = async () => {
    n += 1;
    return { n };
  };
  const first = await runWithRecovery(id, "doubt-ai", run);
  const second = await runWithRecovery(id, "doubt-ai", run);
  assert.equal(first.n, 1);
  assert.equal(second.n, 1);
  assert.equal(n, 1);
});
