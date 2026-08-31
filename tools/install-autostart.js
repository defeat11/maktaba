const fs = require('fs');
const path = require('path');

const startupDir = path.join(process.env.APPDATA, 'Microsoft\\Windows\\Start Menu\\Programs\\Startup');
const vbsPath = path.join(startupDir, 'Maktaba.vbs');

/**
 * Checks if the VBS startup script exists.
 * @returns {boolean}
 */
function isInstalled() {
  return fs.existsSync(vbsPath);
}

/**
 * Creates the VBScript inside the Windows Startup folder.
 * @returns {Object} {ok: boolean, path?: string, error?: string}
 */
function install() {
  try {
    const projectRoot = path.resolve(__dirname, '..');
    const vbsContent = `Set sh = CreateObject("WScript.Shell")\nsh.CurrentDirectory = "${projectRoot}"\nsh.Run "cmd /c npm start", 0, False\n`;
    
    if (!fs.existsSync(startupDir)) {
      fs.mkdirSync(startupDir, { recursive: true });
    }
    
    fs.writeFileSync(vbsPath, vbsContent, 'utf8');
    return { ok: true, path: vbsPath };
  } catch (err) {
    console.error('Failed to install Windows autostart:', err);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  install,
  isInstalled
};
