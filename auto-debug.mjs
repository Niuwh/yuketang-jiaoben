#!/usr/bin/env node
/**
 * 雨课堂刷课脚本 - 自动部署 + PPT Debug
 *
 * 用法：
 *   node auto-debug.mjs "https://www.yuketang.cn/v2/web/studentCards/.../ppt?..."
 *
 * 流程：
 *   1. 启动真实 Chrome（headed）
 *   2. 自动注入本地 yuketang.js（无需安装油猴）
 *   3. 打开目标页面
 *   4. 等待你在浏览器里登录完成，按终端回车继续
 *   5. 自动点击[开始刷课]，监听面板日志
 *   6. 当检测到 PPT/课件处理时，抓取 DOM + 截图
 *   7. 如果翻页卡住（日志长时间不变），自动输出诊断报告
 */

import { chromium } from '/opt/homebrew/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, 'debug-output');
const userDataDir = path.join(outDir, 'chrome-user-data');
fs.mkdirSync(outDir, { recursive: true });

const args = process.argv.slice(2);
const urlArg = args.find(a => !a.startsWith('--'));
const loginWaitArg = args.find(a => a.startsWith('--login-wait='));
const loginWaitSeconds = loginWaitArg ? parseInt(loginWaitArg.split('=')[1], 10) : 90;

const url = urlArg;
if (!url) {
  console.error('请提供目标 URL，例如：');
  console.error('  node auto-debug.mjs "https://www.yuketang.cn/v2/web/studentCards/xxx/ppt?..."');
  console.error('可选参数：');
  console.error('  --login-wait=90   登录等待秒数（默认 90，首次登录需要）');
  process.exit(1);
}

const scriptPath = path.join(__dirname, 'yuketang.js');
if (!fs.existsSync(scriptPath)) {
  console.error('找不到 yuketang.js，请确保它和本脚本在同一目录');
  process.exit(1);
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

function waitForLogin(seconds) {
  return new Promise(resolve => {
    let remaining = seconds;
    const timer = setInterval(() => {
      remaining--;
      if (remaining > 0) {
        process.stdout.write(`\r请登录... ${remaining} 秒后自动继续，或按回车立即继续 `);
      } else {
        clearInterval(timer);
        process.stdout.write('\n');
        resolve();
      }
    }, 1000);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', () => {
      clearInterval(timer);
      rl.close();
      process.stdout.write('\n');
      resolve();
    });
  });
}

function nowStr() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function stripUserscriptHeader(src) {
  // 去除 ==UserScript== 头
  return src.replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/, '').trim();
}

function buildInjectableScript(src) {
  const body = stripUserscriptHeader(src);
  return `
    // == 油猴环境 shim ==
    if (typeof unsafeWindow === 'undefined') {
      window.unsafeWindow = window;
    }
    if (typeof GM_xmlhttpRequest === 'undefined') {
      window.GM_xmlhttpRequest = function(details) {
        fetch(details.url, {
          method: details.method || 'GET',
          headers: details.headers || {},
          body: details.data
        }).then(async res => {
          const text = await res.text();
          if (details.onload) details.onload({ status: res.status, responseText: text });
        }).catch(err => {
          if (details.onerror) details.onerror(err);
        });
      };
    }
    // == 用户脚本正文 ==
    ${body}
  `;
}

