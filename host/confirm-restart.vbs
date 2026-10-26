' Launch the PowerShell auto-confirm helper with NO console window.
'
' Why a .vbs launcher: `powershell.exe -WindowStyle Hidden` still creates a console host for a moment, and
' under `cmd /c start /b` the console is inherited too — both flash a black window. WshShell.Run with a
' window style of 0 asks Windows not to create a console for the child at all, which is the only reliable
' way to stay invisible on Windows.
Option Explicit

Dim shell
Dim args
Dim command
Dim index

If WScript.Arguments.Count = 0 Then
  WScript.Quit 2
End If

Set shell = CreateObject("WScript.Shell")
command = ""

' Every argument is quoted: script paths and window titles can contain spaces.
For index = 0 To WScript.Arguments.Count - 1
  If index > 0 Then command = command & " "
  command = command & """" & WScript.Arguments(index) & """"
Next

' 0 = no window, False = do not wait for it.
shell.Run "powershell.exe " & command, 0, False
WScript.Quit 0
