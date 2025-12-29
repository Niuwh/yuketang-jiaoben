// ==UserScript==
// @name         雨课堂刷课助手
// @namespace    http://tampermonkey.net/
// @version      3.0.2
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
    version: '3.0.2',     // 版本号
    playbackRate: 2,      // 视频播放倍速
    pptInterval: 3000,    // ppt翻页间隔
    storageKeys: {        // 使用者勿动
      progress: '[雨课堂脚本]刷课进度信息',
      ai: 'ykt_ai_conf',
      proClassCount: 'pro_lms_classCount',
      feature: 'ykt_feature_conf' // 是否开启AI作答/自动评论
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
      };
      localStorage.setItem(Config.storageKeys.feature, JSON.stringify(conf));
      return conf;
    },
    setFeatureConf(conf) {
      localStorage.setItem(Config.storageKeys.feature, JSON.stringify(conf));
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
    document.body.appendChild(iframe);

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
              .form-item input[type="password"] {
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
                  <li>🤖 <strong>支持模型：</strong>DeepSeek、Kimi(Moonshot)、通义千问、OpenAI</li>
                  <li>📢 <strong>使用必读：</strong>自动答题需先点击<span style="color:green">[AI配置]</span>开启并填入API Key</li>
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
                </div>
                <div class="form-item">
                  <label class="checkbox-label">
                    <input type="checkbox" id="feature_auto_ai">
                    用 AI 自动作答（作业/题目）
                  </label>
                </div>
                <div class="form-item">
                  <label class="checkbox-label">
                    <input type="checkbox" id="feature_auto_comment">
                    用批量区图文/讨论自动回复
                  </label>
                </div>
                <div class="settings-footer">
                  <button id="save_settings">保存并关闭</button>
                  <button id="close_settings">取消</button>
                </div>
              </div>
              <div class="footer">
                <button id="btn-setting">AI配置</button>
                <button id="btn-clear">清除缓存</button>
                <button id="btn-start">开始刷课</button>
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
      settings: doc.getElementById('settings'),
      saveSettings: doc.getElementById('save_settings'),
      closeSettings: doc.getElementById('close_settings'),
      aiUrlInput: doc.getElementById('ai_url'),
      aiKeyInput: doc.getElementById('ai_key'),
      aiModelInput: doc.getElementById('ai_model'),
      featureAutoAI: doc.getElementById('feature_auto_ai'),
      featureAutoComment: doc.getElementById('feature_auto_comment'),
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

    const defaultAI = { url: 'https://api.deepseek.com/chat/completions', key: 'sk-xxxxxxx', model: 'deepseek-chat' };
    const loadAIConf = () => {
      const saved = Store.getAIConf();
      ui.aiUrlInput.value = saved.url || defaultAI.url;
      ui.aiKeyInput.value = saved.key || defaultAI.key;
      ui.aiModelInput.value = saved.model || defaultAI.model;
    };
    const loadFeatureConf = () => {
      const saved = Store.getFeatureConf();
      ui.featureAutoAI.checked = saved.autoAI;
      ui.featureAutoComment.checked = saved.autoComment;
    };
    loadAIConf();
    loadFeatureConf();
    ui.btnSetting.onclick = () => {
      loadAIConf();
      loadFeatureConf();
      ui.settings.style.display = 'block';
    };
    ui.closeSettings.onclick = () => {
      ui.settings.style.display = 'none';
    };
    ui.saveSettings.onclick = () => {
      const conf = {
        url: ui.aiUrlInput.value.trim(),
        key: ui.aiKeyInput.value.trim(),
        model: ui.aiModelInput.value.trim()
      };
      Store.setAIConf(conf);
      const featureConf = {
        autoAI: ui.featureAutoAI.checked,
        autoComment: ui.featureAutoComment.checked
      };
      Store.setFeatureConf(featureConf);
      ui.settings.style.display = 'none';
      log('✅ AI 配置已保存');
    };

    ui.btnClear.onclick = () => {
      Store.removeProgress(window.parent.location.href);
      localStorage.removeItem(Config.storageKeys.proClassCount);
      log('已清除当前课程的刷课进度缓存');
    };

    // 后面赋值给panel
    return {
      ...ui,
      log,
      setStartHandler(fn) {
        ui.btnStart.onclick = () => {
          log('启动中...');
          ui.btnStart.innerText = '刷课中...';
          fn && fn();
        };
      },
      resetStartButton(text = '开始刷课') {
        ui.btnStart.innerText = text;
      }
    };
  }

  // ---- 播放器工具 ----
  const Player = {
    applySpeed() {
      const rate = Config.playbackRate;
      const speedBtn = document.querySelector('xt-speedlist xt-button') || document.getElementsByTagName('xt-speedlist')[0]?.firstElementChild?.firstElementChild;
      const speedWrap = document.getElementsByTagName('xt-speedbutton')[0];
      if (speedBtn && speedWrap) {
        speedBtn.setAttribute('data-speed', rate);
        speedBtn.setAttribute('keyt', `${rate}.00`);
        speedBtn.innerText = `${rate}.00X`;
        const mousemove = document.createEvent('MouseEvent');
        mousemove.initMouseEvent('mousemove', true, true, unsafeWindow, 0, 10, 10, 10, 10, 0, 0, 0, 0, 0, null);
        speedWrap.dispatchEvent(mousemove);
        speedBtn.click();
      } else if (document.querySelector('video')) {
        document.querySelector('video').playbackRate = rate;
      }
    },
    mute() {
      const muteBtn = document.querySelector('#video-box > div > xt-wrap > xt-controls > xt-inner > xt-volumebutton > xt-icon');
      if (muteBtn) muteBtn.click();
      const video = document.querySelector('video');
      if (video) video.volume = 0;
    },
    applyMediaDefault(media) {
      if (!media) return;
      media.play();
      media.volume = 0;
      media.playbackRate = Config.playbackRate;
    },
    observePause(video) {
      if (!video) return () => { };
      const target = document.getElementsByClassName('play-btn-tip')[0];
      if (!target) return () => { };
      // 自动播放
      const playVideo = () => {
        video.play().catch(e => {
          console.warn('自动播放失败:', e);
          setTimeout(playVideo, 3000);
        });
      };
      playVideo();
      const observer = new MutationObserver(list => {
        for (const mutation of list) {
          if (mutation.type === 'childList' && target.innerText === '播放') {
            video.play();
          }
        }
      });
      observer.observe(target, { childList: true });
      return () => observer.disconnect();
    },
    waitForEnd(media, timeout = 0) {
      return new Promise(resolve => {
        if (!media) return resolve();
        if (media.ended) return resolve();
        let timer;
        const onEnded = () => {
          clearTimeout(timer);
          resolve();
        };
        media.addEventListener('ended', onEnded, { once: true });
        if (timeout > 0) {
          timer = setTimeout(() => {
            media.removeEventListener('ended', onEnded);
            resolve();
          }, timeout);
        }
      });
    }
  };

  // ---- 防切屏 ----
  function preventScreenCheck() {
    const win = unsafeWindow;
    const blackList = new Set(['visibilitychange', 'blur', 'pagehide']);
    win._addEventListener = win.addEventListener;
    win.addEventListener = (...args) => blackList.has(args[0]) ? undefined : win._addEventListener(...args);
    document._addEventListener = document.addEventListener;
    document.addEventListener = (...args) => blackList.has(args[0]) ? undefined : document._addEventListener(...args);
    Object.defineProperties(document, {
      hidden: { value: false },
      visibilityState: { value: 'visible' },
      hasFocus: { value: () => true },
      onvisibilitychange: { get: () => undefined, set: () => { } },
      onblur: { get: () => undefined, set: () => { } }
    });
    Object.defineProperties(win, {
      onblur: { get: () => undefined, set: () => { } },
      onpagehide: { get: () => undefined, set: () => { } }
    });
  }

  // ---- OCR & AI ----
  const Solver = {
    async recognize(element) {
      if (!element) return '无元素';
      try {
        panel.log('正在截图...');
        const canvas = await html2canvas(element, {
          useCORS: true,
          logging: false,
          scale: 2,
          backgroundColor: '#ffffff'
        });
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
    async askAI(ocrText, optionCount = 0) {
      const saved = Store.getAIConf();
      const API_URL = saved.url;
      const API_KEY = saved.key;
      const MODEL_NAME = saved.model;
      return new Promise((resolve, reject) => {
        if (!API_KEY || API_KEY.includes('sk-xxxx')) {
          const msg = '⚠️ 请在 [AI配置] 中填写有效的 API Key';
          panel.log(msg);
          reject(msg);
          return;
        }
        const maxChar = String.fromCharCode(65 + optionCount - 1);
        const rangeStr = optionCount ? `A-${maxChar}` : 'A-D';
        const prompt = `
你是专业做题助手，请分析 OCR 文本，判断题型后给出答案。
强约束：
1) 本题只有 ${optionCount || '若干'} 个选项，范围 ${rangeStr}
2) 忽略 OCR 错误的选项字母，按出现顺序映射 A/B/C/D...
3) 输出格式必须包含“正确答案：”前缀，例如 正确答案：A 或 正确答案：ABD 或 正确答案：对/错
题目内容：
${ocrText}
`;
        GM_xmlhttpRequest({
          method: 'POST',
          url: API_URL,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`
          },
          data: JSON.stringify({
            model: MODEL_NAME,
            messages: [
              { role: 'system', content: "你是一个只输出答案的助手。判断题输出'对'或'错'，选择题输出字母。" },
              { role: 'user', content: prompt }
            ],
            temperature: 0.1
          }),
          timeout: 15000,
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
        itemBodyElement.querySelector('ul.list');
      if (!listContainer) {
        panel.log('⚠️ 未找到选项容器');
        return;
      }
      const options = listContainer.querySelectorAll('li');
      for (const idx of targetIndices) {
        if (!options[idx]) continue;
        const clickable = options[idx].querySelector('label.el-radio') ||
          options[idx].querySelector('label.el-checkbox') ||
          options[idx].querySelector('.el-radio__label') ||
          options[idx].querySelector('.el-checkbox__label') ||
          options[idx].querySelector('input') ||
          options[idx];
        clickable.click();
        await Utils.sleep(150);
      }
      const submitBtn = (() => {
        const local = itemBodyElement.parentElement.querySelectorAll('.el-button--primary');
        for (const btn of local) {
          if (btn.innerText.includes('提交')) return btn;
        }
        const global = document.querySelectorAll('.el-button.el-button--primary.el-button--medium');
        for (const btn of global) {
          if (btn.innerText.includes('提交') && btn.offsetParent !== null) return btn;
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
    }

    updateProgress(outside, inside = 0) {
      this.outside = outside;
      this.inside = inside;
      Store.setProgress(this.baseUrl, outside, inside);
    }

    async run() {
      this.panel.log(`检测到已播放到第 ${this.outside} 集，继续刷课...`);
      while (true) {
        await this.autoSlide();
        const list = document.querySelector('.logs-list')?.childNodes;
        if (!list || !list.length) {
          this.panel.log('未找到课程列表，稍后重试');
          await Utils.sleep(2000);
          continue;
        }
        console.log(`当前集数:${this.outside}/全部集数${list.length}`);
        if (this.outside >= list.length) {
          this.panel.log('课程刷完啦 🎉');
          this.panel.resetStartButton('刷完啦~');
          Store.removeProgress(this.baseUrl);
          break;
        }
        const course = list[this.outside]?.querySelector('.content-box')?.querySelector('section');
        if (!course) {
          this.panel.log('未找到当前课程节点，跳过');
          this.updateProgress(this.outside + 1, 0);
          continue;
        }
        const type = course.querySelector('.tag')?.querySelector('use')?.getAttribute('xlink:href') || 'piliang';
        this.panel.log(`刷课状态：第 ${this.outside + 1}/${list.length} 个，类型 ${type}`);
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
      await Utils.sleep(3000);
      const progressNode = document.querySelector('.progress-wrap')?.querySelector('.text');
      const title = document.querySelector('.title')?.innerText || '视频';
      const isDeadline = document.querySelector('.box')?.innerText.includes('已过考核截止时间');
      if (isDeadline) this.panel.log(`${title} 已过截止，进度不再增加，将直接跳过`);
      Player.applySpeed();
      Player.mute();
      const stopObserve = Player.observePause(document.querySelector('video'));
      await Utils.poll(() => isDeadline || Utils.isProgressDone(progressNode?.innerHTML), { interval: 5000, timeout: await Utils.getDDL() });
      stopObserve();
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
      }
      this.updateProgress(this.outside + 1, 0);
      await Utils.sleep(1000);
    }

    async playAudioItem(item, title, idx) {
      this.panel.log(`开始播放音频：${title}`);
      item.click();
      await Utils.sleep(2500);
      Player.applyMediaDefault(document.querySelector('audio'));
      const progressNode = document.querySelector('.progress-wrap')?.querySelector('.text');
      await Utils.poll(() => Utils.isProgressDone(progressNode?.innerHTML), { interval: 3000, timeout: await Utils.getDDL() });
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
      await Utils.sleep(2500);
      Player.applySpeed();
      Player.mute();
      const stopObserve = Player.observePause(document.querySelector('video'));
      const progressNode = document.querySelector('.progress-wrap')?.querySelector('.text');
      await Utils.poll(() => Utils.isProgressDone(progressNode?.innerHTML), { interval: 3000, timeout: await Utils.getDDL() });
      stopObserve();
      this.panel.log(`${title} 播放完成`);
      idx++;
      this.updateProgress(this.outside, idx);
      history.back();
      await Utils.sleep(1500);
      return idx;
    }

    async autoCommentItem(item, typeText, idx) {
      const featureFlags = Store.getFeatureConf();
      if (!featureFlags.autoComment) {
        this.panel.log('已关闭自动回复评论，跳过该项');
        idx++;
        this.updateProgress(this.outside, idx);
        return idx;
      }
      this.panel.log(`开始处理${typeText}：${item.querySelector('h2')?.innerText || ''}`);
      item.click();
      await Utils.sleep(1200);
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
      this.panel.log('进入作业，启动 OCR + AI');
      item.click();
      await Utils.sleep(1500);
      let i = 0;
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
        const ocrResult = await Solver.recognize(targetEl);
        if (ocrResult && ocrResult.length > 5) {
          try {
            panel.log('🤖 请求 AI 获取答案...');
            const aiText = await Solver.askAI(ocrResult, optionCount);
            await Solver.autoSelectAndSubmit(aiText, targetEl);
          } catch (err) {
            this.panel.log(`AI 答题失败：${err}`);
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
      if (audio) {
        Player.applyMediaDefault(audio);
        await Player.waitForEnd(audio);
      }
      this.updateProgress(this.outside + 1, 0);
      history.go(-1);
      await Utils.sleep(1200);
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
          slides[i].click();
          this.panel.log(`${className}：第 ${i + 1} 张`);
          await Utils.sleep(Config.pptInterval);
        }
        await Utils.sleep(Config.pptInterval);
        const videoBoxes = document.querySelectorAll('.video-box');
        if (videoBoxes?.length) {
          this.panel.log('PPT 中有视频，继续播放');
          for (let i = 0; i < videoBoxes.length; i++) {
            if (videoBoxes[i].innerText === '已完成') {
              this.panel.log(`第 ${i + 1} 个视频已完成，跳过`);
              continue;
            }
            videoBoxes[i].click();
            await Utils.sleep(2000);
            Player.applySpeed();
            const muteBtn = document.querySelector('.xt_video_player_common_icon');
            muteBtn && muteBtn.click();
            const stopObserve = Player.observePause(document.querySelector('video'));
            await Utils.poll(() => {
              const allTime = document.querySelector('.xt_video_player_current_time_display')?.innerText || '';
              const [nowTime, totalTime] = allTime.split(' / ');
              return nowTime && totalTime && nowTime === totalTime;
            }, { interval: 800, timeout: await Utils.getDDL() });
            stopObserve();
          }
        }
        this.panel.log(`${className} 已播放完毕`);
      } else {
        const videoBox = document.querySelector('.video-box');
        if (videoBox) {
          videoBox.click();
          await Utils.sleep(1800);
          Player.applySpeed();
          const muteBtn = document.querySelector('.xt_video_player_common_icon');
          muteBtn && muteBtn.click();
          await Utils.poll(() => {
            const times = document.querySelector('.xt_video_player_current_time_display')?.innerText || '';
            const [nowTime, totalTime] = times.split(' / ');
            return nowTime && totalTime && nowTime === totalTime;
          }, { interval: 800, timeout: await Utils.getDDL() });
          this.panel.log(`${className} 视频播放完毕`);
        }
      }
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
      while (true) {
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
              const video = document.querySelector('video');
              if (video) {
                setTimeout(() => {
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
          break;
        }
      }
    }
  }

  // ---- 路由 ----
  function start() {
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
      panel.log('当前页面非刷课页面，应匹配 */v2/web/* 或 */pro/lms/*');
    }
  }

  // ---- 启动 ----
  if (Utils.inIframe()) return;
  panel = createPanel();
  panel.log(`雨课堂刷课助手 v${Config.version} 已加载`);
  panel.setStartHandler(start);

})();
