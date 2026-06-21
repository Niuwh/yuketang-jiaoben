#!/usr/bin/env node
/**
 * 作业/填空题专项调试脚本
 * 用法：
 *   node debug-homework.mjs "https://www.yuketang.cn/v2/web/studentLog/..."
 *
 * 流程：
 *   1. 启动 Chrome 并注入 yuketang.js
 *   2. 打开课程列表
 *   3. 等待登录
 *   4. 枚举列表项的类型和标题
 *   5. 如果找到作业（zuoye）/考试（kaoshi）/练习（lianxi）项，点击并抓取题目 DOM
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

const url = process.argv[2];
if (!url) {
  console.error('请提供课程列表 URL');
  process.exit(1);
}

const scriptPath = path.join(__dirname, 'yuketang.js');
if (!fs.existsSync(scriptPath)) {
  console.error('找不到 yuketang.js');
  process.exit(1);
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(q, a => { rl.close(); resolve(a); }));
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
  return src.replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/, '').trim();
}

function buildInjectableScript(src) {
  const body = stripUserscriptHeader(src);
  return `
    if (typeof unsafeWindow === 'undefined') window.unsafeWindow = window;
    if (typeof GM_xmlhttpRequest === 'undefined') {
      window.GM_xmlhttpRequest = function(details) {
        fetch(details.url, { method: details.method || 'GET', headers: details.headers || {}, body: details.data })
          .then(async r => { if (details.onload) details.onload({ status: r.status, responseText: await r.text() }); })
          .catch(e => { if (details.onerror) details.onerror(e); });
      };
    }
    ${body}
  `;
}

async function dumpPageInfo(page, label) {
  const info = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    bodyText: document.body?.innerText?.slice(0, 2000) || ''
  }));
  const file = path.join(outDir, `homework-${label}-${nowStr()}.json`);
  fs.writeFileSync(file, JSON.stringify(info, null, 2), 'utf-8');
  const screenshot = path.join(outDir, `homework-${label}-${nowStr()}.png`);
  await page.screenshot({ path: screenshot, fullPage: false });
  console.log(`  → ${label}: ${file}`);
  console.log(`  → 截图: ${screenshot}`);
  return info;
}

async function findAndClickHomework(page) {
  return await page.evaluate(() => {
    const list = document.querySelector('.logs-list');
    if (!list) return { error: '未找到 .logs-list' };
    const items = [...list.querySelectorAll('a, [class*="item"], [class*="log"], [class*="row"]')].filter(el => el.offsetParent !== null);
    const result = [];
    let clicked = false;
    for (const el of items) {
      const href = el.href || el.closest('a')?.href || '';
      const text = el.innerText?.trim().slice(0, 80) || '';
      const typeMatch = href.match(/(kejian|shipin|yinpin|zuoye|kaoshi|lianxi|taolun|tuwen)/);
      const type = typeMatch ? typeMatch[1] : 'unknown';
      if (text || href) {
        result.push({ type, text, href });
      }
      if (!clicked && /zuoye|kaoshi|lianxi/.test(href)) {
        el.click();
        clicked = true;
      }
    }
    return { items: result, clicked };
  });
}

(async () => {
  const rawScript = fs.readFileSync(scriptPath, 'utf-8');
  const injectScript = buildInjectableScript(rawScript);

  console.log('启动 Chrome...');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1440, height: 900 }
  });
  const page = context.pages()[0] || await context.newPage();
  page.on('console', msg => { if (msg.type() === 'error') console.log(`[PAGE ERROR] ${msg.text()}`); });
  page.on('pageerror', err => console.log(`[PAGE EXCEPTION] ${err.message}`));
  await page.addInitScript({ content: injectScript });

  console.log(`打开: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => { });

  console.log('请在浏览器中完成登录，60 秒后自动继续...');
  await waitForLogin(60);

  console.log('等待课程列表加载...');
  await page.locator('.logs-list').waitFor({ state: 'attached', timeout: 15000 }).catch(() => {
    console.log('未找到 .logs-list，将抓取当前页面信息');
  });

  console.log('枚举课程列表项...');
  const listInfo = await findAndClickHomework(page);
  const listFile = path.join(outDir, `homework-list-${nowStr()}.json`);
  fs.writeFileSync(listFile, JSON.stringify(listInfo, null, 2), 'utf-8');
  console.log(`列表信息已保存: ${listFile}`);
  console.log(JSON.stringify((listInfo.items || []).slice(0, 30), null, 2));

  if (!listInfo || listInfo.error || !listInfo.clicked) {
    console.log('未找到作业/考试/练习项，结束调试');
    await context.close();
    return;
  } else {
    console.log('已点击作业/考试/练习项，等待页面加载...');
    await page.waitForTimeout(3000);
  }

  await dumpPageInfo(page, 'homework-entered');

  // 尝试找到题目容器
  console.log('查找题目容器...');
  const questionInfo = await page.evaluate(() => {
    const containers = [
      '.container-problem',
      '#app .container-body .container-problem',
      '.container-body',
      '#app .container-body',
      '.exam-container',
      '.homework-container'
    ];
    for (const sel of containers) {
      const el = document.querySelector(sel);
      if (el) {
        return {
          selector: sel,
          html: el.outerHTML.slice(0, 3000),
          text: el.innerText.slice(0, 1500)
        };
      }
    }
    return { error: '未找到题目容器' };
  });
  const qFile = path.join(outDir, `homework-question-${nowStr()}.json`);
  fs.writeFileSync(qFile, JSON.stringify(questionInfo, null, 2), 'utf-8');
  console.log(`题目信息已保存: ${qFile}`);

  const screenshot = path.join(outDir, `homework-question-${nowStr()}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  console.log(`完整截图: ${screenshot}`);

  console.log('调试完成，5 秒后自动关闭浏览器...');
  await new Promise(r => setTimeout(r, 5000));
  await context.close();
})().catch(err => {
  console.error('调试脚本出错:', err);
  process.exit(1);
});
