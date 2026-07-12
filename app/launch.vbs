Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\mitsu\OneDrive\Desktop\kentikuAI\app"
WshShell.Run "cmd /c npx electron .", 0, False
