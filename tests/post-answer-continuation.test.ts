import assert from "node:assert/strict";
import { it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { newAnswerResult } from "../src/core/native-messages.ts";
const quiz = { question: "2 + 2?", options: [{label: "4"}, {label: "5"}], correctAnswer: "4", explanation: "Addition", type: "check", nodeId: "addition" };
function setup(responses: ReturnType<typeof fauxAssistantMessage>[], enabled = true, tool = "quiz", text?: string) {
 const faux = createFauxCore({}); let calls = 0;
 faux.setResponses(responses.map(response => () => { calls++; return response; }));
 const messages = [fauxAssistantMessage([fauxToolCall(tool, quiz, {id: "old"})], {stopReason: "toolUse"}), newAnswerResult("old", tool, {kind: tool === "ask_user_question" ? "ask" : "quiz", questionText: quiz.question, dontKnow: false, answers: ["4"], answeredAt: "2026-10-31T00:00:00Z", ...(text ? {text} : {})})];
 const agent = createTeacherAgent(undefined, { engine: {model: faux.getModel(), streamFn: faux.streamSimple}, messages, postAnswerContinuation: enabled });
 return {agent, calls: () => calls};
}
const feedback = () => fauxAssistantMessage([fauxText("Correct. Four is the sum.")]);
const next = () => fauxAssistantMessage([fauxToolCall("quiz", quiz, {id: "next"})], {stopReason: "toolUse"});
it("post-answer feedback continues to a next question and waits", async () => {
 const {agent, calls} = setup([feedback(), next(), feedback()]); await agent.continue();
 assert.equal(calls(), 2);
 assert.ok(agent.state.messages.some(m => m.role === "assistant" && m.content.some(b => b.type === "toolCall" && b.id === "next")));
});

it("a learner stop request in an explain answer does not recover", async () => {
 const {agent, calls} = setup([feedback(), next()], true, "explain", "Please stop the session now.");
 await agent.continue(); assert.equal(calls(), 1);
});

it("feedback-only recovery is bounded to one additional request", async () => {
 const {agent, calls} = setup([feedback(), feedback(), next()]);
 await agent.continue(); assert.equal(calls(), 2);
});
it("ordinary turns do not force a question", async () => {
 const {agent, calls} = setup([feedback(), next()], false);
 await agent.prompt("Can you clarify this?"); assert.equal(calls(), 1);
});
it("an ask answer is not a graded-answer continuation", async () => {
 const {agent, calls} = setup([feedback(), next()], true, "ask_user_question", "Pause please");
 await agent.continue(); assert.equal(calls(), 1);
});
it("an already posed question waits without recovery", async () => {
 const {agent, calls} = setup([next(), feedback()]);
 await agent.continue(); assert.equal(calls(), 1);
});
for (const stopReason of ["error", "aborted"] as const) it(`${stopReason} remains a hard exit`, async () => {
 const {agent, calls} = setup([fauxAssistantMessage([fauxText("Interrupted")], {stopReason}), next()]);
 await agent.continue(); assert.equal(calls(), 1);
});
it("new learner input supersedes a graded answer", async () => {
 const {agent, calls} = setup([feedback(), next()]);
 await agent.prompt("Please stop."); assert.equal(calls(), 1);
});

it("a pre-existing sibling question does not trigger another question", async () => {
 const {agent, calls} = setup([feedback(), next()]);
 const first = agent.state.messages.find(m => m.role === "assistant")!;
 assert.equal(first.role, "assistant");
 if (first.role === "assistant") first.content.push(fauxToolCall("quiz", quiz, {id: "sibling"}));
 await agent.continue(); assert.equal(calls(), 1);
});
