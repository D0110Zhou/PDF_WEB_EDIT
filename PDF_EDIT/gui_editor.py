import sys
import os
import json
import warnings
# 靜音 PyMuPDF 的 layout 提示警告
warnings.filterwarnings("ignore")

import pymupdf as fitz
from PySide6.QtWidgets import (QApplication, QMainWindow, QWidget, QHBoxLayout, 
                               QVBoxLayout, QLabel, QLineEdit, QScrollArea, 
                               QPushButton, QFileDialog, QFormLayout, QComboBox, 
                               QGroupBox, QCheckBox, QDoubleSpinBox, QGridLayout, QMessageBox, QFrame,
                               QTabWidget)
from PySide6.QtGui import QPixmap, QImage, QPainter, QPen, QColor, QFont, QFontDatabase
from PySide6.QtCore import Qt, QRectF, QPointF, Signal, QTimer

from page_parser import PDFPageParser
from table_detector import TableCellDetector
from pdf_writer import PDFWriter, DEFAULT_STYLE, normalize_style

def parse_indices(range_str: str, max_count: int) -> list[int]:
    """ 解析如 '1-4,8,9' 的字串為 0-based 索引陣列 """
    indices = set()
    parts = range_str.replace(" ", "").split(",")
    for part in parts:
        if not part:
            continue
        if "-" in part:
            try:
                s, e = part.split("-")
                for i in range(int(s), int(e) + 1):
                    if 1 <= i <= max_count:
                        indices.add(i - 1)
            except ValueError:
                pass
        else:
            try:
                i = int(part)
                if 1 <= i <= max_count:
                    indices.add(i - 1)
            except ValueError:
                pass
    return sorted(list(indices))


class ToastNotification(QFrame):
    """ 右下角浮動通知元件 """
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setStyleSheet("""
            ToastNotification {
                background-color: rgba(30, 30, 30, 220);
                border: 1px solid #0078D7;
                border-radius: 6px;
            }
            QLabel {
                color: #FFFFFF;
                font-size: 12px;
                font-weight: bold;
                padding: 6px 12px;
            }
        """)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(4, 4, 4, 4)
        self.label = QLabel("")
        layout.addWidget(self.label)
        
        self.hide()
        self.timer = QTimer(self)
        self.timer.setSingleShot(True)
        self.timer.timeout.connect(self.hide)

    def show_message(self, message: str, duration: int = 2500):
        self.label.setText(message)
        self.adjustSize()
        if self.parent():
            p_rect = self.parent().rect()
            x = p_rect.width() - self.width() - 25
            y = p_rect.height() - self.height() - 25
            self.move(x, y)
        self.show()
        self.raise_()
        self.timer.start(duration)


