// ==UserScript==
// @name         雨课堂刷课助手
// @namespace    http://tampermonkey.net/
// @version      2.4.18
// @description  针对雨课堂视频进行自动播放
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
// @connect      ib.niuwh.cn
// @require      https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
// @require      https://unpkg.com/tesseract.js@v2.1.0/dist/tesseract.min.js
// ==/UserScript==
// 雨课堂刷课脚本
/*
  已适配雨课堂学校及网址：
  学校：中原工学院，河南大学研究院，辽宁大学，河北大学，中南大学，电子科技大学，华北电力大学，上海理工大学研究生院，东南大学研究生院及其他院校...
  网址：changjiang.yuketang.cn，yuketang.cn ...
*/


const _attachShadow = Element.prototype.attachShadow;
const basicConf = {
  version: '2.4.18',
  rate: 2, //用户可改 视频播放速率,可选值[1,1.25,1.5,2,3,16],默认为2倍速，实测4倍速往上有可能出现 bug，3倍速暂时未出现bug，推荐二倍/一倍。
  pptTime: 3000, // 用户可改 ppt播放时间，单位毫秒
}
const $ = { // 开发脚本的工具对象
  panel: "",      // panel节点，后期赋值
  observer: "",   // 保存observer观察对象
  userInfo: {     // 实时同步刷课记录，避免每次都从头开始检测
    allInfo: {},              // 刷课记录，运行时赋值
    getProgress(classUrl) {   // 参数：classUrl:课程地址
      if (!localStorage.getItem("[雨课堂脚本]刷课进度信息"))   // 第一次初始化这个localStorage
        this.setProgress(classUrl, 0, 0);
      this.allInfo = JSON.parse(localStorage.getItem("[雨课堂脚本]刷课进度信息"));  // 将信息保存到本地
      if (!this.allInfo[classUrl])         // 第一次初始化这个课程
        this.setProgress(classUrl, 0, 0);
      console.log(this.allInfo);
      return this.allInfo[classUrl];   // 返回课程记录对象{outside:外边第几集，inside:里面第几集}
    },
    setProgress(classUrl, outside, inside = 0) {   // 参数:classUrl:课程地址,outside为最外层集数，inside为最内层集数
      this.allInfo[classUrl] = {
        outside,
        inside
      }
      localStorage.setItem("[雨课堂脚本]刷课进度信息", JSON.stringify(this.allInfo));   // localstorage只能保存字符串，需要先格式化为字符串
    },
    removeProgress(classUrl) {   // 移除课程刷课信息，用在课程刷完的情况
      delete this.allInfo[classUrl];
      localStorage.setItem("[雨课堂脚本]刷课进度信息", JSON.stringify(this.allInfo));
    }
  },
  alertMessage(message) { // 向页面中添加信息
    const li = document.createElement("li");
    li.innerText = message;
    $.panel.querySelector('.n_infoAlert').appendChild(li);
  },
  ykt_speed() {   // 视频加速
    const rate = basicConf.rate || 2;
    let speedwrap = document.getElementsByTagName("xt-speedbutton")[0];
    let speedlist = document.getElementsByTagName("xt-speedlist")[0];
    let speedlistBtn = speedlist.firstElementChild.firstElementChild;

    speedlistBtn.setAttribute('data-speed', rate);
    speedlistBtn.setAttribute('keyt', rate + '.00');
    speedlistBtn.innerText = rate + '.00X';
    $.alertMessage('已开启' + rate + '倍速');

    // 模拟点击
    let mousemove = document.createEvent("MouseEvent");
    mousemove.initMouseEvent("mousemove", true, true, unsafeWindow, 0, 10, 10, 10, 10, 0, 0, 0, 0, 0, null);
    speedwrap.dispatchEvent(mousemove);
    speedlistBtn.click();
  },
  claim() {   // 视频静音
    document.querySelector("#video-box > div > xt-wrap > xt-controls > xt-inner > xt-volumebutton > xt-icon").click();
    $.alertMessage('已开启静音');
  },
  videoDetail(video = document.querySelector('video')) {  // 不用鼠标模拟操作就能实现的一般视频加速静音方法
    video.play();
    video.volume = 0;
    video.playbackRate = basicConf.rate;
    $.alertMessage(`实际上已默认静音和${basicConf.rate}倍速`);
  },
  audioDetail(audio = document.querySelector('audio')) {   // 音频处理
    audio.play();
    audio.volume = 0;
    audio.playbackRate = basicConf.rate;
    $.alertMessage(`实际上已默认静音和${basicConf.rate}倍速`);
  },
  observePause() {  // 视频意外暂停，自动播放   duck123ducker贡献
    var targetElement = document.getElementsByClassName('play-btn-tip')[0]; // 要监听的dom元素
    if (document.getElementsByClassName('play-btn-tip').length === 0) { // 还未加载出来视频dom时，开启轮回扫描
      setTimeout(observePause, 100);
    } else {
      $.observer = new MutationObserver(function (mutationsList) {
        for (var mutation of mutationsList) {
          if (mutation.type === 'childList' && mutation.target === targetElement && targetElement.innerText === '播放') { // 被监视的元素状态
            console.log('视频意外暂停了，已恢复播放');
            document.getElementsByTagName('video')[0].play();
            $.alertMessage('视频意外暂停了，已恢复播放');
          }
        }
      });
      var config = { childList: true };
      $.observer.observe(targetElement, config);
      document.querySelector("video").play();     //防止进入下一章时由于鼠标离开窗口而在视频开始时就暂停导致永远无法触发监听器
    }
  },
  preventScreenCheck() {  // 阻止pro/lms雨课堂切屏检测  PRO-2684贡献
    const window = unsafeWindow;
    const blackList = new Set(["visibilitychange", "blur", "pagehide"]); // 限制调用事件名单：1.选项卡的内容变得可见或被隐藏时2.元素失去焦点3.页面隐藏事件
    const isDebug = false;
    const log = console.log.bind(console, "[阻止pro/lms切屏检测]");
    const debug = isDebug ? log : () => { };
    window._addEventListener = window.addEventListener;
    window.addEventListener = (...args) => {                  // args为剩余参数数组
      if (!blackList.has(args[0])) {                          // args[0]为想要定义的事件，如果不在限制名单，调用原生函数
        debug("allow window.addEventListener", ...args);
        return window._addEventListener(...args);
      } else {                                                // 否则不执行，打印参数信息
        log("block window.addEventListener", ...args);
        return undefined;
      }
    };
    document._addEventListener = document.addEventListener;
    document.addEventListener = (...args) => {
      if (!blackList.has(args[0])) {
        debug("allow document.addEventListener", ...args);
        return window._addEventListener(...args);
      } else {
        log("block document.addEventListener", ...args);
        return undefined;
      }
    };
    log("addEventListener hooked!");
    if (isDebug) { // DEBUG ONLY: find out all timers
      window._setInterval = window.setInterval;
      window.setInterval = (...args) => {
        const id = window._setInterval(...args);
        debug("calling window.setInterval", id, ...args);
        return id;
      };
      debug("setInterval hooked!");
      window._setTimeout = window.setTimeout;
      window.setTimeout = (...args) => {
        const id = window._setTimeout(...args);
        debug("calling window.setTimeout", id, ...args);
        return id;
      };
      debug("setTimeout hooked!");
    }
    Object.defineProperties(document, {
      hidden: {                 // 表示页面是（true）否（false）隐藏。
        value: false
      },
      visibilityState: {        // 当前可见元素的上下文环境。由此可以知道当前文档 (即为页面) 是在背后，或是不可见的隐藏的标签页
        value: "visible"        // 此时页面内容至少是部分可见
      },
      hasFocus: {               // 表明当前文档或者当前文档内的节点是否获得了焦点
        value: () => true
      },
      onvisibilitychange: {     // 当其选项卡的内容变得可见或被隐藏时，会在 document 上触发 visibilitychange 事件  ==  visibilitychange
        get: () => undefined,
        set: () => { }
      },
      onblur: {                 // 当元素失去焦点的时候
        get: () => undefined,
        set: () => { }
      }
    });
    log("document properties set!");
    Object.defineProperties(window, {
      onblur: {
        get: () => undefined,
        set: () => { }
      },
      onpagehide: {
        get: () => undefined,
        set: () => { }
      },
    });
    log("window properties set!");
  }
}

