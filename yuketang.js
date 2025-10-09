// ==UserScript==
// @name         雨课堂刷课助手
// @namespace    http://tampermonkey.net/
// @version      2.4.15
// @description  针对雨课堂视频进行自动播放
// @author       风之子
// @license      GPL3
// @match        *://*.yuketang.cn/*
// @match        *://*.gdufemooc.cn/*
// @run-at       document-start
// @icon         http://yuketang.cn/favicon.ico
// @grant        unsafeWindow
// ==/UserScript==
// 雨课堂刷课脚本
/*
  已适配雨课堂学校及网址：
  学校：中原工学院，河南大学研究院，辽宁大学，河北大学，中南大学，电子科技大学，华北电力大学，上海理工大学研究生院及其他院校...
  网址：changjiang.yuketang.cn，yuketang.cn ...
*/

const basicConf = {
  version: '2.4.15',
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

function addWindow() {  // 1.添加交互窗口
  const css = `
  ul,
  li,
  p {
    margin: 0;
    padding: 0;
  }
  .mini-basic{
    position: fixed;
    top: 0;
    left: 0;
    background:#f5f5f5;
    border:1px solid #000;
    height:50px;
    width:50px;
    border-radius:6px;
    text-align:center;
    line-height:50px;
  }
  .miniwin{
    z-index:-9999;
  }

  .n_panel {
    margin: 0;
    padding: 0;
    position: fixed;
    top: 0;
    left: 0;
    width: 500px;
    height: 250px;
    background-color: #fff;
    z-index: 99999;
    box-shadow: 6px 4px 17px 2px #000000;
    border-radius: 10px;
    border: 1px solid #a3a3a3;
    font-family: Avenir, Helvetica, Arial, sans-serif;
    color: #636363;
  }
  
  .hide{
    display:none;
  }

  .n_header {
    text-align: center;
    height: 40px;
    background-color: #f7f7f7;
    color: #000;
    font-size: 18px;
    line-height: 40px;
    cursor: move;
    border-radius: 10px 10px 0 0;
    border-bottom: 2px solid #eee;
  }

  .n_header .tools{
    position:absolute;
    right:0;
    top:0;
  }

  .n_header .tools ul li{
    position:relative;
    display:inline-block;
    padding:0 5px;
    cursor:pointer;
  }

  .n_header .minimality::after{
    content:'最小化';
    display:none;
    position:absolute;
    left:0;
    bottom:-30px;
    height:32px;
    width:50px;
    font-size:12px;
    background:#ffffe1;
    color:#000;
    border-radius:3px;
  }

  .n_header .minimality:hover::after{
    display:block;
  }
  
  .n_header .question::after{
    content:'有问题';
    display:none;
    position:absolute;
    left:0;
    bottom:-30px;
    height:32px;
    width:50px;
    font-size:12px;
    background:#ffffe1;
    color:#000;
    border-radius:3px;
  }

  .n_header .question:hover::after{
    display:block;
  }

  .n_body {
    font-weight: bold;
    font-size: 13px;
    line-height: 26px;
    height: 183px;
  }

  .n_body .n_infoAlert {
    overflow-y: scroll;
    height: 100%;
  }

  /* 滚动条整体 */
  .n_body .n_infoAlert::-webkit-scrollbar {
    height: 20px;
    width: 7px;
  }

  /* 滚动条轨道 */
  .n_body .n_infoAlert::-webkit-scrollbar-track {
    --webkit-box-shadow: inset 0 0 5px rgba(0, 0, 0, 0.2);
    border-radius: 10px;
    background: #ffffff;
  }

  /* 滚动条滑块 */
  .n_body .n_infoAlert::-webkit-scrollbar-thumb {
    border-radius: 10px;
    --webkit-box-shadow: inset 0 0 5px rgba(0, 0, 0, 0.2);
    background: rgb(20, 19, 19, 0.6);
  }

  .n_footer {
    position: absolute;
    bottom: 0;
    left: 0;
    text-align: right;
    height: 25px;
    width: 100%;
    background-color: #f7f7f7;
    color: #c5c5c5;
    font-size: 13px;
    line-height: 25px;
    border-radius: 0 0 10px 10px;
    border-bottom: 2px solid #eee;
    display: flex;
    justify-content: space-between;
  }

  .n_footer #n_button {
    border-radius: 6px;
    border: 0;
    background-color: blue;
    color: #fff;
    cursor: pointer;
  }

  .n_footer #n_button:hover {
    background-color: yellow;
    color: #000;
  }

  .n_footer #n_clear{
    border-radius: 6px;
    border: 0;
    cursor: pointer;
  }

  .n_footer #n_clear::after{
    content:'用于清除课程进度缓存';
    display:none;
    position:absolute;
    left:250px;
    bottom:-30px;
    height:32px;
    width:100px;
    font-size:12px;
    background:#ffffe1;
    color:#000;
    border-radius:3px;
  }

  .n_footer #n_clear:hover::after{
    display:block;
  }

  .n_footer #n_zanshang {
    cursor: pointer;
    position: relative;
    color: red;
  }

  .n_footer #n_zanshang img {
    position: absolute;
    top: 30px;
    left: -130px;
    display: none;
    width: 300px;
  }

  .n_footer #n_zanshang:hover img {
    display: block;
  }
  `;
  const html = `
  <div>
  <style>${css}</style>
  <div class="mini-basic miniwin">
      放大
  </div>
  <div class="n_panel">
  <div class="n_header">
    雨课堂刷课助手
    <div class='tools'>
      <ul>
        <li class='minimality'>_</li>
        <li class='question'>?</li>
      </ul>
    </div>
  </div>
  <div class="n_body">
    <ul class="n_infoAlert">
      <li>⭐ 脚本支持：雨课堂所有版本，支持多倍速，自动播放</li>
      <li>📢 使用方法：点击进入要刷的课程目录，点击开始刷课按钮即可自动运行</li>
      <li>⚠️ 运行后请不要随意点击刷课窗口，可新开窗口，可最小化浏览器</li>
      <li>💡 拖动上方标题栏可以进行拖拽哦!</li>
      <hr>
    </ul>
  </div>
  <div class="n_footer">
    <p>雨课堂助手 ${basicConf.version} </p>
    <button id="n_clear">清除进度缓存</button>
    <button id="n_button">开始刷课</button>
  </div>
  </div>
  </div>
  `;
  // 插入div隐藏dom元素
  const div = document.createElement('div');
  document.body.append(div);
  const shadowroot = div.attachShadow({ mode: 'closed' });
  shadowroot.innerHTML = html;
  console.log("已插入使用面板");
  $.panel = shadowroot.lastElementChild.lastElementChild; // 保存panel节点
  return $.panel;  // 返回panel根容器
}

function addUserOperate() { // 2.添加交互操作
  const panel = addWindow();
  const header = panel.querySelector(".n_header");
  const button = panel.querySelector("#n_button");
  const clear = panel.querySelector("#n_clear");
  const minimality = panel.querySelector(".minimality");
  const question = panel.querySelector(".question");
  const infoAlert = panel.querySelector(".n_infoAlert");
  const miniWindow = panel.previousElementSibling;
  let mouseMoveHander;
  const mouseDownHandler = function (e) {   // 鼠标在header按下处理逻辑
    e.preventDefault();
    // console.log("鼠标按下/////header");
    let innerLeft = e.offsetX,
      innerTop = e.offsetY;
    mouseMoveHander = function (e) {
      // console.log("鼠标移动////body");
      let left = e.clientX - innerLeft,
        top = e.clientY - innerTop;
      //获取body的页面可视宽高
      var clientHeight = document.documentElement.clientHeight || document.body.clientHeight;
      var clientWidth = document.documentElement.clientWidth || document.body.clientWidth;
      // 通过判断是否溢出屏幕
      if (left <= 0) {
        left = 0;
      } else if (left >= clientWidth - panel.offsetWidth) {
        left = clientWidth - panel.offsetWidth
      }
      if (top <= 0) {
        top = 0
      } else if (top >= clientHeight - panel.offsetHeight) {
        top = clientHeight - panel.offsetHeight
      }
      panel.setAttribute("style", `left:${left}px;top:${top}px`);
    }
    document.body.addEventListener("mousemove", mouseMoveHander);
  }
  header.addEventListener('mousedown', mouseDownHandler);
  header.addEventListener('mouseup', function () {
    // console.log("鼠标松起/////header");
    document.body.removeEventListener("mousemove", mouseMoveHander);
  })
  document.body.addEventListener("mouseleave", function () {
    // console.log("鼠标移出了body页面");
    document.body.removeEventListener("mousemove", mouseMoveHander);
  })
  // 刷课按钮
  button.onclick = function () {
    start();
    button.innerText = '刷课中~';
  }
  // 清除数据按钮
  clear.onclick = function () {
    $.userInfo.removeProgress(location.href);
    localStorage.removeItem('pro_lms_classCount');
  }
  // 最小化按钮
  function minimalityHander(e) {
    if (miniWindow.className.includes("miniwin")) {
      console.log("点击了缩小");
      let leftPx = e.clientX - e.offsetX + 'px', topPx = e.clientY - e.offsetY + 'px';
      panel.setAttribute("style", `z-index:-9999;`);
      miniWindow.setAttribute("style", `z-index:9999;top:${topPx};left:${leftPx}`);
    } else {
      let leftPx = e.clientX - 450 + 'px', topPx = e.clientY - e.offsetY + 'px';
      console.log("点击了放大");
      panel.setAttribute("style", `z-index:9999;top:${topPx};left:${leftPx}`);
      miniWindow.setAttribute("style", `z-index:-9999;`);
    }
    miniWindow.classList.toggle("miniwin");
  }
  minimality.addEventListener("click", minimalityHander);
  miniWindow.addEventListener("click", minimalityHander);
  // 有问题按钮
  question.onclick = function () {
    alert('作者网站：niuwh.cn' + '      ' + '作者博客：blog.niuwh.cn');
  };
  // 鼠标移入窗口，暂停自动滚动
  (function () {
    let scrollTimer;
    scrollTimer = setInterval(function () {
      infoAlert.lastElementChild.scrollIntoView({ behavior: "smooth", block: "end", inline: "nearest" });
    }, 500)
    infoAlert.addEventListener('mouseenter', () => {
      clearInterval(scrollTimer);
      // console.log('鼠标进入了打印区');
    })
    infoAlert.addEventListener('mouseleave', () => {
      scrollTimer = setInterval(function () {
        infoAlert.lastElementChild.scrollIntoView({ behavior: "smooth", block: "end", inline: "nearest" });
      }, 500)
      // console.log('鼠标离开了打印区');
    })
  })();
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
              } else if (classInfo1?.includes('shipin') && play === true) {
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
  // window.addEventListener('load', (event) => {    // 用于检测页面是否已经完全正常加载出来
  //   console.log(('页面成功加载出来了'));
  // })
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