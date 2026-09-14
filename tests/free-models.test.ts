import { test } from "node:test";
import assert from "node:assert/strict";
import { isFreeModel, freeModelsFor, bestFreeModel } from "../src/lib/free-models";

test("paid-only providers offer no free model", () => {
  assert.equal(isFreeModel("openai", "gpt-4o-mini"), false);
  assert.equal(isFreeModel("xai", "grok-2-latest"), false);
  assert.deepEqual(freeModelsFor("openai", ["gpt-4o", "gpt-4o-mini"]), []);
  assert.equal(bestFreeModel("openai", ["gpt-4o"]), undefined);
});

test("gemini free tier keeps flash and drops pro", () => {
  const free = freeModelsFor("gemini", ["gemini-2.5-pro", "gemini-2.5-flash", "gemma-3-27b"]);
  assert.ok(free.includes("gemini-2.5-flash"));
  assert.ok(!free.includes("gemini-2.5-pro"));
});

test("openrouter only offers :free variants", () => {
  assert.deepEqual(freeModelsFor("openrouter", ["openai/gpt-4o-mini", "meta/llama-3.1-8b:free"]), [
    "meta/llama-3.1-8b:free",
  ]);
});

test("best free model prefers higher quality over a tiny model", () => {
  assert.equal(
    bestFreeModel("groq", ["llama-3.1-8b-instant", "llama-3.3-70b-versatile"]),
    "llama-3.3-70b-versatile",
  );
});

test("unknown provider is never assumed free", () => {
  assert.equal(isFreeModel("some-new-provider", "any-model"), false);
});