// --- 核心 OCR 识别函数  ---
async function recognizeTextFromElement(element) {
    if (!element) return "无元素";

    try {
        $.alertMessage("正在截图...");
        // 1. 将 DOM 转为 Canvas 图片
        const canvas = await html2canvas(element, {
            useCORS: true,
            logging: false,
            scale: 2,
            backgroundColor: '#ffffff'
        });

        $.alertMessage("正在OCR识别(首次慢，请耐心等待)...");

        // 2. 使用 Tesseract 进行识别
        // 关键修改：去掉了被拦截的 langPath，使用默认配置
        const { data: { text } } = await Tesseract.recognize(
            canvas,
            'chi_sim', // 简体中文
            {
                // 去掉被 CSP 拦截的 langPath
                // 使用默认源，虽然慢一点，但不会报错
                logger: m => {
                    if (m.status === 'downloading tesseract lang') {
                        // 可以在这里提示下载进度
                        console.log(`正在下载语言包: ${(m.progress * 100).toFixed(0)}%`);
                    }
                }
            }
        );

        // 3. 清理结果
        return text.replace(/\s+/g, ' ').trim();
    } catch (err) {
        console.error("OCR 错误:", err);
        // 如果是 Network Error，通常是因为网络慢，多试几次
        $.alertMessage("OCR 失败: " + (err.message || "网络错误"));
        return "OCR识别出错";
    }
}

