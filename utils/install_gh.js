const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const GH_VERSION = '2.45.0';
const GH_URL = `https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_windows_amd64.zip`;
const INSTALL_DIR = path.join(__dirname, '../tools/gh');
const ZIP_PATH = path.join(process.env.TEMP, 'gh.zip');

async function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Follow redirect
        file.close();
        fs.unlinkSync(dest);
        download(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }

      console.log(`Downloading... (${response.statusCode})`);

      let downloaded = 0;
      const total = parseInt(response.headers['content-length'], 10);

      response.on('data', (chunk) => {
        downloaded += chunk.length;
        const percent = ((downloaded / total) * 100).toFixed(1);
        process.stdout.write(`\rProgress: ${percent}%`);
      });

      response.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log('\nDownload complete!');
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function install() {
  console.log('Installing GitHub CLI...');
  console.log(`Version: ${GH_VERSION}`);
  console.log(`URL: ${GH_URL}`);
  console.log(`Install directory: ${INSTALL_DIR}\n`);

  // Create install directory
  if (!fs.existsSync(INSTALL_DIR)) {
    console.log('Creating install directory...');
    fs.mkdirSync(INSTALL_DIR, { recursive: true });
  }

  // Download
  console.log('Downloading GitHub CLI...');
  await download(GH_URL, ZIP_PATH);

  // Extract
  console.log('Extracting...');
  execSync(`powershell -Command "Expand-Archive -Path '${ZIP_PATH}' -DestinationPath '${INSTALL_DIR}' -Force"`, {
    stdio: 'inherit',
  });

  // Clean up zip
  fs.unlinkSync(ZIP_PATH);
  console.log('Cleaned up temporary files.');

  // Find the actual gh.exe
  const entries = fs.readdirSync(INSTALL_DIR);
  const ghSubDir = entries.find(e => e.startsWith('gh_'));

  if (ghSubDir) {
    const binPath = path.join(INSTALL_DIR, ghSubDir, 'bin', 'gh.exe');
    if (fs.existsSync(binPath)) {
      console.log(`\n✓ GitHub CLI installed successfully!`);
      console.log(`Location: ${binPath}`);
      console.log(`\nTest it by running: node utils/test_gh.js`);
      return;
    }
  }

  console.log(`\n✓ GitHub CLI installed to: ${INSTALL_DIR}`);
  console.log('Please verify the installation manually.');
}

install().catch((error) => {
  console.error('Installation failed:', error);
  process.exit(1);
});
