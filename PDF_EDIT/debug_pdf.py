import os
import pymupdf as fitz

# 1. 請填入您要檢查的 PDF 檔案路徑
pdf_path = "C:\\Users\\14940\\Downloads\\output_multipage.pdf"  # 替換成您的輸出 PDF 檔名

# 2. 自動取得桌面路徑與輸出 txt 路徑
desktop_path = os.path.join(os.path.expanduser("~"), "Desktop")
output_txt_path = os.path.join(desktop_path, "pdf_debug_result.txt")

log_lines = []

try:
    doc = fitz.open(pdf_path)
    log_lines.append(f"=== PDF 除錯報告: {os.path.basename(pdf_path)} ===")
    
    # 檢查 AcroForm / DR / Font
    log_lines.append("\n[1. AcroForm 字體登記庫 (/AcroForm/DR/Font)]")
    try:
        catalog_xref = doc.pdf_catalog()
        font_info = doc.xref_get_key(catalog_xref, "AcroForm/DR/Font")
        log_lines.append(f"AcroForm Font 內容: {font_info}")
    except Exception as e:
        log_lines.append(f"查詢 AcroForm 失敗: {e}")

    # 檢查所有頁面的 FreeText 註釋
    log_lines.append("\n[2. FreeText 註釋詳細內容 (xref_object)]")
    found_annots = 0
    for page_idx, page in enumerate(doc):
        for annot in page.annots():
            if annot.type[0] == fitz.PDF_ANNOT_FREE_TEXT:
                found_annots += 1
                xref = annot.xref
                log_lines.append(f"\n--- 頁碼 {page_idx + 1} | Annot xref ID: {xref} ---")
                
                # 讀取底層原始 PDF Dictionary 物件
                raw_obj = doc.xref_object(xref)
                log_lines.append(raw_obj)

    if found_annots == 0:
        log_lines.append("\n警告：此 PDF 檔案中沒有找到任何 FreeText 註釋！")

    doc.close()

except Exception as e:
    log_lines.append(f"\n執行過程中發生錯誤: {e}")

# 3. 寫入 txt 檔案至桌面
with open(output_txt_path, "w", encoding="utf-8") as f:
    f.write("\n".join(log_lines))

print(f"檢查完成！報告已儲存至桌面：\n{output_txt_path}")