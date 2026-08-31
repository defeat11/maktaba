' Completely silent launcher for Maktaba-Guardian (no console flash).
'
' The guardian script sits next to this file, so the path is derived from this
' script's own location instead of being hardcoded.
Option Explicit
Dim fso, sh, here, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "\maktaba-guardian.ps1"""
sh.Run cmd, 0, False
