/**
 * Harvest CAPTCHAs Now
 *
 * Quick script to harvest CAPTCHAs from various sources.
 * Run: node harvest-now.js
 */

const harvester = require('./harvester');
const { chromium } = require('playwright');

const LAB_URL = 'http://localhost:3000';

async function main() {
  console.log('='.repeat(60));
  console.log('CAPTCHA Harvester');
  console.log('='.repeat(60));

  // Check if lab is running
  console.log('\nChecking lab server...');
  try {
    const response = await fetch(LAB_URL);
    if (response.ok) {
      console.log('✓ Lab server running at', LAB_URL);
    }
  } catch (e) {
    console.log('✗ Lab server not running. Starting harvest from online sources only.');
  }

  // Harvest from local lab (auto-labeled)
  console.log('\n--- Harvesting from Local Lab ---\n');
  try {
    const labResult = await harvester.harvestFromLab(50, LAB_URL);
    console.log(`✓ Harvested ${labResult.count || 0} CAPTCHAs from lab (auto-labeled)`);
  } catch (e) {
    console.log('✗ Lab harvest failed:', e.message);
  }

  // Harvest from online CAPTCHA generators
  console.log('\n--- Harvesting from Online Sources ---\n');

  const browser = await chromium.launch({ headless: true });

  // Source 1: captcha.com demo
  console.log('Trying captcha.com demo...');
  try {
    const page = await browser.newPage();
    await page.goto('https://captcha.com/demos/features/captcha-demo.aspx', { timeout: 30000 });
    await page.waitForTimeout(2000);

    const captchaImg = await page.$('#c_default_ctl00_contentplaceholder1_captchademo_CaptchaImage');
    if (captchaImg) {
      for (let i = 0; i < 10; i++) {
        const filename = `captcha_com_${Date.now()}_${i}.png`;
        const outputPath = require('path').join(harvester.IMAGES_DIR, filename);
        await captchaImg.screenshot({ path: outputPath });
        harvester.addSample(outputPath, { source: 'captcha.com', type: 'text' });
        console.log(`  Saved: ${filename}`);

        // Reload for new CAPTCHA
        await page.reload();
        await page.waitForTimeout(1000);
      }
      console.log('✓ Harvested 10 CAPTCHAs from captcha.com');
    } else {
      console.log('✗ CAPTCHA image not found on captcha.com');
    }
    await page.close();
  } catch (e) {
    console.log('✗ captcha.com failed:', e.message);
  }

  // Source 2: textcaptcha.com (text-based challenges)
  console.log('\nTrying text challenges...');
  try {
    const page = await browser.newPage();

    // Create some text CAPTCHAs ourselves for variety
    const challenges = [
      { q: 'What is 5 + 3?', a: '8' },
      { q: 'What is 10 - 4?', a: '6' },
      { q: 'What is 2 * 7?', a: '14' },
      { q: 'What is 15 / 3?', a: '5' },
      { q: 'What is 9 + 11?', a: '20' },
    ];

    for (const challenge of challenges) {
      // Save as text file for variety
      const fs = require('fs');
      const filename = `math_${Date.now()}.txt`;
      const outputPath = require('path').join(harvester.IMAGES_DIR, filename);
      fs.writeFileSync(outputPath, challenge.q);
      harvester.addSample(outputPath, {
        source: 'generated',
        type: 'math',
        label: challenge.a
      });
      console.log(`  Generated: ${challenge.q} = ${challenge.a}`);
    }
    console.log('✓ Generated 5 math challenges');
    await page.close();
  } catch (e) {
    console.log('✗ Text challenges failed:', e.message);
  }

  // Source 3: Generate varied text CAPTCHAs locally
  console.log('\nGenerating local text CAPTCHAs...');
  try {
    const page = await browser.newPage();

    // Use our lab's text CAPTCHA generator
    for (let i = 0; i < 20; i++) {
      await page.goto(`${LAB_URL}/text-captcha`);
      await page.waitForTimeout(300);

      const captchaImage = await page.$('.captcha-image');
      const captchaText = await page.$eval('.captcha-image', el =>
        el.textContent.replace(/<[^>]*>/g, '').trim()
      );

      if (captchaImage && captchaText) {
        const filename = `lab_text_${Date.now()}_${i}.png`;
        const outputPath = require('path').join(harvester.IMAGES_DIR, filename);
        await captchaImage.screenshot({ path: outputPath });
        harvester.addSample(outputPath, {
          source: 'lab',
          type: 'text',
          label: captchaText
        });
      }
    }
    console.log('✓ Generated 20 text CAPTCHAs from lab');
    await page.close();
  } catch (e) {
    console.log('✗ Local generation failed:', e.message);
  }

  // Source 4: Math CAPTCHAs from lab
  console.log('\nGenerating math CAPTCHAs from lab...');
  try {
    const page = await browser.newPage();

    for (let i = 0; i < 20; i++) {
      await page.goto(`${LAB_URL}/math-captcha`);
      await page.waitForTimeout(300);

      const mathElement = await page.$('.math');
      const mathText = await page.$eval('.math', el => el.textContent);

      // Parse the answer
      const match = mathText.match(/(\d+)\s*([+\-×*])\s*(\d+)/);
      if (match && mathElement) {
        const a = parseInt(match[1]);
        const op = match[2];
        const b = parseInt(match[3]);
        let answer;
        switch (op) {
          case '+': answer = a + b; break;
          case '-': answer = a - b; break;
          case '×':
          case '*': answer = a * b; break;
        }

        const filename = `lab_math_${Date.now()}_${i}.png`;
        const outputPath = require('path').join(harvester.IMAGES_DIR, filename);
        await mathElement.screenshot({ path: outputPath });
        harvester.addSample(outputPath, {
          source: 'lab',
          type: 'math',
          label: String(answer)
        });
      }
    }
    console.log('✓ Generated 20 math CAPTCHAs from lab');
    await page.close();
  } catch (e) {
    console.log('✗ Math generation failed:', e.message);
  }

  await browser.close();

  // Print stats
  console.log('\n' + '='.repeat(60));
  console.log('HARVEST COMPLETE');
  console.log('='.repeat(60));

  const stats = harvester.getStats();
  console.log(`\nTotal samples: ${stats.total}`);
  console.log(`Labeled: ${stats.labeled}`);
  console.log(`Unlabeled: ${stats.unlabeled}`);
  console.log('\nBy source:');
  for (const [source, count] of Object.entries(stats.bySource)) {
    console.log(`  ${source}: ${count}`);
  }
  console.log('\nBy type:');
  for (const [type, count] of Object.entries(stats.byType)) {
    console.log(`  ${type}: ${count}`);
  }

  console.log(`\nImages saved to: ${harvester.IMAGES_DIR}`);
  console.log('\nTo label unlabeled CAPTCHAs:');
  console.log('  node harvester/labeling-ui.js');
  console.log('  Open http://localhost:3001');
}

main().catch(console.error);
