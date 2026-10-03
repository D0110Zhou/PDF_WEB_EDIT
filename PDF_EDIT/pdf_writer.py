import os
import sys
import pymupdf as fitz

# 預設文字樣式:Calibri / 12pt / 標準字重
DEFAULT_STYLE = {
    "font_size": 12.0,     # pt
    "line_spacing": 1.0,   # 行距倍率 (× 字級),使用者可以 0.01 為單位微調
    "auto_fit": True,      # 文字過多時自動縮小以放進儲存格
}


def normalize_style(style: dict | None = None) -> dict:
    """ 補齊缺漏欄位並限制合理範圍 (舊版專案 JSON 沒有 style 時也能載入) """
    s = dict(DEFAULT_STYLE)
    if style:
        try:
            s["font_size"] = min(max(float(style.get("font_size", s["font_size"])), 1.0), 200.0)
            s["line_spacing"] = min(max(float(style.get("line_spacing", s["line_spacing"])), 0.3), 5.0)
            s["auto_fit"] = bool(style.get("auto_fit", s["auto_fit"]))
        except (TypeError, ValueError):
            pass
    return s


class FontSet:
    """ 主字體 (Calibri 或相容替代) + 中文備援字體,依字元自動挑選 (僅用於量測排版) """

    LATIN_PATHS = [
        "C:\\Windows\\Fonts\\calibri.ttf",
        "/Library/Fonts/Microsoft/Calibri.ttf",
        "/usr/share/fonts/truetype/crosextra/Carlito-Regular.ttf",   # Calibri 度量相容
        "/usr/share/fonts/truetype/msttcorefonts/Calibri.ttf",
    ]
    CJK_PATHS = [
        "C:\\Windows\\Fonts\\msjh.ttc",      # 微軟正黑體
        "C:\\Windows\\Fonts\\mingliu.ttc",
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    ]

    def __init__(self):
        self.primary_path = self._first_existing(self.LATIN_PATHS)
        self.fallback_path = self._first_existing(self.CJK_PATHS)
        self.primary = self._load(self.primary_path, "helv")
        self.fallback = self._load(self.fallback_path, "cjk")
        self._pick_cache = {}
        self._width_cache = {}

        base = os.path.basename(self.primary_path).lower() if self.primary_path else ""
        if base.startswith("calibri"):
            self.description = "Calibri"
            print("使用 Calibri 字體")
        elif base.startswith("carlito"):
            self.description = "Carlito (找不到 Calibri,改用相容字體)"
            print("Carlito (找不到 Calibri,改用相容字體)")
        else:
            self.description = "Helvetica (找不到 Calibri,改用內建字體)"
            print("Helvetica (找不到 Calibri,改用內建字體)")

    @staticmethod
    def _first_existing(paths):
        for p in paths:
            if os.path.exists(p):
                return p
        return None

    @staticmethod
    def _load(path, builtin):
        if path:
            try:
                return fitz.Font(fontfile=path)
            except Exception:
                pass
        try:
            return fitz.Font(builtin)
        except Exception:
            return None

    def get(self, idx: int):
        if idx == 1 and self.fallback is not None:
            return self.fallback
        return self.primary

    def pick(self, ch: str) -> int:
        """ 0 = 主字體,1 = 中文備援字體 """
        r = self._pick_cache.get(ch)
        if r is not None:
            return r
        r = 0
        try:
            if not self.primary.has_glyph(ord(ch)):
                if self.fallback is not None and self.fallback.has_glyph(ord(ch)):
                    r = 1
        except Exception:
            r = 0
        self._pick_cache[ch] = r
        return r

    def char_width(self, ch: str, fontsize: float) -> float:
        idx = self.pick(ch)
        key = (idx, ch)
        w1 = self._width_cache.get(key)
        if w1 is None:
            try:
                w1 = self.get(idx).text_length(ch, fontsize=1.0)
            except Exception:
                w1 = 0.5
            self._width_cache[key] = w1
        return w1 * fontsize

    def text_width(self, text: str, fontsize: float) -> float:
        return sum(self.char_width(c, fontsize) for c in text)


