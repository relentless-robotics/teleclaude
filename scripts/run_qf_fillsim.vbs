Set oShell = CreateObject("WScript.Shell")
oShell.Run "cmd /c C:\Python311\python.exe -u C:\Users\claude\Lvl3Quant\scripts\qf_iceberg_chase_fillsim.py --data-dir C:\Users\claude\Lvl3Quant\data\processed\dl_book_cache --output C:\Users\claude\qf_iceberg_chase_results.json --max-days 173 --top-n 50 >> C:\Users\claude\Lvl3Quant\scripts\qf_chase_fillsim.log 2>&1", 0, False
