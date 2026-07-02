const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push('PAGEERROR: ' + err.message));

  await page.goto('http://localhost:3000/screener.html');
  await page.waitForTimeout(500);

  // find market mode toggle button text
  const btns = await page.locator('button, [onclick]').allTextContents();
  console.log('candidate texts:', btns.filter(t => /PH|Philippine|US|market/i.test(t)).slice(0,20));

  await browser.close();
})();
