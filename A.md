方案 A：單一 HTML 檔案（離線、免安裝）
核心思路：將整個應用程式打包成一個自包含的 .html 檔案，透過電子郵件或內部共享磁碟分發，使用者雙擊即可在瀏覽器中執行，無需網路、無需伺服器、無需安裝任何軟體。

技術組成：

層級	技術	用途
PDF 渲染	PDF.js（嵌入 HTML）	頁面顯示 + 文字層擷取
表格偵測	OpenCV.js（WASM）	線條分析、ROI 內儲存格切割
PDF 寫入	pdf-lib（純 JS）	建立 FreeText 註釋、寫入修改後 PDF
排版引擎	自訂 JS 模組	複刻 layout_cell 的換行與字型度量邏輯
UI	原生 Web Components	對應 PySide6 各面板
優點：

完全離線，無需任何網路連線

無需安裝 Python 或任何執行環境

可透過 USB、內部共享磁碟、電子郵件分發

不受 Apex One 應用程式控制影響（瀏覽器已在白名單中）

限制：

若企業封鎖 WASM → OpenCV.js 無法使用，表格偵測需改用純 JS 邊緣檢測（準確率下降）

字型度量無法與 fitz.Font.text_length 完全一致

檔案大小較大（PDF.js + OpenCV.js 約 10-15 MB）

分發方式：

text
內部共享磁碟路徑（範例）：
\\company-share\tools\pdf-editor\pdf-table-editor.html

使用者操作：雙擊 → 瀏覽器開啟 → 選擇本機 PDF → 編輯 → 下載結果


