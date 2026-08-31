const fs = require('fs');
const path = require('path');

const startupDir = path.join(process.env.APPDATA, 'Microsoft\\Windows\\Start Menu\\Programs\\Startup');
const vbsPath = path.join(startupDir, 'Maktaba.vbs');

/**
 * Removes the Windows Startup VBScript if it exists.
 * @returns {Object} {ok: boolean, error?: string}
 */
function uninstall() {
  try {
    if (fs.existsSync(vbsPath)) {
      fs.unlinkSync(vbsPath);
    }
    return { ok: true };
  } catch (err) {
    console.error('Failed to uninstall Windows autostart:', err);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  uninstall
};
