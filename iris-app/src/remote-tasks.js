"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const clean = (value, max = 160) => typeof value === "string" ? Array.from(value.replace(/[\x00-\x1f\x7f]/g, " ")).slice(0, max).join("") : "";
const identifier = value => typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
const observedAt = value => Number.isFinite(value) && value > 0 ? value : null;
const STATUSES = { running: "运行中", queued: "排队中", pending: "待处理", waiting: "等待输入", waiting_input: "等待输入", waiting_for_input: "等待输入", blocked: "受阻", completed: "已完成", failed: "失败", cancelled: "已取消", paused: "已暂停" };

function taskSummary(task) {
  return { id: task.id, title: task.title, provider: task.provider, status: task.status, lastObservedAt: task.lastObservedAt };
}

function taskFromSnapshot(task) {
  if (!task || !identifier(task.id)) return null;
  return {
    id: task.id, title: clean(task.title, 80) || "未命名任务", provider: clean(task.provider, 30),
    status: clean(task.status, 40), acceptance: clean(task.acceptance, 40),
    questions: (Array.isArray(task.questions) ? task.questions : []).slice(0, 30).filter(question => question && identifier(question.id)).map(question => ({
      id: question.id, text: clean(question.text, 500), kind: clean(question.kind, 40),
      dispatchId: identifier(question.dispatchId), continuationRequired: question.continuationRequired === true
    })),
    capabilities: { answer: task.capabilities?.answer === true },
    lastObservedAt: observedAt(task.lastObservedAt),
    revision: Number.isSafeInteger(task.revision) && task.revision >= 0 ? task.revision : null,
    sessionId: identifier(task.sessionId), dispatchId: identifier(task.dispatchId),
    freshness: ["connected", "stale", "offline"].includes(task.freshness) ? task.freshness : "stale"
  };
}

class RemoteTasks {
  constructor({ directory, request, now = Date.now, uuid = randomUUID }) {
    this.request = request;
    this.now = now;
    this.uuid = uuid;
    this.cacheFile = path.join(directory, "remote-task-summary.json");
    this.tasks = [];
    this.scopes = [];
    this.online = false;
    this.receivedAt = null;
    this.lastConfirmedAt = null;
    this.selectedTaskId = null;
    this.selectedQuestionId = null;
    this.sending = false;
    this.pending = new Set();
    try {
      const stat = fs.statSync(this.cacheFile);
      if (stat.size > 65536) return;
      const cache = JSON.parse(fs.readFileSync(this.cacheFile, "utf8"));
      if (cache.version !== 1 || !Array.isArray(cache.tasks)) return;
      this.lastConfirmedAt = observedAt(cache.lastConfirmedAt);
      this.tasks = cache.tasks.slice(0, 50).map(taskFromSnapshot).filter(Boolean).map(task => ({ ...task, freshness: "offline", questions: [], capabilities: { answer: false }, revision: null, sessionId: null, dispatchId: null }));
      this.selectCurrent();
    } catch {}
  }

  get task() { return this.tasks.find(task => task.id === this.selectedTaskId) || null; }
  get question() { return this.task?.questions.find(question => question.id === this.selectedQuestionId) || null; }

  selectCurrent() {
    if (!this.task) this.selectedTaskId = this.tasks[0]?.id || null;
    if (!this.question) this.selectedQuestionId = this.task?.questions[0]?.id || null;
  }

  selectTask(delta) {
    if (!this.tasks.length) return;
    const index = Math.max(0, this.tasks.findIndex(task => task.id === this.selectedTaskId));
    this.selectedTaskId = this.tasks[(index + delta % this.tasks.length + this.tasks.length) % this.tasks.length].id;
    this.selectedQuestionId = this.task.questions[0]?.id || null;
  }

  selectQuestion(delta) {
    const questions = this.task?.questions || [];
    if (!questions.length) return;
    const index = Math.max(0, questions.findIndex(question => question.id === this.selectedQuestionId));
    this.selectedQuestionId = questions[(index + delta % questions.length + questions.length) % questions.length].id;
  }