async function capturePPTDOM(page, label) {
  const data = await page.evaluate(() => {
    const r = {
      url: location.href,
      title: document.title,
      bodyTextSample: document.body?.innerText?.slice(0, 1200) || ''
    };
    const selectors = {
      slides: [
        '.swiper-wrapper > .swiper-slide',
        '.swiper-wrapper > *',
        '.ppt-slide',
        '.slide-page',
        '.ppt-container .slide',
        '.ppt-content .page',
        '[class*="ppt-slide"]',
        '[class*="slide-page"]',
        '.ppt-viewer .page'
      ],
      next: [
        '.swiper-button-next',
        '.ppt-next',
        '.next-page',
        '[class*="next"][class*="page"]',
        '[class*="arrow-right"]',
        '.btn-next-slide'
      ],
      indicator: [
        '.swiper-pagination-bullet-active',
        '.page-indicator',
        '.ppt-page-number',
        '[class*="pagination"][class*="active"]'
      ]
    };

    r.slides = [];
    for (const sel of selectors.slides) {
      const els = [...document.querySelectorAll(sel)].filter(el => el.offsetParent !== null);
      if (els.length) {
        r.slides.push({ selector: sel, count: els.length, sample: els[0].outerHTML.slice(0, 500) });
      }
    }

    r.next = [];
    for (const sel of selectors.next) {
      const el = document.querySelector(sel);
      if (el) r.next.push({ selector: sel, visible: el.offsetParent !== null, html: el.outerHTML.slice(0, 300) });
    }

    r.indicator = [];
    for (const sel of selectors.indicator) {
      const el = document.querySelector(sel);
      if (el) r.indicator.push({ selector: sel, text: el.innerText?.trim(), html: el.outerHTML.slice(0, 300) });
    }

    r.containers = [];
    for (const sel of ['.swiper-wrapper', '.ppt-container', '.ppt-viewer', '.ppt-content']) {
      const el = document.querySelector(sel);
      if (el) r.containers.push({ selector: sel, childCount: el.children.length, html: el.outerHTML.slice(0, 600) });
    }

    return r;
  });

  const jsonPath = path.join(outDir, `ppt-dom-${label}-${nowStr()}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf-8');

  const screenshotPath = path.join(outDir, `ppt-screenshot-${label}-${nowStr()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });

  console.log(`  → DOM: ${jsonPath}`);
  console.log(`  → 截图: ${screenshotPath}`);
  return data;
}

async function readPanelLogs(page) {
  try {
    const frame = page.frameLocator('#ykt-helper-iframe');
    const logs = await frame.locator('#info li').allInnerTexts();
    return logs;
  } catch (e) {
    return [];
  }
}

async function clickStart(page) {
  const frame = page.frameLocator('#ykt-helper-iframe');
  const btn = frame.locator('#btn-start');
  await btn.waitFor({ state: 'visible', timeout: 10000 });
  try {
    await btn.click({ timeout: 5000 });
  } catch (e) {
    // 可能被设置面板遮挡，改用 JS 点击
    console.log('[auto-debug] 普通点击失败，改用 JS 点击开始按钮');
    await frame.evaluate(() => {
      const btn = document.getElementById('btn-start');
      if (btn) {
        btn.click();
        // 关闭设置面板
        const settings = document.getElementById('settings');
        if (settings) settings.style.display = 'none';
      }
    });
  }
  console.log('[auto-debug] 已点击[开始刷课]');
}

function logsEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

async function waitForPPTOrStuck(page, options = {}) {
  const { stuckTimeout = 30000, totalTimeout = 1800000 } = options;
  const start = Date.now();
  let lastLogs = [];
  let lastChangeTime = Date.now();
  let capturedPPT = false;
  let capturedHomework = false;

  console.log('[auto-debug] 正在监听刷课进度...');

  while (Date.now() - start < totalTimeout) {
    await page.waitForTimeout(2000);
    const logs = await readPanelLogs(page);

    // 打印最新一条日志
    if (logs.length > 0) {
      const latest = logs[logs.length - 1];
      if (latest !== lastLogs[lastLogs.length - 1]) {
        console.log(`[面板] ${latest}`);
      }
    }

    if (!logsEqual(logs, lastLogs)) {
      lastLogs = logs;
      lastChangeTime = Date.now();
    }

    // 检测到 PPT/课件处理，立刻抓取 DOM
    const latestLog = logs[logs.length - 1] || '';
    if (!capturedPPT && /PPT|课件|kejian|幻灯片/.test(latestLog)) {
      console.log('[auto-debug] 检测到 PPT/课件处理，抓取 DOM...');
      await capturePPTDOM(page, 'ppt-detected');
      capturedPPT = true;
    }

    // 检测到作业/答题处理，抓取 DOM
    if (!capturedHomework && /进入作业|OCR|AI 获取答案|未找到选项|未找到填空输入框|AI 建议/.test(latestLog)) {
      console.log('[auto-debug] 检测到作业/答题处理，抓取 DOM...');
      await capturePPTDOM(page, 'homework-detected');
      capturedHomework = true;
    }

    // 判断是否卡住
    if (Date.now() - lastChangeTime > stuckTimeout) {
      console.log(`[auto-debug] 日志 ${stuckTimeout}ms 未更新，疑似卡住`);
      return { reason: 'stuck', logs, capturedPPT };
    }

    // 检测到刷完
    if (/课程刷完|播放完毕|已播放完毕/.test(logs.slice(-3).join(' '))) {
      return { reason: 'finished', logs, capturedPPT };
    }
  }

  return { reason: 'timeout', logs: lastLogs, capturedPPT };
}

