#!/usr/bin/env node
// 雨课堂 PPT 调试脚本（Playwright）
// 用法：node debug-ppt.mjs [URL]
// 例如：node debug-ppt.mjs "https://www.yuketang.cn/v2/web/studentCards/.../ppt?..."

import { chromium } from '/opt/homebrew/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, 'debug-output');
fs.mkdirSync(outDir, { recursive: true });

const url = process.argv[2] || 'https://www.yuketang.cn/v2/web/studentCards';
const userDataDir = path.join(outDir, 'chrome-user-data');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

function timestamp() {
  const now = new Date();
  return now.toISOString().replace(/[:.]/g, '-');
}

async function dumpPPTInfo(page, label) {
  const info = await page.evaluate(() => {
    const result = {
      url: location.href,
      title: document.title,
      timestamp: new Date().toISOString()
    };

    // 候选选择器（与脚本内保持一致）
    const slideSelectors = [
      '.swiper-wrapper > .swiper-slide',
      '.swiper-wrapper > *',
      '.ppt-slide',
      '.slide-page',
      '.ppt-container .slide',
      '.ppt-content .page',
      '[class*="ppt-slide"]',
      '[class*="slide-page"]',
      '.ppt-viewer .page'
    ];
    result.slides = [];
    for (const sel of slideSelectors) {
      const els = [...document.querySelectorAll(sel)].filter(el => el.offsetParent !== null);
      if (els.length) {
        result.slides.push({
          selector: sel,
          count: els.length,
          firstOuterHTML: els[0]?.outerHTML?.slice(0, 600),
          lastOuterHTML: els[els.length - 1]?.outerHTML?.slice(0, 600)
        });
      }
    }

    // 下一页按钮
    const nextSelectors = [
      '.swiper-button-next',
      '.ppt-next',
      '.next-page',
      '[class*="next"][class*="page"]',
      '[class*="arrow-right"]',
      '.btn-next-slide'
    ];
    result.nextButtons = [];
    for (const sel of nextSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        result.nextButtons.push({
          selector: sel,
          visible: el.offsetParent !== null,
          outerHTML: el.outerHTML?.slice(0, 400)
        });
      }
    }

    // 页码指示器
    const indicatorSelectors = [
      '.swiper-pagination-bullet-active',
      '.page-indicator',
      '.ppt-page-number',
      '[class*="pagination"][class*="active"]'
    ];
    result.indicators = [];
    for (const sel of indicatorSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        result.indicators.push({
          selector: sel,
          text: el.innerText?.trim(),
          outerHTML: el.outerHTML?.slice(0, 400)
        });
      }
    }

    // 通用 PPT 容器
    const containerSelectors = [
      '.swiper-wrapper',
      '.ppt-container',
      '.ppt-viewer',
      '.ppt-content',
      '[class*="ppt-wrapper"]',
      '[class*="slide-wrapper"]'
    ];
    result.containers = [];
    for (const sel of containerSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        result.containers.push({
          selector: sel,
          childCount: el.children.length,
          outerHTML: el.outerHTML?.slice(0, 800)
        });
      }
    }

    // 已完成/进度文字
    const progressText = document.body.innerText.match(/\d+\s*\/\s*\d+|已完成|未读|未开始|100%/)?.[0] || '';
    result.progressHint = progressText;

    return result;
  });

  const file = path.join(outDir, `ppt-dump-${label}-${timestamp()}.json`);
  fs.writeFileSync(file, JSON.stringify(info, null, 2), 'utf-8');
  console.log(`\n[${label}] DOM 信息已保存: ${file}`);
  console.log(`URL: ${info.url}`);
  console.log(`标题: ${info.title}`);
  console.log(`幻灯片候选: ${info.slides.map(s => `${s.selector}(${s.count})`).join(' | ') || '无'}`);
  console.log(`下一页按钮: ${info.nextButtons.map(b => `${b.selector}(visible=${b.visible})`).join(' | ') || '无'}`);
  console.log(`页码指示器: ${info.indicators.map(i => `${i.selector}=${i.text}`).join(' | ') || '无'}`);
  console.log(`进度提示: ${info.progressHint || '无'}`);

  const screenshot = path.join(outDir, `ppt-screenshot-${label}-${timestamp()}.png`);
  await page.screenshot({ path: screenshot, fullPage: false });
  console.log(`截图已保存: ${screenshot}`);

  return info;
}

async function tryFlip(page) {
  console.log('\n--- 开始模拟翻页测试（最多 10 页）---');
  for (let i = 0; i < 10; i++) {
    const before = await dumpPPTInfo(page, `flip-${i + 1}-before`);
    const hasNext = before.nextButtons.some(b => b.visible);

    if (hasNext) {
      const visibleNext = before.nextButtons.find(b => b.visible);
      await page.click(visibleNext.selector);
      console.log(`点击下一页按钮: ${visibleNext.selector}`);
    } else {
      await page.keyboard.press('ArrowRight');
      console.log('模拟键盘 ArrowRight');
    }

    await page.waitForTimeout(1500);
    const after = await dumpPPTInfo(page, `flip-${i + 1}-after`);

    // 如果页码没变且没下一页按钮，认为到底了
    const beforePage = before.indicators[0]?.text;
    const afterPage = after.indicators[0]?.text;
    if (beforePage && afterPage && beforePage === afterPage && !hasNext) {
      console.log('页码未变化且没有可见下一页按钮，结束翻页测试');
      break;
    }
  }
}

(async () => {
  console.log(`启动 Chrome，用户数据目录: ${userDataDir}`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1440, height: 900 }
  });

  const page = context.pages()[0] || await context.newPage();
  console.log(`打开: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  console.log('\n请在浏览器中完成登录并进入 problematic 的 PPT 页面。');
  await ask('准备好后按回车键开始抓取 DOM...');

  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => { });
  await dumpPPTInfo(page, 'initial');

  const answer = await ask('\n是否执行自动翻页测试？(y/N): ');
  if (answer.trim().toLowerCase() === 'y') {
    await tryFlip(page);
  }

  console.log(`\n调试完成，所有输出在: ${outDir}`);
  console.log('你可以直接关闭浏览器，或按回车键关闭...');
  await ask('');
  await context.close();
})().catch(err => {
  console.error('调试脚本出错:', err);
  process.exit(1);
});
