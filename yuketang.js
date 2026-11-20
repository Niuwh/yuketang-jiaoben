// ==UserScript==
// @name         雨课堂刷课助手
// @namespace    http://tampermonkey.net/
// @version      3.0.9
// @description  针对雨课堂视频进行自动播放，配置AI自动答题
// @author       风之子
// @license      GPL3
// @match        *://*.yuketang.cn/*
// @match        *://*.gdufemooc.cn/*
// @run-at       document-start
// @icon         http://yuketang.cn/favicon.ico
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      api.openai.com
// @connect      api.moonshot.cn
// @connect      api.deepseek.com
// @connect      dashscope.aliyuncs.com
// @connect      api.anthropic.com
// @connect      *
// @connect      cdn.jsdelivr.net
// @connect      unpkg.com
// @require      https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
// @require      https://unpkg.com/tesseract.js@v2.1.0/dist/tesseract.min.js
// ==/UserScript==

(() => {
  'use strict';

  let panel; // UI 面板实例后置初始化

  // ---- 脚本配置，用户可修改 ----
  const Config = {
    version: '3.0.9',     // 版本号
    playbackRate: 2,      // 视频播放倍速
    pptInterval: 3000,    // ppt翻页间隔
    storageKeys: {        // 使用者勿动
      progress: '[雨课堂脚本]刷课进度信息',
      ai: 'ykt_ai_conf',
      proClassCount: 'pro_lms_classCount',
      feature: 'ykt_feature_conf', // 是否开启AI作答/自动评论
      rate: 'ykt_rate_conf', // 视频倍速配置：目标倍速与各解锁限制修改点开关
      pendingAutoStart: 'ykt_pending_auto_start',
      userStopped: 'ykt_user_stopped' // 用户已点击停止刷课（持久化，防止重新加载后自动恢复）
    }
  };

  const Utils = {
    // 短暂睡眠，等待网页加载
    sleep: (ms = 1000) => new Promise(resolve => setTimeout(resolve, ms)),
    // 将一个 JSON 字符串解析为 JavaScript 对象
    safeJSONParse(value, fallback) {
      try {
        return JSON.parse(value);
      } catch (_) {
        return fallback;
      }
    },
    // 每隔一段时间检查某个条件是否满足（通过 checker 函数），如果满足就成功返回；如果超时仍未满足，就失败返回
    poll(checker, { interval = 1000, timeout = 20000 } = {}) {
      return new Promise(resolve => {
        const start = Date.now();
        const timer = setInterval(() => {
          // 停止刷课后立即中止所有轮询，让流程尽快收尾
          if (Session.isStopped()) {
            clearInterval(timer);
            resolve(false);
            return;
          }
          if (checker()) {
            clearInterval(timer);
            resolve(true);
            return;
          }
          if (Date.now() - start > timeout) {
            clearInterval(timer);
            resolve(false);
          }
        }, interval);
      });
    },
    // 使用UI课程完成度来判别是否完成课程
    isProgressDone(text) {
      if (!text) return false;
      return text.includes('100%') || text.includes('99%') || text.includes('98%') || text.includes('已完成');
    },
    // 主要是规避firefox会创建多个iframe的问题
    inIframe() {
      return window.top !== window.self;
    },
    // 下滑到最底部，触发课程加载
    scrollToBottom(containerSelector) {
      const el = document.querySelector(containerSelector);
      if (el) el.scrollTop = el.scrollHeight;
    },
    getCurrentClassroomId() {
      const query = new URLSearchParams(location.search);
      const queryId = query.get('classroom_id');
      if (queryId) return queryId;

      const path = location.pathname;
      return path.match(/^\/ai-workspace\/lms-graph\/([^/]+)/)?.[1]
        || path.match(/^\/v2\/web\/studentLog\/([^/]+)/)?.[1]
        || path.match(/\/(\d+)\/studycontent$/)?.[1]
        || '';
    },
    returnUrl() { // 得到课程开始的url
      if (location.pathname.includes('/v2/web/studentLog/') || location.pathname.includes('pro/lms/')) {
        return location.href
      }
      return ""
    },
    isSupportedLearningPage() {
      const path = location.pathname;
      return path.includes('/ai-workspace/lms-graph/')
        || path.includes('/v2/web/')
        || path.includes('/pro/lms/');
    },
    waitForMountTarget(timeout = 15000) {
      const getTarget = () => document.body || document.documentElement;
      const existing = getTarget();
      if (existing) return Promise.resolve(existing);

      return new Promise(resolve => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          observer.disconnect();
          clearTimeout(timer);
          resolve(getTarget());
        };
        const observer = new MutationObserver(() => {
          if (getTarget()) finish();
        });
        observer.observe(document, { childList: true, subtree: true });
        document.addEventListener('DOMContentLoaded', finish, { once: true });
        window.addEventListener('load', finish, { once: true });
        const timer = setTimeout(finish, timeout);
      });
    },
    async getDDL() {
      const element = document.querySelector('video') || document.querySelector('audio');

      const fallback = 180_000;
      if (!element) return fallback;

      let duration = Number(element.duration);
      if (!Number.isFinite(duration) || duration <= 0) {
        await new Promise(resolve => element.addEventListener('loadedmetadata', resolve, { once: true }));
        duration = Number(element.duration);
      }

      const elementDurationMs = duration * 1000;               // 转为秒
      const timeout = Math.max(elementDurationMs * 3, 10_000); // 至少 10 秒（防极短视频）;
      return timeout;
    },
    // 关闭雨课堂的挂机/离开检测弹窗，避免遮罩拦截刷课流程
    dismissPopups() {
      const wrappers = document.querySelectorAll('.el-dialog__wrapper, .el-message-box__wrapper');
      for (const wrapper of wrappers) {
        const style = getComputedStyle(wrapper);
        const rect = wrapper.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0) continue;
        const text = wrapper.innerText || '';
        const buttons = [...wrapper.querySelectorAll('button')];
        const clickBtn = label => {
          const btn = buttons.find(b => (b.innerText || '').trim().includes(label));
          if (btn) btn.click();
        };
        if (text.includes('好好学习') || text.includes('继续观看')) {
          clickBtn('继续观看');
        } else if (text.includes('报告老师')) {
          clickBtn('取消');
        }
      }
    }
  };

  // ---- 存储工具 ----
  const Store = {
    getProgress(url) {
      const raw = localStorage.getItem(Config.storageKeys.progress);
      const all = Utils.safeJSONParse(raw, {}) || { url: { outside: 0, inside: 0 } };
      if (!all[url]) {
        all[url] = { outside: 0, inside: 0 };
        localStorage.setItem(Config.storageKeys.progress, JSON.stringify(all));
      }
      return { all, current: all[url] };
    },
    setProgress(url, outside, inside = 0) {
      const raw = localStorage.getItem(Config.storageKeys.progress);
      const all = Utils.safeJSONParse(raw, {});
      all[url] = { outside, inside };
      localStorage.setItem(Config.storageKeys.progress, JSON.stringify(all));
    },
    removeProgress(url) {
      const raw = localStorage.getItem(Config.storageKeys.progress);
      const all = Utils.safeJSONParse(raw, {});
      delete all[url];
      localStorage.setItem(Config.storageKeys.progress, JSON.stringify(all));
    },
    getAIConf() {
      const raw = localStorage.getItem(Config.storageKeys.ai);
      const saved = Utils.safeJSONParse(raw, {}) || {};
      const conf = {
        url: saved.url ?? "https://api.deepseek.com/chat/completions",
        key: saved.key ?? "sk-xxxxxxx",
        model: saved.model ?? "deepseek-chat",
        apiFormat: saved.apiFormat ?? "openai", // openai 或 anthropic
        authMethod: saved.authMethod ?? "bearer", // bearer 或 x-api-key
      };
      localStorage.setItem(Config.storageKeys.ai, JSON.stringify(conf));
      return conf;
    },
    setAIConf(conf) {
      localStorage.setItem(Config.storageKeys.ai, JSON.stringify(conf));
    },
    getProClassCount() {
      const value = localStorage.getItem(Config.storageKeys.proClassCount);
      return value ? Number(value) : 1;
    },
    setProClassCount(count) {
      localStorage.setItem(Config.storageKeys.proClassCount, count);
    },
    getFeatureConf() {
      const raw = localStorage.getItem(Config.storageKeys.feature);
      const saved = Utils.safeJSONParse(raw, {}) || {};
      const conf = {
        autoAI: saved.autoAI ?? false,
        autoComment: saved.autoComment ?? false,
        useOCR: saved.useOCR ?? true, // 是否启用 OCR 识题（关闭后截图直传多模态模型）
      };
      localStorage.setItem(Config.storageKeys.feature, JSON.stringify(conf));
      return conf;
    },
    setFeatureConf(conf) {
      localStorage.setItem(Config.storageKeys.feature, JSON.stringify(conf));
    },
    getRateConf() {
      const raw = localStorage.getItem(Config.storageKeys.rate);
      const saved = Utils.safeJSONParse(raw, {}) || {};
      // 目标倍速钳制到 1-16（与倍速迁移说明一致）；缺失、非法或非正值回退默认值
      const num = Number(saved.targetRate);
      const targetRate = Number.isFinite(num) && num > 0 ? Math.min(16, Math.max(1, num)) : Config.playbackRate;
      return {
        targetRate,
        buttonSetEnabled: saved.buttonSetEnabled ?? true,
        directSetEnabled: saved.directSetEnabled ?? true,
        keepAliveEnabled: saved.keepAliveEnabled ?? true,
        ratechangeBlockEnabled: saved.ratechangeBlockEnabled ?? true,
        pauseGuardEnabled: saved.pauseGuardEnabled ?? true,
      };
    },
    setRateConf(conf) {
      localStorage.setItem(Config.storageKeys.rate, JSON.stringify(conf));
    },
    getPendingAutoStart() {
      const raw = localStorage.getItem(Config.storageKeys.pendingAutoStart);
      const saved = Utils.safeJSONParse(raw, null);
      if (!saved || !saved.classroomId || !saved.ts) return null;
      if (Date.now() - saved.ts > 30 * 60 * 1000) {
        localStorage.removeItem(Config.storageKeys.pendingAutoStart);
        return null;
      }
      return saved;
    },
    setPendingAutoStart(classroomId = '', returnUrl = '') {
      if (!classroomId) return;
      const prev = this.getPendingAutoStart() || {};
      localStorage.setItem(Config.storageKeys.pendingAutoStart, JSON.stringify({
        classroomId,
        returnUrl: returnUrl || prev.returnUrl || '',
        ts: Date.now()
      }));
    },
    clearPendingAutoStart() {
      localStorage.removeItem(Config.storageKeys.pendingAutoStart);
    },
    isUserStopped() {
      return localStorage.getItem(Config.storageKeys.userStopped) === '1';
    },
    setUserStopped(on) {
      if (on) localStorage.setItem(Config.storageKeys.userStopped, '1');
      else localStorage.removeItem(Config.storageKeys.userStopped);
    },
  };

  // ---- 刷课会话状态 ----
  // 用户点击“停止刷课”后持久化停止标记：重新加载页面（含其它标签页）也不会自动恢复刷课，
  // 只有再次点击“开始刷课”才会清除该状态。每次读取持久化值，保证多标签页之间状态一致。
  const Session = {
    isStopped() {
      return Store.isUserStopped();
    },
    begin() {
      Store.setUserStopped(false);
    },
    stop() {
      Store.setUserStopped(true);
    }
  };

  // ---- UI 面板 ----
  function createPanel() {
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.top = '40px';
    iframe.style.left = '40px';
    iframe.style.width = '520px';
    iframe.style.height = '340px';
    iframe.style.zIndex = '999999';
    iframe.style.border = '1px solid #a3a3a3';
    iframe.style.borderRadius = '10px';
    iframe.style.background = '#fff';
    iframe.style.overflow = 'hidden';
    iframe.style.boxShadow = '6px 4px 17px 2px #000000';
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('id', 'ykt-helper-iframe');
    iframe.setAttribute('allowtransparency', 'true');
    const mountTarget = document.body || document.documentElement;
    if (!mountTarget) {
      throw new Error('面板挂载点不存在');
    }
    mountTarget.appendChild(iframe);

    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(`
                  <style>
              /* 全局重置 */
              html, body { overflow: hidden; margin: 0; padding: 0; font-family: "Segoe UI", "PingFang SC", Avenir, Helvetica, Arial, sans-serif; color: #4a4a4a; background: transparent; }

              /* 主容器 */
              .mini-basic {
                position: absolute;
                inset: 0;
                background: #3a7afe;
                color: white;
                height: 100%;
                width: 100%;
                min-height: 42px;
                min-width: 42px;
                border-radius: 10px;
                text-align: center;
                line-height: 1;
                z-index: 1000000;
                cursor: pointer;
                display: none;
                align-items: center;
                justify-content: center;
                font-weight: bold;
                box-shadow: 0 4px 12px rgba(0,0,0,0);
              }
              .mini-basic.show {
                display: flex;
              }

              /* 面板主容器 */
              .panel {
                width: 100%;
                height: 100%;
                background: white;
                border-radius: 10px;
                position: relative;
                overflow: hidden;
              }

              /* 标题栏 */
              .header {
                text-align: center;
                height: 40px;
                background: #f7f7f7;
                color: #000;
                font-size: 18px;
                line-height: 40px;
                border-radius: 10px 10px 0 0;
                border-bottom: 2px solid #eee;
                cursor: move;
                position: relative;
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 0 10px;
              }
              .tools ul {
                margin: 0;
                padding: 0;
                list-style: none;
                display: flex;
                gap: 5px;
              }
              .tools li {
                display: inline-block;
                cursor: pointer;
                font-size: 14px;
                padding: 0 5px;
              }

              /* 内容区 */
              .body {
                font-weight: normal;
                font-size: 13px;
                line-height: 22px;
                height: calc(100% - 85px);
                overflow-y: auto;
                padding: 6px 8px;
                box-sizing: border-box;
              }

              .info {
                margin: 0;
                padding: 0;
                list-style: none;
              }
              .info li {
                margin-bottom: 4px;
                color: #333;
              }

              /* 设置面板 */
              #settings {
                display: none;
                position: absolute;
                top: 40px;
                left: 0;
                width: 100%;
                height: calc(100% - 40px);
                background: white;
                z-index: 99;
                padding: 15px;
                box-sizing: border-box;
                overflow-y: auto;
              }

              /* 表单项 */
              .form-item {
                margin-bottom: 15px;
              }
              .form-item label {
                display: block;
                margin-bottom: 5px;
                font-size: 12px;
                color: #333;
              }
              .form-item input[type="text"],
              .form-item input[type="password"],
              .form-item input[type="number"] {
                width: 100%;
                padding: 8px;
                border: 1px solid #ddd;
                border-radius: 4px;
                font-size: 12px;
                box-sizing: border-box;
              }

              /* 复选框标签优化：避免“启用”跑到右边 */
              .form-item .checkbox-label {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 12px;
                cursor: pointer;
              }
              .form-item .checkbox-label input[type="checkbox"] {
                margin: 0;
                width: auto;
              }

              /* 表单项提示文案 */
              .form-item .hint {
                margin-top: 4px;
                font-size: 11px;
                color: #999;
                line-height: 1.5;
              }

              /* 底部按钮栏 */
              .footer {
                position: absolute;
                bottom: 0;
                left: 0;
                width: 100%;
                background: #f7f7f7;
                color: #c5c5c5;
                font-size: 13px;
                line-height: 25px;
                border-radius: 0 0 10px 10px;
                border-bottom: 2px solid #eee;
                display: flex;
                justify-content: center;
                align-items: center;
                padding: 6px 0;
                gap: 10px;
              }
              .footer button {
                border: none;
                border-radius: 6px;
                color: white;
                cursor: pointer;
                padding: 6px 12px;
                font-size: 12px;
                transition: all 0.2s ease;
              }
              #btn-start {
                background-color: #1677ff;
              }
              #btn-start:hover {
                background-color: #f6ff00;
                color: black;
              }
              #btn-clear {
                background-color: #ff4d4f;
              }
              #btn-setting {
                background-color: #52c41a;
              }
              #btn-stop {
                background-color: #8c8c8c;
              }
              #btn-reload {
                background-color: #fa8c16;
              }

              /* 设置页底部按钮 */
              .settings-footer {
                text-align: center;
                margin-top: 12px;
                display: flex;
                justify-content: center;
                gap: 10px;
              }
              .settings-footer button {
                padding: 6px 15px;
                font-size: 12px;
                border-radius: 6px;
                border: none;
                cursor: pointer;
              }
              #save_settings {
                background-color: #1677ff;
                color: white;
              }
              #close_settings {
                background-color: #999;
                color: white;
              }
            </style>

            <div class="mini-basic" id="mini-basic">展开</div>
            <div class="panel" id="panel">
              <div class="header" id="header">
                雨课堂刷课助手
                <div class='tools'>
                  <ul>
                    <li class='minimality' id="minimality">_</li>
                    <li class='question' id="question">?</li>
                  </ul>
                </div>
              </div>
              <div class="body">
                <ul class="info" id="info">
                  <li>⭐ 脚本支持：雨课堂所有版本</li>
                  <li>🤖 <strong>支持模型：</strong>DeepSeek、Kimi(Moonshot)、通义千问、OpenAI、Claude(Anthropic)</li>
                  <li>📢 <strong>使用必读：</strong>自动答题需先点击<span style="color:green">[脚本设置]</span>开启并填入API Key</li>
                  <li>🚀 配置完成后，点击<span style="color:blue">[开始刷课]</span>即可启动视频与作业挂机</li>
                  <li>🤝 脚本还有很多不足，欢迎各位一起完善代码</li>
                  <hr>
                </ul>
              </div>
              <div id="settings">
                <div class="form-item">
                  <label>API URL:</label>
                  <input type="text" id="ai_url" placeholder="https://api.deepseek.com/chat/completions">
                </div>
                <div class="form-item">
                  <label>API KEY:</label>
                  <input type="password" id="ai_key" placeholder="sk-xxxxxxxx">
                </div>
                <div class="form-item">
                  <label>Model Name:</label>
                  <input type="text" id="ai_model" placeholder="deepseek-chat">
                  <div class="hint">提示：若模型支持图片输入（多模态/视觉，如 GPT-4o、Claude 3.5+、Qwen-VL），可关闭下方 OCR 开关，截图将直接发给模型识别</div>
                </div>
                <div class="form-item">
                  <label>API Format:</label>
                  <select id="ai_format" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:4px;font-size:12px;">
                    <option value="openai">OpenAI Format (Chat Completions)</option>
                    <option value="anthropic">Anthropic Format (Messages API)</option>
                  </select>
                </div>
                <div class="form-item">
                  <label>Auth Method:</label>
                  <select id="auth_method" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:4px;font-size:12px;">
                    <option value="bearer">Bearer Token (Authorization: Bearer)</option>
                    <option value="x-api-key">X-API-Key Header</option>
                  </select>
                </div>
                <div class="form-item">
                  <label class="checkbox-label">
                    <input type="checkbox" id="feature_auto_ai">
                    用 AI 自动作答（作业/题目）
                  </label>
                </div>
                <div class="form-item">
                  <label class="checkbox-label">
                    <input type="checkbox" id="feature_use_ocr">
                    启用 OCR 识别题目
                  </label>
                  <div class="hint">开启：截图经 OCR 识别后把文本发给模型（默认，所有模型可用）；关闭：截图直接发给多模态模型作答（请自行确认模型支持图片输入）</div>
                </div>
                <div class="form-item">
                  <label class="checkbox-label">
                    <input type="checkbox" id="feature_auto_comment">
                    用批量区图文/讨论自动回复
                  </label>
                </div>
                <div class="form-item">
                  <label style="font-weight:bold;font-size:13px;">视频倍速</label>
                  <input type="number" id="rate_target" min="1" max="16" step="0.5">
                  <div class="hint">目标倍速，范围 1-16（超出自动钳制），设为 1 即原速播放</div>
                </div>
                <div class="form-item">
                  <label class="checkbox-label">
                    <input type="checkbox" id="rate_button_set">
                    速度按钮改写设速（当前实现）
                  </label>
                  <div class="hint">改写播放器速度按钮并点击来设速；关闭后不再走按钮路径</div>
                </div>
                <div class="form-item">
                  <label class="checkbox-label">
                    <input type="checkbox" id="rate_direct_set">
                    直设媒体倍速（当前实现）
                  </label>
                  <div class="hint">直接给 video/audio 的 playbackRate 赋值（含按钮不可用时的兜底与倍速保活）；关闭后仅在按钮路径设速</div>
                </div>
                <div class="form-item">
                  <label class="checkbox-label">
                    <input type="checkbox" id="rate_keep_alive">
                    倍速保活（当前实现）
                  </label>
                  <div class="hint">播放期间定时检测并恢复被页面重置的倍速</div>
                </div>
                <div class="form-item">
                  <label class="checkbox-label">
                    <input type="checkbox" id="rate_unlock">
                    解除倍速限制：拦截倍速回写（新增）
                  </label>
                  <div class="hint">包装播放器实例，拦截限速监听在 ratechange 事件期间把倍速重置为 1；仅对探测到的 Video.js 风格播放器生效，页面若通过异步或其它接口限速则无法拦截</div>
                </div>
                <div class="form-item">
                  <label class="checkbox-label">
                    <input type="checkbox" id="rate_pause_guard">
                    限速暂停拦截（新增）
                  </label>
                  <div class="hint">拦截限速监听在 ratechange 事件期间的惩罚性暂停；窗口外的暂停（含手动暂停）不受影响。效果依赖页面限速行为，可随时关闭回退</div>
                </div>
                <div class="settings-footer">
                  <button id="save_settings">保存并关闭</button>
                  <button id="close_settings">取消</button>
                </div>
              </div>
              <div class="footer">
                <button id="btn-setting">脚本设置</button>
                <button id="btn-clear">清除课程进度缓存</button>
                <button id="btn-start">开始刷课</button>
                <button id="btn-stop">停止刷课</button>
                <button id="btn-reload">重新加载</button>
              </div>
            </div>
    `);
    doc.close();

    const ui = {
      iframe,
      doc,
      panel: doc.getElementById('panel'),
      header: doc.getElementById('header'),
      info: doc.getElementById('info'),
      btnStart: doc.getElementById('btn-start'),
      btnClear: doc.getElementById('btn-clear'),
      btnSetting: doc.getElementById('btn-setting'),
      btnStop: doc.getElementById('btn-stop'),
      btnReload: doc.getElementById('btn-reload'),
      settings: doc.getElementById('settings'),
      saveSettings: doc.getElementById('save_settings'),
      closeSettings: doc.getElementById('close_settings'),
      aiUrlInput: doc.getElementById('ai_url'),
      aiKeyInput: doc.getElementById('ai_key'),
      aiModelInput: doc.getElementById('ai_model'),
      aiFormatSelect: doc.getElementById('ai_format'),
      authMethodSelect: doc.getElementById('auth_method'),
      featureAutoAI: doc.getElementById('feature_auto_ai'),
      featureUseOCR: doc.getElementById('feature_use_ocr'),
      featureAutoComment: doc.getElementById('feature_auto_comment'),
      rateTargetInput: doc.getElementById('rate_target'),
      rateButtonSet: doc.getElementById('rate_button_set'),
      rateDirectSet: doc.getElementById('rate_direct_set'),
      rateKeepAlive: doc.getElementById('rate_keep_alive'),
      rateUnlock: doc.getElementById('rate_unlock'),
      ratePauseGuard: doc.getElementById('rate_pause_guard'),
      minimality: doc.getElementById('minimality'),
      question: doc.getElementById('question'),
      miniBasic: doc.getElementById('mini-basic')
    };

    let isDragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;
    const hostWindow = window.parent || window;
    const onMove = e => {
      if (!isDragging) return;
      const deltaX = e.screenX - startX;
      const deltaY = e.screenY - startY;
      const maxLeft = Math.max(0, hostWindow.innerWidth - iframe.offsetWidth);
      const maxTop = Math.max(0, hostWindow.innerHeight - iframe.offsetHeight);
      iframe.style.left = Math.min(Math.max(0, startLeft + deltaX), maxLeft) + 'px';
      iframe.style.top = Math.min(Math.max(0, startTop + deltaY), maxTop) + 'px';
    };
    const stopDrag = () => {
      if (!isDragging) return;
      isDragging = false;
      iframe.style.transition = '';
      doc.body.style.userSelect = '';
    };
    ui.header.addEventListener('mousedown', e => {
      isDragging = true;
      startX = e.screenX;
      startY = e.screenY;
      startLeft = parseFloat(iframe.style.left) || 0;
      startTop = parseFloat(iframe.style.top) || 0;
      iframe.style.transition = 'none';
      doc.body.style.userSelect = 'none';
      e.preventDefault();
    });
    doc.addEventListener('mousemove', onMove);
    hostWindow.addEventListener('mousemove', onMove);
    doc.addEventListener('mouseup', stopDrag);
    hostWindow.addEventListener('mouseup', stopDrag);
    hostWindow.addEventListener('blur', stopDrag);

    const normalSize = { width: parseFloat(iframe.style.width), height: parseFloat(iframe.style.height) };
    const miniSize = 64;
    let isMinimized = false;
    const enterMini = () => {
      if (isMinimized) return;
      isMinimized = true;
      ui.panel.style.display = 'none';
      ui.miniBasic.classList.add('show');
      iframe.style.width = miniSize + 'px';
      iframe.style.height = miniSize + 'px';
    };
    const exitMini = () => {
      if (!isMinimized) return;
      isMinimized = false;
      ui.panel.style.display = '';
      ui.miniBasic.classList.remove('show');
      iframe.style.width = normalSize.width + 'px';
      iframe.style.height = normalSize.height + 'px';
    };
    ui.minimality.addEventListener('click', enterMini);
    ui.miniBasic.addEventListener('click', exitMini);

    ui.question.addEventListener('click', () => {
      window.parent.alert('作者：niuwh.cn（重构版 by Codex）');
    });

    const log = message => {
      const li = doc.createElement('li');
      li.innerText = message;
      ui.info.appendChild(li);
      if (ui.info.lastElementChild) ui.info.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'nearest' });
    };

    const warn = message => {
      const li = doc.createElement('li');
      li.innerText = '⚠️警告：' + message;
      ui.info.appendChild(li);
      if (ui.info.lastElementChild) ui.info.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'nearest' });
    };

    const error = message => {
      const li = doc.createElement('li');
      li.innerText = '🚨报错：' + message;
      ui.info.appendChild(li);
      if (ui.info.lastElementChild) ui.info.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'nearest' });
    };

    const defaultAI = { url: 'https://api.deepseek.com/chat/completions', key: 'sk-xxxxxxx', model: 'deepseek-chat', apiFormat: 'openai', authMethod: 'bearer' };
    const loadAIConf = () => {
      const saved = Store.getAIConf();
      ui.aiUrlInput.value = saved.url || defaultAI.url;
      ui.aiKeyInput.value = saved.key || defaultAI.key;
      ui.aiModelInput.value = saved.model || defaultAI.model;
      ui.aiFormatSelect.value = saved.apiFormat || defaultAI.apiFormat;
      ui.authMethodSelect.value = saved.authMethod || defaultAI.authMethod;
    };
    const loadFeatureConf = () => {
      const saved = Store.getFeatureConf();
      ui.featureAutoAI.checked = saved.autoAI;
      ui.featureAutoComment.checked = saved.autoComment;
      ui.featureUseOCR.checked = saved.useOCR;
    };
    const loadRateConf = () => {
      const saved = Store.getRateConf();
      ui.rateTargetInput.value = saved.targetRate;
      ui.rateButtonSet.checked = saved.buttonSetEnabled;
      ui.rateDirectSet.checked = saved.directSetEnabled;
      ui.rateKeepAlive.checked = saved.keepAliveEnabled;
      ui.rateUnlock.checked = saved.ratechangeBlockEnabled;
      ui.ratePauseGuard.checked = saved.pauseGuardEnabled;
    };
    loadAIConf();
    loadFeatureConf();
    loadRateConf();
    ui.btnSetting.onclick = () => {
      loadAIConf();
      loadFeatureConf();
      loadRateConf();
      ui.settings.style.display = 'block';
    };
    ui.closeSettings.onclick = () => {
      ui.settings.style.display = 'none';
    };
    ui.saveSettings.onclick = () => {
      const conf = {
        url: ui.aiUrlInput.value.trim(),
        key: ui.aiKeyInput.value.trim(),
        model: ui.aiModelInput.value.trim(),
        apiFormat: ui.aiFormatSelect.value,
        authMethod: ui.authMethodSelect.value
      };
      Store.setAIConf(conf);
      const featureConf = {
        autoAI: ui.featureAutoAI.checked,
        autoComment: ui.featureAutoComment.checked,
        useOCR: ui.featureUseOCR.checked
      };
      Store.setFeatureConf(featureConf);
      const rateConf = {
        targetRate: Number(ui.rateTargetInput.value),
        buttonSetEnabled: ui.rateButtonSet.checked,
        directSetEnabled: ui.rateDirectSet.checked,
        keepAliveEnabled: ui.rateKeepAlive.checked,
        ratechangeBlockEnabled: ui.rateUnlock.checked,
        pauseGuardEnabled: ui.ratePauseGuard.checked
      };
      Store.setRateConf(rateConf);
      // 先还原旧的播放器包装，下次接管播放器时按新开关重新安装
      RateUnlock.uninstallAll();
      ui.settings.style.display = 'none';
      log('✅ 脚本配置已保存');
      if (!featureConf.useOCR) {
        log('已关闭 OCR：答题时截图将直接发送给多模态模型');
      }
    };

    ui.btnClear.onclick = () => {
      Store.removeProgress(window.parent.location.href);
      localStorage.removeItem(Config.storageKeys.proClassCount);
      Store.clearPendingAutoStart();
      log('已清除当前课程的刷课进度缓存');
    };

    let stopHandler = null;
    // 停止刷课：交给外部处理器结束会话并还原对页面/播放器的修改（进度缓存保留）
    ui.btnStop.onclick = () => {
      if (stopHandler) {
        stopHandler();
        return;
      }
      Session.stop();
      Store.clearPendingAutoStart();
      log('已停止刷课');
    };

    // 重新加载：刷新页面；刷课进行中会自动续跑，已停止刷课时仅重新加载、不会自动恢复
    ui.btnReload.onclick = () => {
      if (!Session.isStopped()) {
        Store.setPendingAutoStart(Utils.getCurrentClassroomId());
      }
      log('正在重新加载脚本...');
      window.parent.location.reload();
    };

    let startHandler = null;
    let running = false;
    const invokeStart = () => {
      if (running) {
        log('已在刷课中，忽略重复启动');
        return;
      }
      running = true;
      log('启动中...');
      ui.btnStart.innerText = '刷课中...';
      startHandler && startHandler();
    };

    // 后面赋值给panel
    return {
      ...ui,
      log,
      warn,
      error,
      setStartHandler(fn) {
        startHandler = fn;
        ui.btnStart.onclick = invokeStart;
      },
      setStopHandler(fn) {
        stopHandler = fn;
      },
      start() {
        invokeStart();
      },
      resetStartButton(text = '开始刷课') {
        ui.btnStart.innerText = text;
        if (text !== '刷课中...') running = false;
      }
    };
  }

  // ---- 倍速解锁适配层（迁移自《视频倍速逻辑迁移说明》第一层机制）----
  // 页面限速监听器会在 ratechange 事件同步派发期间把倍速写回 1（并可能顺带 pause）。
  // 这里不删除它的监听（内部数据结构不可靠），而是在播放器实例上包装 trigger/playbackRate/pause：
  // trigger 派发 ratechange 期间打标记，只在该同步派发窗口内拦截“写回 1”和“惩罚性暂停”。
  const RateUnlock = {
    // player -> { origTrigger, origRate, origPause, hadOwnTrigger, hadOwnRate, hadOwnPause }
    // 用 Map 而非 WeakMap：卸载时需要枚举全部已包装实例以还原方法（记录体积很小，可忽略持有开销）
    installed: new Map(),

    // 安全探测 Video.js 风格播放器实例；探测不到返回 null（此时仅现有设速路径生效）
    locatePlayer(media) {
      if (!media) return null;
      const videojs = typeof unsafeWindow !== 'undefined' ? unsafeWindow.videojs : null;
      const candidates = [
        media.player,
        media.el_ && media.el_.player,
        videojs && typeof videojs.getPlayer === 'function' ? videojs.getPlayer(media) : null
      ];
      for (const player of candidates) {
        if (player
          && typeof player.trigger === 'function'
          && typeof player.playbackRate === 'function'
          && typeof player.pause === 'function') {
          return player;
        }
      }
      return null;
    },

    // 幂等安装：同一实例重复调用不叠加包装；任一步赋值失败立即回滚，不留部分替换
    install(media) {
      const conf = Store.getRateConf();
      const wrapRate = conf.ratechangeBlockEnabled;
      const wrapPause = conf.pauseGuardEnabled;
      if (!wrapRate && !wrapPause) return false;
      const player = this.locatePlayer(media);
      if (!player) {
        // 仅提示一次：未探测到播放器实例时其余设速路径照常工作，避免反复刷日志
        if (!this.notFoundLogged) {
          this.notFoundLogged = true;
          console.log('[倍速] 未探测到 Video.js 风格播放器实例，跳过倍速解锁（按钮改写/直设/保活路径不受影响）');
        }
        return false;
      }
      if (this.installed.has(player)) return true;

      const origTrigger = player.trigger;
      const origRate = player.playbackRate;
      const origPause = player.pause;
      let inRatechange = false;
      let rateInterceptLogged = false;
      let pauseInterceptLogged = false;
      const triggerWrap = function (event) {
        const type = typeof event === 'string' ? event : event && event.type;
        if (type !== 'ratechange') return origTrigger.apply(this, arguments);
        inRatechange = true;
        try {
          return origTrigger.apply(this, arguments);
        } finally {
          inRatechange = false;
        }
      };
      const rateWrap = function (value) {
        // 仅拦截“限速器在派发期间把大于 1 的倍速写回 1”的那一次调用，其余调用原样转发
        if (arguments.length > 0 && inRatechange && Number(value) === 1 && Number(origRate.call(player)) > 1) {
          if (!rateInterceptLogged) {
            rateInterceptLogged = true;
            console.log('[倍速] 已拦截播放器的倍速重置（解除倍速限制生效）');
          }
          return player;
        }
        return arguments.length > 0 ? origRate.call(player, value) : origRate.call(player);
      };
      const pauseWrap = function () {
        // 拦截限速监听器在派发窗口内的惩罚性暂停；窗口外的暂停（含手动暂停）不受影响
        if (inRatechange) {
          if (!pauseInterceptLogged) {
            pauseInterceptLogged = true;
            console.log('[倍速] 已拦截限速器的惩罚性暂停（限速暂停拦截生效）');
          }
          return player;
        }
        return origPause.apply(this, arguments);
      };

      // 记录属性是否为自有属性：卸载时自有属性还原原值，原本继承的直接删除以恢复原型链查找
      const record = {
        origTrigger, origRate, origPause,
        hadOwnTrigger: Object.prototype.hasOwnProperty.call(player, 'trigger'),
        hadOwnRate: Object.prototype.hasOwnProperty.call(player, 'playbackRate'),
        hadOwnPause: Object.prototype.hasOwnProperty.call(player, 'pause')
      };
      try {
        player.trigger = triggerWrap;
        if (wrapRate) player.playbackRate = rateWrap;
        if (wrapPause) player.pause = pauseWrap;
      } catch (e) {
        this.restore(player, record);
        console.warn('[倍速] 解除倍速限制安装失败，已还原原始方法：', e);
        return false;
      }
      this.installed.set(player, record);
      console.log(`[倍速] 倍速解锁已安装：回写拦截 ${wrapRate ? '开' : '关'}，暂停拦截 ${wrapPause ? '开' : '关'}`);
      return true;
    },

    // 还原单个实例被包装的方法
    restore(player, record) {
      const tryRestore = (key, hadOwn, orig) => {
        try {
          if (hadOwn) player[key] = orig;
          else delete player[key];
        } catch (_) { /* 单个还原失败不影响其它方法 */ }
      };
      tryRestore('trigger', record.hadOwnTrigger, record.origTrigger);
      tryRestore('playbackRate', record.hadOwnRate, record.origRate);
      tryRestore('pause', record.hadOwnPause, record.origPause);
    },

    // 必须先于首次设置倍速调用：设速会触发 ratechange，限速监听正是在该事件里写回 1
    ensure(media) {
      const conf = Store.getRateConf();
      if (!conf.ratechangeBlockEnabled && !conf.pauseGuardEnabled) return false;
      return this.install(media || document.querySelector('video'));
    },

    // 明确的清理/还原入口：恢复全部被包装的方法（面板保存后按新开关重新安装）
    uninstallAll() {
      for (const [player, record] of this.installed) {
        this.restore(player, record);
      }
      this.installed.clear();
    }
  };

  // ---- 页面/播放器修改的还原记录 ----
  // 快照脚本首次改动前的原值（媒体倍速/音量/静音、速度按钮 DOM、防切屏包装），
  // 停止刷课时一次性还原。用 Map 保证还原时可枚举全部对象（记录仅在页面生命周期内有效）。
  const PageRestore = {
    mediaStates: new Map(), // media -> { playbackRate, volume, muted, defaultMuted }
    nodeStates: new Map(), // node -> { attrs: {name: 原值|null}, text }
    screenCheckUndo: null,

    snapshotMedia(media) {
      if (!media || this.mediaStates.has(media)) return;
      this.mediaStates.set(media, {
        playbackRate: media.playbackRate,
        volume: media.volume,
        muted: media.muted,
        defaultMuted: media.defaultMuted
      });
    },
    snapshotNode(node, attrs = []) {
      if (!node || this.nodeStates.has(node)) return;
      const savedAttrs = {};
      for (const name of attrs) savedAttrs[name] = node.getAttribute(name);
      this.nodeStates.set(node, { attrs: savedAttrs, text: node.innerText });
    },
    restoreAll() {
      // 先卸载播放器包装，避免还原倍速时被拦截
      RateUnlock.uninstallAll();
      for (const [media, state] of this.mediaStates) {
        try {
          media.playbackRate = state.playbackRate;
          media.volume = state.volume;
          media.muted = state.muted;
          media.defaultMuted = state.defaultMuted;
        } catch (_) { /* 单个对象还原失败不影响其余对象 */ }
      }
      this.mediaStates.clear();
      for (const [node, state] of this.nodeStates) {
        try {
          for (const [name, value] of Object.entries(state.attrs)) {
            if (value === null) node.removeAttribute(name);
            else node.setAttribute(name, value);
          }
          node.innerText = state.text;
        } catch (_) { }
      }
      this.nodeStates.clear();
      if (this.screenCheckUndo) {
        this.screenCheckUndo();
        this.screenCheckUndo = null;
      }
    }
  };

  // ---- 播放器工具 ----
  const Player = {
    isNearEnd(media, threshold = 1) {
      if (!media) return false;
      const duration = Number(media.duration || 0);
      const currentTime = Number(media.currentTime || 0);
      return Number.isFinite(duration) && duration > 1 && currentTime > 0 && duration - currentTime <= threshold;
    },
    applySpeed(media) {
      if (Session.isStopped()) return;
      const conf = Store.getRateConf();
      const rate = conf.targetRate;
      // 解锁包装必须先于首次设置倍速安装：设速触发的 ratechange 正是限速监听写回 1 的时机
      RateUnlock.ensure(media);
      const video = media && media.tagName?.toLowerCase() === 'video' ? media : document.querySelector('video');
      const speedBtn = document.querySelector('xt-speedlist xt-button') || document.getElementsByTagName('xt-speedlist')[0]?.firstElementChild?.firstElementChild;
      const speedWrap = document.getElementsByTagName('xt-speedbutton')[0];
      const rateText = Number(rate).toFixed(2);
      if (conf.buttonSetEnabled && speedBtn && speedWrap) {
        // 记录原值，停止刷课时还原
        PageRestore.snapshotMedia(video);
        PageRestore.snapshotNode(speedBtn, ['data-speed', 'keyt']);
        speedBtn.setAttribute('data-speed', rate);
        speedBtn.setAttribute('keyt', rateText);
        speedBtn.innerText = `${rateText}X`;
        const mousemove = document.createEvent('MouseEvent');
        mousemove.initMouseEvent('mousemove', true, true, unsafeWindow, 0, 10, 10, 10, 10, 0, 0, 0, 0, 0, null);
        speedWrap.dispatchEvent(mousemove);
        speedBtn.click();
      } else if (conf.directSetEnabled && video) {
        PageRestore.snapshotMedia(video);
        video.playbackRate = rate;
      }
    },
    mute() {
      if (Session.isStopped()) return;
      const muteBtn = document.querySelector('#video-box > div > xt-wrap > xt-controls > xt-inner > xt-volumebutton > xt-icon');
      if (muteBtn) muteBtn.click();
      const video = document.querySelector('video');
      if (video) {
        PageRestore.snapshotMedia(video);
        video.volume = 0;
      }
    },
    applyMediaDefault(media) {
      if (!media || Session.isStopped()) return;
      // 解锁包装必须先于首次设置倍速安装
      RateUnlock.ensure(media);
      // 记录原值，停止刷课时还原
      PageRestore.snapshotMedia(media);
      media.play();
      media.volume = 0;
      const conf = Store.getRateConf();
      if (conf.directSetEnabled) media.playbackRate = conf.targetRate;
    },
    observePause(video, shouldResume = () => true) {
      if (!video) return () => { };
      const canResume = () => shouldResume() && !Session.isStopped() && !video.ended && !this.isNearEnd(video);
      // 自动播放
      const playVideo = () => {
        if (!canResume()) return;
        video.play().catch(e => {
          if (!canResume()) return;
          console.warn('自动播放失败:', e);
          setTimeout(playVideo, 3000);
        });
      };
      playVideo();
      // 直接监听 pause 事件，不依赖播放器 UI 元素
      const onPause = () => { if (canResume()) playVideo(); };
      video.addEventListener('pause', onPause);
      // 定时兜底：防止 pause 事件被拦截
      const timer = setInterval(() => { if (video.paused && canResume()) playVideo(); }, 5000);
      // 播放器 UI 观察：按钮被点击暂停时 tip 变为「播放」
      const target = document.getElementsByClassName('play-btn-tip')[0];
      let observer = null;
      if (target) {
        observer = new MutationObserver(list => {
          for (const mutation of list) {
            if (mutation.type === 'childList' && target.innerText === '播放' && canResume()) {
              video.play();
            }
          }
        });
        observer.observe(target, { childList: true });
      }
      return () => {
        video.removeEventListener('pause', onPause);
        clearInterval(timer);
        if (observer) observer.disconnect();
      };
    },
    waitForEnd(media, timeout = 0) {
      return new Promise(resolve => {
        if (!media) return resolve();
        if (media.ended) return resolve();
        let timer;
        let stopTimer;
        const finish = () => {
          clearTimeout(timer);
          clearInterval(stopTimer);
          media.removeEventListener('ended', onEnded);
          resolve();
        };
        const onEnded = () => finish();
        media.addEventListener('ended', onEnded, { once: true });
        // 停止刷课时提前结束等待，让调用流程尽快收尾
        stopTimer = setInterval(() => { if (Session.isStopped()) finish(); }, 500);
        if (timeout > 0) {
          timer = setTimeout(finish, timeout);
        }
      });
    }
  };

  // ---- ai-workspace 路由工具 ----
  const AiWorkspace = {
    normalizeText(text) {
      return String(text || '').replace(/\s+/g, ' ').trim();
    },
    isVisibleElement(element) {
      if (!element || element.nodeType !== 1) return false;
      const view = element.ownerDocument?.defaultView || window;
      const style = view.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
    },
    getRoute() {
      const match = location.pathname.match(/^\/ai-workspace\/lms-graph\/([^/]+)\/([^/]+)\/([^/?#]+)/);
      if (!match) return null;
      const [, classroomId, type, leafId] = match;
      const query = new URLSearchParams(location.search);
      return {
        classroomId,
        type,
        leafId,
        nodeId: query.get('node_id') || ''
      };
    },
    getMediaCandidates() {
      return [...document.querySelectorAll('video, audio')].filter(media => {
        if (!(media instanceof HTMLMediaElement)) return false;
        const rect = media.getBoundingClientRect();
        const isVisible = rect.width > 0 && rect.height > 0;
        return isVisible || media.tagName.toLowerCase() === 'audio';
      });
    },
    getMedia() {
      const candidates = this.getMediaCandidates();
      if (!candidates.length) return document.querySelector('video') || document.querySelector('audio');
      const score = media => {
        const rect = media.getBoundingClientRect();
        const area = rect.width * rect.height;
        const playingBoost = !media.paused && !media.ended ? 1_000_000 : 0;
        const currentBoost = Number(media.currentTime || 0);
        return playingBoost + area + currentBoost;
      };
      return [...candidates].sort((a, b) => score(b) - score(a))[0];
    },
    isPlayerDone(media, { startTime = 0, minPlayedDelta = 0 } = {}) {
      if (!media) return false;
      const currentTime = Number(media?.currentTime || 0);
      const duration = Number(media?.duration || 0);
      const playedDelta = Math.max(0, currentTime - startTime);
      if (playedDelta < minPlayedDelta) return false;
      if (media?.ended) return true;
      if (duration > 1 && currentTime > 0 && duration - currentTime <= 1) return true;
      const display = document.querySelector('.xt_video_player_current_time_display')?.innerText?.trim() || '';
      const [current, total] = display.split(' / ').map(text => text?.trim());
      return Boolean(playedDelta >= minPlayedDelta && current && total && current === total);
    },
    keepAlive(shouldResume = () => true) {
      let lastMedia = null;
      const tick = () => {
        if (!shouldResume() || Session.isStopped()) return;
        const media = this.getMedia();
        if (!media) return;
        if (lastMedia !== media) {
          lastMedia = media;
          media.addEventListener('pause', tick);
        }
        // 记录原值，停止刷课时还原
        PageRestore.snapshotMedia(media);
        media.muted = true;
        media.defaultMuted = true;
        media.volume = 0;
        // 解锁包装随媒体更换迁移（幂等，重复调用无副作用）
        RateUnlock.ensure(media);
        // 倍速保活：定时恢复被页面重置的倍速，受“倍速保活”与“直设媒体倍速”双开关控制
        const rateConf = Store.getRateConf();
        if (rateConf.keepAliveEnabled && rateConf.directSetEnabled) {
          media.playbackRate = rateConf.targetRate;
        }
        if (media.paused && !media.ended && !Player.isNearEnd(media)) {
          media.play().catch(() => { });
        }
      };
      const timer = setInterval(tick, 500);
      document.addEventListener('visibilitychange', tick);
      window.addEventListener('focus', tick);
      tick();
      return () => {
        clearInterval(timer);
        if (lastMedia) lastMedia.removeEventListener('pause', tick);
        document.removeEventListener('visibilitychange', tick);
        window.removeEventListener('focus', tick);
      };
    },
    getActiveLeafTitle() {
      return document.querySelector('.leaf-item.is-active')?.innerText?.replace(/\s+/g, ' ').trim() || '';
    },
    getExerciseDocument() {
      const localHasExercise = document.querySelector('#app .container-body .container-problem')
        || document.querySelector('#app .container-problem')
        || document.querySelector('.container-problem');
      if (localHasExercise) return document;

      const frames = [...document.querySelectorAll('iframe')];
      for (const frame of frames) {
        try {
          const doc = frame.contentDocument;
          if (!doc?.body) continue;
          if (
            doc.querySelector('.container-problem')
            || doc.querySelector('.subject-item')
            || doc.querySelector('.item-body')
          ) {
            return doc;
          }
        } catch (_) {
          // ignore cross-document access failures
        }
      }
      return null;
    },
    getExerciseContainer() {
      const exerciseDoc = this.getExerciseDocument();
      return exerciseDoc?.querySelector('#app .container-body .container-problem')
        || exerciseDoc?.querySelector('#app .container-problem')
        || exerciseDoc?.querySelector('.container-problem')
        || null;
    },
    getExerciseQuestionTabs(root = this.getExerciseContainer()) {
      if (!root) return [];
      const selectors = [
        '.subject-item.J_order',
        '.subject-item',
        '.problem-index-item',
        '.question-index-item',
        '[class*="subject-item"]',
        '[class*="problem-index"]',
        '[class*="question-index"]'
      ].join(',');
      const all = [...root.querySelectorAll(selectors)];
      return all.filter((el, index, arr) => {
        if (!this.isVisibleElement(el)) return false;
        if (arr.indexOf(el) !== index) return false;
        const text = this.normalizeText(el.innerText);
        return text && text.length <= 20;
      });
    },
    getExerciseQuestionBody(root = this.getExerciseContainer()) {
      if (!root) return null;
      const itemType = root.querySelector('.item-type');
      if (itemType?.parentElement && this.isVisibleElement(itemType.parentElement)) return itemType.parentElement;
      const selectors = [
        '.item-body',
        '.problem-content',
        '.question-content',
        '.problem-main',
        '.problem-body',
        '.question-body',
        '[class*="problem-content"]',
        '[class*="question-content"]',
        '[class*="problem-body"]',
        '[class*="question-body"]'
      ];
      for (const selector of selectors) {
        const match = [...root.querySelectorAll(selector)].find(el => this.isVisibleElement(el));
        if (match) return match;
      }
      return root;
    },
    isExerciseAnswered(root = this.getExerciseContainer()) {
      if (!root) return false;
      const disabled = root.querySelector('.el-button.el-button--info.is-disabled.is-plain')
        || root.querySelector('button[disabled]');
      if (disabled) return true;
      const statusSelectors = [
        '.result',
        '.status',
        '.answer-status',
        '[class*="result"]',
        '[class*="status"]'
      ];
      for (const selector of statusSelectors) {
        const statusNode = [...root.querySelectorAll(selector)]
          .find(el => this.isVisibleElement(el) && /已完成|已作答|已提交|回答正确|回答错误/.test(this.normalizeText(el.innerText)));
        if (statusNode) return true;
      }
      return false;
    },
    getExerciseActionButton(root = this.getExerciseContainer(), pattern = /提交|保存|确认|确定|下一题|下一道|下一步|完成本题/) {
      if (!root) return null;
      const selectors = 'button, .el-button, [role="button"], [class*="button"]';
      const nodes = [
        ...root.querySelectorAll(selectors),
        ...document.querySelectorAll(selectors)
      ];
      return nodes.find(el => this.isVisibleElement(el) && pattern.test(this.normalizeText(el.innerText)));
    },
    getAllScourse() { // 获得ai-workspace的课程列表
      const list = document?.querySelectorAll(".nav-item-leaf-box")
      if (!list) panel.warn("没有发现课程资源")
      return list
    }
  };

  // ---- 防切屏 ----
  function preventScreenCheck() {
    const win = unsafeWindow;
    // 幂等安装：重复调用不再叠加包装，并登记还原入口（停止刷课时恢复页面原行为）
    if (PageRestore.screenCheckUndo) return;
    const blackList = new Set(['visibilitychange', 'blur', 'pagehide']);
    const origWinAdd = win.addEventListener;
    const origDocAdd = document.addEventListener;
    win._addEventListener = origWinAdd;
    win.addEventListener = (...args) => blackList.has(args[0]) ? undefined : win._addEventListener(...args);
    document._addEventListener = origDocAdd;
    document.addEventListener = (...args) => blackList.has(args[0]) ? undefined : document._addEventListener(...args);
    // 属性遮蔽声明为可配置，便于停止刷课时删除还原
    Object.defineProperties(document, {
      hidden: { value: false, configurable: true },
      visibilityState: { value: 'visible', configurable: true },
      hasFocus: { value: () => true, configurable: true },
      onvisibilitychange: { get: () => undefined, set: () => { }, configurable: true },
      onblur: { get: () => undefined, set: () => { }, configurable: true }
    });
    Object.defineProperties(win, {
      onblur: { get: () => undefined, set: () => { }, configurable: true },
      onpagehide: { get: () => undefined, set: () => { }, configurable: true }
    });
    PageRestore.screenCheckUndo = () => {
      try {
        win.addEventListener = origWinAdd;
        delete win._addEventListener;
      } catch (_) { /* 尽力还原 */ }
      try {
        document.addEventListener = origDocAdd;
        delete document._addEventListener;
      } catch (_) { }
      for (const key of ['hidden', 'visibilityState', 'hasFocus', 'onvisibilitychange', 'onblur']) {
        try { delete document[key]; } catch (_) { }
      }
      for (const key of ['onblur', 'onpagehide']) {
        try { delete win[key]; } catch (_) { }
      }
    };
  }

  // ---- OCR & AI ----
  const Solver = {
    // 解析答题模式：OCR 开启走 OCR 识别（原行为），关闭即认为模型支持图片输入，截图直传
    resolveAnswerMode() {
      return Store.getFeatureConf().useOCR ? 'ocr' : 'vision';
    },
    // 两条路径共用的截图逻辑
    async capture(element) {
      panel.log('正在截图...');
      return html2canvas(element, {
        useCORS: true,
        logging: false,
        scale: 2,
        backgroundColor: '#ffffff'
      });
    },
    async recognize(element) {
      if (!element) return '无元素';
      try {
        const canvas = await this.capture(element);
        panel.log('正在 OCR 识别 (首轮较慢)...');
        const { data: { text } } = await Tesseract.recognize(canvas, 'chi_sim', {
          logger: m => {
            if (m.status === 'downloading tesseract lang') {
              console.log(`正在下载语言包 ${(m.progress * 100).toFixed(0)}%`);
            }
          }
        });
        return text.replace(/\s+/g, ' ').trim();
      } catch (err) {
        console.error('OCR error:', err);
        panel.log(`OCR 失败: ${err.message || '网络错误'}`);
        return 'OCR识别出错';
      }
    },
    // 截图直传路径：把截图压缩成模型可接受的 JPEG 图片负载
    toImagePayload(canvas) {
      const MAX_SIDE = 1568; // 限制最长边，避免 base64 请求体过大
      let target = canvas;
      const maxSide = Math.max(canvas.width, canvas.height);
      if (maxSide > MAX_SIDE) {
        const ratio = MAX_SIDE / maxSide;
        const scaled = document.createElement('canvas');
        scaled.width = Math.round(canvas.width * ratio);
        scaled.height = Math.round(canvas.height * ratio);
        scaled.getContext('2d').drawImage(canvas, 0, 0, scaled.width, scaled.height);
        target = scaled;
      }
      const dataUrl = target.toDataURL('image/jpeg', 0.85);
      return { base64: dataUrl.split(',')[1], mediaType: 'image/jpeg', dataUrl };
    },
    // 按模式准备题目输入：vision 返回图片负载，ocr 返回 OCR 文本；失败或过短返回 null
    async prepareQuestion(element, mode = 'ocr') {
      if (!element) return null;
      if (mode === 'vision') {
        try {
          const canvas = await this.capture(element);
          return this.toImagePayload(canvas);
        } catch (err) {
          console.error('Screenshot error:', err);
          panel.log(`截图失败: ${err.message || '网络错误'}`);
          return null;
        }
      }
      const text = await this.recognize(element);
      return (text && text.length > 5) ? text : null;
    },
    // OCR 文本路径提示词
    buildTextPrompt(ocrText, optionCount) {
      const maxChar = String.fromCharCode(65 + optionCount - 1);
      const rangeStr = optionCount ? `A-${maxChar}` : 'A-D';
      return `
你是专业做题助手，请分析 OCR 文本，判断题型后给出答案。
强约束：
1) 本题只有 ${optionCount || '若干'} 个选项，范围 ${rangeStr}
2) 忽略 OCR 错误的选项字母，按出现顺序映射 A/B/C/D...
3) 输出格式必须包含“正确答案：”前缀，例如 正确答案：A 或 正确答案：ABD 或 正确答案：对/错
题目内容：
${ocrText}
`;
    },
    // 截图直传路径提示词
    buildVisionPrompt(optionCount) {
      const maxChar = String.fromCharCode(65 + optionCount - 1);
      const rangeStr = optionCount ? `A-${maxChar}` : 'A-D';
      return `
你是专业做题助手，请直接分析题目截图，判断题型后给出答案。
强约束：
1) 本题只有 ${optionCount || '若干'} 个选项，范围 ${rangeStr}
2) 以截图中选项出现顺序为准，映射 A/B/C/D...
3) 输出格式必须包含“正确答案：”前缀，例如 正确答案：A 或 正确答案：ABD 或 正确答案：对/错
`;
    },
    async askAI(question, optionCount = 0) {
      const saved = Store.getAIConf();
      const API_URL = saved.url;
      const API_KEY = saved.key;
      const MODEL_NAME = saved.model;
      const API_FORMAT = saved.apiFormat || 'openai';
      const AUTH_METHOD = saved.authMethod || 'bearer';
      // question 为对象时走截图直传（多模态），为字符串时走 OCR 文本，两条路径并列
      const isImage = !!question && typeof question === 'object';
      return new Promise((resolve, reject) => {
        if (!API_KEY || API_KEY.includes('sk-xxxx')) {
          const msg = '⚠️ 请在 [AI配置] 中填写有效的 API Key';
          panel.log(msg);
          reject(msg);
          return;
        }
        const prompt = isImage ? this.buildVisionPrompt(optionCount) : this.buildTextPrompt(question, optionCount);
        const systemPrompt = isImage
          ? "你是一个只输出答案的助手。请根据题目截图作答，判断题输出'对'或'错'，选择题输出字母。"
          : "你是一个只输出答案的助手。判断题输出'对'或'错'，选择题输出字母。";
        // 图片路径用多模态 content 数组承载截图，文本路径保持纯文本
        const userContent = isImage
          ? [
            { type: 'text', text: prompt },
            API_FORMAT === 'anthropic'
              ? { type: 'image', source: { type: 'base64', media_type: question.mediaType, data: question.base64 } }
              : { type: 'image_url', image_url: { url: question.dataUrl } }
          ]
          : prompt;

        // 构建认证 header
        const authHeader = AUTH_METHOD === 'x-api-key'
          ? { 'x-api-key': API_KEY }
          : { 'Authorization': `Bearer ${API_KEY}` };

        if (API_FORMAT === 'anthropic') {
          // Anthropic API 格式
          const headers = {
            'Content-Type': 'application/json',
            ...authHeader
          };
          // 只有原生 Anthropic API 才需要 anthropic-version，代理通常不需要
          if (API_URL.includes('api.anthropic.com')) {
            headers['anthropic-version'] = '2023-06-01';
          }
          const requestBody = {
            model: MODEL_NAME,
            max_tokens: 1024,
            system: systemPrompt,
            messages: [
              { role: 'user', content: userContent }
            ]
          };
          // 调试日志
          console.log('[AI请求] URL:', API_URL);
          console.log('[AI请求] Headers:', headers);
          console.log('[AI请求] Body:', requestBody);
          panel.log(`请求 ${API_URL}...`);
          GM_xmlhttpRequest({
            method: 'POST',
            url: API_URL,
            headers,
            data: JSON.stringify(requestBody),
            timeout: 120000, // 120秒，思考模型需要更长响应时间
            onload: res => {
              console.log('[AI响应] Status:', res.status);
              console.log('[AI响应] Response:', res.responseText);
              if (res.status === 200) {
                try {
                  const json = JSON.parse(res.responseText);
                  // Anthropic 返回格式: content[0].text
                  const answerText = json.content?.[0]?.text || json.choices?.[0]?.message?.content;
                  resolve(answerText);
                } catch (e) {
                  reject('JSON 解析失败');
                }
              } else {
                const err = `请求失败: HTTP ${res.status} - ${res.responseText}`;
                panel.log(err);
                reject(err);
              }
            },
            onerror: () => reject('网络错误'),
            ontimeout: () => reject('请求超时')
          });
        } else {
          // OpenAI API 格式（默认）
          GM_xmlhttpRequest({
            method: 'POST',
            url: API_URL,
            headers: {
              'Content-Type': 'application/json',
              ...authHeader
            },
            data: JSON.stringify({
              model: MODEL_NAME,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userContent }
              ],
              temperature: 0.1
            }),
            timeout: 120000, // 120秒，思考模型需要更长响应时间
            onload: res => {
              if (res.status === 200) {
                try {
                  const json = JSON.parse(res.responseText);
                  const answerText = json.choices[0].message.content;
                  resolve(answerText);
                } catch (e) {
                  reject('JSON 解析失败');
                }
              } else {
                const err = `请求失败: HTTP ${res.status}`;
                panel.log(err);
                reject(err);
              }
            },
            onerror: () => reject('网络错误'),
            ontimeout: () => reject('请求超时')
          });
        }
      });
    },
    async autoSelectAndSubmit(aiResponse, itemBodyElement) {
      const match = aiResponse.match(/(?:正确)?答案[：:]?\s*([A-F]+(?:[,，][A-F]+)*|[对错]|正确|错误)/i);
      if (!match) {
        panel.log('⚠️ 未提取到有效选项，请人工检查');
        return;
      }
      let answerRaw = match[1].replace(/[,，]/g, '').trim();
      const map = { 'A': 0, 'B': 1, 'C': 2, 'D': 3, 'E': 4, 'F': 5 };
      let targetIndices = [];
      if (answerRaw === '对' || answerRaw === '正确') {
        targetIndices = [0];
      } else if (answerRaw === '错' || answerRaw === '错误') {
        targetIndices = [1];
      } else {
        for (const char of answerRaw.toUpperCase()) {
          if (map[char] !== undefined) targetIndices.push(map[char]);
        }
      }
      if (!targetIndices.length) return;
      panel.log(`✅ AI 建议选：${answerRaw}`);

      const listContainer = itemBodyElement.querySelector('.list-inline.list-unstyled-radio') ||
        itemBodyElement.querySelector('.list-unstyled.list-unstyled-radio') ||
        itemBodyElement.querySelector('.list-unstyled') ||
        itemBodyElement.querySelector('ul.list') ||
        itemBodyElement.querySelector('[class*="option-list"]') ||
        itemBodyElement.querySelector('[class*="answer-list"]') ||
        itemBodyElement.querySelector('ul') ||
        itemBodyElement.querySelector('[role="radiogroup"]');
      if (!listContainer) {
        panel.log('⚠️ 未找到选项容器');
        return;
      }
      const options = listContainer.querySelectorAll('li, .option-item, .answer-item, [class*="option-item"], [class*="answer-item"]');
      for (const idx of targetIndices) {
        if (!options[idx]) continue;
        const clickable = options[idx].querySelector('label.el-radio') ||
          options[idx].querySelector('label.el-checkbox') ||
          options[idx].querySelector('.el-radio__label') ||
          options[idx].querySelector('.el-checkbox__label') ||
          options[idx].querySelector('[role="radio"]') ||
          options[idx].querySelector('[role="checkbox"]') ||
          options[idx].querySelector('input') ||
          options[idx];
        clickable.click();
        await Utils.sleep(150);
      }
      const submitBtn = (() => {
        const ownerDocument = itemBodyElement.ownerDocument || document;
        const roots = [itemBodyElement.parentElement, itemBodyElement, ownerDocument].filter(Boolean);
        const matchText = text => /提交|保存|确认|确定|提交答案/.test(text);
        for (const root of roots) {
          const local = root.querySelectorAll('button, .el-button, [role="button"]');
          for (const btn of local) {
            if (btn.offsetParent !== null && matchText(btn.innerText || '')) return btn;
          }
        }
        const global = ownerDocument.querySelectorAll('.el-button.el-button--primary.el-button--medium');
        for (const btn of global) {
          if (matchText(btn.innerText || '') && btn.offsetParent !== null) return btn;
        }
        return null;
      })();
      if (submitBtn) {
        panel.log('正在提交...');
        submitBtn.click();
      } else {
        panel.log('⚠️ 未找到提交按钮，请手动提交');
      }
    }
  };

  // ---- v2 逻辑 ----
  class V2Runner {
    constructor(panel) {
      this.panel = panel;
      this.baseUrl = location.href;
      const { current } = Store.getProgress(this.baseUrl);
      this.outside = current.outside;
      this.inside = current.inside;
      this.shouldStop = false;
    }

    updateProgress(outside, inside = 0) {
      this.outside = outside;
      this.inside = inside;
      Store.setProgress(this.baseUrl, outside, inside);
    }

    async waitForExternalHandoff(timeout = 1200) {
      await Utils.sleep(timeout);
      if (document.visibilityState === 'hidden' || !document.hasFocus()) {
        this.shouldStop = true;
        this.panel.log('已交给新页面继续，返回目录页后会自动续跑');
        return true;
      }
      return false;
    }

    checkCompletionStatus(statusBox, statusText) {
      // 1. 检查明确的完成状态文本
      if (statusText.includes('已完成') || statusText.includes('已读')) {
        return true;
      }

      // 2. 检查明确的未完成状态文本
      if (statusText.includes('未开始') || statusText.includes('未读') || statusText.includes('进行中')) {
        return false;
      }

      // 3. 检查学习进度数字比例
      const progressMatch = statusText.match(/(\d+)\/(\d+)/);
      if (progressMatch) {
        const [, current, total] = progressMatch;
        const currentNum = parseInt(current, 10);
        const totalNum = parseInt(total, 10);

        // 根据数字进度判断：相等且大于0表示已完成
        return currentNum === totalNum && totalNum > 0;
      }

      // 默认返回false（未完成）
      return false;
    }

    async run() {
      this.panel.log(`检测到已播放到第 ${this.outside} 集，继续刷课...`);
      // 在课件页恢复时直接续播当前内容，不重新走列表流程
      if (location.pathname.includes('/studentCards/')) {
        const videoBox = document.querySelector('.video-box');
        const boxText = videoBox?.innerText || '';
        if ((videoBox || document.querySelector('video')) && !boxText.includes('已完成')) {
          this.panel.log('检测到当前课件页，直接续播当前内容');
          await this.waitCoursewareVideo();
          history.back();
          await Utils.sleep(1000);
        }
      }
      while (!Session.isStopped()) {
        await this.autoSlide();
        const list = document.querySelector('.logs-list')?.childNodes;
        if (!list || !list.length) {
          // 可能停留在课件页：跳回目录页继续，避免无限重试
          const pending = Store.getPendingAutoStart();
          const returnUrl = pending?.returnUrl
            || (pending?.classroomId ? `/v2/web/studentLog/${pending.classroomId}` : '');
          if (returnUrl && !location.pathname.includes('/studentLog/')) {
            this.panel.log('当前页面无课程列表，返回目录页继续');
            location.href = returnUrl;
            return;
          }
          this.panel.log('未找到课程列表，稍后重试');
          await Utils.sleep(2000);
          continue;
        }
        console.log(`当前集数:${this.outside}/全部集数${list.length}`);
        if (this.outside >= list.length) {
          this.panel.log('课程刷完啦 🎉');
          this.panel.resetStartButton('刷完啦~');
          Store.removeProgress(this.baseUrl);
          Store.clearPendingAutoStart();
          break;
        }
        const course = list[this.outside]?.querySelector('.content-box')?.querySelector('section');
        if (!course) {
          this.panel.log('未找到当前课程节点，跳过');
          this.updateProgress(this.outside + 1, 0);
          continue;
        }
        const type = course.querySelector('.tag')?.querySelector('use')?.getAttribute('xlink:href') || 'piliang';
        const title = course.querySelector('h2')?.innerText?.trim() || `第${this.outside + 1}项`;

        // 预检查完成状态
        const statusBox = course.querySelector('.statistics-box .aside');
        const statusText = statusBox?.innerText || '';

        // 判断是否已完成
        let isCompleted = this.checkCompletionStatus(statusBox, statusText);

        if (isCompleted) {
          this.panel.log(`✅ ${title} 已完成，跳过`);
          this.updateProgress(this.outside + 1, 0);
          continue;
        }

        this.panel.log(`刷课状态：第 ${this.outside + 1}/${list.length} 个，类型 ${type}，标题：${title}`);
        if (type.includes('shipin')) {
          await this.handleVideo(course);
        } else if (type.includes('piliang')) {
          await this.handleBatch(course, list);
        } else if (type.includes('ketang')) {
          await this.handleClassroom(course);
        } else if (type.includes('kejian')) {
          await this.handleCourseware(course);
        } else if (type.includes('kaoshi')) {
          this.panel.log('考试区域脚本会被屏蔽，已跳过');
          this.updateProgress(this.outside + 1, 0);
        } else {
          this.panel.log('非视频/批量/课件/考试，已跳过');
          this.updateProgress(this.outside + 1, 0);
        }
        if (this.shouldStop || Session.isStopped()) return;
      }
    }

    async autoSlide() {
      const frequency = Math.floor((this.outside + 1) / 20) + 1;
      for (let i = 0; i < frequency; i++) {
        Utils.scrollToBottom('.viewContainer');
        await Utils.sleep(800);
      }
    }

    async handleVideo(course) {
      course.click();
      if (await this.waitForExternalHandoff(1500)) return;
      await Utils.sleep(3000);
      const progressNode = document.querySelector('.progress-wrap')?.querySelector('.text');
      const title = document.querySelector('.title')?.innerText || '视频';
      const isDeadline = document.querySelector('.box')?.innerText.includes('已过考核截止时间');
      if (isDeadline) this.panel.log(`${title} 已过截止，进度不再增加，将直接跳过`);
      Player.applySpeed();
      Player.mute();
      const stopObserve = Player.observePause(document.querySelector('video'));
      await Utils.poll(() => {
        Utils.dismissPopups();
        return isDeadline || Utils.isProgressDone(progressNode?.innerHTML);
      }, { interval: 5000, timeout: await Utils.getDDL() });
      stopObserve();
      if (Session.isStopped()) return;
      this.updateProgress(this.outside + 1, 0);
      history.back();
      await Utils.sleep(1200);
    }

    async handleBatch(course, list) {
      const expandBtn = course.querySelector('.sub-info')?.querySelector('.gray')?.querySelector('span');
      if (!expandBtn) {
        this.panel.log('未找到批量展开按钮，跳过');
        this.updateProgress(this.outside + 1, 0);
        return;
      }
      expandBtn.click();
      await Utils.sleep(1200);
      const activities = list[this.outside]?.querySelector('.leaf_list__wrap')?.querySelectorAll('.activity__wrap') || [];
      let idx = this.inside;
      this.panel.log(`进入批量区，内部进度 ${idx}/${activities.length}`);
      while (idx < activities.length) {
        const item = activities[idx];
        if (!item) break;

        const tagText = item.querySelector('.tag')?.innerText || '';
        const tagHref = item.querySelector('.tag')?.querySelector('use')?.getAttribute('xlink:href') || '';
        const title = item.querySelector('h2')?.innerText || `第${idx + 1}项`;

        // 检查当前项目的完成状态
        const statusBox = item.querySelector('.statistics-box .aside');
        const statusText = statusBox?.innerText || '';
        const isCompleted = this.checkCompletionStatus(statusBox, statusText);

        if (isCompleted) {
          this.panel.log(`✅ ${title} 已完成，跳过`);
          idx++;
          this.updateProgress(this.outside, idx);
          continue;
        }

        if (tagText === '音频') {
          idx = await this.playAudioItem(item, title, idx);
        } else if (tagHref.includes('shipin')) {
          idx = await this.playVideoItem(item, title, idx);
        } else if (tagHref.includes('tuwen') || tagHref.includes('taolun')) {
          idx = await this.autoCommentItem(item, tagHref.includes('tuwen') ? '图文' : '讨论', idx);
        } else if (tagHref.includes('zuoye')) {
          idx = await this.handleHomework(item, idx);
        } else {
          this.panel.log(`类型未知，已跳过：${title}`);
          idx++;
          this.updateProgress(this.outside, idx);
        }
        if (this.shouldStop || Session.isStopped()) return;
      }
      this.updateProgress(this.outside + 1, 0);
      await Utils.sleep(1000);
    }

    async playAudioItem(item, title, idx) {
      this.panel.log(`开始播放音频：${title}`);
      item.click();
      if (await this.waitForExternalHandoff()) return idx;
      await Utils.sleep(2500);
      Player.applyMediaDefault(document.querySelector('audio'));
      const progressNode = document.querySelector('.progress-wrap')?.querySelector('.text');
      await Utils.poll(() => {
        Utils.dismissPopups();
        return Utils.isProgressDone(progressNode?.innerHTML);
      }, { interval: 3000, timeout: await Utils.getDDL() });
      if (Session.isStopped()) return idx;
      this.panel.log(`${title} 播放完成`);
      idx++;
      this.updateProgress(this.outside, idx);
      history.back();
      await Utils.sleep(1500);
      return idx;
    }

    async playVideoItem(item, title, idx) {
      this.panel.log(`开始播放视频：${title}`);
      item.click();
      if (await this.waitForExternalHandoff()) return idx;
      await Utils.sleep(2500);
      Player.applySpeed();
      Player.mute();
      const stopObserve = Player.observePause(document.querySelector('video'));
      const progressNode = document.querySelector('.progress-wrap')?.querySelector('.text');
      await Utils.poll(() => {
        Utils.dismissPopups();
        return Utils.isProgressDone(progressNode?.innerHTML);
      }, { interval: 3000, timeout: await Utils.getDDL() });
      stopObserve();
      if (Session.isStopped()) return idx;
      this.panel.log(`${title} 播放完成`);
      idx++;
      this.updateProgress(this.outside, idx);
      history.back();
      await Utils.sleep(1500);
      return idx;
    }

    async autoCommentItem(item, typeText, idx) {
      this.panel.log(`开始处理${typeText}：${item.querySelector('h2')?.innerText || ''}`);
      item.click();
      await Utils.sleep(1200);

      // 检查是否开启自动评论功能
      const featureFlags = Store.getFeatureConf();
      if (!featureFlags.autoComment) {
        this.panel.log(`${typeText}已查看，但未开启自动回复功能`);
        idx++;
        this.updateProgress(this.outside, idx);
        history.back();
        await Utils.sleep(1000);
        return idx;
      }

      // 开启了自动评论功能，执行评论逻辑
      window.scrollTo(0, document.body.scrollHeight);
      await Utils.sleep(800);
      window.scrollTo(0, 0);
      const commentSelectors = ['#new_discuss .new_discuss_list .cont_detail', '.new_discuss_list dd .cont_detail', '.cont_detail.word-break'];
      let firstComment = '';
      for (let retry = 0; retry < 30 && !firstComment; retry++) {
        for (const sel of commentSelectors) {
          const list = document.querySelectorAll(sel);
          for (const node of list) {
            if (node?.innerText?.trim()) {
              firstComment = node.innerText.trim();
              break;
            }
          }
          if (firstComment) break;
        }
        if (!firstComment) await Utils.sleep(500);
      }
      if (!firstComment) {
        this.panel.log('未找到评论内容，跳过该项');
      } else {
        const input = document.querySelector('.el-textarea__inner');
        if (input) {
          input.value = firstComment;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          await Utils.sleep(800);
          const sendBtn = document.querySelector('.el-button.submitComment') ||
            document.querySelector('.publish_discuss .postBtn button') ||
            document.querySelector('.el-button--primary');
          if (sendBtn && !sendBtn.disabled && !sendBtn.classList.contains('is-disabled')) {
            sendBtn.click();
            this.panel.log(`已在${typeText}区发表评论`);
          } else {
            this.panel.log('发送按钮不可用或不存在');
          }
        } else {
          this.panel.log('未找到评论输入框，跳过');
        }
      }
      idx++;
      this.updateProgress(this.outside, idx);
      history.back();
      await Utils.sleep(1000);
      return idx;
    }

    async handleHomework(item, idx) {
      const featureFlags = Store.getFeatureConf();
      if (!featureFlags.autoAI) {
        this.panel.log('已关闭AI自动答题，跳过该项');
        idx++;
        this.updateProgress(this.outside, idx);
        return idx;
      }
      const mode = Solver.resolveAnswerMode();
      this.panel.log(mode === 'vision' ? '进入作业，启动 截图直传 + AI' : '进入作业，启动 OCR + AI');
      item.click();
      await Utils.sleep(1500);
      let i = 0;
      const maxRetry = 3; // 最大重试次数
      while (true) {
        const items = document.querySelectorAll('.subject-item.J_order');
        if (i >= items.length) {
          this.panel.log(`所有题目处理完毕，共 ${items.length} 题，准备交卷`);
          break;
        }
        const listItem = items[i];
        listItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
        listItem.click();
        await Utils.sleep(1800);
        const disabled = document.querySelectorAll('.el-button.el-button--info.is-disabled.is-plain');
        if (disabled.length > 0) {
          this.panel.log(`第 ${i + 1} 题已完成，跳过...`);
          i++;
          continue;
        }
        const targetEl = document.querySelector('.item-type')?.parentElement || document.querySelector('.item-body');
        let optionCount = 0;
        const listContainer = targetEl?.querySelector('.list-inline.list-unstyled-radio') ||
          targetEl?.querySelector('.list-unstyled.list-unstyled-radio') ||
          targetEl?.querySelector('ul.list');
        if (listContainer) optionCount = listContainer.querySelectorAll('li').length;
        const questionInput = await Solver.prepareQuestion(targetEl, mode);
        if (questionInput) {
          let retryCount = 0;
          let success = false;
          while (retryCount < maxRetry && !success) {
            try {
              if (retryCount > 0) {
                this.panel.log(`🔄 第 ${i + 1} 题重试 ${retryCount}/${maxRetry}...`);
              }
              panel.log('🤖 请求 AI 获取答案...');
              const aiText = await Solver.askAI(questionInput, optionCount);
              await Solver.autoSelectAndSubmit(aiText, targetEl);
              success = true;
            } catch (err) {
              retryCount++;
              this.panel.log(`AI 答题失败：${err}`);
              if (retryCount < maxRetry) {
                this.panel.log(`等待 5 秒后重试...`);
                await Utils.sleep(5000);
              } else {
                this.panel.log(`⚠️ 第 ${i + 1} 题重试 ${maxRetry} 次后仍失败，跳过`);
              }
            }
          }
        }
        await Utils.sleep(1500);
        i++;
      }
      idx++;
      this.updateProgress(this.outside, idx);
      history.back();
      await Utils.sleep(1200);
      return idx;
    }

    async handleClassroom(course) {
      this.panel.log('进入课堂模式...');
      course.click();
      await Utils.sleep(5000);
      const iframe = document.querySelector('iframe.lesson-report-mobile');
      if (!iframe || !iframe.contentDocument) {
        this.panel.log('未找到课堂 iframe，跳过');
        this.updateProgress(this.outside + 1, 0);
        return;
      }
      const video = iframe.contentDocument.querySelector('video');
      const audio = iframe.contentDocument.querySelector('audio');
      if (video) {
        Player.applyMediaDefault(video);
        await Player.waitForEnd(video);
      }
      if (!Session.isStopped() && audio) {
        Player.applyMediaDefault(audio);
        await Player.waitForEnd(audio);
      }
      if (Session.isStopped()) return;
      this.updateProgress(this.outside + 1, 0);
      history.go(-1);
      await Utils.sleep(1200);
    }

    // 等待课件视频播放完毕；播放器被关闭（弹窗关闭/元素销毁）时自动重新打开
    async waitCoursewareVideo() {
      const deadline = await Utils.getDDL();
      const start = Date.now();
      let boundVideo = null;
      let stopObserve = () => { };
      let reopenAttempts = 0;
      try {
        while (Date.now() - start < deadline && !Session.isStopped()) {
          Utils.dismissPopups();
          const video = document.querySelector('video');
          const display = document.querySelector('.xt_video_player_current_time_display');
          if (!video) {
            // 播放器被关闭或视频元素被销毁，重新打开视频框
            const videoBox = document.querySelector('.video-box');
            if (videoBox && !videoBox.innerText.includes('已完成')) {
              this.panel.log('播放器被关闭，正在重新打开');
              videoBox.click();
              boundVideo = null;
            }
            reopenAttempts++;
            if (reopenAttempts >= 4) {
              this.panel.log('播放器恢复失败，刷新页面重试');
              location.reload();
              return false;
            }
            await Utils.sleep(2000);
            continue;
          }
          reopenAttempts = 0;
          if (!display) {
            // 播放器加载中，等待渲染
            await Utils.sleep(800);
            continue;
          }
          if (video !== boundVideo) {
            stopObserve();
            Player.applySpeed();
            Player.mute();
            boundVideo = video;
            stopObserve = Player.observePause(video);
          }
          const times = display.innerText || '';
          const [nowTime, totalTime] = times.split(' / ');
          if (nowTime && totalTime && nowTime === totalTime) return true;
          await Utils.sleep(800);
        }
        return false;
      } finally {
        stopObserve();
      }
    }

    async handleCourseware(course) {
      const tableData = course.parentNode?.parentNode?.parentNode?.__vue__?.tableData;
      const deadlinePassed = (tableData?.deadline || tableData?.end) ? (tableData.deadline < Date.now() || tableData.end < Date.now()) : false;
      if (deadlinePassed) {
        this.panel.log(`${course.querySelector('h2')?.innerText || '课件'} 已结课，跳过`);
        this.updateProgress(this.outside + 1, 0);
        return;
      }
      course.click();
      await Utils.sleep(3000);

      // 检测"查看课件"按钮（课件概况页专用）
      const checkBtn = document.querySelector('.ppt_img_box .check') || document.querySelector('p.check');
      if (checkBtn && checkBtn.innerText?.trim() === '查看课件') {
        this.panel.log('检测到"查看课件"按钮，正在点击...');
        checkBtn.click();
        await Utils.sleep(2000);
      }
      const classType = document.querySelector('.el-card__header')?.innerText || '';
      const className = document.querySelector('.dialog-header')?.firstElementChild?.innerText || '课件';
      if (classType.includes('PPT')) {
        const slides = document.querySelector('.swiper-wrapper')?.children || [];
        this.panel.log(`开始播放 PPT：${className}`);
        for (let i = 0; i < slides.length; i++) {
          if (Session.isStopped()) return;
          slides[i].click();
          this.panel.log(`${className}：第 ${i + 1} 张`);
          await Utils.sleep(Config.pptInterval);
        }
        await Utils.sleep(Config.pptInterval);
        const videoBoxes = document.querySelectorAll('.video-box');
        if (videoBoxes?.length) {
          this.panel.log('PPT 中有视频，继续播放');
          for (let i = 0; i < videoBoxes.length; i++) {
            if (Session.isStopped()) return;
            if (videoBoxes[i].innerText === '已完成') {
              this.panel.log(`第 ${i + 1} 个视频已完成，跳过`);
              continue;
            }
            videoBoxes[i].click();
            await Utils.sleep(2000);
            await this.waitCoursewareVideo();
          }
        }
        this.panel.log(`${className} 已播放完毕`);
      } else {
        const videoBox = document.querySelector('.video-box');
        if (videoBox) {
          videoBox.click();
          await Utils.sleep(1800);
          await this.waitCoursewareVideo();
          this.panel.log(`${className} 视频播放完毕`);
        }
      }
      if (Session.isStopped()) return;
      this.updateProgress(this.outside + 1, 0);
      history.back();
      await Utils.sleep(1000);
    }
  }

  // ---- pro/lms 旧版（仅做转发） ----
  class ProOldRunner {
    constructor(panel) {
      this.panel = panel;
    }
    run() {
      this.panel.log('准备打开新标签页...');
      const leafDetail = document.querySelectorAll('.leaf-detail');
      let classCount = Store.getProClassCount() - 1;
      while (leafDetail[classCount] && !leafDetail[classCount].firstChild.querySelector('i').className.includes('shipin')) {
        classCount++;
        Store.setProClassCount(classCount + 1);
        this.panel.log('课程不属于视频，已跳过');
      }
      leafDetail[classCount]?.click();
    }
  }

  // ---- pro/lms 新版（主要逻辑） ----
  class ProNewRunner {
    constructor(panel) {
      this.panel = panel;
    }
    async run() {
      preventScreenCheck();
      let classCount = Store.getProClassCount();
      while (!Session.isStopped()) {
        this.panel.log(`准备播放第 ${classCount} 集...`);
        await Utils.sleep(2000);
        const className = document.querySelector('.header-bar')?.firstElementChild?.innerText || '';
        const classType = document.querySelector('.header-bar')?.firstElementChild?.firstElementChild?.getAttribute('class') || '';
        const classStatus = document.querySelector('#app > div.app_index-wrapper > div.wrap > div.viewContainer.heightAbsolutely > div > div > div > div > section.title')?.lastElementChild?.innerText || '';
        if (classType.includes('tuwen') && !classStatus.includes('已读')) {
          this.panel.log(`正在阅读：${className}`);
          await Utils.sleep(2000);
        } else if (classType.includes('taolun')) {
          this.panel.log(`讨论区暂不自动发帖，${className}`);
          await Utils.sleep(2000);
        } else if (classType.includes('shipin') && !classStatus.includes('100%')) {
          this.panel.log(`2s 后开始播放：${className}`);
          await Utils.sleep(2000);
          let statusTimer;
          let videoTimer;
          try {
            statusTimer = setInterval(() => {
              const status = document.querySelector('#app > div.app_index-wrapper > div.wrap > div.viewContainer.heightAbsolutely > div > div > div > div > section.title')?.lastElementChild?.innerText || '';
              if (status.includes('100%') || status.includes('99%') || status.includes('98%') || status.includes('已完成')) {
                this.panel.log(`${className} 播放完毕`);
                clearInterval(statusTimer);
                statusTimer = null;
              }
            }, 200);

            const videoWaitStart = Date.now();
            videoTimer = setInterval(() => {
              if (Session.isStopped()) return;
              const video = document.querySelector('video');
              if (video) {
                setTimeout(() => {
                  if (Session.isStopped()) return;
                  Player.applySpeed();
                  Player.mute();
                  Player.observePause(video);
                }, 2000);
                clearInterval(videoTimer);
                videoTimer = null;
              } else if (Date.now() - videoWaitStart > 20000) {
                location.reload();
              }
            }, 5000);

            await Utils.sleep(8000);
            await Utils.poll(() => {
              const status = document.querySelector('#app > div.app_index-wrapper > div.wrap > div.viewContainer.heightAbsolutely > div > div > div > div > section.title')?.lastElementChild?.innerText || '';
              return status.includes('100%') || status.includes('99%') || status.includes('98%') || status.includes('已完成');
            }, { interval: 1000, timeout: await Utils.getDDL() });
          } finally {
            if (statusTimer) clearInterval(statusTimer);
            if (videoTimer) clearInterval(videoTimer);
          }
        } else if (classType.includes('zuoye')) {
          this.panel.log(`进入作业：${className}（暂无自动答题）`);
          await Utils.sleep(2000);
        } else if (classType.includes('kaoshi')) {
          this.panel.log(`进入考试：${className}（不会自动答题）`);
          await Utils.sleep(2000);
        } else if (classType.includes('ketang')) {
          this.panel.log(`进入课堂：${className}（暂无自动功能）`);
          await Utils.sleep(2000);
        } else {
          this.panel.log(`已看过：${className}`);
          await Utils.sleep(2000);
        }
        if (Session.isStopped()) return;
        this.panel.log(`第 ${classCount} 集播放完毕`);
        classCount++;
        Store.setProClassCount(classCount);
        const nextBtn = document.querySelector('.btn-next');
        if (nextBtn) {
          const event1 = new Event('mousemove', { bubbles: true });
          event1.clientX = 9999;
          event1.clientY = 9999;
          nextBtn.dispatchEvent(event1);
          nextBtn.dispatchEvent(new Event('click'));
        } else {
          localStorage.removeItem(Config.storageKeys.proClassCount);
          this.panel.log('课程播放完毕 🎉');
          Store.clearPendingAutoStart();
          this.panel.resetStartButton('开始刷课');
          break;
        }
      }
    }
  }

  // ---- ai-workspace 新版学习空间 ----
  class AiWorkspaceRunner {
    constructor(panel) {
      this.panel = panel;
    }

    getExerciseQuestionLabel(root) {
      const tabs = AiWorkspace.getExerciseQuestionTabs(root);
      const active = tabs.find(tab => /active|current|selected|is-active/.test(tab.className));
      return AiWorkspace.normalizeText(active?.innerText || '');
    }

    // 获取要跳转回去的目标地址
    getReturnUrl() {
      const pending = Store.getPendingAutoStart();
      const route = AiWorkspace.getRoute();
      if (!pending || !route) return '';
      if (pending.classroomId !== route.classroomId) return '';
      console.log(`returnUrl:${pending.returnUrl}`)
      return pending.returnUrl || '';
    }

    async autoSelect() {
      if (Session.isStopped()) return;
      // 进入ai - workspace的方式有两种：可以处理两种不同的逻辑，增加兼容性
      const returnUrl = this.getReturnUrl()
      // 1. 从传统的 v2 - pro / lms 的目录新开标签页进入（开始刷课）的
      if (returnUrl) {
        await this.returnToSource(returnUrl)
      } else {
        // 2. 直接从ai - workspac页面进入（开始刷课）的
        this.panel.log("检测到是从ai - workspac页面点击开始刷课");
        this.source = AiWorkspace.getAllScourse(); // 得到课程列表
        this.activateIndex = Array.from(this.source).findIndex(el => el.firstChild.classList.contains("is-active")) // 现在正在刷第几个（从0开始）
        await this.handleNext(this.activateIndex + 1)
      }
    }

    // 获取父窗口对象 window.opener
    getSourceWindow() {
      try {
        if (!window.opener || window.opener.closed) return null;
        if (window.opener.location.origin !== location.origin) return null;
        return window.opener;
      } catch (_) {
        return null;
      }
    }

    async returnToSource(returnUrl) {
      this.panel.log('媒体播放完成，返回课程目录页继续匹配');
      await Utils.sleep(1200);
      const sourceWindow = this.getSourceWindow();
      console.log(sourceWindow);
      if (sourceWindow) {
        try {
          sourceWindow.location.href = returnUrl;
          sourceWindow.focus();
          window.close();
          return true;
        } catch (e) {
          console.error("跳转父窗口异常", e);
        }
      }
      // if (location.href !== returnUrl) {
      //   location.href = returnUrl;
      // } else {
      //   history.back();
      // }
      // return true;
    }

    async handleMedia(route) {
      const title = AiWorkspace.getActiveLeafTitle() || `${route.type} ${route.leafId}`;
      this.panel.log(`开始播放：${title}`);
      const ready = await Utils.poll(() => Boolean(AiWorkspace.getMedia()), { interval: 500, timeout: 20000 });
      if (Session.isStopped()) return false;
      let media = AiWorkspace.getMedia();
      if (!ready || !media) {
        this.panel.log('未找到视频/音频元素，停止当前轮次');
        return false;
      }

      const playbackState = { completed: false };
      const shouldResume = () => !playbackState.completed;
      let stopObserve = () => { };
      if (media.tagName.toLowerCase() === 'video') {
        Player.applySpeed(media);
        Player.mute();
        stopObserve = Player.observePause(media, shouldResume);
      } else {
        Player.applyMediaDefault(media);
      }
      const stopKeepAlive = AiWorkspace.keepAlive(shouldResume);
      const rateConf = Store.getRateConf();
      this.panel.log(`已接管播放器：${media.tagName.toLowerCase()}，目标倍速 ${rateConf.targetRate}x，静音开启；按钮设速:${rateConf.buttonSetEnabled ? '开' : '关'} 直设倍速:${rateConf.directSetEnabled ? '开' : '关'} 倍速保活:${rateConf.keepAliveEnabled ? '开' : '关'} 回写拦截:${rateConf.ratechangeBlockEnabled ? '开' : '关'} 暂停拦截:${rateConf.pauseGuardEnabled ? '开' : '关'}`);
      try {
        let startTime = Number(media.currentTime || 0);
        const started = await Utils.poll(() => {
          const currentMedia = AiWorkspace.getMedia();
          if (currentMedia) media = currentMedia;
          if (!media) return false;
          const currentTime = Number(media.currentTime || 0);
          return currentTime > startTime + 0.5 || (!media.paused && media.readyState >= 2 && currentTime > startTime + 0.2);
        }, { interval: 500, timeout: 15000 });
        if (!started) {
          if (!Session.isStopped()) this.panel.log('未确认到视频实际开始播放，停止当前轮次');
          return false;
        }
        startTime = Number(media.currentTime || 0);

        let resolveEnded;
        const endedPromise = new Promise(resolve => {
          resolveEnded = resolve;
        });
        const onEnded = () => {
          playbackState.completed = true;
          resolveEnded(true);
        };
        media.addEventListener('ended', onEnded);
        const done = await Promise.race([
          endedPromise,
          Utils.poll(() => {
            if (playbackState.completed) return true;
            const currentMedia = AiWorkspace.getMedia();
            if (currentMedia) media = currentMedia;
            if (AiWorkspace.isPlayerDone(media, { startTime, minPlayedDelta: 3 })) {
              playbackState.completed = true;
              return true;
            }
            return false;
          }, { interval: 1000, timeout: await Utils.getDDL() })
        ]);
        media.removeEventListener('ended', onEnded);
        playbackState.completed = true;
        if (!done) {
          if (!Session.isStopped()) this.panel.log('等待播放完成超时，停止当前轮次');
          return false;
        }
      } finally {
        stopObserve();
        stopKeepAlive();
      }

      this.panel.log(`${title} 播放完成`);
      return true;
    }

    async solveExerciseQuestion(root, label = '') {
      const questionRoot = AiWorkspace.getExerciseQuestionBody(root);
      if (!questionRoot) {
        this.panel.log('未找到题目容器，停止当前轮次');
        return false;
      }
      if (AiWorkspace.isExerciseAnswered(questionRoot)) {
        this.panel.log(`${label || '当前题目'} 已完成，跳过`);
        return true;
      }

      const listContainer = questionRoot.querySelector('.list-inline.list-unstyled-radio')
        || questionRoot.querySelector('.list-unstyled.list-unstyled-radio')
        || questionRoot.querySelector('.list-unstyled')
        || questionRoot.querySelector('ul.list')
        || questionRoot.querySelector('[class*="option-list"]')
        || questionRoot.querySelector('[class*="answer-list"]')
        || questionRoot.querySelector('ul')
        || questionRoot.querySelector('[role="radiogroup"]');
      const optionCount = listContainer
        ? listContainer.querySelectorAll('li, .option-item, .answer-item, [class*="option-item"], [class*="answer-item"]').length
        : 0;
      if (!optionCount) {
        this.panel.log(`${label || '当前题目'} 未找到选项，跳过`);
        return false;
      }

      const mode = Solver.resolveAnswerMode();
      const questionInput = await Solver.prepareQuestion(questionRoot, mode);
      if (!questionInput) {
        this.panel.log(`${label || '当前题目'} ${mode === 'vision' ? '截图失败' : 'OCR 结果过短'}，跳过`);
        return false;
      }

      const maxRetry = 3;
      for (let retryCount = 0; retryCount < maxRetry; retryCount++) {
        try {
          if (retryCount > 0) this.panel.log(`${label || '当前题目'} 重试 ${retryCount}/${maxRetry - 1}`);
          this.panel.log('🤖 请求 AI 获取答案...');
          const aiText = await Solver.askAI(questionInput, optionCount);
          await Solver.autoSelectAndSubmit(aiText, questionRoot);
          await Utils.sleep(1200);
          return true;
        } catch (err) {
          this.panel.log(`AI 答题失败：${err}`);
          if (retryCount < maxRetry - 1) await Utils.sleep(5000);
        }
      }
      return false;
    }

    async advanceExerciseQuestion(root, previousFingerprint = '') {
      const currentRoot = AiWorkspace.getExerciseContainer() || root;
      const nextBtn = AiWorkspace.getExerciseActionButton(currentRoot, /下一题|下一道|下一步/);
      if (!nextBtn) return false;
      nextBtn.click();
      return Utils.poll(() => {
        const latestRoot = AiWorkspace.getExerciseContainer() || currentRoot;
        const questionRoot = AiWorkspace.getExerciseQuestionBody(latestRoot);
        const fingerprint = AiWorkspace.normalizeText(questionRoot?.innerText || '').slice(0, 120);
        return fingerprint && fingerprint !== previousFingerprint;
      }, { interval: 500, timeout: 5000 });
    }

    async handleExercise(route) {
      const featureFlags = Store.getFeatureConf();
      if (!featureFlags.autoAI) {
        this.panel.log('已关闭 AI 自动答题，作业将直接跳过');
        return true;
      }

      const ready = await Utils.poll(() => Boolean(AiWorkspace.getExerciseContainer()), { interval: 500, timeout: 20000 });
      if (Session.isStopped()) return true;
      const root = AiWorkspace.getExerciseContainer();
      if (!ready || !root) {
        this.panel.log('未找到作业容器，停止当前轮次');
        return false;
      }

      this.panel.log(`开始处理作业：${AiWorkspace.getActiveLeafTitle() || route.leafId}`);
      const tabs = AiWorkspace.getExerciseQuestionTabs(root);
      if (tabs.length) {
        this.panel.log(`检测到题目索引 ${tabs.length} 个，按题号顺序作答`);
        for (let i = 0; i < tabs.length; i++) {
          if (Session.isStopped()) return true;
          const currentRoot = AiWorkspace.getExerciseContainer() || root;
          const currentTabs = AiWorkspace.getExerciseQuestionTabs(currentRoot);
          const currentTab = currentTabs[i];
          if (!currentTab) break;
          currentTab.click();
          await Utils.sleep(1200);
          await this.solveExerciseQuestion(AiWorkspace.getExerciseContainer() || currentRoot, `第 ${i + 1} 题`);
        }
        return true;
      }

      this.panel.log('未找到题号列表，尝试只处理当前题并按下一题推进');
      let previousFingerprint = '';
      for (let i = 0; i < 20; i++) {
        if (Session.isStopped()) return true;
        const currentRoot = AiWorkspace.getExerciseContainer() || root;
        const questionRoot = AiWorkspace.getExerciseQuestionBody(currentRoot);
        const fingerprint = AiWorkspace.normalizeText(questionRoot?.innerText || '').slice(0, 120);
        if (!fingerprint) break;
        if (i > 0 && fingerprint === previousFingerprint) break;
        await this.solveExerciseQuestion(currentRoot, this.getExerciseQuestionLabel(currentRoot) || `第 ${i + 1} 题`);
        previousFingerprint = fingerprint;
        const moved = await this.advanceExerciseQuestion(currentRoot, fingerprint);
        if (!moved) break;
      }
      return true;
    }

    // 直接在ai-workspace页面处理课程的逻辑
    async handleNext(count) {
      if (Session.isStopped()) return;
      if (count >= this.source.length) {
        this.panel.log('课程刷完啦 🎉');
        this.panel.resetStartButton('刷完啦~');
        Store.clearPendingAutoStart();
        return;
      }
      this.source[count].firstChild.click();
      await Utils.sleep(2000);
      await this.run(false)
    }

    async run(preventScreenCheckSwitch = true) {
      // 仅开启一次防切屏
      if (preventScreenCheckSwitch) preventScreenCheck();
      const route = AiWorkspace.getRoute();
      if (!route) {
        this.panel.log('当前页面已离开 ai-workspace/lms-graph');
        return;
      }
      if (!route.leafId) {
        this.panel.log('未能识别当前知识点');
        return;
      }
      let ok = false;
      if (route.type === 'video' || route.type === 'audio') {
        ok = await this.handleMedia(route);
      } else if (route.type === 'exercise') {
        ok = await this.handleExercise(route);
      } else {
        this.panel.log(`当前类型为 ${route.type}，当前暂不自动处理此类型，自动跳过`);
        await Utils.sleep(2000);
        ok = true;
      }
      if (Session.isStopped()) return;
      if (!ok) this.panel.warn("(该视频可能已经刷完了)，即将跳过开始下一个");
      // 继续下一个
      await this.autoSelect()
    }
  }

  // ---- 路由 ----
  // 停止刷课：结束当前会话、还原对页面/播放器的修改，并持久化停止状态（重新加载也不会自动恢复）
  function stopBrushing() {
    Session.stop();
    Store.clearPendingAutoStart();
    PageRestore.restoreAll();
    panel.resetStartButton('开始刷课');
    panel.log('已停止刷课：对页面/播放器的修改已还原；重新加载后不会自动恢复，点击[开始刷课]可重新启动');
  }

  function start() {
    // 显式开始刷课：清除“用户已停止”状态，之后的跨页面跳转才允许自动续跑
    Session.begin();
    // ---- ai-workspace获取课程根目录信息并保存（处理完一个课程重定向到根目录） ----
    const classroomId = Utils.getCurrentClassroomId();
    const returnUrl = Utils.returnUrl()
    Store.setPendingAutoStart(classroomId, returnUrl);
    const aiRoute = AiWorkspace.getRoute();
    if (aiRoute) {
      panel.log(`正在匹配处理逻辑：ai-workspace/lms-graph/${aiRoute.type}`);
      new AiWorkspaceRunner(panel).run();
      return;
    }
    // ---- ai-workspace end
    const url = location.host;
    const path = location.pathname.split('/');
    const matchURL = `${url}${path[0]}/${path[1]}/${path[2]}`;
    panel.log(`正在匹配处理逻辑：${matchURL}`);
    if (matchURL.includes('yuketang.cn/v2/web') || matchURL.includes('gdufemooc.cn/v2/web')) {
      new V2Runner(panel).run();
    } else if (matchURL.includes('yuketang.cn/pro/lms') || matchURL.includes('gdufemooc.cn/pro/lms')) {
      if (document.querySelector('.btn-next')) {
        new ProNewRunner(panel).run();
      } else {
        new ProOldRunner(panel).run();
      }
    } else {
      panel.resetStartButton('开始刷课');
      panel.log('当前页面非刷课页面，应匹配 */v2/web/*、*/pro/lms/* 或 */ai-workspace/lms-graph/*');
    }
  }

  // ---- 启动 ----
  async function boot() {
    if (Utils.inIframe()) return;
    await Utils.waitForMountTarget();
    try {
      panel = createPanel();
      panel.log(`雨课堂刷课助手 v${Config.version} 已加载`);
      panel.setStartHandler(start);
      panel.setStopHandler(stopBrushing);
      const pendingAutoStart = Store.getPendingAutoStart();
      const currentClassroomId = Utils.getCurrentClassroomId();
      if (
        pendingAutoStart
        && !Session.isStopped()
        && Utils.isSupportedLearningPage()
        && currentClassroomId
        && pendingAutoStart.classroomId === currentClassroomId
      ) {
        panel.log(`检测到跨页面跳转，自动恢复刷课：课堂 ${currentClassroomId}`);
        setTimeout(() => panel.start(), 1200);
      }
    } catch (err) {
      console.error('面板初始化失败:', err);
    }
  }

  boot();

})();