  async refresh() {
    try {
      const snapshot = await this.request("/api/remote/snapshot");
      if (!snapshot || !Array.isArray(snapshot.tasks) || !Number.isFinite(snapshot.serverTime)) throw new Error("远程任务快照无效");
      this.tasks = snapshot.tasks.slice(0, 50).map(taskFromSnapshot).filter(Boolean);
      this.scopes = Array.isArray(snapshot.permissions?.scopes) ? snapshot.permissions.scopes.filter(scope => typeof scope === "string") : [];
      this.receivedAt = this.now();
      this.lastConfirmedAt = this.receivedAt;
      this.online = true;
      this.selectCurrent();
      // Pending submissions are never replayed. A receipt may advance revision
      // before the provider answers; keep that original question locked.
      for (const key of this.pending) {
        const [taskId, questionId, sessionId, dispatchId] = JSON.parse(key);
        const task = this.tasks.find(item => item.id === taskId);
        if (!task || task.sessionId !== sessionId || !task.questions.some(item => item.id === questionId && item.dispatchId === dispatchId)) this.pending.delete(key);
      }
      const cache = { version: 1, lastConfirmedAt: this.lastConfirmedAt, tasks: this.tasks.map(taskSummary) };
      try {
        fs.writeFileSync(`${this.cacheFile}.tmp`, JSON.stringify(cache), { mode: 0o600 });
        fs.renameSync(`${this.cacheFile}.tmp`, this.cacheFile);
      } catch { /* A read-only filesystem must not make live task status stale. */ }
      return snapshot;
    } catch (error) {
      this.online = false;
      this.scopes = [];
      throw error;
    }
  }

  connection() {
    if (!this.online || this.receivedAt === null || this.now() - this.receivedAt >= 45000 || this.task?.freshness === "offline") return "offline";
    if (this.now() < this.receivedAt || this.now() - this.receivedAt >= 15000 || (this.task && this.task.freshness !== "connected")) return "stale";
    return "connected";
  }

  answerProblem() {
    if (this.connection() !== "connected") return "状态已过期 · 重连后再回答";
    if (!this.task || !this.question) return "没有选中的原问题";
    if (this.question.kind !== "question" || this.question.continuationRequired) return "此项需在手机或主机确认";
    if (!this.scopes.includes("answer") || !this.task.capabilities.answer) return "当前设备没有回答权限";
    if (this.task.revision === null || !this.question.dispatchId || (this.task.dispatchId && this.question.dispatchId !== this.task.dispatchId)) return "问题上下文已变化 · 请刷新";
    if (this.sending || this.pending.has(JSON.stringify([this.task.id, this.question.id, this.task.sessionId, this.question.dispatchId]))) return "答复已提交 · 等待主机确认";
    return null;
  }

  navigation(action) {
    if (action === "left") this.selectTask(-1);
    else if (action === "right") this.selectTask(1);
    else if (action === "up") this.selectQuestion(-1);
    else if (action === "down") this.selectQuestion(1);
    else if (action === "activate") return this.answerProblem() || "手机回答或输入 /answer 内容";
    else if (action === "back") return "远程任务只读 · 左右切换";
    return null;
  }

  async answer(text) {
    const problem = this.answerProblem();
    if (problem) throw new Error(problem);
    const answer = String(text || "").trim();
    if (!answer || answer.length > 4000) throw new Error("回答须为 1–4000 个字符");
    const task = this.task, question = this.question;
    const key = JSON.stringify([task.id, question.id, task.sessionId, question.dispatchId]);
    const command = {
      id: this.uuid(), taskId: task.id, action: "answer", expectedRevision: task.revision,
      sessionId: task.sessionId, questionId: question.id, dispatchId: question.dispatchId,
      expiresAt: this.now() + 60000, payload: { answer }
    };
    this.sending = true;
    // A timeout leaves delivery ambiguous. Keep this binding locked until a
    // refreshed host question resolves it; never manufacture another command ID.
    this.pending.add(key);
    try {
      await this.request("/api/remote/commands", command);
      return "答复已提交 · 等待主机确认";
    } catch (error) {
      this.online = false;
      this.scopes = [];
      if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500 && error.status !== 408) {
        this.pending.delete(key);
        throw new Error("答复被拒绝 · 请刷新后重试");
      }
      throw new Error("答复未确认 · 请在手机核对");
    } finally { this.sending = false; }
  }

  hudLines() {
    const task = this.task, question = this.question;
    const connection = this.connection();
    const labels = { connected: "在线", stale: "过期", offline: "断连" };
    const stamp = task?.lastObservedAt || this.lastConfirmedAt;
    const time = stamp ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(stamp) : "尚无确认";
    const footer = stamp ? `${labels[connection]} · 最后确认${time}` : `${labels[connection]} · ${time}`;
    if (!task) return ["远程 Agent 任务", this.online ? "暂无可见任务 · 手机选择" : "等待连接 · 不发送命令", footer];
    const index = this.tasks.findIndex(item => item.id === task.id);
    const title = `${index + 1}/${this.tasks.length} ${task.title}`;
    const status = STATUSES[task.status] || task.status || "状态未知";
    const questionIndex = task.questions.findIndex(item => item.id === question?.id);
    const content = question ? `${question.kind === "question" && !question.continuationRequired ? "问" : "待确认"}${questionIndex + 1}/${task.questions.length} ${question.text}` : `${task.provider ? `${task.provider} · ` : ""}${task.acceptance || ""}`;
    return [title, `${status} · ${content}`, footer].map(line => Array.from(line).slice(0, 22).join(""));
  }
}

module.exports = { RemoteTasks };
