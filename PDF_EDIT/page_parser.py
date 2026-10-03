import pymupdf as fitz
import re

class PDFPageParser:
    def __init__(self, pdf_path: str):
        self.doc = fitz.open(pdf_path)

    def parse_page_range(self, range_str: str) -> list[int]:
        """
        將 '5-7,11,13-16' 轉為從 0 開始的索引清單 [4, 5, 6, 10, 12, 13, 14, 15]
        """
        pages = set()
        parts = [p.strip() for p in range_str.split(",") if p.strip()]
        total_pages = len(self.doc)

        for part in parts:
            if "-" in part:
                match = re.match(r"^(\d+)\s*-\s*(\d+)$", part)
                if match:
                    start, end = map(int, match.groups())
                    for p in range(start, end + 1):
                        if 1 <= p <= total_pages:
                            pages.add(p - 1)
            else:
                if part.isdigit():
                    p = int(part)
                    if 1 <= p <= total_pages:
                        pages.add(p - 1)

        return sorted(list(pages))

    def get_page_pixmap(self, page_index: int, dpi: int = 150):
        """將指定頁面渲染為高解析度 Pixmap"""
        page = self.doc[page_index]
        zoom = dpi / 72.0
        mat = fitz.Matrix(zoom, zoom)
        return page.get_pixmap(matrix=mat), zoom