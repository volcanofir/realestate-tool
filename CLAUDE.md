# 行情分析工具 - Claude Code 操作指南

## 初次部署
1. 建立 GitHub repo 並開啟 GitHub Pages
2. 上傳 index.html 到 repo 根目錄
3. 建立 data/ 資料夾，上傳 Excel 和 sources.json

## 更新 Excel 資料
把新的 Excel 檔案上傳到 data/ 資料夾，覆蓋同名舊檔案

## sources.json 格式
```json
[
  { "name": "顯示名稱", "file": "檔案名稱.xlsx", "mode": "normal" },
  { "name": "透天社區", "file": "透天社區.xlsx", "mode": "townhouse" }
]
```

## mode 說明
- normal：一般住宅（內政部實價登錄格式）
- townhouse：透天（5168格式）
