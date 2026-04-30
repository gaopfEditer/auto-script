import { http } from "./http";

export async function fetchDefinitions() {
  const { data } = await http.get("/api/definitions");
  return data;
}

export async function createDefinition(payload) {
  const { data } = await http.post("/api/definitions", payload);
  return data;
}

export async function deleteDefinition(taskId) {
  const { data } = await http.delete(`/api/definitions/${taskId}`);
  return data;
}

export async function createExecution(taskId) {
  const { data } = await http.post("/api/executions", { task_id: taskId });
  return data;
}

export async function triggerExecutionNow(taskId) {
  const { data } = await http.post("/api/executions/trigger-now", { task_id: taskId });
  return data;
}

export async function fetchExecutions() {
  const { data } = await http.get("/api/executions");
  return data;
}

export async function deleteExecution(executionId) {
  const { data } = await http.delete(`/api/executions/${executionId}`);
  return data;
}

export async function sendChat(agentId, message, conversationId = "", extraPayload = {}) {
  const { data } = await http.post("/api/chat/send", {
    agent_id: agentId,
    message,
    conversation_id: conversationId || null,
    extra_payload: extraPayload,
  });
  return data;
}
