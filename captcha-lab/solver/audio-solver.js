/**
 * Audio CAPTCHA Solver
 *
 * Solves audio CAPTCHAs (like reCAPTCHA audio challenge) using speech recognition.
 * Uses Windows Speech Recognition or Whisper for transcription.
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const TEMP_DIR = path.join(__dirname, 'temp');

// Find FFmpeg path
function findFFmpegPath() {
  // Common installation locations
  const userLocal = process.env.LOCALAPPDATA || 'C:\\Users\\' + (process.env.USERNAME || 'Footb') + '\\AppData\\Local';
  const wingetPath = path.join(userLocal, 'Microsoft', 'WinGet', 'Packages');

  const paths = [
    process.env.FFMPEG_PATH,
    // WinGet installations (check for any ffmpeg version)
    ...(() => {
      try {
        const packages = fs.readdirSync(wingetPath);
        const ffmpegPkg = packages.find(p => p.toLowerCase().includes('ffmpeg'));
        if (ffmpegPkg) {
          const pkgDir = path.join(wingetPath, ffmpegPkg);
          const contents = fs.readdirSync(pkgDir);
          const versionDir = contents.find(c => c.startsWith('ffmpeg-'));
          if (versionDir) {
            return [path.join(pkgDir, versionDir, 'bin', 'ffmpeg.exe')];
          }
        }
      } catch {}
      return [];
    })(),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
    '/usr/bin/ffmpeg', // Linux
    'ffmpeg', // In PATH
  ].filter(Boolean);

  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        return p;
      }
    } catch {}
  }

  // Final fallback: try command directly
  return 'ffmpeg';
}

const FFMPEG_PATH = findFFmpegPath();

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * Download audio file from URL
 */
async function downloadAudio(url, outputPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;

    const file = fs.createWriteStream(outputPath);
    protocol.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Follow redirect
        downloadAudio(response.headers.location, outputPath)
          .then(resolve)
          .catch(reject);
        return;
      }

      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(outputPath);
      });
    }).on('error', (err) => {
      fs.unlink(outputPath, () => {});
      reject(err);
    });
  });
}

/**
 * Convert audio to WAV format using FFmpeg
 */
async function convertToWav(inputPath, outputPath) {
  try {
    const ffmpegCmd = FFMPEG_PATH.includes(' ') ? `"${FFMPEG_PATH}"` : FFMPEG_PATH;
    execSync(`${ffmpegCmd} -y -i "${inputPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${outputPath}"`, {
      stdio: 'pipe'
    });
    return outputPath;
  } catch (e) {
    throw new Error('FFmpeg conversion failed. Is FFmpeg installed? Path: ' + FFMPEG_PATH);
  }
}

/**
 * Check if Whisper is available (via Python)
 */
function checkWhisper() {
  try {
    execSync('python -c "import whisper"', { stdio: 'pipe' });
    return { installed: true, type: 'openai-whisper' };
  } catch {
    try {
      execSync('whisper --help', { stdio: 'pipe' });
      return { installed: true, type: 'whisper-cli' };
    } catch {
      return { installed: false };
    }
  }
}

/**
 * Check if Windows Speech Recognition is available
 */
function checkWindowsSpeech() {
  // Windows has built-in speech recognition via PowerShell
  try {
    execSync('powershell -Command "Add-Type -AssemblyName System.Speech"', { stdio: 'pipe' });
    return { installed: true };
  } catch {
    return { installed: false };
  }
}

/**
 * Transcribe audio using OpenAI Whisper (Python)
 */
async function transcribeWithWhisper(audioPath) {
  try {
    // Normalize path for Python
    const normalizedPath = audioPath.replace(/\\/g, '/');

    // Write Python script to temp file to avoid escaping issues
    const scriptContent = `
import whisper
import warnings
warnings.filterwarnings("ignore")

# Use base model for good accuracy/speed balance
# Will use GPU (CUDA) if available
model = whisper.load_model("base")
result = model.transcribe("${normalizedPath}", language="en", fp16=False)
print(result["text"].strip())
`;

    const scriptPath = path.join(TEMP_DIR, `whisper_${Date.now()}.py`);
    fs.writeFileSync(scriptPath, scriptContent);

    const result = execSync(`python "${scriptPath}"`, {
      encoding: 'utf-8',
      timeout: 120000,  // 2 minute timeout for model loading
      maxBuffer: 10 * 1024 * 1024
    });

    // Cleanup script
    try { fs.unlinkSync(scriptPath); } catch {}

    return result.trim();
  } catch (e) {
    throw new Error('Whisper transcription failed: ' + e.message);
  }
}

/**
 * Transcribe audio using Windows Speech Recognition (PowerShell)
 */
