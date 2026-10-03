import pymupdf as fitz
import numpy as np
import cv2

class TableCellDetector:
    @staticmethod
    def detect_cells_in_roi(page: fitz.Page, roi_rect: fitz.Rect) -> list[fitz.Rect]:
        cells = []

        # -----------------------------------------------------------------
        # 1. 使用 PyMuPDF 內建表格分析
        # 🎯 修正 #1：加入 Y 軸頂部過濾，避免抓到上方未完全框選到的表頭
        # -----------------------------------------------------------------
        try:
            expand_roi = fitz.Rect(
                roi_rect.x0 - 5, roi_rect.y0 - 5,
                roi_rect.x1 + 5, roi_rect.y1 + 5
            )
            tables = page.find_tables(clip=expand_roi)
            if tables and len(tables.tables) > 0:
                for table in tables.tables:
                    for cell_bbox in table.cells:
                        cell_rect = fitz.Rect(cell_bbox)
                        center_p = fitz.Point((cell_rect.x0 + cell_rect.x1) / 2.0, (cell_rect.y0 + cell_rect.y1) / 2.0)
                        
                        # 核心判斷：中心點在 ROI 內，且儲存格頂部 y0 不能顯著高於 ROI 起點 (避開上方表頭)
                        if roi_rect.contains(center_p) and (cell_rect.y0 >= roi_rect.y0 - 8):
                            cells.append(cell_rect)
        except Exception as e:
            print(f"⚠️ PyMuPDF 向量檢測跳過: {e}")

        # -----------------------------------------------------------------
        # 2. OpenCV 影像處理
        # 🎯 修正 #15：絕不盲目補 pix.height，只採用「兩條真實橫線之間」的區域
        # -----------------------------------------------------------------
        if not cells:
            try:
                dpi = 150
                scale = 72.0 / dpi
                pix = page.get_pixmap(clip=roi_rect, dpi=dpi)
                img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
                gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
                
                _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

                # A. 水平線分析 (Y 軸)
                kernel_w = max(int(pix.width * 0.15), 5)
                kernel_h_elem = cv2.getStructuringElement(cv2.MORPH_RECT, (kernel_w, 1))
                horiz_lines = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, kernel_h_elem)

                y_proj = np.sum(horiz_lines, axis=1)
                line_y_indices = np.where(y_proj > 0)[0]

                y_cuts = []
                if len(line_y_indices) > 0:
                    current_group = [line_y_indices[0]]
                    for y in line_y_indices[1:]:
                        if y - current_group[-1] <= 4:
                            current_group.append(y)
                        else:
                            y_cuts.append(int(np.mean(current_group)))
                            current_group = [y]
                    y_cuts.append(int(np.mean(current_group)))

                # ⚠️ 關鍵修復 #15：移除 y_cuts.append(pix.height)，不強迫補底邊！

                # B. 垂直線分析 (X 軸)
                kernel_h_v = max(int(pix.height * 0.15), 5)
                kernel_v_elem = cv2.getStructuringElement(cv2.MORPH_RECT, (1, kernel_h_v))
                vert_lines = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, kernel_v_elem)

                x_proj = np.sum(vert_lines, axis=0)
                line_x_indices = np.where(x_proj > 0)[0]

                x_cuts = []
                if len(line_x_indices) > 0:
                    current_group = [line_x_indices[0]]
                    for x in line_x_indices[1:]:
                        if x - current_group[-1] <= 4:
                            current_group.append(x)
                        else:
                            x_cuts.append(int(np.mean(current_group)))
                            current_group = [x]
                    x_cuts.append(int(np.mean(current_group)))

                real_x0 = roi_rect.x0 + (x_cuts[0] * scale) if len(x_cuts) >= 1 else roi_rect.x0
                real_x1 = roi_rect.x0 + (x_cuts[-1] * scale) if len(x_cuts) >= 2 else roi_rect.x1

                # 只有當找到至少兩條真實橫線時，相鄰橫線間才算一個儲存格
                for i in range(len(y_cuts) - 1):
                    top_y = y_cuts[i]
                    bot_y = y_cuts[i+1]
                    cell_top = roi_rect.y0 + top_y * scale
                    cell_bot = roi_rect.y0 + bot_y * scale

                    # ⚠️ 關鍵修復 #1：若儲存格頂部顯著高於拉框起點，過濾掉 (避開表頭)
                    if cell_top < roi_rect.y0 - 8:
                        continue

                    cell_h = bot_y - top_y
                    if cell_h > 6:
                        pdf_cell = fitz.Rect(real_x0, cell_top, real_x1, cell_bot)
                        cells.append(pdf_cell)
            except Exception as e:
                print(f"⚠️ 影像分析切割失敗: {e}")

        # -----------------------------------------------------------------
        # 3. 保底與線條吸附
        # -----------------------------------------------------------------
        if not cells:
            print("💡 嘗試尋找頁面向量線段自動對齊 X 軸...")
            real_x0, real_x1 = TableCellDetector._snap_x_to_vector_lines(page, roi_rect)
            cells.append(fitz.Rect(real_x0, roi_rect.y0, real_x1, roi_rect.y1))

        # 去重與排序
        unique_cells = []
        for c in cells:
            if not any(abs(c.x0 - u.x0) < 2 and abs(c.y0 - u.y0) < 2 and abs(c.x1 - u.x1) < 2 and abs(c.y1 - u.y1) < 2 for u in unique_cells):
                unique_cells.append(c)

        unique_cells.sort(key=lambda r: (r.y0, r.x0))
        return unique_cells

    @staticmethod
    def _snap_x_to_vector_lines(page: fitz.Page, roi: fitz.Rect) -> tuple[float, float]:
        x0, x1 = roi.x0, roi.x1
        try:
            drawings = page.get_drawings()
            vertical_x_coords = []

            for path in drawings:
                for item in path.get("items", []):
                    if item[0] == "l":
                        p1, p2 = item[1], item[2]
                        if abs(p1.x - p2.x) < 1.5:
                            if (min(p1.y, p2.y) <= roi.y1 + 10) and (max(p1.y, p2.y) >= roi.y0 - 10):
                                vertical_x_coords.append(p1.x)

            if vertical_x_coords:
                closest_x0 = min(vertical_x_coords, key=lambda x: abs(x - roi.x0))
                closest_x1 = min(vertical_x_coords, key=lambda x: abs(x - roi.x1))

                if abs(closest_x0 - roi.x0) < 25:
                    x0 = closest_x0
                if abs(closest_x1 - roi.x1) < 25:
                    x1 = closest_x1
        except Exception as e:
            print(f"⚠️ 向量線條吸附失敗: {e}")

        return x0, x1