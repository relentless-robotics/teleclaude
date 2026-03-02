/**
 * Ghidra Bridge Module
 * Provides headless Ghidra analysis capabilities for reverse engineering
 *
 * Usage:
 *   const { analyzeBinary, decompileFunction, extractStrings } = require('./utils/ghidra_bridge');
 *   const result = await analyzeBinary('/path/to/binary');
 */

const { runInWSL, windowsToWSLPath, isToolInstalled } = require('./wsl_bridge');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');

// Ghidra headless analyzer path (standard Kali installation)
const GHIDRA_HEADLESS = '/usr/bin/analyzeHeadless';

// Temporary project directory in WSL
const GHIDRA_PROJECTS_DIR = '/tmp/ghidra_projects';

/**
 * Check if Ghidra is installed
 * @returns {Promise<boolean>}
 */
async function isGhidraInstalled() {
  return await isToolInstalled('analyzeHeadless');
}

/**
 * Create a Ghidra analysis script
 * @param {string} scriptContent - Python script content for Ghidra
 * @returns {Promise<string>} - Path to script file in WSL
 */
async function createGhidraScript(scriptContent) {
  const scriptId = uuidv4();
  const scriptPath = `/tmp/ghidra_script_${scriptId}.py`;

  // Write script via WSL
  const escapedContent = scriptContent.replace(/'/g, "'\\''");
  await runInWSL(`echo '${escapedContent}' > ${scriptPath}`, { skipValidation: true });

  return scriptPath;
}

/**
 * Analyze a binary with Ghidra headless mode
 * @param {string} binaryPath - Path to binary (Windows or WSL path)
 * @param {Object} options - Analysis options
 * @param {string} options.projectName - Project name (auto-generated if not provided)
 * @param {boolean} options.analyze - Run auto-analysis (default: true)
 * @param {string} options.scriptPath - Path to custom Ghidra script
 * @param {number} options.timeout - Timeout in milliseconds (default: 10 minutes)
 * @returns {Promise<Object>} - Analysis results
 */
async function analyzeBinary(binaryPath, options = {}) {
  const {
    projectName = `project_${Date.now()}`,
    analyze = true,
    scriptPath = null,
    timeout = 600000
  } = options;

  // Check Ghidra installation
  const ghidraInstalled = await isGhidraInstalled();
  if (!ghidraInstalled) {
    throw new Error('Ghidra is not installed. Run: sudo apt install ghidra');
  }

  // Convert Windows path to WSL if needed
  let wslBinaryPath = binaryPath;
  if (binaryPath.match(/^[A-Za-z]:\\/)) {
    wslBinaryPath = windowsToWSLPath(binaryPath);
  }

  // Verify binary exists
  const checkResult = await runInWSL(`test -f "${wslBinaryPath}" && echo "exists"`, { skipValidation: true });
  if (!checkResult.stdout.includes('exists')) {
    throw new Error(`Binary not found: ${wslBinaryPath}`);
  }

  // Prepare project directory
  const projectDir = `${GHIDRA_PROJECTS_DIR}/${projectName}`;
  await runInWSL(`mkdir -p ${projectDir}`, { skipValidation: true });

  // Build analyzeHeadless command
  const binaryName = path.basename(wslBinaryPath);
  let command = `analyzeHeadless ${projectDir} ${projectName} -import "${wslBinaryPath}"`;

  if (analyze) {
    command += ' -analyze';
  }

  if (scriptPath) {
    command += ` -postScript ${scriptPath}`;
  }

  // Run Ghidra analysis
  try {
    const result = await runInWSL(command, {
      timeout,
      skipValidation: true
    });

    return {
      success: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      projectPath: projectDir,
      binaryName
    };
  } catch (error) {
    throw new Error(`Ghidra analysis failed: ${error.message}`);
  }
}

/**
 * Decompile a specific function from a binary
 * @param {string} binaryPath - Path to binary
 * @param {string} functionAddress - Function address (e.g., '0x401000') or name
 * @param {Object} options - Options
 * @returns {Promise<string>} - Decompiled code
 */
async function decompileFunction(binaryPath, functionAddress, options = {}) {
  // Create Ghidra script to decompile function
  const script = `
# Ghidra Python script to decompile function
from ghidra.app.decompiler import DecompInterface
from ghidra.util.task import ConsoleTaskMonitor

def decompile_function(func_addr):
    # Get current program
    program = currentProgram

    # Parse address
    if func_addr.startswith('0x'):
        addr = program.getAddressFactory().getAddress(func_addr)
    else:
        # Try to find function by name
        func = getFunction(func_addr)
        if func is None:
            print("ERROR: Function not found: " + func_addr)
            return
        addr = func.getEntryPoint()

    # Get function at address
    func = getFunctionAt(addr)
    if func is None:
        print("ERROR: No function at address: " + str(addr))
        return

    # Set up decompiler
    decompiler = DecompInterface()
    decompiler.openProgram(program)

    # Decompile
    results = decompiler.decompileFunction(func, 30, ConsoleTaskMonitor())

    if results.decompileCompleted():
        print("=== DECOMPILED CODE START ===")
        print(results.getDecompiledFunction().getC())
        print("=== DECOMPILED CODE END ===")
    else:
        print("ERROR: Decompilation failed")

decompile_function("${functionAddress}")
`;

  const scriptPath = await createGhidraScript(script);

  try {
    const result = await analyzeBinary(binaryPath, {
      ...options,
      scriptPath
    });

    // Extract decompiled code from output
    const match = result.stdout.match(/=== DECOMPILED CODE START ===([\s\S]*)=== DECOMPILED CODE END ===/);
    if (match) {
      return match[1].trim();
    } else {
      throw new Error('Failed to extract decompiled code from Ghidra output');
    }
  } finally {
    // Clean up script
    await runInWSL(`rm -f ${scriptPath}`, { skipValidation: true });
  }
}

/**
 * List all functions in a binary
 * @param {string} binaryPath - Path to binary
 * @param {Object} options - Options
 * @returns {Promise<Array>} - List of functions with addresses and names
 */
async function listFunctions(binaryPath, options = {}) {
  const script = `
# List all functions
from ghidra.program.model.symbol import SymbolType

program = currentProgram
fm = program.getFunctionManager()

print("=== FUNCTIONS START ===")
for func in fm.getFunctions(True):
    entry = func.getEntryPoint()
    name = func.getName()
    print(str(entry) + " | " + name)
print("=== FUNCTIONS END ===")
`;

  const scriptPath = await createGhidraScript(script);

  try {
    const result = await analyzeBinary(binaryPath, {
      ...options,
      scriptPath
    });

    // Extract function list
    const match = result.stdout.match(/=== FUNCTIONS START ===([\s\S]*)=== FUNCTIONS END ===/);
    if (match) {
      const lines = match[1].trim().split('\n');
      return lines.map(line => {
        const [address, name] = line.split(' | ');
        return { address: address.trim(), name: name.trim() };
      }).filter(f => f.address && f.name);
    } else {
      throw new Error('Failed to extract function list from Ghidra output');
    }
  } finally {
    await runInWSL(`rm -f ${scriptPath}`, { skipValidation: true });
  }
}

/**
 * Extract strings from a binary
 * @param {string} binaryPath - Path to binary
 * @param {Object} options - Options
 * @param {number} options.minLength - Minimum string length (default: 4)
 * @returns {Promise<Array>} - List of strings with addresses
 */
async function extractStrings(binaryPath, options = {}) {
  const { minLength = 4 } = options;

  const script = `
# Extract defined strings
print("=== STRINGS START ===")
listing = currentProgram.getListing()
data_iter = listing.getDefinedData(True)

for data in data_iter:
    if data.hasStringValue():
        addr = data.getAddress()
        value = data.getValue()
        if value is not None and len(str(value)) >= ${minLength}:
            print(str(addr) + " | " + str(value))
print("=== STRINGS END ===")
`;

  const scriptPath = await createGhidraScript(script);

  try {
    const result = await analyzeBinary(binaryPath, {
      ...options,
      scriptPath
    });

    // Extract strings
    const match = result.stdout.match(/=== STRINGS START ===([\s\S]*)=== STRINGS END ===/);
    if (match) {
      const lines = match[1].trim().split('\n');
      return lines.map(line => {
        const pipeIndex = line.indexOf(' | ');
        if (pipeIndex === -1) return null;
        return {
          address: line.substring(0, pipeIndex).trim(),
          value: line.substring(pipeIndex + 3).trim()
        };
      }).filter(s => s !== null);
    } else {
      throw new Error('Failed to extract strings from Ghidra output');
    }
  } finally {
    await runInWSL(`rm -f ${scriptPath}`, { skipValidation: true });
  }
}

/**
 * Get binary information using basic tools (file, strings, etc.)
 * @param {string} binaryPath - Path to binary
 * @returns {Promise<Object>} - Binary information
 */
async function getBinaryInfo(binaryPath) {
  // Convert to WSL path if needed
  let wslPath = binaryPath;
  if (binaryPath.match(/^[A-Za-z]:\\/)) {
    wslPath = windowsToWSLPath(binaryPath);
  }

  const fileInfo = await runInWSL(`file "${wslPath}"`, { skipValidation: true });
  const stringsResult = await runInWSL(`strings "${wslPath}" | head -n 100`, { skipValidation: true });

  return {
    fileType: fileInfo.stdout,
    sampleStrings: stringsResult.stdout.split('\n').slice(0, 50),
    path: wslPath
  };
}

/**
 * Clean up old Ghidra projects
 * @param {number} olderThanHours - Delete projects older than X hours (default: 24)
 */
async function cleanupProjects(olderThanHours = 24) {
  const command = `find ${GHIDRA_PROJECTS_DIR} -type d -mtime +0 -exec rm -rf {} + 2>/dev/null || true`;
  await runInWSL(command, { skipValidation: true });
}

module.exports = {
  analyzeBinary,
  decompileFunction,
  listFunctions,
  extractStrings,
  getBinaryInfo,
  isGhidraInstalled,
  cleanupProjects,
  GHIDRA_PROJECTS_DIR
};