// --- 大模型 API 调用函数 (动态配置版) ---
async function fetchAnswerFromAI(ocrText) {
    // 1. 从 localStorage 获取配置
    const savedConf = JSON.parse(localStorage.getItem('ykt_ai_conf') || '{}');

    const API_URL = savedConf.url;
    const API_KEY = savedConf.key;
    const MODEL_NAME = savedConf.model;

    return new Promise((resolve, reject) => {
        // 安全检查
        if (!API_KEY || API_KEY.includes("sk-xxxx")) {
            const msg = "❌ 请点击[AI配置]按钮填入正确的API Key";
            $.alertMessage(msg);
            reject(msg);
            return;
        }

        const prompt = `你是一个专业的做题助手。请先分析下面的 OCR 识别文本，判断题目类型，然后给出答案。

        【输出规则】：
        1. 识别到是【判断题】时：
           - 如果是正确的，请输出：正确答案：对
           - 如果是错误的，请输出：正确答案：错
        2. 识别到是【单选题】或【多选题】时：
           - 请直接输出选项字母，如：正确答案：A 或 正确答案：ABD
        3. 格式必须包含“正确答案：”前缀。

        【题目内容】：
        ${ocrText}`;

        GM_xmlhttpRequest({
            method: "POST",
            url: API_URL,
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${API_KEY}`
            },
            data: JSON.stringify({
                model: MODEL_NAME,
                messages: [
                    { role: "system", content: "你是一个只输出答案的助手。判断题输出'对'或'错'，选择题输出字母。" },
                    { role: "user", content: prompt }
                ],
                temperature: 0.1
            }),
            timeout: 10000,
            onload: function(response) {
                if (response.status === 200) {
                    try {
                        const resJson = JSON.parse(response.responseText);
                        const answerText = resJson.choices[0].message.content;
                        resolve(answerText);
                    } catch (e) {
                        reject("JSON解析失败");
                    }
                } else {
                    const errMsg = `❌ 请求失败: HTTP ${response.status}`;
                    $.alertMessage(errMsg);
                    if (response.status === 401) $.alertMessage("原因: API Key 无效或余额不足");
                    reject(errMsg);
                }
            },
            onerror: function(err) {
                reject("网络错误");
            },
            ontimeout: function() {
                reject("请求超时");
            }
        });
    });
}

// --- 答案解析与点击提交函数 (适配 Element UI 结构) ---
async function autoSelectAndSubmit(aiResponse, itemBodyElement) {
    // 1. 提取 AI 回复中的选项 (支持 "A", "ABD", "对", "错")
    const match = aiResponse.match(/(?:正确)?答案[：:]?\s*([A-F]+(?:[,，][A-F]+)*|[对错]|正确|错误)/i);

    if (!match) {
        $.alertMessage("❌ 未提取到有效选项，请人工检查");
        return;
    }

    let answerRaw = match[1].replace(/[,，]/g, '').trim();
    let targetIndices = [];

    // 2. 将答案转换为索引 [0, 1, 2...]
    if (answerRaw === '对' || answerRaw === '正确') {
        targetIndices = [0]; // A
    } else if (answerRaw === '错' || answerRaw === '错误') {
        targetIndices = [1]; // B
    } else {
        const map = { 'A': 0, 'B': 1, 'C': 2, 'D': 3, 'E': 4, 'F': 5 };
        for (let char of answerRaw.toUpperCase()) {
            if (map[char] !== undefined) targetIndices.push(map[char]);
        }
    }

    if (targetIndices.length === 0) return;

    $.alertMessage(`✅ AI建议选择: ${answerRaw}`);

    // 3. 查找选项列表容器
    let listContainer = itemBodyElement.querySelector('.list-inline.list-unstyled-radio') || // 判断题容器
                        itemBodyElement.querySelector('.list-unstyled.list-unstyled-radio') || // 选择题容器
                        itemBodyElement.querySelector('.list-unstyled') ||
                        itemBodyElement.querySelector('ul.list');

    if (!listContainer) {
        $.alertMessage("❌ 未找到选项列表容器");
        return;
    }
    // 获取所有选项 li
    const options = listContainer.querySelectorAll('li');

    // 4. 执行点击
    for (let index of targetIndices) {
        if (options[index]) {
            // 【核心修改】精准定位点击目标
            // 优先查找 Element UI 的 label 包装器 (el-radio 或 el-checkbox)
            // 其次查找 文字标签 (el-radio__label)
            // 最后查找 input 本身
            const clickable = options[index].querySelector('label.el-radio') ||
                              options[index].querySelector('label.el-checkbox') ||
                              options[index].querySelector('.el-radio__label') ||
                              options[index].querySelector('.el-checkbox__label') ||
                              options[index].querySelector('input') ||
                              options[index]; // 实在找不到就点 li 本身

            if (clickable) {
                clickable.click();
                // 多选题防抖延迟
                await new Promise(r => setTimeout(r, 300));
            }
        }
    }

    // 5. 点击提交按钮
    await new Promise(r => setTimeout(r, 800));

    // 使用你提供的 class 进行定位
    // 结合 class 和 文字内容双重校验，防止点错
    let submitBtn = null;

    // 策略A：在当前题目区域内找
    const localBtns = itemBodyElement.parentElement.querySelectorAll('.el-button--primary');
    for (let btn of localBtns) {
        if (btn.innerText.includes('提交')) {
            submitBtn = btn;
            break;
        }
    }

    // 策略B：如果在局部没找到，在全局找 (使用完整类名)
    if (!submitBtn) {
        const allSubmitBtns = document.querySelectorAll('.el-button.el-button--primary.el-button--medium');
        for (let btn of allSubmitBtns) {
            // 必须包含“提交”二字，且可见
            if (btn.innerText.includes('提交') && btn.offsetParent !== null) {
                submitBtn = btn;
                break;
            }
        }
    }

    if (submitBtn) {
        $.alertMessage("正在提交...");
        submitBtn.click();
    } else {
        $.alertMessage("⚠️ 未找到提交按钮,请手动提交。");
    }
}

window.$ = $;
window.start = start;

function addWindow() {
  // 创建iframe
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.top = '40px';
  iframe.style.left = '40px';
  iframe.style.width = '500px';
  iframe.style.height = '300px'; // 稍微加高一点以容纳设置面板
  iframe.style.zIndex = '999999';
  iframe.style.border = '1px solid #a3a3a3';
  iframe.style.borderRadius = '10px';
  iframe.style.background = '#fff';
  iframe.style.boxShadow = '6px 4px 17px 2px #000000';
  iframe.setAttribute('frameborder', '0');
  iframe.setAttribute('id', 'ykt-helper-iframe');
  iframe.setAttribute('allowtransparency', 'true');
  document.body.appendChild(iframe);

  // iframe内容
  const doc = iframe.contentDocument || iframe.contentWindow.document;
  doc.open();
  doc.write(`
    <style>
      body { margin:0; font-family: Avenir, Helvetica, Arial, sans-serif; color: #636363; background:transparent; }
      .mini-basic{ position: absolute; top: 0; left: 0; background:#f5f5f5; border:1px solid #000; height:50px; width:50px; border-radius:6px; text-align:center; line-height:50px; z-index:1000000; cursor:pointer; display:none; }
      .mini-basic.show { display:block; }
      .n_panel { width:100%; height:100%; background:#fff; border-radius:10px; position:relative; overflow:hidden; }
      .n_header { text-align:center; height:40px; background:#f7f7f7; color:#000; font-size:18px; line-height:40px; border-radius:10px 10px 0 0; border-bottom:2px solid #eee; cursor:move; position:relative;}
      .tools{position:absolute;right:0;top:0;}
      .tools ul{margin:0;padding:0;}
      .tools ul li{position:relative;display:inline-block;padding:0 5px;cursor:pointer;}
      .n_body { font-weight:bold; font-size:13px; line-height:26px; height:calc(100% - 85px); overflow-y:auto; padding: 5px;}
      .n_infoAlert { margin:0; padding:0; list-style:none; }
      .n_footer { position:absolute; bottom:0; left:0; width:100%; background:#f7f7f7; color:#c5c5c5; font-size:13px; line-height:25px; border-radius:0 0 10px 10px; border-bottom:2px solid #eee; display:flex; justify-content:center; align-items:center; padding: 5px 0;}

      /* 按钮通用样式 */
      button { border-radius:6px; border:0; color:#fff; cursor:pointer; margin:0 5px; padding: 5px 10px; font-size: 12px; }
      #n_button { background-color:blue; }
      #n_button:hover { background-color:yellow; color:#000; }
      #n_clear { background-color:#ff4d4f; }
      #n_setting { background-color:#52c41a; }

      /* 设置面板样式 */
      #n_settings_panel { display:none; position:absolute; top:40px; left:0; width:100%; height:calc(100% - 40px); background:#fff; z-index:99; padding:15px; box-sizing:border-box; overflow-y:auto; }
      .form-item { margin-bottom: 10px; }
      .form-item label { display:block; margin-bottom: 3px; font-size: 12px; color: #333; }
      .form-item input { width: 95%; padding: 5px; border: 1px solid #ddd; border-radius: 4px; }
      .settings-footer { text-align: center; margin-top: 15px; }
      .settings-footer button { padding: 6px 15px; }
    </style>

    <div class="mini-basic" id="mini-basic">放大</div>
    <div class="n_panel" id="n_panel">
      <div class="n_header" id="n_header">
        雨课堂刷课助手
        <div class='tools'>
          <ul>
            <li class='minimality' id="minimality">_</li>
            <li class='question' id="question">?</li>
          </ul>
        </div>
      </div>

      <div class="n_body">
        <ul class="n_infoAlert" id="n_infoAlert">
          <li>⭐ 脚本支持：雨课堂所有版本</li>
          <li>🤖 <strong>支持模型：</strong>DeepSeek、Kimi(Moonshot)、通义千问、OpenAI</li>
          <li>📢 <strong>使用必读：</strong>自动答题需先点击<span style="color:green">[AI配置]</span>填入API Key</li>
          <li>🚀 配置完成后，点击<span style="color:blue">[开始刷课]</span>即可启动视频与作业挂机</li>
          <hr>
        </ul>
      </div>

      <div id="n_settings_panel">
          <div class="form-item">
            <label>API URL (接口地址):</label>
            <input type="text" id="ai_url" placeholder="https://api.deepseek.com/chat/completions">
          </div>
          <div class="form-item">
            <label>API KEY (密钥):</label>
            <input type="password" id="ai_key" placeholder="sk-xxxxxxxx">
          </div>
          <div class="form-item">
            <label>Model Name (模型名):</label>
            <input type="text" id="ai_model" placeholder="deepseek-chat">
          </div>
          <div class="settings-footer">
            <button id="save_settings" style="background:blue;">保存并关闭</button>
            <button id="close_settings" style="background:#999;">取消</button>
          </div>
      </div>

      <div class="n_footer">
        <button id="n_setting">AI配置</button>
        <button id="n_clear">清除缓存</button>
        <button id="n_button">开始刷课</button>
      </div>
    </div>
  `);
  doc.close();

  return {
    iframe,
    doc,
    panel: doc.getElementById('n_panel'),
    header: doc.getElementById('n_header'),
    button: doc.getElementById('n_button'),
    clear: doc.getElementById('n_clear'),
    settingBtn: doc.getElementById('n_setting'), // 新增
    settingsPanel: doc.getElementById('n_settings_panel'), // 新增
    saveSettingsBtn: doc.getElementById('save_settings'), // 新增
    closeSettingsBtn: doc.getElementById('close_settings'), // 新增
    aiUrlInput: doc.getElementById('ai_url'), // 新增
    aiKeyInput: doc.getElementById('ai_key'), // 新增
    aiModelInput: doc.getElementById('ai_model'), // 新增
    infoAlert: doc.getElementById('n_infoAlert'),
    minimality: doc.getElementById('minimality'),
    question: doc.getElementById('question'),
    miniBasic: doc.getElementById('mini-basic')
  };
}

function addUserOperate() {
  const { iframe, doc, panel, header, button, clear, settingBtn, settingsPanel, saveSettingsBtn, closeSettingsBtn, aiUrlInput, aiKeyInput, aiModelInput, infoAlert, minimality, question, miniBasic } = addWindow();

  // 1. 初始化读取配置
  const defaultConf = {
    url: "https://api.deepseek.com/chat/completions",
    key: "XXXxxxxxx",
    model: "deepseek-chat"
  };

  // 从 localStorage 读取，如果没有则使用默认
  function loadSettings() {
    const saved = JSON.parse(window.parent.localStorage.getItem('ykt_ai_conf') || '{}');
    aiUrlInput.value = saved.url || defaultConf.url;
    aiKeyInput.value = saved.key || defaultConf.key;
    aiModelInput.value = saved.model || defaultConf.model;
  }
  loadSettings();

  // 2. 按钮事件绑定
  // 打开设置面板
  settingBtn.onclick = function() {
    loadSettings(); // 每次打开重新读取最新
    settingsPanel.style.display = 'block';
  }

  // 关闭设置面板
  closeSettingsBtn.onclick = function() {
    settingsPanel.style.display = 'none';
  }

  // 保存设置
  saveSettingsBtn.onclick = function() {
    const newConf = {
      url: aiUrlInput.value.trim(),
      key: aiKeyInput.value.trim(),
      model: aiModelInput.value.trim()
    };
    window.parent.localStorage.setItem('ykt_ai_conf', JSON.stringify(newConf));
    settingsPanel.style.display = 'none';
    $.alertMessage("✅ AI配置已保存！");
  }

  // --- 原有的拖拽和功能逻辑保持不变 ---

  // 拖拽功能
  let isDragging = false, offsetX = 0, offsetY = 0;
  header.addEventListener('mousedown', function (e) {
    isDragging = true;
    offsetX = e.clientX;
    offsetY = e.clientY;
    iframe.style.transition = 'none';
    doc.body.style.userSelect = 'none';
  });
  doc.addEventListener('mousemove', function (e) {
    if (isDragging) {
      let dx = e.clientX - offsetX;
      let dy = e.clientY - offsetY;
      let left = parseInt(iframe.style.left) + dx;
      let top = parseInt(iframe.style.top) + dy;
      left = Math.max(0, Math.min(window.parent.innerWidth - parseInt(iframe.style.width), left));
      top = Math.max(0, Math.min(window.parent.innerHeight - parseInt(iframe.style.height), top));
      iframe.style.left = left + 'px';
      iframe.style.top = top + 'px';
      offsetX = e.clientX;
      offsetY = e.clientY;
    }
  });
  doc.addEventListener('mouseup', function () {
    isDragging = false;
    iframe.style.transition = '';
    doc.body.style.userSelect = '';
  });

  // 最小化/放大
  minimality.addEventListener('click', function () {
    panel.style.display = 'none';
    miniBasic.classList.add('show');
  });
  miniBasic.addEventListener('click', function () {
    panel.style.display = '';
    miniBasic.classList.remove('show');
  });

  // 有问题按钮
  question.addEventListener('click', function () {
    window.parent.alert('作者网站：niuwh.cn');
  });

  // 刷课按钮
  button.onclick = function () {
    window.parent.start && window.parent.start();
    button.innerText = '刷课中~';
  };
  // 清除数据按钮
  clear.onclick = function () {
    window.parent.$.userInfo.removeProgress(window.parent.location.href);
    window.parent.localStorage.removeItem('pro_lms_classCount');
  };

  // 自动滚动消息
  (function () {
    let scrollTimer;
    scrollTimer = setInterval(function () {
      if (infoAlert.lastElementChild) infoAlert.lastElementChild.scrollIntoView({ behavior: "smooth", block: "end", inline: "nearest" });
    }, 500)
    infoAlert.addEventListener('mouseenter', () => { clearInterval(scrollTimer); })
    infoAlert.addEventListener('mouseleave', () => {
      scrollTimer = setInterval(function () {
        if (infoAlert.lastElementChild) infoAlert.lastElementChild.scrollIntoView({ behavior: "smooth", block: "end", inline: "nearest" });
      }, 500)
    })
  })();

  // 重定向 alertMessage
  $.panel = panel;
  $.alertMessage = function (message) {
    const li = doc.createElement('li');
    li.innerText = message;
    infoAlert.appendChild(li);
  };
}

function start() {  // 脚本入口函数
  const url = location.host;
  const pathName = location.pathname.split('/');
  const matchURL = url + pathName[0] + '/' + pathName[1] + '/' + pathName[2];
  $.alertMessage(`正在为您匹配${matchURL}的处理逻辑...`);
  if (matchURL.includes('yuketang.cn/v2/web') || matchURL.includes('gdufemooc.cn/v2/web')) {
    yuketang_v2();
  } else if (matchURL.includes('yuketang.cn/pro/lms') || matchURL.includes('gdufemooc.cn/pro/lms')) {
    yuketang_pro_lms();
  } else {
    $.panel.querySelector("button").innerText = "开始刷课";
    $.alertMessage(`这不是刷课的页面哦，刷课页面的网址应该匹配 */v2/web/* 或 */pro/lms/*`)
    return false;
  }
}
window.$ = $;
window.start = start;
// yuketang.cn/v2/web页面的处理逻辑
function yuketang_v2() {
  const baseUrl = location.href;    // 用于判断不同的课程
  let count = $.userInfo.getProgress(baseUrl).outside;  // 记录当前课程播放的外层集数
  let play = true;        // 用于标记视频是否播放完毕
  $.alertMessage(`检测到已经播放到${count}集...`);
  $.alertMessage('已匹配到yuketang.cn/v2/web,正在处理...');
  // 主函数
  function main() {
    autoSlide(count).then(() => {
      let list = document.querySelector('.logs-list').childNodes;   // 保存当前课程的所有外层集数
      const course = list[count]?.querySelector('.content-box')?.querySelector('section');   // 保存当前课程dom结构
      let classInfo = course.querySelector('.tag')?.querySelector('use')?.getAttribute('xlink:href') || 'piliang'; // 2023.11.23 雨课堂更新，去掉了批量字样,所有如果不存在就默认为批量课程
      $.alertMessage('刷课状态：第' + (count + 1) + '个/' + list.length + '个');
      // $.alertMessage('类型[' + classInfo + '] 第' + (count + 1) + '/' + list.length + '个');

      if (count === list.length && play === true) {            // 结束
        $.alertMessage('课程刷完了');
        $.panel.querySelector('#n_button').innerText = '刷完了~';
        $.userInfo.removeProgress(baseUrl);
        return;
      } else if (classInfo?.includes('shipin') && play === true) { // 视频处理
        play = false;
        course.click(); // 进入课程
        setTimeout(() => {
          let progress = document.querySelector('.progress-wrap').querySelector('.text');   // 课程进度
          let deadline = false;   // 课程是否到了截止日期
          const title = document.querySelector(".title").innerText;   // 课程标题
          $.alertMessage(`正在播放：${title}`);
          if (document.querySelector('.box').innerText.includes('已过考核截止时间')) {
            deadline = true;
            $.alertMessage(`${title}已经过了截至日期，进度不再增加，将跳过~`);
          }
          $.ykt_speed();
          $.claim();
          $.observePause();
          let timer1 = setInterval(() => {
            // console.log(progress);
            if (progress.innerHTML.includes('100%') || progress.innerHTML.includes('99%') || progress.innerHTML.includes('98%') || progress.innerHTML.includes('已完成') || deadline) {
              count++;
              $.userInfo.setProgress(baseUrl, count);
              play = true;
              if (!!$.observer) {         // 防止oberver为undefined(网速卡导致视频没加载出来，observer为空)
                $.observer.disconnect();  // 视频播放完了，停止监听
              }
              history.back();
              main();
              clearInterval(timer1);
            }
          }, 10000);
        }, 3000)
        // 批量处理
      } else if (classInfo?.includes('piliang') && play === true) {   // 批量处理
        let zhankai = course.querySelector('.sub-info').querySelector('.gray').querySelector('span');
        sync();
        async function sync() {
          await zhankai.click();
          setTimeout(() => {
            // 保存所有视频
            let a = list[count].querySelector('.leaf_list__wrap').querySelectorAll('.activity__wrap');
            let count1 = $.userInfo.allInfo[baseUrl].inside;     // 保存内部集数
            $.alertMessage('第' + (count + 1) + '个：进入了批量区');
            bofang();
            function bofang() {
              let play = true;
              let classInfo1;
              let videotitle, audiotitle;
              if (count1 === a.length && play === true) {
                $.alertMessage('合集播放完毕');
                count++;
                $.userInfo.setProgress(baseUrl, count);
                main();
              }
              console.log(a[count1]?.querySelector('.tag').innerText);
              if (a[count1]?.querySelector('.tag').innerText === '音频') {
                classInfo1 = "音频";
                audiotitle = a[count1]?.querySelector("h2").innerText;
              } else {    // 不是音频
                classInfo1 = a[count1]?.querySelector('.tag').querySelector('use').getAttribute('xlink:href');
                videotitle = a[count1].querySelector("h2").innerText;
                console.log(classInfo1);

              }
              $.alertMessage('批量中[' + classInfo1 + ']'); // 查找进入批量操作之后所有的类型
              if (classInfo1 == "音频" && play === true) {
                play = false;
                a[count1].click();
                $.alertMessage(`开始播放:${audiotitle}`);
                setTimeout(() => {
                  $.audioDetail();
                }, 3000);
                let timer = setInterval(() => {
                  let progress = document.querySelector('.progress-wrap').querySelector('.text');
                  if (document.querySelector('audio').paused) {
                    document.querySelector('audio').play();
                  }
                  if (progress.innerHTML.includes('100%') || progress.innerHTML.includes('99%') || progress.innerHTML.includes('98%') || progress.innerHTML.includes('已完成')) {
                    count1++;
                    $.userInfo.setProgress(baseUrl, count, count1);
                    clearInterval(timer);
                    $.alertMessage(`${audiotitle}播放完毕`);
                    history.back();
                    setTimeout(() => {
                      bofang();
                    }, 2000);
                  }
                }, 3000)
              } else if (classInfo1?.includes('shipin') && play === true) { // #icon-shipin
                play = false;
                a[count1].click();
                $.alertMessage(`开始播放:${videotitle}`);
                // 延迟3秒后加速
                setTimeout(() => {
                  $.ykt_speed();
                  $.claim();
                  $.observePause();
                }, 3000);
                let timer = setInterval(() => {
                  let progress = document.querySelector('.progress-wrap').querySelector('.text');
                  if (progress.innerHTML.includes('100%') || progress.innerHTML.includes('99%') || progress.innerHTML.includes('98%') || progress.innerHTML.includes('已完成')) {
                    count1++;
                    $.userInfo.setProgress(baseUrl, count, count1);
                    clearInterval(timer);
                    $.alertMessage(`${videotitle}播放完毕`);
                    if (!!$.observer) {         // 防止oberver为undefined.
                      $.observer.disconnect();  // 视频播放完了，停止监听
                    }
                    history.back();
                    setTimeout(() => {
                      bofang();
                    }, 2000);
                  }
                }, 3000)
              } else if ((classInfo1?.includes('tuwen') || classInfo1?.includes('taolun')) && play === true) { // #icon-tuwen
                  play = false;
                  a[count1].click(); // 进入详情页

                  // 获取标题用于提示当前处理是图文或者讨论
                  const typeText = classInfo1.includes('tuwen') ? '图文' : '讨论';
                  const titleText = a[count1]?.querySelector('h2')?.innerText || '';
                  $.alertMessage(`开始处理${typeText}: ${titleText}`);

                  (async function () {
                      // 1. 初始等待，并让页面向下滚动以触发加载
                      $.alertMessage('页面加载中，正在等待评论区刷新...');
                      window.scrollTo(0, document.body.scrollHeight); // 滚到底部触发加载
                      await new Promise(r => setTimeout(r, 1000));
                      window.scrollTo(0, 0); // 滚回顶部（可选，防止找不到元素）

                      // 2. 定义评论区的选择器（修正后的）
                      const commentCandidates = [
                          '#new_discuss .new_discuss_list .cont_detail',
                          '.new_discuss_list dd .cont_detail',
                          '.cont_detail.word-break'
                      ];
                      // 3. 【关键修改】轮询检测评论，最多等待 15 秒
                      let firstCommentText = '';
                      let maxRetries = 30; // 30次 * 500ms = 15秒

                      while (maxRetries > 0) {
                          for (const sel of commentCandidates) {
                              const list = document.querySelectorAll(sel);
                              if (list && list.length > 0) {
                                  for (const it of list) {
                                      // 找到内容不为空的评论
                                      if (it && it.innerText && it.innerText.trim().length > 0) {
                                          firstCommentText = it.innerText.trim();
                                          break;
                                      }
                                  }
                              }
                              if (firstCommentText) break;
                          }

                          if (firstCommentText) {
                              break; // 找到了，跳出循环
                          } else {
                              // 没找到，等待 500ms 后重试
                              maxRetries--;
                              if (maxRetries % 4 === 0) $.alertMessage(`等待评论加载... 剩余重试 ${maxRetries} 次`); // 偶尔提示一下
                              await new Promise(r => setTimeout(r, 500));
                          }
                      }

                      // 4. 最终检查是否获取到评论
                      if (!firstCommentText) {
                          $.alertMessage(`超时未找到评论内容，跳过该条${typeText}`);
                          count1++;
                          $.userInfo.setProgress(baseUrl, count, count1);
                          history.back();
                          setTimeout(() => { bofang(); }, 1200);
                          return;
                      } else {
                          $.alertMessage(`获取成功: ${firstCommentText.substring(0, 10)}...`);
                      }

                      // 5. 查找输入框
                      const inputSelectors = [
                          '.el-textarea__inner',
                          'textarea.el-textarea__inner'
                      ];
                      let inputEl = null;
                      // 同样稍微等待一下输入框（通常评论出来输入框也就出来了，简单查即可）
                      for (const sel of inputSelectors) {
                          const tmp = document.querySelector(sel);
                          if (tmp) { inputEl = tmp; break; }
                      }

                      if (!inputEl) {
                          $.alertMessage('未找到评论输入框，跳过');
                          count1++;
                          $.userInfo.setProgress(baseUrl, count, count1);
                          history.back();
                          setTimeout(() => { bofang(); }, 1200);
                          return;
                      }

                      // 6. 填入内容并触发事件
                      try {
                          inputEl.value = firstCommentText;
                          inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                          inputEl.dispatchEvent(new Event('change', { bubbles: true }));
                          inputEl.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true })); // 模拟键盘事件激活按钮
                      } catch (e) { console.warn(e); }

                      // 等待按钮激活
                      await new Promise(r => setTimeout(r, 800));

                      // 7. 点击发送
                      const sendCandidates = [
                          '.el-button.submitComment',
                          '.publish_discuss .postBtn button',
                          '.el-button--primary'
                      ];
                      let sent = false;
                      for (const s of sendCandidates) {
                          const btn = document.querySelector(s);
                          // 检查按钮是否存在，并且没有 'is-disabled' 类，且 disabled 属性为 false
                          if (btn && !btn.disabled && !btn.classList.contains('is-disabled') && !btn.closest('.is-disabled')) {
                              btn.click();
                              sent = true;
                              break;
                          }
                      }

                      if(sent) {
                          $.alertMessage(`已在${typeText}区发表评论`);
                      } else {
                          $.alertMessage('发送按钮仍不可用或未找到');
                      }

                      // 8. 等待发送完成并返回
                      await new Promise(r => setTimeout(r, 1500));
                      count1++;
                      $.userInfo.setProgress(baseUrl, count, count1);
                      history.back();
                      setTimeout(() => { bofang(); }, 1000);

                  })();
              } else if (classInfo1?.includes('zuoye') && play === true) { // #icon-zuoye
                play = false;
                a[count1].click(); // 进入作业页面

                (async function () {
                    // 1. 等待页面基本加载
                    $.alertMessage('等待作业加载...');
                    let maxRetries = 40;
                    while (maxRetries > 0) {
                        if (document.querySelectorAll('.subject-item').length > 0) break;
                        await new Promise(r => setTimeout(r, 500));
                        maxRetries--;
                    }
                    // 2. 动态循环做题 (无限循环，直到找不到下一题)
                    let i = 0;
                    while (true) {
                        // 【核心修改】每次都重新查询所有题目
                        let items = document.querySelectorAll('.subject-item.J_order');

                        // 如果当前索引超出了题目总数，说明做完了
                        if (i >= items.length) {
                            $.alertMessage(`✅ 已到达列表末尾 (共${items.length}题)，准备交卷`);
                            break;
                        }

                        const listItem = items[i];

                        // --- A. 点击切换题目 ---
                        listItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        listItem.click();

                        // --- B. 等待渲染 (OCR需要画面完全静止且加载完毕) ---
                        await new Promise(r => setTimeout(r, 2000));
                        // 检测是否已禁用提交按钮 (已提交状态)
                        const disabledBtns = document.querySelectorAll('.el-button.el-button--info.is-disabled.is-plain');
                        if (disabledBtns.length > 0) {
                            $.alertMessage(`第 ${i + 1} 题已完成，跳过...`);
                            i++; // 索引+1，继续下一题
                            continue;
                        }
                        // --- C. OCR 与 AI ---
                        let targetEl = document.querySelector('.item-body');
                        const typeEl = document.querySelector('.item-type');
                        if (typeEl && typeEl.parentElement) targetEl = typeEl.parentElement;

                        if (targetEl) {
                            $.alertMessage(`正在处理第 ${i + 1} 题...`);
                            let ocrResult = await recognizeTextFromElement(targetEl);
                            $.alertMessage(`第 ${i+1} 题识别: ${ocrResult.substring(0, 8)}...`);
                            if (ocrResult && ocrResult.length > 5) {
                                try {
                                    $.alertMessage("🤖 正在请求AI获取答案...");
                                    const aiResponse = await fetchAnswerFromAI(ocrResult);
                                    await autoSelectAndSubmit(aiResponse, targetEl);
                                } catch (err) {
                                    $.alertMessage("AI 答题失败: " + err);
                                    console.error(err);
                                }
                            }
                        }

                        // 缓冲
                        await new Promise(r => setTimeout(r, 2000));

                        // 准备处理下一题
                        i++;
                    }

                    $.alertMessage('作业识别完毕，准备返回');
                    await new Promise(r => setTimeout(r, 2000));

                    // 返回逻辑
                    count1++;
                    $.userInfo.setProgress(baseUrl, count, count1);
                    history.back();
                    setTimeout(() => { bofang(); }, 1000);

                })();
              } else if (classInfo1 && !classInfo1.includes('shipin') && play === true) {
                $.alertMessage('不是视频');
                count1++;
                $.userInfo.setProgress(baseUrl, count, count1);
                bofang();
              }
            }
          }, 2000)
        }
      } else if (classInfo?.includes('ketang') && play === true) {    // 课堂处理
        $.alertMessage('第' + (count + 1) + '个：进入了课堂区');
        play = false;
        course.click();
        setTimeout(() => {

          async function waitForVideoEnd(video) {
            return new Promise((resolve) => {
              if (video.ended) return resolve();
              video.addEventListener("ended", () => {
                $.alertMessage("课堂视频看完了~")
                resolve()
              }, { once: true });
            });
          }

          async function waitForAudioEnd(audio) {
            return new Promise((resolve) => {
              if (audio.ended) return resolve();
              audio.addEventListener("ended", () => resolve(), { once: true });
            });
          }

          async function mainFlow() {
            //  !!! documen获取不到内嵌的iframe框架里面的dom，浪费了我好长时间来测试，特此记录
            video = document.querySelector('iframe.lesson-report-mobile').contentDocument.querySelector("video");
            audio = document.querySelector('iframe.lesson-report-mobile').contentDocument.querySelector("audio");

            if (video) {
              $.videoDetail(video);
              $.alertMessage("获取到video");
              await waitForVideoEnd(video);
            }
            if (audio) {
              $.alertMessage("获取到audio");
              $.audioDetail(audio);
              await waitForAudioEnd(audio);
            }
            console.log("没有视频或音频了");
            count++;
            $.userInfo.setProgress(baseUrl, count);
            play = true;
            history.go(-1);
            main();

          }
          mainFlow();
        }, 5000)
      } else if (classInfo?.includes('kejian') && play === true) {  // 课件处理
        const tableDate = course.parentNode.parentNode.parentNode.__vue__.tableData;
        console.log(tableDate.deadline, tableDate.end);
        if ((tableDate.deadline || tableDate.end) ? (tableDate.deadline < Date.now() || tableDate.end < Date.now()) : false) {  // 没有该属性默认没有结课
          $.alertMessage('第' + (count + 1) + '个：' + course.childNodes[0].childNodes[2].childNodes[0].innerText + '课件结课了，已跳过');
          count++;
          $.userInfo.setProgress(baseUrl, count);
          main();
        } else {
          // $.alertMessage('根据ycj用户的反馈修改新增课件处理，且赞助支持，表示感谢') // 8.8元
          $.alertMessage('第' + (count + 1) + '个：进入了课件区');
          play = false;
          console.log();
          course.click();
          let classType;
          (async function () {
            await new Promise(function (resolve) {
              setTimeout(function () {
                classType = document.querySelector('.el-card__header').innerText;
                console.log(classType);
                document.querySelector('.check').click();
                resolve();
              }, 3000)
            })  // 3秒后执行点击事件
            let className = document.querySelector('.dialog-header').firstElementChild.innerText;
            console.log(className);
            if (classType == '课件PPT') {  // 课件为ppt
              let allPPT = document.querySelector('.swiper-wrapper').children;
              let pptTime = basicConf.pptTime || 3000;
              $.alertMessage(`开始播放${className}`)
              for (let i = 0; i < allPPT.length; i++) {
                await new Promise(function (resolve) {
                  setTimeout(function () {
                    allPPT[i].click();
                    $.alertMessage(`${className}：第${i + 1}个ppt已经播放`);
                    resolve();
                  }, pptTime)
                })
              }
              await new Promise(function (resolve) {  // 稍微等待
                setTimeout(function () {
                  resolve();
                }, pptTime) // 最后一张ppt等待时间
              })
              if (document.querySelector('.video-box')) {  // 回头检测如果ppt里面有视频
                let pptVideo = document.querySelectorAll('.video-box');
                $.alertMessage('检测到ppt里面有视频，将继续播放视频');
                for (let i = 0; i < pptVideo.length; i++) {
                  if (document.querySelectorAll('.video-box')[i].innerText != '已完成') {   // 判断视频是否已播放
                    pptVideo[i].click();
                    $.alertMessage(`开始播放：${className}里面的第${i + 1}个视频`)
                    await new Promise(function (resolve) {
                      setTimeout(function () {
                        $.ykt_speed();  // 加速
                        document.querySelector('.xt_video_player_common_icon').click();  // 静音
                        $.observePause(); // 防止切屏自动暂停
                        resolve();
                      }, 3000)
                    })
                    await new Promise(function (resolve) {
                      let timer = setInterval(function () {
                        let allTime = document.querySelector('.xt_video_player_current_time_display').innerText;
                        nowTime = allTime.split(' / ')[0];
                        totalTime = allTime.split(' / ')[1]
                        console.log(nowTime + totalTime);
                        if (nowTime == totalTime) {
                          clearInterval(timer);
                          if (!!$.observer) {  // 防止新的视频已经播放完了，还未来得及赋值observer的问题
                            $.observer.disconnect();  // 停止监听
                          }
                          resolve();
                        }
                      }, 200);
                    })  // 等待视频结束
                  } else {  // 视频已完成
                    $.alertMessage(`检测到${className}里面的第${i + 1}个视频已经播放完毕`);
                  }
                }
              }
              $.alertMessage(`${className} 已经播放完毕`)
            } else {  // 课件为视频
              document.querySelector('.video-box').click();
              $.alertMessage(`开始播放视频：${className}`);
              await new Promise(function (resolve) {
                setTimeout(function () {
                  $.ykt_speed();
                  document.querySelector('.xt_video_player_common_icon').click();
                  resolve();
                }, 3000)
              })  // 3秒后加速,静音
              await new Promise(function (resolve) {
                let timer = setInterval(function () {
                  let allTime = document.querySelector('.xt_video_player_current_time_display').innerText;
                  let nowTime = allTime.split(' / ')[0];
                  let totalTime = allTime.split(' / ')[1]
                  console.log(nowTime + totalTime);
                  if (nowTime == totalTime) {
                    clearInterval(timer);
                    resolve();
                  }
                }, 200);
              })  // 等待视频结束
              $.alertMessage(`${className} 视频播放完毕`)
            }
            count++;
            $.userInfo.setProgress(baseUrl, count);
            play = true;
            history.back();
            main();
          })()
        }
      } else if (!(classInfo.includes('shipin') || classInfo.includes('piliang') || classInfo.includes('kejian')) && play === true) { // 视频，批量，课件都不是的时候跳过，此处可以优化
        $.alertMessage('第' + (count + 1) + '个：不是视频，已跳过');
        count++;
        $.userInfo.setProgress(baseUrl, count);
        main();
      }
    })
  }
  // 根据视频集数，自动下拉刷新集数
  async function autoSlide(count) {
    let frequency = parseInt((count + 1) / 20) + 1;
    for (let i = 0; i < frequency; i++) {
      await new Promise((resolve, reject) => {
        setTimeout(() => {
          document.querySelector('.viewContainer').scrollTop = document.querySelector('.el-tab-pane').scrollHeight;
          resolve();
        }, 1000)
      })
    }
  }
  main();
}

// yuketang.cn/pro/lms旧页面的跳转逻辑
function yuketang_pro_lms() {
  localStorage.setItem('n_type', true);
  $.alertMessage('正准备打开新标签页...');
  localStorage.getItem('pro_lms_classCount') ? null : localStorage.setItem('pro_lms_classCount', 1);  // 初始化集数
  let classCount = localStorage.getItem('pro_lms_classCount') - 1;
  let leafDetail = document.querySelectorAll('.leaf-detail');     // 课程列表
  while (!leafDetail[classCount].firstChild.querySelector('i').className.includes('shipin')) {
    classCount++;
    localStorage.setItem('pro_lms_classCount', classCount);
    $.alertMessage('课程不属于视频，已跳过^_^');
  };
  document.querySelectorAll('.leaf-detail')[classCount].click();  // 进入第一个【视频】课程，启动脚本
}

// yuketang.cn/pro/lms新页面的刷课逻辑
function yuketang_pro_lms_new() {
  $.preventScreenCheck();
  function nextCount(classCount) {
    event1 = new Event('mousemove', { bubbles: true });
    event1.clientX = 9999;
    event1.clientY = 9999;
    if (document.querySelector('.btn-next')) {
      localStorage.setItem('pro_lms_classCount', classCount);
      document.querySelector('.btn-next').dispatchEvent(event1);
      document.querySelector('.btn-next').dispatchEvent(new Event('click'));
      localStorage.setItem('n_type', true);
      main();
    } else {
      localStorage.removeItem('pro_lms_classCount');
      $.alertMessage('课程播放完毕了');
    }
  }
  $.alertMessage('已就绪，开始刷课，请尽量保持页面不动。');
  let classCount = localStorage.getItem('pro_lms_classCount');
  async function main() {
    $.alertMessage(`准备播放第${classCount}集...`);
    await new Promise(function (resolve) {
      setTimeout(function () {
        let className = document.querySelector('.header-bar').firstElementChild.innerText;
        let classType = document.querySelector('.header-bar').firstElementChild.firstElementChild.getAttribute('class');
        let classStatus = document.querySelector('#app > div.app_index-wrapper > div.wrap > div.viewContainer.heightAbsolutely > div > div > div > div > section.title')?.lastElementChild?.innerText;
        if (classType.includes('tuwen') && classStatus != '已读') {
          $.alertMessage(`正在废寝忘食地看:${className}中...`);
          setTimeout(() => {
            resolve();
          }, 2000)
        } else if (classType.includes('taolun')) {
          $.alertMessage(`只是看看，目前没有自动发表讨论功能，欢迎反馈...`);
          setTimeout(() => {
            resolve();
          }, 2000)
        } else if (classType.includes('shipin') && !classStatus.includes('100%')) {
          $.alertMessage(`7s后开始播放：${className}`);
          setTimeout(() => {
            // 监测视频播放状态
            let timer = setInterval(() => {
              let classStatus = document.querySelector('#app > div.app_index-wrapper > div.wrap > div.viewContainer.heightAbsolutely > div > div > div > div > section.title')?.lastElementChild?.innerText;
              if (classStatus.includes('100%') || classStatus.includes('99%') || classStatus.includes('98%') || classStatus.includes('已完成')) {
                $.alertMessage(`${className}播放完毕...`);
                clearInterval(timer);
                if (!!$.observer) {  // 防止新的视频已经播放完了，还未来得及赋值observer的问题
                  $.observer.disconnect();  // 停止监听
                }
                resolve();
              }
            }, 200)
            // 根据video是否加载出来判断加速时机
            let nowTime = Date.now();
            let videoTimer = setInterval(() => {
              let video = document.querySelector('video');
              if (video) {
                setTimeout(() => {  // 防止视频刚加载出来，就加速，出现无法获取到元素地bug
                  $.ykt_speed();
                  $.claim();
                  $.observePause();
                  clearInterval(videoTimer);
                }, 2000)
              } else if (!video && Date.now() - nowTime > 20000) {  // 如果20s内仍未加载出video
                localStorage.setItem('n_type', true);
                location.reload();
              }
            }, 5000)
          }, 2000)
        } else if (classType.includes('zuoye')) {
          $.alertMessage(`进入：${className}，目前没有自动作答功能，敬请期待...`);
          setTimeout(() => {
            resolve();
          }, 2000)
        } else if (classType.includes('kaoshi')) {
          $.alertMessage(`进入：${className}，目前没有自动考试功能，敬请期待...`);
          setTimeout(() => {
            resolve();
          }, 2000)
        } else if (classType.includes('ketang')) {
          $.alertMessage(`进入：${className}，目前没有课堂作答功能，敬请期待...`);
          setTimeout(() => {
            resolve();
          }, 2000)
        } else {
          $.alertMessage(`您已经看过${className}...`);
          setTimeout(() => {
            resolve();
          }, 2000)
        }
      }, 2000);
    })
    $.alertMessage(`第${classCount}集播放完了...`);
    classCount++;
    nextCount(classCount);
  }
  main();
};

// 油猴执行文件
(function () {
  'use strict';
  // 防止在 iframe 内重复执行（Firefox 专用）
  if (window.top !== window.self) return;

  const listenDom = setInterval(() => {
    if (document.body) {
      addUserOperate();
      if (localStorage.getItem('n_type') === 'true') {
        $.panel.querySelector('#n_button').innerText = '刷课中~';
        localStorage.setItem('n_type', false);
        yuketang_pro_lms_new();
      }
      clearInterval(listenDom);
    }
  }, 100)
})();