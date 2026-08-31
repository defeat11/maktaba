const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { logError, logInfo } = require('./logger');

/**
 * Captures the current foreground window or full screen and saves it as a PNG.
 * Only supports win32 platforms.
 * 
 * @param {string} outPath Destination PNG filepath.
 * @returns {Promise<boolean>} Resolves to true on success, false otherwise.
 */
async function captureDesktop(outPath) {
  if (process.platform !== 'win32') {
    logInfo('winshot', 'captureDesktop called on a non-win32 platform. Skipping.');
    return false;
  }

  const tempScriptPath = path.join(__dirname, 'temp_capture.ps1');
  // Resolve to an absolute path so PowerShell saves to the intended location
  // regardless of its own current working directory.
  outPath = path.resolve(outPath);
  try {
    const psScript = `
param([string]$outPath)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
}
"@

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$hwnd = [Win32]::GetForegroundWindow()
$rect = New-Object Win32+RECT
$gotRect = [Win32]::GetWindowRect($hwnd, [ref]$rect)

$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top

if (-not $gotRect -or $width -le 0 -or $height -le 0) {
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $left = $bounds.Left
    $top = $bounds.Top
    $width = $bounds.Width
    $height = $bounds.Height
} else {
    $left = $rect.Left
    $top = $rect.Top
}

$bmp = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$graphics.CopyFromScreen($left, $top, 0, 0, (New-Object System.Drawing.Size($width, $height)))
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bmp.Dispose()
`;

    fs.writeFileSync(tempScriptPath, psScript, 'utf8');

    // Run powershell with execution bypass, avoiding script-blocking policies
    execSync(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tempScriptPath}" -outPath "${outPath}"`, {
      windowsHide: true,
      stdio: 'ignore'
    });

    if (fs.existsSync(outPath)) {
      logInfo('winshot', `Successfully captured screen to: ${outPath}`);
      return true;
    } else {
      logError('winshot', new Error('PowerShell script ran but output file was not created.'));
      return false;
    }
  } catch (err) {
    logError('winshot', err);
    return false;
  } finally {
    // Clean up temporary script
    try {
      if (fs.existsSync(tempScriptPath)) {
        fs.unlinkSync(tempScriptPath);
      }
    } catch (err) {
      // Ignore cleanup errors
    }
  }
}

module.exports = {
  captureDesktop
};
