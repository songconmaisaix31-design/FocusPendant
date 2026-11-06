'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const labels = { reading: '阅读', writing: '书写', screen_work: '电脑工作', meeting: '会议', eating: '用餐', exercise: '运动', away: '离开桌面', other: '其他活动', unknown: '尚未确认' };
  const sourceLabels = { vision: '视觉线索', flow: '电脑活动', window: '电脑活动', manual: '本人记录', checkin: '主动打卡', timer: '专注计时', fused: '综合线索', none: '尚未观测', unknown: '未观测' };
  const phases = { idle: '准备开始', focus: '专注中', paused: '已暂停', break: '休息中' };
  let state = null;
  let date = '';
  let token = sessionStorage.getItem('focus-token') || '';
  let fetching = false;
  let cameraStream = null;
  let cameraTimer = null;
  let framePending = false;
  let cameraGeneration = 0;
  let toastTimer = null;
  let lastTimelineKey = '';
  let busyAction = false;
  let recordingHistory = false;
  let cloudReportDate = '';
  let healthFetching = false;
  let notesKey = '';
  let voiceUrls = [];
  let recorder = null;
  let microphoneStream = null;
  let microphoneChunks = [];
  let microphoneTimer = null;
  let microphoneStartedAt = 0;
  let microphonePending = false;
  let microphoneAborted = false;
  let speechUrl = null;
  let speechHealthFetching = false;

  function localDate(value = Date.now()) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: state?.timezone || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
    return ['year', 'month', 'day'].map((key) => parts.find((part) => part.type === key).value).join('-');
  }
  function time(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('zh-CN', { timeZone: state?.timezone || 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
  }
  function dayStart(day) {
    const target = Date.parse(day + 'T00:00:00Z');
    let result = target;
    const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: state?.timezone || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    for (let i = 0; i < 3; i++) {
      const values = Object.fromEntries(formatter.formatToParts(new Date(result)).map((part) => [part.type, part.value]));
      const represented = Date.UTC(+values.year, +values.month - 1, +values.day, +values.hour, +values.minute, +values.second);
      result += target - represented;
    }
    return result;
  }
  function duration(seconds) {
    const minutes = Math.floor(Math.max(0, Number(seconds) || 0) / 60);
    if (minutes < 60) return `${minutes} 分钟`;
    return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
  }
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function toast(message) {
    $('toast').textContent = message;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4200);
  }
  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (options.body && typeof options.body === 'object' && !(options.body instanceof Blob)) {
      headers.set('Content-Type', 'application/json');
      options = { ...options, body: JSON.stringify(options.body) };
    }
    const response = await fetch(path, { ...options, headers, signal: options.signal || AbortSignal.timeout(15000) });
    let data;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('json')) data = await response.json();
    else data = await response.text();
    if (!response.ok) {
      if (response.status === 401) $('token-form').hidden = false;
      throw new Error(typeof data === 'object' ? (data.error || data.message || `请求未成功 (${response.status})`) : `请求未成功 (${response.status})`);
    }
    return data;
  }
  async function action(payload) {
    if (busyAction) return;
    busyAction = true;
    try {
      await api('/api/action', { method: 'POST', body: payload });
      await refresh();
      return true;
    } catch (error) { toast(error.message); return false; }
    finally { busyAction = false; }
  }
  function setConnected(connected) {
    const node = $('connection-status');
    node.classList.toggle('connected', connected);
    node.lastElementChild.textContent = connected ? '本地服务已连接' : '连接已断开';
    $('connection-banner').hidden = connected;
  }
  async function refresh() {
    if (fetching) return;
    fetching = true;
    try {
      const requested = date;
      const next = await api(`/api/state${requested ? `?date=${encodeURIComponent(requested)}` : ''}`);
      if (requested !== date) return;
      if (!requested) { date = next.date; $('day-picker').value = date; }
      state = next;
      render(next);
      setConnected(true);
    } catch (error) { setConnected(false); }
    finally { fetching = false; }
  }
  function metric(id, value, unit) {
    const node = $(id);
    node.replaceChildren(document.createTextNode(String(Math.max(0, Math.floor(Number(value) || 0)))), el('span', '', unit));
  }
  function render(s) {
    $('demo-banner').hidden = !s.isDemo;
    $('insights-list').hidden = !s.insights?.length;
    $('insights-list').replaceChildren(...(s.insights || []).map((text) => el('p', 'insight', text)));
    recordingHistory = date !== localDate(s.now || Date.now());
    $('cloud-review').hidden = cloudReportDate !== date;
    $('date-caption').textContent = recordingHistory ? `${date.replaceAll('-', '.')} · 历史记录` : '今日概览';
    document.querySelectorAll('[data-mode]').forEach((button) => {
      button.classList.toggle('active', button.dataset.mode === s.modeRequested);
      button.setAttribute('aria-pressed', String(button.dataset.mode === s.modeRequested));
    });
    const effective = s.modeEffective || 'lite';
    const descriptions = { lite: 'Lite · 计时与主动记录', flow: 'Flow · 加入电脑活动线索', vision: 'Vision · 加入桌面场景线索' };
    $('mode-description').textContent = descriptions[effective] + (effective !== s.modeRequested ? ' · 采集源待连接' : '');
    $('current-label').textContent = s.current?.label || labels[s.current?.scene] || '等待记录';
    const stats = s.stats || {};
    metric('observed-stat', stats.observedSec / 60, '分钟');
    metric('focus-stat', stats.focusSec / 60, '分钟');
    metric('switches-stat', stats.switches, '次');
    metric('checkins-stat', stats.checkins, '次');
    $('distraction-count').textContent = `${stats.distractions || 0} 次`;
    renderNotes(s.notes || []);
    const seconds = Math.max(0, Math.ceil(Number(s.remainingSec) || 0));
    $('timer-display').replaceChildren(document.createTextNode(String(Math.floor(seconds / 60)).padStart(2, '0')), el('span', '', ':'), document.createTextNode(String(seconds % 60).padStart(2, '0')));
    $('timer-phase').textContent = phases[s.phase] || '准备开始';
    $('timer-toggle').textContent = s.phase === 'paused' ? '继续专注' : s.phase === 'focus' || s.phase === 'break' ? '暂停' : '开始专注';
    $('timer-finish').disabled = s.phase === 'idle';
    $('timer-title').textContent = recordingHistory ? '当前计时 · 记录到今天' : '留一段专注时间';
    $('timer-description').textContent = s.phase === 'break' ? '让眼睛休息，也给思绪一点空间' : '25 分钟专注 · 5 分钟休息';
    $('hud-mode').textContent = effective.toUpperCase();
    $('hud-lines').replaceChildren(...(s.hudLines || ['FocusPendant', '等待记录', '']).slice(0, 3).map((line) => el('p', '', line)));
    for (const name of ['flow', 'vision']) {
      const source = s.sources?.[name] || {};
      $(`${name}-dot`).classList.toggle('online', !!source.online);
      $(`${name}-status`).textContent = source.online ? '已连接' : '未连接';
      $(`${name}-detail`).textContent = source.online ? `最近更新 ${time(source.lastSeen)}` : name === 'flow' ? '等待采集端连接' : '等待有效视觉采样';
    }
    if (document.activeElement !== $('flow-enabled')) $('flow-enabled').checked = s.settings?.flowEnabled !== false;
    if (document.activeElement !== $('local-only')) $('local-only').checked = s.settings?.localOnly !== false;
    $('privacy-detail').textContent = s.settings?.localOnly === false ? '可使用已配置的云端模型' : '采样图像留在本机';
    if (cameraStream && s.settings?.cameraEnabled === false) stopCamera(false);
    renderTimeline(s.timeline || [], s.now || Date.now());
    const summary = Array.isArray(s.report?.summary) ? s.report.summary : [];
    $('review-list').replaceChildren(...(summary.length ? summary : ['今天的记录会在这里逐渐汇成复盘。']).map((line) => el('li', '', line)));
    $('review-suggestion').textContent = s.report?.suggestion || '先积累真实记录，再回看自己的节奏。';
    $('report-source').textContent = s.report?.source === 'cloud' ? '云端复盘' : '本地整理';
    renderWeekly(s.daily || []);
    $('export-markdown').href = `/api/report?date=${encodeURIComponent(date)}`;
    $('export-json').href = `/api/export?date=${encodeURIComponent(date)}`;
  }
  function renderNotes(notes) {
    const key = JSON.stringify([date, notes]);
    if (key === notesKey) return;
    notesKey = key;
    voiceUrls.forEach((url) => URL.revokeObjectURL(url));
    voiceUrls = [];
    $('notes-list').replaceChildren(...(notes.length ? [...notes].reverse().map((note) => {
      const item = el('div', 'note-entry');
      item.append(el('p', 'timeline-time', time(note.ts)), el('p', '', note.voice?.transcript ? '语音打卡 · 本地转写' : note.text || '语音打卡'));
      if (note.voice?.url && /^\/voice\/[a-z0-9._-]+$/i.test(note.voice.url)) {
        const audio = el('audio', 'voice-playback');
        audio.controls = true;
        audio.preload = 'none';
        audio.setAttribute('aria-label', `${time(note.ts)} 的语音打卡`);
        if (!token) audio.src = note.voice.url;
        else {
          const load = el('button', 'button button-secondary', '载入录音');
          load.type = 'button';
          load.addEventListener('click', async () => {
            load.disabled = true;
            try {
              const response = await fetch(note.voice.url, { headers: { Authorization: `Bearer ${token}` } });
              if (!response.ok) throw new Error('录音读取失败');
              const url = URL.createObjectURL(await response.blob());
              voiceUrls.push(url); audio.src = url; load.remove();
              await audio.play();
            } catch (error) { toast(error.message); load.disabled = false; }
          });
          item.append(load);
        }
        const voiceStatus = { saved: '录音已保存，等待本地转写', transcribing: '本地模型正在转写…', transcribed: '本地转写已完成', empty: '未检测到清晰语音，可重新录制', unavailable: '本地转写模型尚未就绪', error: '本地转写暂未完成' };
        item.append(audio, el('p', 'voice-transcript', note.voice.transcript || voiceStatus[note.voice.status] || '录音已保存 · 尚未转写'));
        if (note.voice.error) item.append(el('p', 'footnote', note.voice.error));
        if (!note.voice.transcript && note.voice.status !== 'transcribing') {
          const retry = el('button', 'button button-quiet', '本地转写');
          retry.type = 'button';
          retry.addEventListener('click', async () => {
            retry.disabled = true;
            try { await api('/api/transcribe', { method: 'POST', body: { voiceId: note.voice.id }, signal: AbortSignal.timeout(180000) }); await refresh(); }
            catch (error) { toast(error.message); retry.disabled = false; }
          });
          item.append(retry);
        }
      }
      return item;
    }) : [el('p', 'muted', '今天还没有打卡。')]));
  }
  function renderTimeline(segments, now) {
    $('segment-count').textContent = `${segments.length} 个片段`;
    const ribbon = $('day-ribbon');
    ribbon.replaceChildren();
    if (!segments.length) ribbon.append(el('div', 'blank-chart', '尚无活动记录'));
    const startDay = dayStart(date);
    const nextDate = new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
    const endDay = dayStart(nextDate);
    const dayLength = endDay - startDay;
    for (const segment of segments) {
      const start = Math.max(startDay, new Date(segment.start).getTime());
      const end = Math.min(endDay, new Date(segment.end || now).getTime());
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      const bar = el('div', 'ribbon-segment');
      bar.dataset.scene = segment.scene || Object.keys(labels).find((key) => labels[key] === segment.label) || segment.source;
      bar.style.left = `${100 * (start - startDay) / dayLength}%`;
      bar.style.width = `${Math.max(0.12, 100 * (end - start) / dayLength)}%`;
      bar.title = `${time(start)}–${time(end)} ${segment.label}`;
      ribbon.append(bar);
    }
    const key = JSON.stringify(segments);
    if (key === lastTimelineKey) return;
    lastTimelineKey = key;
    const list = $('timeline-list');
    list.replaceChildren();
    if (!segments.length) {
      const empty = el('div', 'empty-state');
      empty.append(el('span', 'empty-icon', '◌'), el('h3', '', '从第一条记录开始'), el('p', '', '开启电脑采集、连接摄像头，或手动记下此刻正在做的事。'));
      list.append(empty);
      return;
    }
    for (const segment of [...segments].reverse()) {
      const row = el('article', 'timeline-item');
      row.append(el('span', 'timeline-dot'));
      const body = el('div', 'timeline-body');
      const line = el('div', 'timeline-label');
      line.append(el('strong', '', segment.label || labels[segment.scene] || '未分类活动'), el('span', 'badge', segment.corrected ? '已修正' : sourceLabels[segment.source] || segment.source || '活动线索'));
      body.append(el('p', 'timeline-time', `${time(segment.start)} – ${segment.end ? time(segment.end) : '现在'}`), line);
      let evidence = segment.evidence;
      if (Array.isArray(evidence)) evidence = evidence.join(' · ');
      if (evidence && typeof evidence === 'object') evidence = Object.entries(evidence).map(([k, v]) => `${k}: ${v}`).join(' · ');
      const confidence = typeof segment.confidence === 'number' && segment.source === 'vision' ? ` · 模型分数 ${Math.round(segment.confidence * 100)}%（未校准）` : '';
      if (evidence || confidence) body.append(el('p', 'evidence', (evidence || '场景识别线索') + confidence));
      const correct = el('button', 'timeline-correct', '修正');
      correct.type = 'button';
      correct.setAttribute('aria-label', `修正 ${time(segment.start)} 的活动`);
      correct.addEventListener('click', async () => {
        const label = prompt('这段时间实际在做什么？', segment.label || '');
        if (!label?.trim()) return;
        if (await action({ action: 'correct', segmentId: segment.id, label: label.trim().slice(0, 80) })) toast('已保存你的修正');
      });
      row.append(body, correct);
      list.append(row);
    }
  }
  function renderWeekly(days) {
    const chart = $('weekly-bars');
    chart.replaceChildren();
    if (!days.length || !days.some((day) => day.observedSec > 0)) {
      chart.append(el('div', 'empty-state', '积累几天记录后，你会看见自己的节奏。'));
      return;
    }
    const recent = days.slice(-7);
    const max = Math.max(...recent.map((day) => Number(day.observedSec) || 0), 60);
    for (const day of recent) {
      const col = el('button', 'day-column');
      col.type = 'button';
      col.title = `${day.date} · ${duration(day.observedSec)}`;
      col.setAttribute('aria-label', col.title);
      const track = el('div', 'day-bar-track');
      const bar = el('div', 'day-bar');
      bar.style.height = `${Math.max(2, 100 * day.observedSec / max)}%`;
      track.append(bar);
      col.append(el('span', 'day-value', `${Math.floor(day.observedSec / 60)}m`), track, el('span', 'day-label', day.date.slice(5).replace('-', '/')));
      col.addEventListener('click', () => { date = day.date; $('day-picker').value = date; lastTimelineKey = ''; refresh(); });
      chart.append(col);
    }
  }
  async function stopCamera(updateServer = true) {
    cameraGeneration++;
    clearTimeout(cameraTimer);
    cameraTimer = null;
    if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    $('camera-video').srcObject = null;
    $('camera-placeholder').hidden = false;
    $('crop-guide').hidden = true;
    $('camera-toggle').textContent = '开启摄像头';
    $('camera-badge').textContent = '未开启';
    $('camera-message').textContent = '摄像头已关闭，采样停止。';
    const deviceName = $('camera-device').selectedOptions[0]?.textContent;
    $('camera-device-name').textContent = `已选择：${deviceName || '电脑默认摄像头'}`;
    if (updateServer) await action({ action: 'settings', settings: { cameraEnabled: false } });
  }
  function cameraCrop(width, height) {
    if ($('camera-crop').value === 'lower') return { x: 0, y: height / 2, width, height: height / 2 };
    if ($('camera-crop').value === 'center') return { x: width / 4, y: height / 4, width: width / 2, height: height / 2 };
    return { x: 0, y: 0, width, height };
  }
  function showCrop() {
    const crop = cameraCrop(100, 100), guide = $('crop-guide');
    guide.hidden = !cameraStream || $('camera-crop').value === 'full';
    guide.style.left = `${crop.x}%`; guide.style.top = `${crop.y}%`;
    guide.style.width = `${crop.width}%`; guide.style.height = `${crop.height}%`;
  }
  async function cameraDevices() {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'videoinput');
    const current = cameraStream?.getVideoTracks()[0]?.getSettings().deviceId || $('camera-device').value;
    $('camera-device').replaceChildren(el('option', '', '电脑默认摄像头'));
    $('camera-device').firstChild.value = '';
    devices.forEach((device, index) => {
      const option = el('option', '', device.label || `摄像头 ${index + 1}`);
      option.value = device.deviceId; $('camera-device').append(option);
    });
    if (devices.some((device) => device.deviceId === current)) $('camera-device').value = current;
    const track = cameraStream?.getVideoTracks()[0];
    $('camera-device-name').textContent = track ? `正在使用：${track.label || '电脑默认摄像头'}` : '授权后显示设备名称，可切换其他摄像头。';
  }
  async function captureFrame(generation) {
    if (!cameraStream || generation !== cameraGeneration) return;
    if (!framePending) {
      framePending = true;
      try {
        const video = $('camera-video');
        if (!video.videoWidth) throw new Error('等待摄像头画面');
        const canvas = document.createElement('canvas');
        const crop = cameraCrop(video.videoWidth, video.videoHeight);
        const ratio = Math.min(512 / crop.width, 512 / crop.height, 1);
        canvas.width = Math.round(crop.width * ratio);
        canvas.height = Math.round(crop.height * ratio);
        canvas.getContext('2d').drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.5));
        if (!blob) throw new Error('未能生成采样图像');
        if (generation !== cameraGeneration) return;
        const result = await api('/api/frame', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
        if (generation !== cameraGeneration) return;
        const label = result.label || labels[result.scene] || '尚未确认';
        $('camera-message').textContent = `${time(Date.now())} · ${label}${result.reason ? ` · ${result.reason}` : ''}`;
        await refresh();
      } catch (error) { if (generation === cameraGeneration) $('camera-message').textContent = `采样暂未完成：${error.message}`; }
      finally { framePending = false; }
    }
    if (cameraStream && generation === cameraGeneration) cameraTimer = setTimeout(() => captureFrame(generation), 20000);
  }
  async function startCamera() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      toast('请在本机 localhost 或 HTTPS 页面开启摄像头。手机局域网 HTTP 无法调用摄像头。');
      return;
    }
    const button = $('camera-toggle');
    button.disabled = true;
    try {
      const selected = $('camera-device').value;
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, ...(selected ? { deviceId: { exact: selected } } : {}) }, audio: false });
      if (!(await action({ action: 'settings', settings: { cameraEnabled: true } }))) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      cameraStream = stream;
      const generation = ++cameraGeneration;
      $('camera-video').srcObject = stream;
      $('camera-placeholder').hidden = true;
      $('camera-details').open = true;
      await $('camera-video').play();
      document.querySelector('.camera-preview').style.aspectRatio = `${$('camera-video').videoWidth} / ${$('camera-video').videoHeight}`;
      await cameraDevices(); showCrop();
      button.textContent = '关闭摄像头';
      $('camera-badge').textContent = '采样中';
      $('camera-message').textContent = '摄像头已开启，正在采样…';
      stream.getVideoTracks()[0].addEventListener('ended', () => { stopCamera(); toast('摄像头已断开'); });
      button.disabled = false;
      captureFrame(generation);
    } catch (error) {
      stopCamera();
      toast(error.name === 'NotAllowedError' ? '摄像头权限未开启；仍可使用计时和手动记录。' : `摄像头不可用：${error.message}`);
    } finally { button.disabled = false; }
  }
  async function visionHealth() {
    if (healthFetching) return;
    healthFetching = true;
    try {
      const health = await api('/api/vision-health');
      const localOnly = state?.settings?.localOnly !== false;
      const ready = localOnly ? (health.local?.ready ?? health.ready) : health.ready;
      $('vision-service-status').textContent = ready ? (localOnly ? '本地视觉模型已加载' : `识别服务已配置 · ${health.backend || '可用'}`) : `识别服务待配置：${health.reason || health.local?.error || health.error || health.status || '模型尚未就绪'}`;
    } catch (error) { $('vision-service-status').textContent = '识别服务未就绪；开启采样后可查看具体状态。'; }
    finally { healthFetching = false; }
  }
  function stopMicrophone(abort = false) {
    microphoneAborted ||= abort;
    clearInterval(microphoneTimer); microphoneTimer = null;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    if (microphoneStream) microphoneStream.getTracks().forEach((track) => track.stop());
    microphoneStream = null;
  }
  async function startMicrophone() {
    if (microphonePending || recorder?.state === 'recording') return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { toast('请使用支持录音的浏览器，在 localhost 或 HTTPS 页面打开。'); return; }
    const mime = ['audio/webm;codecs=opus', 'audio/webm'].find((value) => MediaRecorder.isTypeSupported(value));
    if (!mime) { toast('此浏览器不支持 WebM 录音，请使用 Chrome 或 Edge，或通过眼镜录音。'); return; }
    microphonePending = true; $('mic-toggle').disabled = true;
    try {
      microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      microphoneChunks = []; microphoneAborted = false;
      recorder = new MediaRecorder(microphoneStream, { mimeType: mime, audioBitsPerSecond: 48000 });
      recorder.addEventListener('dataavailable', (event) => { if (event.data.size) microphoneChunks.push(event.data); });
      recorder.addEventListener('error', () => { stopMicrophone(true); $('mic-message').textContent = '录音发生错误，请重新尝试。'; });
      recorder.addEventListener('stop', async () => {
        const activeRecorder = recorder;
        clearInterval(microphoneTimer); microphoneTimer = null;
        if (microphoneStream) microphoneStream.getTracks().forEach((track) => track.stop());
        microphoneStream = null; recorder = null;
        $('mic-duration').hidden = true; $('mic-toggle').textContent = '语音打卡'; $('mic-toggle').disabled = true;
        microphonePending = true;
        try {
          if (microphoneAborted) return;
          const clip = new Blob(microphoneChunks, { type: activeRecorder.mimeType });
          if (clip.size < 100) throw new Error('录音过短，请重新录制。');
          $('mic-message').textContent = '正在保存到本机…';
          await api('/api/voice', { method: 'POST', headers: { 'Content-Type': clip.type }, body: clip, signal: AbortSignal.timeout(20000) });
          $('mic-message').textContent = '录音已保存，本地模型会完成转写；可在打卡记录中查看。';
          document.querySelector('.daily-notes').open = true; await refresh();
        } catch (error) { $('mic-message').textContent = `未能保存录音：${error.message}`; }
        finally { microphoneChunks = []; microphonePending = false; $('mic-toggle').disabled = false; }
      });
      recorder.start(1000); microphoneStartedAt = Date.now();
      $('mic-duration').textContent = '00:00 / 01:00'; $('mic-duration').hidden = false;
      $('mic-toggle').textContent = '停止并保存'; $('mic-message').textContent = '录音中，仅在本机处理。';
      microphoneTimer = setInterval(() => {
        const elapsed = Math.min(60, Math.floor((Date.now() - microphoneStartedAt) / 1000));
        $('mic-duration').textContent = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')} / 01:00`;
        if (elapsed >= 60) stopMicrophone();
      }, 250);
      microphoneStream.getAudioTracks()[0].addEventListener('ended', () => { if (recorder?.state === 'recording') stopMicrophone(); });
    } catch (error) {
      if (microphoneStream) microphoneStream.getTracks().forEach((track) => track.stop());
      microphoneStream = null;
      $('mic-message').textContent = error.name === 'NotAllowedError' ? '麦克风权限未开启，仍可使用文字打卡。' : `麦克风不可用：${error.message}`;
    } finally { microphonePending = false; $('mic-toggle').disabled = false; }
  }
  async function speechHealth() {
    if (speechHealthFetching) return;
    speechHealthFetching = true;
    try {
      const health = await api('/api/speech-health');
      const part = (value, name) => value?.ready ? `${name}就绪` : `${name}待准备`;
      $('speech-health').textContent = `本地语音：${part(health.asr, '转写')} · ${part(health.tts, '朗读')}`;
      $('speech-health').title = [health.asr?.reason || health.asr?.error, health.tts?.reason || health.tts?.error].filter(Boolean).join('；');
    } catch { $('speech-health').textContent = '本地语音服务未连接；录音仍可保存。'; }
    finally { speechHealthFetching = false; }
  }
  $('mic-toggle').addEventListener('click', () => recorder?.state === 'recording' ? stopMicrophone() : startMicrophone());
  $('read-report').addEventListener('click', async () => {
    const button = $('read-report'); button.disabled = true;
    const target = $('speech-target').value;
    $('speech-message').textContent = '本地模型正在生成朗读…';
    $('report-audio').pause();
    if (target === 'iris') $('report-audio').hidden = true;
    try {
      const result = await api('/api/speech', { method: 'POST', body: { date, target }, signal: AbortSignal.timeout(180000) });
      if (target === 'iris') { $('speech-message').textContent = '朗读已发送到眼镜，等待眼镜连接并播放。'; return; }
      if (!/^\/speech\/[a-z0-9._-]+$/i.test(result.url || '')) throw new Error('语音文件路径无效');
      const response = await fetch(result.url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!response.ok) throw new Error('语音读取失败');
      if (speechUrl) URL.revokeObjectURL(speechUrl);
      speechUrl = URL.createObjectURL(await response.blob());
      $('report-audio').src = speechUrl; $('report-audio').hidden = false;
      try { await $('report-audio').play(); $('speech-message').textContent = '正在播放本地生成的复盘。'; }
      catch { $('speech-message').textContent = '朗读已生成，点击下方播放按钮收听。'; }
    } catch (error) { $('speech-message').textContent = `朗读暂不可用：${error.message}`; }
    finally { button.disabled = false; }
  });
  $('cloud-report').addEventListener('click', async () => {
    if (!confirm('将所选日期的活动摘要发送给你已配置的云端模型，生成复盘？')) return;
    const button = $('cloud-report'); button.disabled = true;
    $('cloud-report-status').textContent = '正在生成复盘…';
    const requestedDate = date;
    try {
      const result = await api(`/api/ai-report?date=${encodeURIComponent(requestedDate)}`, { method: 'POST', signal: AbortSignal.timeout(60000) });
      $('cloud-review-text').textContent = result.text || '模型未返回复盘内容。';
      cloudReportDate = requestedDate;
      $('cloud-review').hidden = date !== requestedDate;
      $('cloud-report-status').textContent = '云端复盘已生成；活动事实仍以时间线和原始记录为准。';
    } catch (error) { $('cloud-report-status').textContent = `云端复盘暂不可用：${error.message}`; }
    finally { button.disabled = false; }
  });
  $('day-picker').value = date || localDate();
  $('day-picker').addEventListener('change', () => { if ($('day-picker').value) { date = $('day-picker').value; lastTimelineKey = ''; refresh(); } });
  document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => action({ action: 'mode', mode: button.dataset.mode })));
  $('timer-toggle').addEventListener('click', () => action({ action: state?.phase === 'paused' ? 'resume' : state?.phase === 'focus' || state?.phase === 'break' ? 'pause' : 'start' }));
  $('timer-finish').addEventListener('click', () => action({ action: 'finish' }));
  $('distraction').addEventListener('click', async () => { if (await action({ action: 'distraction' })) toast('已记下这次分心。把注意力轻轻带回来。'); });
  $('checkin-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = $('checkin-note').value.trim();
    if (await action({ action: 'checkin', text })) { $('checkin-note').value = ''; toast('这一刻，已记下。'); }
  });
  $('manual-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try { await api('/api/events', { method: 'POST', body: { type: 'manual', ts: Date.now(), scene: $('manual-scene').value } }); await refresh(); toast('已添加本人记录'); }
    catch (error) { toast(error.message); }
  });
  $('flow-enabled').addEventListener('change', async () => { if (!(await action({ action: 'settings', settings: { flowEnabled: $('flow-enabled').checked } }))) await refresh(); });
  $('local-only').addEventListener('change', async () => {
    if (!$('local-only').checked && !confirm('允许已配置的云端模型接收桌面采样缩略图？图像可能包含桌面上的文字与物品。')) { $('local-only').checked = true; return; }
    if (!(await action({ action: 'settings', settings: { localOnly: $('local-only').checked } }))) await refresh();
  });
  $('camera-toggle').addEventListener('click', () => cameraStream ? stopCamera() : startCamera());
  $('camera-device').addEventListener('change', async () => { if (cameraStream) { await stopCamera(); await startCamera(); } });
  $('camera-crop').addEventListener('change', showCrop);
  for (const id of ['export-markdown', 'export-json']) $(id).addEventListener('click', async (event) => {
    if (!token) return;
    event.preventDefault();
    try {
      const response = await fetch($(id).href, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error('导出未成功');
      const blob = await response.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `FocusPendant-${date}.${id === 'export-json' ? 'json' : 'md'}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } catch (error) { toast(error.message); }
  });
  const tokenForm = el('form', 'token-form');
  tokenForm.id = 'token-form';
  tokenForm.hidden = true;
  const tokenLabel = el('label', '', '本地连接口令');
  const tokenInput = el('input', 'note-input');
  tokenInput.type = 'password';
  tokenInput.autocomplete = 'off';
  tokenInput.setAttribute('aria-label', 'FOCUS_TOKEN 本地连接口令');
  tokenLabel.append(tokenInput);
  const connect = el('button', 'button button-secondary', '连接'); connect.type = 'submit';
  tokenForm.append(tokenLabel, connect);
  $('connection-banner').append(tokenForm);
  tokenForm.addEventListener('submit', (event) => { event.preventDefault(); token = tokenInput.value.trim(); sessionStorage.setItem('focus-token', token); refresh(); speechHealth(); visionHealth(); });
  window.addEventListener('pagehide', () => {
    stopMicrophone(true);
    $('report-audio').pause();
    if (speechUrl) URL.revokeObjectURL(speechUrl);
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ action: 'settings', settings: { cameraEnabled: false } }), keepalive: true }).catch(() => {});
    }
  });
  refresh();
  visionHealth();
  speechHealth();
  setInterval(refresh, 2000);
  setInterval(visionHealth, 10000);
  setInterval(speechHealth, 10000);
})();