class PDFWriter:
    MIN_FONT_SIZE = 5.0
    PAD_X = 2.0
    PAD_Y = 1.0

    # ---- 寫入 PDF 的字體設定 (以「名稱參照」,不嵌入字體檔) ----
    # 資源名稱 (DA 裡的 /名稱) → BaseFont (編輯器/檢視器據此找系統字體)
    LATIN_RES = "Calibri"
    LATIN_BASEFONT = "Calibri"
    CJK_RES = "MSJH"
    CJK_BASEFONT = "MicrosoftJhengHei"

    _fonts = None

    @classmethod
    def get_fonts(cls) -> FontSet:
        if cls._fonts is None:
            cls._fonts = FontSet()
        return cls._fonts

    # -----------------------------------------------------------------
    # 排版核心:預覽視窗與最終 PDF 共用同一套計算,確保兩邊一致
    # -----------------------------------------------------------------
    @classmethod
    def wrap_text(cls, text: str, fonts: FontSet, fontsize: float, max_width: float) -> list[str]:
        lines = []
        for para in text.split("\n"):
            if not para:
                lines.append("")
                continue
            cur, cur_w, last_space = "", 0.0, -1
            for ch in para:
                if cur == "" and ch == " ":
                    continue  # 行首空白略過
                w = fonts.char_width(ch, fontsize)
                if cur and cur_w + w > max_width:
                    if ch == " ":
                        lines.append(cur.rstrip())
                        cur, cur_w, last_space = "", 0.0, -1
                        continue
                    if last_space >= 0:
                        head = cur[:last_space + 1].rstrip()
                        tail = cur[last_space + 1:]
                        lines.append(head)
                        cur, cur_w, last_space = tail, fonts.text_width(tail, fontsize), -1
                    else:
                        lines.append(cur)
                        cur, cur_w, last_space = "", 0.0, -1
                cur += ch
                cur_w += w
                if ch == " ":
                    last_space = len(cur) - 1
            if cur:
                lines.append(cur)
        return lines

    @classmethod
    def layout_cell(cls, text: str, rect, fonts: FontSet, style: dict | None = None):
        """
        回傳 {"fontsize": float, "lines": [{"baseline": y, "runs": [(font_idx, text, x), ...]}]}
        座標皆為 PDF 點數 (pt),水平/垂直皆置中。
        """
        if not text or not text.strip():
            return None
        style = normalize_style(style)

        avail_w = max(rect.width - 2 * cls.PAD_X, 8.0)
        avail_h = max(rect.height - 2 * cls.PAD_Y, 5.0)

        fs = style["font_size"]
        min_fs = min(cls.MIN_FONT_SIZE, fs)
        spacing = style["line_spacing"]

        while True:
            lines = cls.wrap_text(text, fonts, fs, avail_w)
            total_h = len(lines) * fs * spacing
            if (not style["auto_fit"]) or total_h <= avail_h or (fs - 0.5) < min_fs:
                break
            fs -= 0.5

        line_h = fs * spacing
        total_h = len(lines) * line_h

        asc = fonts.primary.ascender if fonts.primary else 0.8
        desc = fonts.primary.descender if fonts.primary else -0.2
        if asc <= 0 or (asc - desc) <= 0:
            asc, desc = 0.8, -0.2
        content_h = (asc - desc) * fs

        top = rect.y0 + (rect.height - total_h) / 2.0
        out_lines = []
        for i, line in enumerate(lines):
            if not line:
                continue
            # 依字元切成連續的同字體片段
            segs = []
            for ch in line:
                idx = fonts.pick(ch)
                if segs and segs[-1][0] == idx:
                    segs[-1][1] += ch
                else:
                    segs.append([idx, ch])
            line_w = sum(fonts.text_width(s[1], fs) for s in segs)
            x = rect.x0 + (rect.width - line_w) / 2.0
            baseline = top + i * line_h + (line_h - content_h) / 2.0 + asc * fs

            runs = []
            for idx, seg in segs:
                runs.append((idx, seg, x))
                x += fonts.text_width(seg, fs)
            out_lines.append({"baseline": baseline, "runs": runs})

        return {"fontsize": fs, "lines": out_lines}

    # -----------------------------------------------------------------
    # PDF 物件輔助
    # -----------------------------------------------------------------
    @staticmethod
    def _pdf_literal(s: str) -> str:
        """ 轉成 PDF 字面字串 (cp1252 編碼,再以 latin-1 放進 str) """
        raw = s.encode("cp1252")
        out = []
        for b in raw:
            c = chr(b)
            if c in "\\()":
                out.append("\\" + c)
            elif 32 <= b < 127:
                out.append(c)
            else:
                out.append(f"\\{b:03o}")
        return "(" + "".join(out) + ")"

    @staticmethod
    def _latin_encodable(s: str, fonts: FontSet) -> bool:
        """ 這一行能否只用 Calibri + WinAnsi 表示 """
        for ch in s:
            if fonts.pick(ch) != 0:
                return False
            try:
                ch.encode("cp1252")
            except UnicodeEncodeError:
                return False
        return True

    @staticmethod
    def _dict_xref(doc, owner_xref: int, key: str) -> int:
        """ 取得 owner[key] 這個字典的 xref;若不存在或是直接物件,轉成間接物件 """
        t, v = doc.xref_get_key(owner_xref, key)
        if t == "xref":
            return int(v.split()[0])
        new = doc.get_new_xref()
        doc.update_object(new, "<<>>" if t == "null" else v)
        doc.xref_set_key(owner_xref, key, f"{new} 0 R")
        return new

    @classmethod
    def _make_font_object(cls, doc, fonts: FontSet, base_font: str, metrics_font) -> int:
        """
        建立「不嵌入」的 TrueType 字體物件 (WinAnsi),附 Widths 與 FontDescriptor。
        Widths 取自實際量測用的字體 (Carlito 與 Calibri 度量相容),讓各編輯器排版一致。
        """
        widths = []
        for code in range(32, 256):
            try:
                ch = bytes([code]).decode("cp1252")
                w = int(round(metrics_font.text_length(ch, fontsize=1.0) * 1000)) if metrics_font else 500
            except Exception:
                w = 0
            widths.append(str(w))

        asc, desc = 750, -250
        bbox = "[-500 -250 1250 750]"
        if metrics_font:
            try:
                if metrics_font.ascender > 0:
                    asc = int(metrics_font.ascender * 1000)
                if metrics_font.descender < 0:
                    desc = int(metrics_font.descender * 1000)
            except Exception:
                pass

        fd = doc.get_new_xref()
        doc.update_object(
            fd,
            f"<</Type/FontDescriptor/FontName/{base_font}/Flags 32"
            f"/FontBBox{bbox}/ItalicAngle 0/Ascent {asc}/Descent {desc}"
            f"/CapHeight 644/StemV 80>>")

        fx = doc.get_new_xref()
        doc.update_object(
            fx,
            f"<</Type/Font/Subtype/TrueType/BaseFont/{base_font}"
            f"/Encoding/WinAnsiEncoding/FirstChar 32/LastChar 255"
            f"/Widths[{' '.join(widths)}]/FontDescriptor {fd} 0 R>>")
        return fx

    @classmethod
    def _register_fonts(cls, doc, fonts: FontSet) -> dict:
        """
        建立字體物件並登記到 /Root/AcroForm/DR/Font (編輯器依 DA 的字體名稱到這裡查)。
        回傳 {資源名稱: 字體 xref}。
        """
        latin_x = cls._make_font_object(doc, fonts, cls.LATIN_BASEFONT, fonts.primary)
        cjk_x = cls._make_font_object(doc, fonts, cls.CJK_BASEFONT, fonts.primary)
        registry = {cls.LATIN_RES: latin_x, cls.CJK_RES: cjk_x}

        cat = doc.pdf_catalog()
        af = cls._dict_xref(doc, cat, "AcroForm")
        if doc.xref_get_key(af, "Fields")[0] == "null":
            doc.xref_set_key(af, "Fields", "[]")
        dr = cls._dict_xref(doc, af, "DR")
        fd = cls._dict_xref(doc, dr, "Font")
        for name, x in registry.items():
            doc.xref_set_key(fd, name, f"{x} 0 R")
        return registry

    # -----------------------------------------------------------------
    # 匯出 (FreeText 註釋版:每一行一個文字框,行距由 layout_cell 決定)
    # -----------------------------------------------------------------
    @classmethod
    def write_project_as_annotations(cls, src_path: str, project_data: dict,
                                     output_path: str, style: dict | None = None) -> int:
        if os.path.abspath(src_path) == os.path.abspath(output_path):
            raise ValueError("輸出檔案不能與原始 PDF 相同,請另存新檔名。")

        style = normalize_style(style)
        fonts = cls.get_fonts()
        doc = fitz.open(src_path)
        written_pages = 0

        try:
            registry = cls._register_fonts(doc, fonts)

            for key in sorted(project_data.keys(), key=lambda k: int(k)):
                page_idx = int(key)
                if not (0 <= page_idx < len(doc)):
                    continue

                pdata = project_data[key]
                cells = [fitz.Rect(c) for c in pdata.get("cells", [])]
                texts = pdata.get("texts", [])
                page = doc[page_idx]
                wrote = False

                for rect, text in zip(cells, texts):
                    lay = cls.layout_cell(text, rect, fonts, style)
                    if not lay:
                        continue
                    fs = lay["fontsize"]

                    for line_info in lay["lines"]:
                        line_text = "".join(seg for _, seg, _ in line_info["runs"])
                        if not line_text.strip():
                            continue

                        FT_BASELINE = 0.75
                        b = line_info["baseline"]
                        y0 = b - fs * FT_BASELINE
                        line_rect = fitz.Rect(rect.x0, y0, rect.x1, y0 + fs * 1.3)
                        if line_rect.is_empty or not line_rect.is_valid:
                            continue

                      
                     
                        # 建立 FreeText 註釋
                        annot = page.add_freetext_annot(
                            line_rect, line_text,
                            fontsize=fs, fontname="helv",
                            text_color=(0, 0, 0),
                            fill_color=None,
                            align=fitz.TEXT_ALIGN_CENTER,
                        )
                        if not annot:
                            continue
                        annot.set_border(width=0)
                        xref = annot.xref

                        # 1. 解決無法移動問題：移除引起鎖定的 Callout (/CL) 屬性
                        doc.xref_set_key(xref, "CL", "null")
                        doc.xref_set_key(xref, "IT", "null")

                        # 2. 解決移動後變靠左問題：明確指定 /Q 為 1 (0:靠左, 1:置中, 2:靠右)
                        doc.xref_set_key(xref, "Q", "1")

                        # 3. 解決字型顯示為 Helvetica 問題：
                        latin_only = cls._latin_encodable(line_text, fonts)
                        res_font = cls.LATIN_RES if latin_only else cls.CJK_RES # "Calibri" 或 "MSJH"
                        font_xref = registry[res_font]

                        # 強制設定 /DA (Default Appearance)
                        doc.xref_set_key(xref, "DA", f"(/{res_font} {fs:.2f} Tf 0 g)")

                        # 設定 /DS (Default Style)，許多現代 PDF 編輯器 (如 Right PDF/Acrobat) 會優先讀取此屬性來顯示字型與對齊
                        ds_font_family = "Calibri" if latin_only else "Microsoft JhengHei"
                        doc.xref_set_key(
                            xref, "DS",
                            f"(font: {ds_font_family} {fs:.1f}pt; text-align: center; color: #000000;)"
                        )

                        # 將字型資源明確掛載於該註釋的 /DR 字典中
                        doc.xref_set_key(xref, "DR", f"<</Font<</{res_font} {font_xref} 0 R>>>>")

                        # 4. 保留初次繪製的外觀串流 (/AP)
                        if latin_only:
                            ap = doc.xref_get_key(xref, "AP/N")
                            if ap[0] == "xref":
                                ap_xref = int(ap[1].split()[0])
                                base_y = line_rect.y1 - b
                                x_rel = line_info["runs"][0][2] - line_rect.x0
                                stream = (
                                    f"BT /{res_font} {fs:.2f} Tf 0 g "
                                    f"{x_rel:.2f} {base_y:.2f} Td "
                                    f"{cls._pdf_literal(line_text)} Tj ET"
                                ).encode("latin-1")
                                doc.update_stream(ap_xref, stream)
                                doc.xref_set_key(
                                    ap_xref, "BBox",
                                    f"[0 0 {line_rect.width:.2f} {line_rect.height:.2f}]")
                                doc.xref_set_key(ap_xref, "Matrix", "[1 0 0 1 0 0]")
                                doc.xref_set_key(
                                    ap_xref, "Resources",
                                    f"<</Font<</{res_font} {font_xref} 0 R>>>>")
                        wrote = True

                if wrote:
                    written_pages += 1

            doc.save(output_path, garbage=3, deflate=True)
        finally:
            doc.close()

        return written_pages

    # 相容 gui_editor.py 目前呼叫的名稱
    @classmethod
    def write_project_to_pdf(cls, src_path, project_data, output_path, style=None):
        return cls.write_project_as_annotations(src_path, project_data, output_path, style)