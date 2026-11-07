import assert from "node:assert/strict";
import { it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";

it("conversational reports recover a dead end once, without overriding a task, question or pause", async () => {
 for (const scenario of [
  {input: "The trace shows a gap before the next kernel launch.", feedback: "That distinguishes feeding the GPU from executing on it.", expected: 2, next: "question"},
  {input: "The trace shows a gap.", feedback: "Try this next: inspect one existing gap and bring back its launch correlation.", expected: 1, next: "question"},
  {input: "The trace shows a gap.", feedback: "What would distinguish delayed submission from slow kernel execution?", expected: 1, next: "question"},
  {input: "Please pause the session now.", feedback: "We can stop here.", expected: 1, next: "question"},
  {input: "The trace shows a gap.", feedback: "That is a useful distinction.", expected: 2, next: "feedback"},
 ]) {
  const faux=createFauxCore({}); let calls=0;
  faux.setResponses([
   () => {calls++; return fauxAssistantMessage([fauxText(scenario.feedback)]);},
   () => {calls++; return scenario.next === "question"
    ? fauxAssistantMessage([fauxToolCall("ask_user_question", {question: "What does this observation establish, and what remains unknown?"}, {id: "next-check"})], {stopReason: "toolUse"})
    : fauxAssistantMessage([fauxText("Still feedback only.")]);},
   () => {calls++; return fauxAssistantMessage([fauxText("Must not loop.")]);},
  ]);
  const agent=createTeacherAgent(undefined, {engine: {model: faux.getModel(),streamFn: (model,context,options) => {
   if (calls === 1) assert.match(JSON.stringify(context), /TURN COMPLETION/, "recovery must instruct the model, not silently repeat the same request");
   return faux.streamSimple(model,context,options);
  }},postAnswerContinuation: true,
   messages: [{role: "user",content: scenario.input,timestamp: Date.now()}]});
  await agent.continue();
  assert.equal(calls,scenario.expected,scenario.feedback);
  if (scenario.expected === 2 && scenario.next === "question") {
   assert.ok(agent.state.messages.some(m => m.role === "toolResult" && m.toolCallId === "next-check" && !m.isError));
  }
 }
});