async function transcribeWithWindows(audioPath) {
  // Properly escape the path for PowerShell
  const escapedPath = audioPath.replace(/\\/g, '\\\\').replace(/'/g, "''");

  const psScript = `
Add-Type -AssemblyName System.Speech
$recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine
$recognizer.SetInputToWaveFile('${escapedPath}')
$grammar = New-Object System.Speech.Recognition.DictationGrammar
$recognizer.LoadGrammar($grammar)
try {
    $result = $recognizer.Recognize()
    if ($result) {
        Write-Output $result.Text
    }
} finally {
    $recognizer.Dispose()
}
`;

  try {
    // Write script to temp file to avoid escaping issues
    const tempScript = path.join(TEMP_DIR, `speech_${Date.now()}.ps1`);
    fs.writeFileSync(tempScript, psScript);

    const result = execSync(`powershell -ExecutionPolicy Bypass -File "${tempScript}"`, {
      encoding: 'utf-8',
      timeout: 30000
    });

    // Cleanup temp script
    try { fs.unlinkSync(tempScript); } catch {}

    return result.trim();
  } catch (e) {
    throw new Error('Windows speech recognition failed: ' + e.message);
  }
}

/**
 * Transcribe audio using available method
 */
async function transcribeAudio(audioPath) {
  // Try Whisper first (more accurate)
  const whisper = checkWhisper();
  if (whisper.installed) {
    try {
      return await transcribeWithWhisper(audioPath);
    } catch (e) {
      console.log('Whisper failed, trying fallback:', e.message);
    }
  }

  // Try Windows Speech Recognition
  const windowsSpeech = checkWindowsSpeech();
  if (windowsSpeech.installed) {
    try {
      return await transcribeWithWindows(audioPath);
    } catch (e) {
      console.log('Windows speech failed:', e.message);
    }
  }

  throw new Error('No speech recognition available. Install Whisper: pip install openai-whisper');
}

/**
 * Solve audio CAPTCHA from URL
 */
async function solveAudioUrl(audioUrl) {
  const tempId = crypto.randomBytes(8).toString('hex');
  const downloadPath = path.join(TEMP_DIR, `audio_${tempId}.mp3`);
  const wavPath = path.join(TEMP_DIR, `audio_${tempId}.wav`);

  try {
    // Download audio
    await downloadAudio(audioUrl, downloadPath);

    // Convert to WAV
    await convertToWav(downloadPath, wavPath);

    // Transcribe
    const text = await transcribeAudio(wavPath);

    // Clean up
    [downloadPath, wavPath].forEach(p => {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    });

    // Extract digits/words (audio CAPTCHAs often spell out numbers)
    const cleaned = cleanTranscription(text);

    return {
      success: true,
      solution: cleaned,
      rawText: text
    };

  } catch (e) {
    // Clean up on error
    [downloadPath, wavPath].forEach(p => {
      if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch {}
    });

    return { success: false, error: e.message };
  }
}

/**
 * Solve audio CAPTCHA from file
 */
async function solveAudioFile(audioPath) {
  const tempId = crypto.randomBytes(8).toString('hex');
  const wavPath = path.join(TEMP_DIR, `audio_${tempId}.wav`);

  try {
    // Convert to WAV if needed
    if (!audioPath.endsWith('.wav')) {
      await convertToWav(audioPath, wavPath);
    } else {
      fs.copyFileSync(audioPath, wavPath);
    }

    // Transcribe
    const text = await transcribeAudio(wavPath);

    // Clean up
    if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);

    const cleaned = cleanTranscription(text);

    return {
      success: true,
      solution: cleaned,
      rawText: text
    };

  } catch (e) {
    if (fs.existsSync(wavPath)) try { fs.unlinkSync(wavPath); } catch {}
    return { success: false, error: e.message };
  }
}

/**
 * Clean transcription for CAPTCHA answer
 * - Convert spelled numbers to digits
 * - Remove filler words
 * - Extract just the answer
 */
function cleanTranscription(text) {
  let cleaned = text.toLowerCase();

  // Word to digit mapping
  const wordToDigit = {
    'zero': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4',
    'five': '5', 'six': '6', 'seven': '7', 'eight': '8', 'nine': '9',
    'oh': '0', 'o': '0'
  };

  // Replace words with digits
  for (const [word, digit] of Object.entries(wordToDigit)) {
    cleaned = cleaned.replace(new RegExp(`\\b${word}\\b`, 'gi'), digit);
  }

  // Remove common filler phrases from audio CAPTCHAs
  const fillers = [
    'please type', 'please enter', 'the numbers are', 'the digits are',
    'type the following', 'enter the following', 'you will hear'
  ];
  for (const filler of fillers) {
    cleaned = cleaned.replace(new RegExp(filler, 'gi'), '');
  }

  // Extract just alphanumeric characters
  cleaned = cleaned.replace(/[^a-z0-9]/gi, '');

  return cleaned.toUpperCase();
}

/**
 * Get solver status
 */
function getStatus() {
  let ffmpegInstalled = false;
  let ffmpegPath = FFMPEG_PATH;

  try {
    const cmd = FFMPEG_PATH.includes(' ') ? `"${FFMPEG_PATH}"` : FFMPEG_PATH;
    execSync(`${cmd} -version`, { stdio: 'pipe' });
    ffmpegInstalled = true;
  } catch {
    ffmpegInstalled = false;
  }

  return {
    whisper: checkWhisper(),
    windowsSpeech: checkWindowsSpeech(),
    ffmpegInstalled,
    ffmpegPath
  };
}

module.exports = {
  solveAudioUrl,
  solveAudioFile,
  transcribeAudio,
  cleanTranscription,
  getStatus,
  checkWhisper,
  checkWindowsSpeech
};
