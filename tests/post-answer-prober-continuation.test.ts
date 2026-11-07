import assert from "node:assert/strict";
import { it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createProberAgent } from "../src/agent/teacher-agent.ts";
import { newAnswerResult } from "../src/core/native-messages.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";

for (const toolName of ["recall", "probe"] as const) {
 it(`prober ${toolName} answer continues feedback to a valid question then waits`, async () => {
  const faux = createFauxCore({}); let calls = 0;
  const input: Parameters<typeof fauxToolCall>[1] = toolName === "recall"
   ? {question: "What is two plus two?", correctAnswer: "Four."}
   : {question: "What is two plus two?", options: [{label: "4"}, {label: "5"}], correctAnswer: "4", explanation: "Addition."};
  faux.setResponses([
   () => {calls++; return fauxAssistantMessage([fauxText("Correct. Four is the sum.")]);},
   () => {calls++; return fauxAssistantMessage([fauxToolCall(toolName, input, {id: "next-prober-question"})], {stopReason: "toolUse"});},
   () => {calls++; return fauxAssistantMessage([fauxText("Must wait for the learner.")]);},
  ]);
  const chatId = chatStore.createChat("ADMIN isolated prober continuation regression").id;
  const agent = createProberAgent({chatId, chatStore, jobStore, deliver: () => {}, spawn: () => {}}, {
   engine: {model: faux.getModel(), streamFn: faux.streamSimple},
   toolToggles: {explain: toolName === "recall"},
   postAnswerContinuation: true,
   messages: [
    fauxAssistantMessage([fauxToolCall(toolName, input, {id: "answered-prober-question"})], {stopReason: "toolUse"}),
    newAnswerResult("answered-prober-question", toolName, {kind: toolName === "recall" ? "explain" : "quiz", questionText: input.question, dontKnow: false, answers: ["4"], text: "Four", answeredAt: "2026-10-31T00:00:00Z"}),
   ],
  });
  await agent.continue();
  assert.equal(calls, 2, "feedback must trigger one continuation, then stop on a successfully posed question");
  assert.ok(agent.state.messages.some(m => m.role === "toolResult" && m.toolCallId === "next-prober-question" && !m.isError), "next question must execute successfully, not merely appear as an invalid call");
 });
}