class PDFCanvas(QLabel):
    roi_selected = Signal(fitz.Rect)

    def __init__(self):
        super().__init__()
        self.start_pos = None
        self.current_roi = None
        self.user_roi = None
        self.cells = []
        self.cell_texts = []
        self.scale = 1.0

        # 文字樣式與字體:與 PDFWriter 共用同一套排版 (由 MainWindow 傳入同一個 dict)
        self.text_style = dict(DEFAULT_STYLE)
        self.fonts = PDFWriter.get_fonts()
        self.qt_families = [
            self._register_qt_font(self.fonts.primary_path, "Arial"),
            self._register_qt_font(self.fonts.fallback_path, "Microsoft JhengHei"),
        ]

        self.show_user_roi = True
        self.show_detected_cells = True
        self.show_text_preview = True

        self.setAlignment(Qt.AlignLeft | Qt.AlignTop)

    @staticmethod
    def _register_qt_font(path, default_family):
        if path:
            fid = QFontDatabase.addApplicationFont(path)
            if fid != -1:
                fams = QFontDatabase.applicationFontFamilies(fid)
                if fams:
                    return fams[0]
        return default_family

    def mousePressEvent(self, event):
        if event.button() == Qt.LeftButton:
            self.start_pos = event.position()
            self.current_roi = None
            self.update()

    def mouseMoveEvent(self, event):
        if self.start_pos:
            curr = event.position()
            self.current_roi = QRectF(self.start_pos, curr).normalized()
            self.update()

    def mouseReleaseEvent(self, event):
        if event.button() == Qt.LeftButton and self.current_roi:
            pdf_rect = fitz.Rect(
                self.current_roi.left() / self.scale,
                self.current_roi.top() / self.scale,
                self.current_roi.right() / self.scale,
                self.current_roi.bottom() / self.scale
            )
            self.user_roi = pdf_rect
            self.start_pos = None
            self.current_roi = None
            self.roi_selected.emit(pdf_rect)

    def paintEvent(self, event):
        super().paintEvent(event)
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing)
        painter.setRenderHint(QPainter.TextAntialiasing)

        # 1. 使用者框選 (橘黃虛線)
        if self.show_user_roi:
            pen_user = QPen(QColor(255, 140, 0), 2, Qt.DashLine)
            painter.setPen(pen_user)
            painter.setBrush(QColor(255, 215, 0, 30))

            if self.current_roi:
                painter.drawRect(self.current_roi)
            elif self.user_roi:
                screen_user_rect = QRectF(
                    self.user_roi.x0 * self.scale, self.user_roi.y0 * self.scale,
                    self.user_roi.width * self.scale, self.user_roi.height * self.scale
                )
                painter.drawRect(screen_user_rect)

        # 2. 儲存格藍框與文字預覽 (支援緊湊行距)
        if self.show_detected_cells:
            pen_cell = QPen(QColor(0, 120, 215), 2, Qt.SolidLine)
            
            for idx, cell in enumerate(self.cells, 1):
                screen_rect = QRectF(
                    cell.x0 * self.scale, cell.y0 * self.scale,
                    cell.width * self.scale, cell.height * self.scale
                )
                painter.setPen(pen_cell)
                painter.setBrush(QColor(0, 120, 215, 25))
                painter.drawRect(screen_rect)

                # 編號點
                painter.setPen(QPen(QColor(255, 255, 255)))
                painter.setBrush(QColor(220, 50, 50))
                painter.drawEllipse(screen_rect.topLeft(), 9, 9)
                painter.drawText(QRectF(screen_rect.x() - 9, screen_rect.y() - 9, 18, 18), Qt.AlignCenter, str(idx))

                # 文字預覽:與 PDF 匯出共用 PDFWriter.layout_cell,位置/換行/字級完全一致
                if self.show_text_preview and (idx - 1) < len(self.cell_texts):
                    txt = self.cell_texts[idx - 1]
                    layout = PDFWriter.layout_cell(txt, cell, self.fonts, self.text_style)
                    if layout:
                        painter.setPen(QColor(0, 0, 0))   # 明確指定純黑 (避免沿用編號白字的畫筆)
                        k = layout["fontsize"] * self.scale / 100.0
                        for line in layout["lines"]:
                            for font_idx, seg, x in line["runs"]:
                                f = QFont(self.qt_families[font_idx])
                                f.setPixelSize(100)
                                f.setBold(False)
                                f.setKerning(False)
                                f.setHintingPreference(QFont.PreferNoHinting)
                                painter.save()
                                painter.translate(x * self.scale, line["baseline"] * self.scale)
                                painter.scale(k, k)
                                painter.setFont(f)
                                painter.drawText(QPointF(0, 0), seg)
                                painter.restore()

        # 🎯 顯式結束繪圖，防止出現 QBackingStore::endPaint 警告
        painter.end()


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("PDF 表格編輯器")
        self.resize(1400, 900)

        self.pdf_path = ""
        self.pdf_parser = None
        self.parsed_pages = []
        self.current_page_idx = 0
        self.zoom_factor = 0.5
        
        self.cells = []
        self.original_cells = []
        self.inputs = []

        self.project_data = {}
        self.text_style = dict(DEFAULT_STYLE)   # 不可命名為 self.style (會蓋掉 QWidget.style())
        self.init_ui()

        self.toast = ToastNotification(self)

    def resizeEvent(self, event):
        super().resizeEvent(event)
        if hasattr(self, 'toast') and self.toast.isVisible():
            p_rect = self.rect()
            self.toast.move(p_rect.width() - self.toast.width() - 25, p_rect.height() - self.toast.height() - 25)

    def closeEvent(self, event):
        self.save_current_page_state(show_toast=False)
        self.sort_project_data()
        event.accept()

    def sort_project_data(self):
        if not self.project_data:
            return
        sorted_keys = sorted([int(k) for k in self.project_data.keys()])
        self.project_data = {str(k): self.project_data[str(k)] for k in sorted_keys}

    def init_ui(self):
        main_widget = QWidget()
        layout = QHBoxLayout(main_widget)
        layout.setContentsMargins(5, 5, 5, 5)

        self.canvas = PDFCanvas()
        self.canvas.text_style = self.text_style
        self.canvas.roi_selected.connect(self.on_roi_selected)

        self.scroll = QScrollArea()
        self.scroll.setWidget(self.canvas)
        self.scroll.setWidgetResizable(True)
        layout.addWidget(self.scroll, stretch=1)

        right_panel = QWidget()
        right_panel.setFixedWidth(360)
        right_layout = QVBoxLayout(right_panel)
        right_layout.setContentsMargins(5, 5, 5, 5)

        # 右側分兩頁:第 1 頁 = 控制功能,第 2 頁 = 儲存格文字編輯
        self.right_tabs = QTabWidget()
        page_ctrl = QWidget()
        page_ctrl_layout = QVBoxLayout(page_ctrl)
        page_ctrl_layout.setContentsMargins(2, 2, 2, 2)
        scroll_ctrl = QScrollArea()          # 螢幕矮時第 1 頁可捲動
        scroll_ctrl.setWidgetResizable(True)
        scroll_ctrl.setFrameShape(QFrame.NoFrame)
        scroll_ctrl.setWidget(page_ctrl)

        page_edit = QWidget()
        page_edit_layout = QVBoxLayout(page_edit)
        page_edit_layout.setContentsMargins(2, 2, 2, 2)

        self.right_tabs.addTab(scroll_ctrl, "🎛 控制")
        self.right_tabs.addTab(page_edit, "✏️ 文字編輯")
        right_layout.addWidget(self.right_tabs, stretch=1)

        # --- 1. 專案存檔與 PDF 載入 ---
        grp_proj = QGroupBox("📁 專案進度存取")
        layout_proj = QVBoxLayout(grp_proj)

        layout_proj_btns = QHBoxLayout()
        self.btn_save_proj = QPushButton("💾 儲存專案 (.json)")
        self.btn_save_proj.clicked.connect(self.save_project)
        self.btn_load_proj = QPushButton("📂 載入專案 (.json)")
        self.btn_load_proj.clicked.connect(self.load_project)
        layout_proj_btns.addWidget(self.btn_save_proj)
        layout_proj_btns.addWidget(self.btn_load_proj)
        layout_proj.addLayout(layout_proj_btns)

        self.btn_open = QPushButton("開啟 PDF 檔案")
        self.btn_open.clicked.connect(self.open_pdf)
        layout_proj.addWidget(self.btn_open)

        layout_proj.addWidget(QLabel("頁碼範圍 (例: 1, 5-7):"))
        self.range_input = QLineEdit("1")
        layout_proj.addWidget(self.range_input)

        self.btn_parse_range = QPushButton("解析頁碼範圍")
        self.btn_parse_range.clicked.connect(self.parse_and_load_pages)
        layout_proj.addWidget(self.btn_parse_range)

        layout_proj.addWidget(QLabel("選擇要編輯的頁面:"))
        self.combo_pages = QComboBox()
        self.combo_pages.currentIndexChanged.connect(self.on_page_selected)
        layout_proj.addWidget(self.combo_pages)

        page_ctrl_layout.addWidget(grp_proj)

        # --- 2. 批量微調與寬高縮放 ---
        grp_adjust = QGroupBox("🎯 格子位置與寬高微調")
        layout_adjust = QVBoxLayout(grp_adjust)

        layout_adjust.addWidget(QLabel("目標表格編號 (例: 1-4,8,9):"))
        self.batch_range_input = QLineEdit("1-4,8,9")
        layout_adjust.addWidget(self.batch_range_input)

        layout_step = QHBoxLayout()
        layout_step.addWidget(QLabel("微調步長 (pt):"))
        self.spin_step = QDoubleSpinBox()
        self.spin_step.setRange(0.1, 20.0)
        self.spin_step.setValue(1.0)
        self.spin_step.setSingleStep(0.5)
        layout_step.addWidget(self.spin_step)
        layout_adjust.addLayout(layout_step)

        grid_btns = QGridLayout()
        
        btn_up = QPushButton("▲ 上移")
        btn_down = QPushButton("▼ 下移")
        btn_left = QPushButton("◄ 左移")
        btn_right = QPushButton("► 右移")

        btn_w_dec = QPushButton("寬 - (壓縮)")
        btn_w_inc = QPushButton("寬 + (擴張)")
        btn_h_dec = QPushButton("高 - (壓縮)")
        btn_h_inc = QPushButton("高 + (擴張)")

        btn_up.clicked.connect(lambda: self.adjust_selected_cells(dy=-self.spin_step.value()))
        btn_down.clicked.connect(lambda: self.adjust_selected_cells(dy=self.spin_step.value()))
        btn_left.clicked.connect(lambda: self.adjust_selected_cells(dx=-self.spin_step.value()))
        btn_right.clicked.connect(lambda: self.adjust_selected_cells(dx=self.spin_step.value()))

        btn_w_dec.clicked.connect(lambda: self.adjust_selected_cells(dw=-self.spin_step.value()))
        btn_w_inc.clicked.connect(lambda: self.adjust_selected_cells(dw=self.spin_step.value()))
        btn_h_dec.clicked.connect(lambda: self.adjust_selected_cells(dh=-self.spin_step.value()))
        btn_h_inc.clicked.connect(lambda: self.adjust_selected_cells(dh=self.spin_step.value()))

        grid_btns.addWidget(btn_up, 0, 1)
        grid_btns.addWidget(btn_left, 1, 0)
        grid_btns.addWidget(btn_right, 1, 2)
        grid_btns.addWidget(btn_down, 2, 1)

        grid_btns.addWidget(btn_w_dec, 3, 0)
        grid_btns.addWidget(btn_w_inc, 3, 1)
        grid_btns.addWidget(btn_h_dec, 4, 0)
        grid_btns.addWidget(btn_h_inc, 4, 1)

        layout_adjust.addLayout(grid_btns)

        self.btn_reset_cells = QPushButton("↺ 還原選取格子初次偵測")
        self.btn_reset_cells.setStyleSheet("background-color: #FFF0F0; color: #C00000; font-weight: bold;")
        self.btn_reset_cells.clicked.connect(self.reset_selected_cells)
        layout_adjust.addWidget(self.btn_reset_cells)

        page_ctrl_layout.addWidget(grp_adjust)

        # --- 2.5 文字樣式 (字體 / 大小 / 行距) ---
        grp_style = QGroupBox("🔤 文字樣式")
        layout_style = QGridLayout(grp_style)

        self.lbl_font_info = QLabel(f"字體: {PDFWriter.get_fonts().description} (標準)")
        self.lbl_font_info.setWordWrap(True)
        layout_style.addWidget(self.lbl_font_info, 0, 0, 1, 2)

        layout_style.addWidget(QLabel("字體大小 (pt):"), 1, 0)
        self.spin_font_size = QDoubleSpinBox()
        self.spin_font_size.setRange(4.0, 72.0)
        self.spin_font_size.setDecimals(1)
        self.spin_font_size.setSingleStep(0.5)
        self.spin_font_size.setValue(DEFAULT_STYLE["font_size"])
        layout_style.addWidget(self.spin_font_size, 1, 1)

        layout_style.addWidget(QLabel("行距 (× 字級):"), 2, 0)
        self.spin_line_spacing = QDoubleSpinBox()
        self.spin_line_spacing.setRange(0.50, 3.00)
        self.spin_line_spacing.setDecimals(2)
        self.spin_line_spacing.setSingleStep(0.01)      # 最小調整單位 0.01
        self.spin_line_spacing.setValue(DEFAULT_STYLE["line_spacing"])
        self.spin_line_spacing.setToolTip("每按一次箭頭 ±0.01;也可直接輸入數值")
        layout_style.addWidget(self.spin_line_spacing, 2, 1)

        self.chk_auto_fit = QCheckBox("文字過多時自動縮小以符合格子")
        self.chk_auto_fit.setChecked(DEFAULT_STYLE["auto_fit"])
        layout_style.addWidget(self.chk_auto_fit, 3, 0, 1, 2)

        self.spin_font_size.valueChanged.connect(self.on_style_changed)
        self.spin_line_spacing.valueChanged.connect(self.on_style_changed)
        self.chk_auto_fit.toggled.connect(self.on_style_changed)

        page_ctrl_layout.addWidget(grp_style)

        # --- 3. 檢視控制 ---
        grp_view = QGroupBox("檢視控制")
        layout_view = QVBoxLayout(grp_view)

        layout_view.addWidget(QLabel("縮放比例:"))
        self.combo_zoom = QComboBox()
        self.combo_zoom.addItems(["50%", "75%", "100%", "125%", "150%", "200%"])
        self.combo_zoom.setCurrentText("50%")
        self.combo_zoom.currentTextChanged.connect(self.on_zoom_changed)
        layout_view.addWidget(self.combo_zoom)

        page_ctrl_layout.addWidget(grp_view)

        # --- 4. 表格內容編輯 ---
        grp_edit = QGroupBox("儲存格文字編輯")
        layout_edit = QVBoxLayout(grp_edit)

        self.form_layout = QFormLayout()
        form_widget = QWidget()
        form_widget.setLayout(self.form_layout)

        scroll_form = QScrollArea()
        scroll_form.setWidgetResizable(True)
        scroll_form.setWidget(form_widget)
        layout_edit.addWidget(scroll_form)

        page_edit_layout.addWidget(grp_edit, stretch=1)

        page_ctrl_layout.addStretch(1)

        self.btn_export = QPushButton("匯出修改後的 PDF (所有編輯頁)")
        self.btn_export.setStyleSheet("font-weight: bold; padding: 10px; background-color: #0078D7; color: white;")
        self.btn_export.clicked.connect(self.export_pdf)
        right_layout.addWidget(self.btn_export)

        layout.addWidget(right_panel)
        self.setCentralWidget(main_widget)

    # -----------------------------------------------------------------
    # 文字樣式
    # -----------------------------------------------------------------
    def on_style_changed(self, *_):
        self.text_style.update({
            "font_size": self.spin_font_size.value(),
            "line_spacing": self.spin_line_spacing.value(),
            "auto_fit": self.chk_auto_fit.isChecked(),
        })
        self.canvas.update()

    def apply_style_to_widgets(self, style: dict | None):
        st = normalize_style(style)
        for w in (self.spin_font_size, self.spin_line_spacing, self.chk_auto_fit):
            w.blockSignals(True)
        self.spin_font_size.setValue(st["font_size"])
        self.spin_line_spacing.setValue(st["line_spacing"])
        self.chk_auto_fit.setChecked(st["auto_fit"])
        for w in (self.spin_font_size, self.spin_line_spacing, self.chk_auto_fit):
            w.blockSignals(False)
        self.text_style.update(st)
        self.canvas.update()

    # -----------------------------------------------------------------
    # 狀態儲存、Toast 浮動通知與 JSON Save / Load
    # -----------------------------------------------------------------
    def save_current_page_state(self, show_toast: bool = True):
        if self.pdf_parser and self.cells:
            texts = [inp.text() for inp in self.inputs]
            user_roi = [self.canvas.user_roi.x0, self.canvas.user_roi.y0, self.canvas.user_roi.x1, self.canvas.user_roi.y1] if self.canvas.user_roi else None
            
            p_key = str(self.current_page_idx)
            self.project_data[p_key] = {
                "user_roi": user_roi,
                "cells": [[c.x0, c.y0, c.x1, c.y1] for c in self.cells],
                "original_cells": [[c.x0, c.y0, c.x1, c.y1] for c in self.original_cells],
                "texts": texts
            }

            if show_toast:
                p_display = self.current_page_idx + 1
                total_edited = len(self.project_data)
                self.toast.show_message(f"第 {p_display} 頁編輯已暫存！目前累計已記錄 {total_edited} 頁數據")

    def load_page_state(self, page_idx: int):
        self.clear_cells_and_inputs_ui()
        p_str = str(page_idx)

        if p_str in self.project_data:
            pdata = self.project_data[p_str]
            
            if pdata.get("user_roi"):
                r = pdata["user_roi"]
                self.canvas.user_roi = fitz.Rect(r[0], r[1], r[2], r[3])
            
            self.cells = [fitz.Rect(c[0], c[1], c[2], c[3]) for c in pdata.get("cells", [])]
            self.original_cells = [fitz.Rect(c[0], c[1], c[2], c[3]) for c in pdata.get("original_cells", [])]
            
            texts = pdata.get("texts", [])
            self.rebuild_inputs_ui(texts)
            self.canvas.cells = self.cells
            self.canvas.cell_texts = texts
            self.canvas.update()

    def save_project(self):
        self.save_current_page_state(show_toast=False)
        if not self.project_data:
            QMessageBox.warning(self, "提示", "目前沒有任何編輯紀錄可供儲存！")
            return

        self.sort_project_data()
        init_dir = os.getcwd()
        save_path, _ = QFileDialog.getSaveFileName(self, "儲存專案進度", os.path.join(init_dir, "pdf_editor_project.json"), "JSON Files (*.json)")
        if save_path:
            out_data = {
                "pdf_path": self.pdf_path,
                "style": self.text_style,
                "project_data": self.project_data
            }
            with open(save_path, "w", encoding="utf-8") as f:
                json.dump(out_data, f, ensure_ascii=False, indent=2)
            QMessageBox.information(self, "成功", f"專案進度已儲存！共計 {len(self.project_data)} 頁資料 (已自動升序排列)")

    def load_project(self):
        init_dir = os.getcwd()
        load_path, _ = QFileDialog.getOpenFileName(self, "載入專案進度", init_dir, "JSON Files (*.json)")
        if not load_path:
            return

        try:
            with open(load_path, "r", encoding="utf-8") as f:
                data = json.load(f)

            if "project_data" not in data:
                QMessageBox.critical(self, "錯誤", "不合法的 JSON 專案檔案格式！")
                return

            pdf_path = data.get("pdf_path", "")
            if not pdf_path or not os.path.exists(pdf_path):
                msg_box = QMessageBox(self)
                msg_box.setIcon(QMessageBox.Warning)
                msg_box.setWindowTitle("警告：找不到對應的 PDF 檔案")
                msg_box.setText("專案內記載的 PDF 檔案路徑無效或檔案不存在。\n請指定對應的原 PDF 檔案才能繼續載入專案！")
                msg_box.setStandardButtons(QMessageBox.Ok | QMessageBox.Cancel)
                
                if msg_box.exec() != QMessageBox.Ok:
                    return

                pdf_path, _ = QFileDialog.getOpenFileName(self, "請指定該專案對應的 PDF 檔案", os.getcwd(), "PDF Files (*.pdf)")
                if not pdf_path or not os.path.exists(pdf_path):
                    QMessageBox.critical(self, "阻擋載入", "未提供有效的 PDF 檔案，專案載入已終止。")
                    return

            self.pdf_path = pdf_path
            self.pdf_parser = PDFPageParser(pdf_path)
            self.clear_cells_and_inputs_ui()
            self.project_data = data.get("project_data", {})
            self.apply_style_to_widgets(data.get("style"))
            self.sort_project_data()

            edited_pages = sorted([int(k) for k in self.project_data.keys()])
            self.parsed_pages = edited_pages

            self.combo_pages.blockSignals(True)
            self.combo_pages.clear()
            for p in edited_pages:
                self.combo_pages.addItem(f"第 {p + 1} 頁 (Page {p + 1})", p)
            self.combo_pages.blockSignals(False)

            if edited_pages:
                self.current_page_idx = edited_pages[0]
                self.render_page()
                self.load_page_state(self.current_page_idx)

            QMessageBox.information(self, "成功", f"成功載入專案！共記錄 {len(self.project_data)} 頁數據。")
        except Exception as e:
            QMessageBox.critical(self, "錯誤", f"專案檔載入失敗: {e}")

    # -----------------------------------------------------------------
    # 格子位置平移與寬高微調
    # -----------------------------------------------------------------
    def adjust_selected_cells(self, dx: float = 0.0, dy: float = 0.0, dw: float = 0.0, dh: float = 0.0):
        if not self.cells:
            return
        target_indices = parse_indices(self.batch_range_input.text(), len(self.cells))
        for idx in target_indices:
            old = self.cells[idx]
            new_x0 = old.x0 + dx - (dw / 2.0)
            new_x1 = old.x1 + dx + (dw / 2.0)
            new_y0 = old.y0 + dy - (dh / 2.0)
            new_y1 = old.y1 + dy + (dh / 2.0)
            
            if (new_x1 - new_x0) >= 5.0 and (new_y1 - new_y0) >= 5.0:
                self.cells[idx] = fitz.Rect(new_x0, new_y0, new_x1, new_y1)

        self.canvas.cells = self.cells
        self.canvas.update()
        self.save_current_page_state()

    def reset_selected_cells(self):
        if not self.cells or not self.original_cells:
            return
        target_indices = parse_indices(self.batch_range_input.text(), len(self.cells))
        for idx in target_indices:
            if idx < len(self.original_cells):
                self.cells[idx] = fitz.Rect(self.original_cells[idx])

        self.canvas.cells = self.cells
        self.canvas.update()
        self.save_current_page_state()

    # -----------------------------------------------------------------
    # UI 事件與頁面切換控制
    # -----------------------------------------------------------------
    def open_pdf(self):
        file_path, _ = QFileDialog.getOpenFileName(self, "開啟 PDF", os.getcwd(), "PDF Files (*.pdf)")
        if not file_path:
            return
        # 先清空舊頁面狀態,避免舊 PDF 的格子被寫進新專案
        self.clear_cells_and_inputs_ui()
        self.pdf_path = file_path
        self.pdf_parser = PDFPageParser(file_path)
        self.project_data.clear()
        self.parse_and_load_pages()

    def parse_and_load_pages(self):
        if not self.pdf_parser:
            return
        self.save_current_page_state(show_toast=False)
        range_str = self.range_input.text()
        self.parsed_pages = self.pdf_parser.parse_page_range(range_str)

        self.combo_pages.blockSignals(True)
        self.combo_pages.clear()
        for p in self.parsed_pages:
            self.combo_pages.addItem(f"第 {p + 1} 頁 (Page {p + 1})", p)
        self.combo_pages.blockSignals(False)

        if self.parsed_pages:
            self.current_page_idx = self.parsed_pages[0]
            self.render_page()
            self.load_page_state(self.current_page_idx)

    def on_page_selected(self, index: int):
        if index < 0:
            return
        page_val = self.combo_pages.currentData()
        if page_val is None:
            return

        self.save_current_page_state(show_toast=False)
        self.current_page_idx = int(page_val)
        self.render_page()
        self.load_page_state(self.current_page_idx)

    def on_zoom_changed(self, zoom_text: str):
        self.zoom_factor = int(zoom_text.replace("%", "")) / 100.0
        if self.pdf_parser:
            self.render_page()

    def render_page(self):
        try:
            target_dpi = int(150 * self.zoom_factor)
            pix, scale = self.pdf_parser.get_page_pixmap(self.current_page_idx, dpi=target_dpi)
            img = QImage(bytes(pix.samples), pix.width, pix.height, pix.stride, QImage.Format_RGB888).copy()

            self.canvas.setPixmap(QPixmap.fromImage(img))
            self.canvas.scale = scale
            self.canvas.setFixedSize(pix.width, pix.height)
            self.canvas.adjustSize()
        except Exception as e:
            print(f"渲染第 {self.current_page_idx + 1} 頁失敗: {e}")

    def clear_cells_and_inputs_ui(self):
        self.cells = []
        self.original_cells = []
        self.canvas.cells = []
        self.canvas.cell_texts = []
        self.canvas.user_roi = None
        self.canvas.update()
        for i in reversed(range(self.form_layout.count())):
            self.form_layout.itemAt(i).widget().setParent(None)
        self.inputs.clear()

    def rebuild_inputs_ui(self, texts: list[str]):
        for i in reversed(range(self.form_layout.count())):
            self.form_layout.itemAt(i).widget().setParent(None)
        self.inputs.clear()

        for idx in range(1, len(self.cells) + 1):
            inp = QLineEdit()
            if (idx - 1) < len(texts):
                inp.setText(texts[idx - 1])
            inp.textChanged.connect(self.sync_preview_text)
            self.form_layout.addRow(f"儲存格 #{idx}:", inp)
            self.inputs.append(inp)

    def sync_preview_text(self):
        self.canvas.cell_texts = [inp.text() for inp in self.inputs]
        self.canvas.update()
        self.save_current_page_state(show_toast=True)

    def on_roi_selected(self, roi_rect: fitz.Rect):
        self.clear_cells_and_inputs_ui()
        self.canvas.user_roi = roi_rect

        page = self.pdf_parser.doc[self.current_page_idx]
        raw_cells = TableCellDetector.detect_cells_in_roi(page, roi_rect)
        
        self.cells = []
        for c in raw_cells:
            expanded_rect = fitz.Rect(c.x0 - 1.2, c.y0 - 1.2, c.x1 + 1.2, c.y1 + 1.2)
            self.cells.append(expanded_rect)

        self.original_cells = [fitz.Rect(c) for c in self.cells]

        self.canvas.cells = self.cells
        self.rebuild_inputs_ui([])
        self.save_current_page_state(show_toast=True)

    def export_pdf(self):
        self.save_current_page_state(show_toast=False)
        if not self.project_data:
            QMessageBox.warning(self, "提示", "沒有可供匯出的編輯內容！")
            return

        self.sort_project_data()

        init_dir = os.path.dirname(self.pdf_path) or os.getcwd()
        save_path, _ = QFileDialog.getSaveFileName(self, "儲存 PDF", os.path.join(init_dir, "output_multipage.pdf"), "PDF Files (*.pdf)")
        if not save_path or not self.pdf_parser:
            return

        if os.path.abspath(save_path) == os.path.abspath(self.pdf_path):
            QMessageBox.warning(self, "提示", "不能覆蓋正在編輯的原始 PDF,請另存新檔名。")
            return

        try:
            # 以原始檔重新開啟一份文件來寫入,不影響目前畫面上的 PDF
            n = PDFWriter.write_project_to_pdf(self.pdf_path, self.project_data, save_path, self.text_style)
        except Exception as e:
            QMessageBox.critical(self, "匯出失敗", f"匯出 PDF 時發生錯誤:\n{e}")
            return
        QMessageBox.information(self, "成功", f"已成功將 {n} 頁的編輯內容匯出至 PDF!\n{save_path}")

if __name__ == "__main__":
    app = QApplication(sys.argv)
    window = MainWindow()
    window.show()
    sys.exit(app.exec())