(async () => {
  console.log('=== 雨课堂脚本自动部署 + PPT Debug ===\n');

  const rawScript = fs.readFileSync(scriptPath, 'utf-8');
  const injectScript = buildInjectableScript(rawScript);
  const injectPath = path.join(outDir, 'injected-yuketang.js');
  fs.writeFileSync(injectPath, injectScript, 'utf-8');
  console.log(`已生成注入版脚本: ${injectPath}`);

  console.log(`启动 Chrome，用户数据目录: ${userDataDir}`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1440, height: 900 }
  });

  const page = context.pages()[0] || await context.newPage();

  // 捕获页面报错，便于诊断脚本注入/运行问题
  page.on('console', msg => {
    const text = msg.text();
    if (msg.type() === 'error') {
      console.log(`[PAGE ERROR] ${text}`);
    }
  });
  page.on('pageerror', err => console.log(`[PAGE EXCEPTION] ${err.message}`));

  // 在 document-start 注入脚本
  await page.addInitScript({ content: injectScript });
  console.log(`导航到: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 清除脚本刷课进度缓存，但保留浏览器登录态
  await page.evaluate(() => {
    const keys = [
      '[雨课堂脚本]刷课进度信息',
      'ykt_pending_auto_start',
      'ykt_pro_class_count'
    ];
    keys.forEach(k => {
      try { localStorage.removeItem(k); } catch (e) { }
    });
    console.log('[auto-debug] 已清除脚本刷课进度缓存');
  });

  // 等待页面稳定
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => { });

  console.log('\n请在弹出的 Chrome 窗口中完成登录。');
  console.log(`脚本将等待 ${loginWaitSeconds} 秒；登录完成后按回车可立即继续。`);
  console.log('Cookie 会保存在 debug-output/chrome-user-data，后续运行无需再次登录。');
  await waitForLogin(loginWaitSeconds);

  // 等待面板 iframe 出现
  console.log('[auto-debug] 等待助手面板加载...');
  await page.locator('#ykt-helper-iframe').waitFor({ state: 'attached', timeout: 15000 });
  console.log('[auto-debug] 面板已加载');

  // 点击开始
  await clickStart(page);

  // 监听直到卡住或完成
  const result = await waitForPPTOrStuck(page, { stuckTimeout: 30000, totalTimeout: 300000 });

  console.log(`\n[auto-debug] 监听结束，原因: ${result.reason}`);
  console.log('最近日志:');
  result.logs.slice(-20).forEach(l => console.log('  - ' + l));

  // 最终抓取
  console.log('\n[auto-debug] 最终状态抓取...');
  await capturePPTDOM(page, `final-${result.reason}`);

  // 保存日志
  const logPath = path.join(outDir, `panel-logs-${result.reason}-${nowStr()}.json`);
  fs.writeFileSync(logPath, JSON.stringify(result.logs, null, 2), 'utf-8');
  console.log(`日志已保存: ${logPath}`);

  console.log(`\n所有调试输出目录: ${outDir}`);
  console.log('请把最新的 json 和 png 文件发给我，我继续修复脚本。');

  const closeAns = await ask('\n按回车关闭浏览器（或输入 keep 保持打开）: ');
  if (closeAns.trim().toLowerCase() !== 'keep') {
    await context.close();
  }
})().catch(err => {
  console.error('自动调试脚本出错:', err);
  process.exit(1);
});
