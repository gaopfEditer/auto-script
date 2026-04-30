<template>
  <div class="page">
    <el-tabs v-model="activeTab">
      <el-tab-pane label="任务设置" name="settings">
        <el-row :gutter="16">
          <el-col :span="10">
            <el-card>
              <template #header>创建任务定义</template>
              <el-form :model="form" label-width="90px">
                <el-form-item label="任务名称">
                  <el-input v-model="form.name" />
                </el-form-item>
                <el-form-item label="执行周期">
                  <el-input v-model="form.task_cycle" placeholder="例如 */5 * * * *" />
                </el-form-item>
                <el-form-item label="类目">
                  <el-input v-model="form.category" />
                </el-form-item>
                <el-form-item label="Agent ID">
                  <el-input v-model="form.agent_id" />
                </el-form-item>
                <el-form-item label="Payload">
                  <el-input v-model="payloadText" type="textarea" :rows="5" />
                </el-form-item>
                <el-form-item label="启用">
                  <el-switch v-model="form.is_enabled" />
                </el-form-item>
                <el-button type="primary" @click="onCreateDefinition">创建定义</el-button>
              </el-form>
            </el-card>
          </el-col>

          <el-col :span="14">
            <el-card>
              <template #header>
                <div class="header-row">
                  <span>任务定义</span>
                  <el-button @click="loadDefinitions">刷新</el-button>
                </div>
              </template>
              <el-table :data="definitions" size="small">
                <el-table-column prop="id" label="ID" width="70" />
                <el-table-column prop="name" label="名称" />
                <el-table-column prop="task_cycle" label="周期" />
                <el-table-column prop="category" label="类目" />
                <el-table-column prop="agent_id" label="Agent ID" />
                <el-table-column label="操作" width="250">
                  <template #default="{ row }">
                    <el-button type="success" link @click="onRun(row.id)">入队执行</el-button>
                    <el-button type="primary" link @click="onTriggerNow(row.id)">立即触发</el-button>
                    <el-button type="danger" link @click="onDeleteDefinition(row.id)">删除</el-button>
                  </template>
                </el-table-column>
              </el-table>
            </el-card>
          </el-col>
        </el-row>

        <el-card class="mt16">
          <template #header>
            <div class="header-row">
              <span>执行记录</span>
              <el-button @click="loadExecutions">刷新</el-button>
            </div>
          </template>
          <el-table :data="executions" size="small">
            <el-table-column prop="id" label="执行ID" width="90" />
            <el-table-column prop="task_id" label="任务ID" width="80" />
            <el-table-column prop="task_name" label="任务名称" />
            <el-table-column prop="status" label="状态" width="100" />
            <el-table-column prop="retry_count" label="重试" width="80" />
            <el-table-column prop="started_at" label="开始时间" />
            <el-table-column prop="finished_at" label="结束时间" />
            <el-table-column label="操作" width="100">
              <template #default="{ row }">
                <el-button type="danger" link @click="onDeleteExecution(row.id)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="发起对话" name="chat">
        <el-card>
          <template #header>发送消息到 OpenClaw</template>
          <el-form label-width="100px">
            <el-form-item label="Agent ID">
              <el-select v-model="chatForm.agentId" filterable allow-create default-first-option placeholder="选择或输入 Agent ID">
                <el-option v-for="d in definitions" :key="d.id" :label="`${d.name} (${d.agent_id})`" :value="d.agent_id" />
              </el-select>
            </el-form-item>
            <el-form-item label="会话ID">
              <el-input v-model="chatForm.conversationId" placeholder="可选，不填则由 OpenClaw 侧处理" />
            </el-form-item>
          </el-form>

          <div class="chat-panel">
            <div v-for="(item, idx) in chatMessages" :key="idx" class="chat-item">
              <div class="chat-role">{{ item.role }}</div>
              <div class="chat-content">{{ item.content }}</div>
            </div>
          </div>

          <div class="chat-actions">
            <el-input v-model="chatForm.message" type="textarea" :rows="3" placeholder="输入你要发给 OpenClaw 的内容" />
            <el-button type="primary" @click="onSendChat">发送</el-button>
          </div>
        </el-card>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup>
import { onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  createDefinition,
  createExecution,
  deleteDefinition,
  deleteExecution,
  fetchDefinitions,
  fetchExecutions,
  sendChat,
  triggerExecutionNow,
} from "./api/tasks";

const activeTab = ref("settings");
const form = ref({
  name: "",
  task_cycle: "",
  category: "",
  agent_id: "",
  payload: {},
  is_enabled: true,
});
const payloadText = ref("{\"example\": \"value\"}");
const definitions = ref([]);
const executions = ref([]);
const chatMessages = ref([]);
const chatForm = ref({
  agentId: "",
  conversationId: "",
  message: "",
});

async function loadDefinitions() {
  definitions.value = await fetchDefinitions();
}

async function loadExecutions() {
  executions.value = await fetchExecutions();
}

async function onCreateDefinition() {
  try {
    form.value.payload = payloadText.value ? JSON.parse(payloadText.value) : {};
  } catch {
    ElMessage.error("Payload 必须是合法 JSON");
    return;
  }
  await createDefinition(form.value);
  ElMessage.success("任务定义已创建");
  await loadDefinitions();
}

async function onRun(taskId) {
  await createExecution(taskId);
  ElMessage.success("已入队，等待调度器发送");
  await loadExecutions();
}

async function onTriggerNow(taskId) {
  await triggerExecutionNow(taskId);
  ElMessage.success("已立即转发到 OpenClaw");
  await loadExecutions();
}

async function onDeleteDefinition(taskId) {
  await ElMessageBox.confirm("删除任务定义会级联删除其执行记录，确定继续？", "确认删除", {
    type: "warning",
    confirmButtonText: "删除",
    cancelButtonText: "取消",
  });
  await deleteDefinition(taskId);
  ElMessage.success("任务定义已删除");
  await loadDefinitions();
  await loadExecutions();
}

async function onDeleteExecution(executionId) {
  await ElMessageBox.confirm("确定删除该执行记录？", "确认删除", {
    type: "warning",
    confirmButtonText: "删除",
    cancelButtonText: "取消",
  });
  await deleteExecution(executionId);
  ElMessage.success("执行记录已删除");
  await loadExecutions();
}

async function onSendChat() {
  if (!chatForm.value.agentId || !chatForm.value.message.trim()) {
    ElMessage.warning("请填写 Agent ID 和消息内容");
    return;
  }
  const content = chatForm.value.message.trim();
  chatMessages.value.push({ role: "我", content });
  const result = await sendChat(chatForm.value.agentId, content, chatForm.value.conversationId);
  chatMessages.value.push({ role: "OpenClaw", content: JSON.stringify(result.data ?? result, null, 2) });
  chatForm.value.message = "";
}

onMounted(async () => {
  await loadDefinitions();
  await loadExecutions();
});
</script>

<style scoped>
.page {
  padding: 16px;
}
.header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.mt16 {
  margin-top: 16px;
}
.chat-panel {
  border: 1px solid #e4e7ed;
  border-radius: 6px;
  padding: 12px;
  min-height: 260px;
  max-height: 360px;
  overflow: auto;
  margin-bottom: 12px;
}
.chat-item + .chat-item {
  margin-top: 10px;
}
.chat-role {
  font-size: 12px;
  color: #909399;
}
.chat-content {
  white-space: pre-wrap;
  margin-top: 4px;
}
.chat-actions {
  display: flex;
  gap: 10px;
  align-items: flex-end;
}
</style>
