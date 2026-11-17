#!/usr/bin/env python3
"""Redpen: mark up a file in the browser, then let an AI agent apply the notes.

    python3 review.py FILE [--port N] [--no-open] [--source F] [--build CMD] [--slides CSS] [--notes CSS] [--page] [--lang en|zh]
    python3 review.py show FILE       print the current annotations as text
    python3 review.py prompt FILE     print the instruction to paste to an agent
    python3 review.py archive FILE [--summary TEXT]     close the round after the notes were applied
    python3 review.py import FILE MARKED_COPY           read handwriting from a copy annotated elsewhere (iPad)
    python3 review.py FILE --lan      also reachable from an iPad on the same network (token in the URL)

FILE is an HTML slide deck, any other HTML page (poster, report), an image, a PDF, or a folder of images.
Annotations live next to the file, in "<file name>.review/":
    annotations.json   everything, rewritten on every change
    annotations.md     the same notes as readable text
    images/            screenshots and pictures the reviewer attached
    archive/           earlier rounds
    history/           automatic copies of earlier versions of annotations.json
Standard library only. Listens on 127.0.0.1 and accepts writes only from its own page. See AGENTS.md.
"""
import argparse
import hashlib
import hmac
import html
import json
import mimetypes
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import webbrowser
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

__version__ = "1.1.0"
TOOL = Path(__file__).resolve().parent
IMG_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif"}
UPLOAD = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
          ".webp": "image/webp", ".pdf": "application/pdf"}
MAX_JSON, MAX_FILE = 16 * 1024 * 1024, 60 * 1024 * 1024
PDF_DPI = 110
CONFIG_KEYS = ("source", "build", "slides", "notes", "title", "root", "mode")

KINDS = {"comment": "评论", "text": "改文字", "image": "加图 / 换图", "layout": "版式", "remove": "删掉", "other": "其他"}
TYPES = {"pin": "点评", "box": "框选", "el": "选中元素", "text": "选中文字", "edit": "直接改字", "image": "加图",
         "pen": "手绘", "arrow": "箭头", "slide": "整页意见", "new": "新增一页", "del": "删除此页", "move": "移动此页",
         "notes": "修改讲稿", "op": "整页操作", "ink": "手写批注"}
OPS = {"keep": "这页不要动", "split": "拆成两页", "merge": "和下一页合并", "backup": "移到备用页",
       "optional": "短版本里跳过", "dup": "复制这一页再改"}
LAYOUTS = {"auto": "由 AI 决定", "fig": "标题 + 一张大图", "figtext": "左图右文", "bullets": "标题 + 要点", "table": "表格",
           "compare": "左右对比", "full": "整页一张图", "copy": "照本页的版式"}
IMGMODES = {"add": "放在这个位置", "replace": "替换下面这张图", "ref": "只是参考，不放进去"}
STATUS = {"done": "已改", "partial": "部分已改", "skipped": "没有改"}

# Interface language. Chinese is the source text and EN holds the translations (app.js has its own table for the page).
# Notes are written in the language of the page they were made on ("lang" in annotations.json); what this program
# prints follows --lang, then REDPEN_LANG, then the system.
EN = {
    # categories, note types, page operations, layouts, results
    "评论": "Comment", "改文字": "Change text", "加图 / 换图": "Add / replace image", "版式": "Layout", "删掉": "Delete", "其他": "Other",
    "点评": "Pin", "框选": "Box", "选中元素": "Element", "选中文字": "Selected text", "直接改字": "Edited text", "加图": "Image",
    "手绘": "Drawing", "箭头": "Arrow", "整页意见": "Page comment", "新增一页": "New page", "删除此页": "Delete this page",
    "移动此页": "Move this page", "修改讲稿": "Speaker notes", "整页操作": "Page operation", "手写批注": "Handwriting",
    "前面加一页": "Add page before", "后面加一页": "Add page after",
    "这页不要动": "Do not touch this page", "拆成两页": "Split into two pages", "和下一页合并": "Merge with the next page",
    "移到备用页": "Move to backup", "短版本里跳过": "Skip in the short version", "复制这一页再改": "Duplicate this page and change the copy",
    "由 AI 决定": "Let the AI decide", "标题 + 一张大图": "Title + one large figure", "左图右文": "Figure left, text right",
    "标题 + 要点": "Title + bullets", "表格": "Table", "左右对比": "Side-by-side comparison", "整页一张图": "One full-page image",
    "照本页的版式": "Same layout as this page",
    "放在这个位置": "Place it here", "替换下面这张图": "Replace the image underneath", "只是参考，不放进去": "Only a reference, do not insert it",
    "已改": "Done", "部分已改": "Partly done", "没有改": "Not done",
    # annotations.md
    "# 修改意见：{name}\n\n目前没有标注。\n": "# Review notes: {name}\n\nThere are no notes at the moment.\n",
    "# 修改意见：{name}": "# Review notes: {name}",
    "- 审阅的文件：`{path}`（{kind}）": "- File under review: `{path}` ({kind})",
    "图片|kind": "image", "图片文件夹": "folder of images",
    "- 要改的源文件：`{src}`": "- Source file to edit: `{src}`",
    "- 改完后在 `{dir}` 运行：`{cmd}`": "- After editing, run in `{dir}`: `{cmd}`",
    "- 每条后面的“TeX 位置”来自 SyncTeX，是这处内容在源文件里的行号，可以直接去改":
        "- The “TeX” line of a note comes from SyncTeX: it is the line of the source file where that content is, so go straight there",
    "- 这个 PDF 没有 SyncTeX 信息：用每条的“原文 / 对象”在 .tex 里搜索来定位（编译时加 -synctex=1 以后会直接给出行号）":
        "- This PDF has no SyncTeX data: find each note by searching the .tex for its “Original” / “Target” text (compile with -synctex=1 and the next round gives line numbers)",
    "- “手写批注”是从另外批注过的副本里找出来的笔迹：内容在图片里，必须打开图片读":
        "- “Handwriting” notes are marks found in a copy that was annotated elsewhere: the content is in the image, so you must open the image",
    "- 共 {n} 条，文件版本 {build}": "- Notes: {n}; file version {build}",
    "（文件现在的版本是 {build}，标注之后文件改过）": " (the file is now at version {build}: it changed after the notes were made)",
    "- 坐标以每页左上角为原点，单位是该页自己的像素，页面尺寸写在每页标题后面":
        "- Coordinates have their origin at the top-left of each page and are in that page's own pixels; the page size follows each page heading",
    "；PDF 按 {dpi} dpi 渲染，像素 ÷ {dpi} × 72 = pt": "; PDF pages are rendered at {dpi} dpi, so pixel ÷ {dpi} × 72 = pt",
    "- 每条的完整数据（目标元素的路径、原文、图片路径）在 `{name}` 里，用 id 对应":
        "- The full data of each note (path of the target element, original text, image paths) is in `{name}`; match by id",
    "## 总体意见": "## General comments", "## 本轮修改说明": "## Summary of this round",
    "（{w} × {h}）": "({w} × {h})", "整页": "Whole page", "第 {n} 页": "Page {n}",
    "｜": " | ", "：": ": ", "，": ", ", "（": " (", "）": ")", "【": "[", "】": "]",
    "【重要】": "[IMPORTANT]", "【所有页同样处理】": "[ALL PAGES]",
    " 位置 ({x}, {y})": " at ({x}, {y})", " 区域 x={x} y={y} 宽={w} 高={h}": " region x={x} y={y} w={w} h={h}",
    " 从 ({x}, {y}) 到 ({x2}, {y2})": " from ({x}, {y}) to ({x2}, {y2})",
    "用法": "Use", "对象": "Target", "指向": "Points to", "原文": "Original", "改成": "Change to", "新页": "New page", "移到": "Move to",
    "新讲稿": "New speaker notes", "意见": "Comment", "TeX 位置": "TeX", "笔迹截图（打开看）": "Handwriting crop (open it)",
    "图片": "Images", "图片|one": "Image", "整页（带批注）": "Annotated page", "处理结果": "Result",
    "{title}（放在{page}{pos}，版式：{layout}）": "{title} (placed {pos} {page}; layout: {layout})",
    "（标题未填）": "(no title given)", "这页": "this page", "之前": "before", "之后": "after",
    "{page}｜{title} {pos}": "{pos} {page} | {title}", "（未选位置）": "(no position chosen)",
    # the instruction for the agent
    "请按我在审阅工具里留的标注修改：{path}": "Please apply the notes I left in the review tool (Redpen) to: {path}",
    "1. 先读标注清单：{md}": "1. Read the list of notes first: {md}",
    "2. 需要坐标、目标元素或图片时查：{ann}（我附的截图和图片在 {images}/）":
        "2. For coordinates, target elements or images, look in: {ann} (the screenshots and pictures I attached are in {images}/)",
    "要改的源文件是 {src}": "The source file to edit is {src}", "直接改上面这个文件": "Edit the file above directly",
    "；改完在 {dir} 运行 `{cmd}`": "; after editing, run `{cmd}` in {dir}",
    "3. 先确认这个文件是手写的还是由别的源文件生成的，改源文件":
        "3. First find out whether this file is hand-written or generated from another source file; edit the source",
    "（图片和 PDF 要改生成它的源文件，然后重新导出）": " (for an image or a PDF, edit what produces it, then export it again)",
    "4. 规则和数据格式见：{agents}": "4. Rules and data format: {agents}",
    "5. 改完后在 annotations.json 里给每条写上 status 和 reply，然后运行：python3 {tool} archive \"{path}\" --summary \"一句话说明改了什么\"":
        "5. When you are done, write a status and a reply on each note in annotations.json, then run: python3 {tool} archive \"{path}\" --summary \"one line on what changed\"",
    # the command line
    "找不到文件：{p}": "File not found: {p}",
    "不支持的格式：{name}（支持 HTML、PDF、图片，或一个装图片的文件夹；PPT 请先导出成 PDF）":
        "Unsupported format: {name} (supported: HTML, PDF, images, or a folder of images; export PowerPoint to PDF first)",
    "打开 PDF 需要 pdftoppm（macOS：brew install poppler；Linux：apt install poppler-utils）。也可以先把 PDF 导出成 PNG 再打开。":
        "Opening a PDF needs pdftoppm (macOS: brew install poppler; Linux: apt install poppler-utils). You can also export the PDF to PNG images and open those.",
    "读 PDF 需要 pdftoppm（macOS：brew install poppler；Linux：apt install poppler-utils）":
        "Reading a PDF needs pdftoppm (macOS: brew install poppler; Linux: apt install poppler-utils)",
    "导入手写批注需要 Pillow 和 numpy：pip install pillow numpy": "Importing handwriting needs Pillow and numpy: pip install pillow numpy",
    "HTML 不能直接对比。请把它导出的 PDF 作为 FILE：review.py import 原始.pdf 批注过的.pdf":
        "HTML cannot be compared directly. Use its PDF export as FILE: review.py import original.pdf annotated.pdf",
    "需要两个文件：没批注的原件和批注过的副本": "Two files are needed: the untouched original and the annotated copy",
    "注意：原件 {a} 页，批注件 {b} 页，只对比前 {m} 页": "Note: the original has {a} pages and the annotated copy {b}; only the first {m} are compared",
    "这一页和原件整体不同，请看整页图": "This whole page differs from the original; look at the image of the page",
    "没有发现和原件不同的地方。确认批注件是在同一份原件上写的。":
        "No difference from the original was found. Check that the annotated copy was made from this same original.",
    "找到 {n} 处手写批注，已写入 {ann}\n文字清单：{md}\n每处的笔迹截图在 {images}/（需要看图才能读出内容）":
        "Found {n} handwritten marks, written to {ann}\nAs text: {md}\nA crop of each mark is in {images}/ (the content can only be read from the images)",
    "这个文件夹里没有图片": "There are no images in this folder",
    "需要从这台电脑打开，或用带口令的链接打开。": "Open this page on the computer itself, or with the link that carries the token.",
    "{name}: {n} 页": "{name}: {n} pages",
    "端口 {a}–{b} 都被占用了，用 --port 换一个": "Ports {a}–{b} are all taken; choose another one with --port",
    "Redpen: {url}\n  文件: {path}\n  标注: {ann}": "Redpen: {url}\n  File:  {path}\n  Notes: {ann}",
    "  iPad 或其他设备（同一个 Wi-Fi 或 Tailscale）打开: {url}": "  On an iPad or another device (same Wi-Fi or Tailscale) open: {url}",
    "  按 Ctrl+C 停止": "  Ctrl+C stops the server", "\n已停止": "\nStopped",
    "已归档到 {dest}": "Archived to {dest}", "没有需要归档的标注": "There are no notes to archive",
}
UI_LANG = None    # set by --lang or REDPEN_LANG: the language a review page starts in, until the reviewer switches it there
_lang = None


def system_lang():
    """"zh" when the system is set up for Chinese, also as a second language on macOS; otherwise "en"."""
    seen = [os.environ.get(k, "") for k in ("LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE")]
    try:
        import locale
        seen.append(locale.getlocale()[0] or "")
    except Exception:
        pass
    if sys.platform == "darwin":
        try:
            out = subprocess.run(["defaults", "read", "-g", "AppleLanguages"], capture_output=True, text=True, timeout=3).stdout
            seen += re.findall(r"[A-Za-z][-\w]*", out)
        except Exception:
            pass
    return "zh" if any(s.lower().startswith(("zh", "chinese")) for s in seen) else "en"


def cli_lang():
    global _lang
    if _lang is None:
        v = (os.environ.get("REDPEN_LANG") or "").lower()[:2]
        _lang = v if v in ("en", "zh") else system_lang()
    return _lang


def tr(s, lang=None, **kw):
    """Interface text in a language ("en" or "zh"; default: the command line's). A "|context" suffix tells two uses of one word apart."""
    if s is None:
        return s
    if (lang or cli_lang()) == "en":
        s = EN.get(s, s)
    s = re.sub(r"\|[a-z]+$", "", s)
    return s.format(**kw) if kw else s


class Target:
    """The file under review and the folder that holds its annotations."""

    def __init__(self, path, opts=None):
        p = Path(path).expanduser().resolve()
        if not p.exists():
            raise SystemExit(tr("找不到文件：{p}", p=p))
        self.path, ext = p, p.suffix.lower()
        if p.is_dir():
            self.kind, self.review, self.docroot = "images", p / "_review", p
        elif ext in (".html", ".htm"):
            self.kind = "html"
        elif ext == ".pdf":
            self.kind = "pdf"
        elif ext in IMG_EXT:
            self.kind = "image"
        else:
            raise SystemExit(tr("不支持的格式：{name}（支持 HTML、PDF、图片，或一个装图片的文件夹；PPT 请先导出成 PDF）", name=p.name))
        if not p.is_dir():
            self.review, self.docroot = p.with_name(p.name + ".review"), p.parent
        self.images, self.archive = self.review / "images", self.review / "archive"
        self.ann, self.md, self.cfg_file = self.review / "annotations.json", self.review / "annotations.md", self.review / "config.json"
        self.config = {}
        if self.cfg_file.exists():
            try:
                self.config = json.loads(self.cfg_file.read_text())
            except Exception:
                self.config = {}
        new = {k: v for k, v in (opts or {}).items() if k in CONFIG_KEYS and v}
        if new and any(self.config.get(k) != v for k, v in new.items()):
            self.config.update(new)
            self.review.mkdir(parents=True, exist_ok=True)
            self.cfg_file.write_text(json.dumps(self.config, ensure_ascii=False, indent=1))
        if self.kind == "html" and self.config.get("root"):
            root = (p.parent / self.config["root"]).resolve()
            if root in p.parents:
                self.docroot = root

    # -- what the browser needs --
    def build(self):
        h = hashlib.sha1()
        if self.path.is_dir():
            for f in self.page_files():
                h.update(f"{f.name}:{f.stat().st_mtime_ns}".encode())
        else:
            h.update(self.path.read_bytes())
        return h.hexdigest()[:10]

    def rev(self):
        return str(self.ann.stat().st_mtime_ns) if self.ann.exists() else "0"

    def page_files(self):
        if self.kind == "image":
            return [self.path]
        if self.kind == "images":
            return sorted((f for f in self.path.iterdir() if f.suffix.lower() in IMG_EXT), key=lambda f: natural(f.name))
        if self.kind == "pdf":
            out, key = self.review / "pages", f"{self.path.stat().st_mtime_ns}:{PDF_DPI}"
            stamp = out / ".stamp"
            if not (stamp.exists() and stamp.read_text() == key):
                exe = shutil.which("pdftoppm")
                if not exe:
                    raise SystemExit(tr("打开 PDF 需要 pdftoppm（macOS：brew install poppler；Linux：apt install poppler-utils）。也可以先把 PDF 导出成 PNG 再打开。"))
                shutil.rmtree(out, ignore_errors=True)
                out.mkdir(parents=True)
                subprocess.run([exe, "-png", "-r", str(PDF_DPI), str(self.path), str(out / "p")], check=True)
                stamp.write_text(key)
            return sorted(out.glob("p-*.png"), key=lambda f: natural(f.name))
        return []

    def pages(self, lang=None):
        base = "/pages/" if self.kind == "pdf" else "/doc/"
        fs = self.page_files()
        return [{"title": (tr("第 {n} 页", lang, n=i + 1) if self.kind == "pdf" else f.name), "url": base + quote(f.name)} for i, f in enumerate(fs)]

    def pdf_text(self):
        """Words of a PDF with their boxes, per page, in pixels of the rendered page: [{w, h, blocks: [{x, y, w, h, lines: [{x, y, w, h, t}]}]}]."""
        if self.kind != "pdf":
            return []
        self.page_files()
        cache = self.review / "pages" / "text.json"
        if cache.exists():
            try:
                return json.loads(cache.read_text())
            except Exception:
                pass
        exe, pages = shutil.which("pdftotext"), []
        if exe:
            with tempfile.TemporaryDirectory() as tmp:
                out = Path(tmp) / "t.html"
                try:
                    subprocess.run([exe, "-bbox-layout", str(self.path), str(out)], check=True, capture_output=True, timeout=180)
                    pages = parse_bbox(out.read_text(errors="replace"), PDF_DPI / 72)
                except Exception:
                    pages = []
        cache.write_text(json.dumps(pages, ensure_ascii=False))
        return pages

    def words_in(self, n, box, pad=6):
        """Text of the PDF lines that a box on page n touches."""
        pages = self.pdf_text()
        if not (0 < n <= len(pages)):
            return ""
        x0, y0, x1, y1 = box[0] - pad, box[1] - pad, box[0] + box[2] + pad, box[1] + box[3] + pad
        out = []
        for b in pages[n - 1]["blocks"]:
            for ln in b["lines"]:
                if ln["x"] < x1 and ln["x"] + ln["w"] > x0 and ln["y"] < y1 and ln["y"] + ln["h"] > y0:
                    out.append(ln["t"])
        return " ".join(out)

    def tex_at(self, n, x, y):
        """Source file and line behind a point of a PDF page, when the PDF was compiled with -synctex=1."""
        if self.kind != "pdf":
            return None
        if not hasattr(self, "_sync"):
            has = self.path.with_suffix(".synctex.gz").exists() or self.path.with_suffix(".synctex").exists()
            self._sync, self._tex = (shutil.which("synctex") if has else None), {}
        key = (n, round(x), round(y))
        if not self._sync:
            return None
        if key not in self._tex:
            res = None
            try:
                out = subprocess.run([self._sync, "edit", "-o", f"{n}:{x * 72 / PDF_DPI:.2f}:{y * 72 / PDF_DPI:.2f}:{self.path.name}"],
                                     cwd=self.path.parent, capture_output=True, text=True, timeout=15).stdout
                fi, li = re.search(r"^Input:(.*)$", out, re.M), re.search(r"^Line:(\d+)", out, re.M)
                if fi and li and int(li.group(1)) > 0:
                    res = {"file": os.path.normpath(fi.group(1).strip()), "line": int(li.group(1))}
            except Exception:
                res = None
            self._tex[key] = res
        return self._tex[key]

    def enrich(self, data):
        """Add the TeX location to each note on a PDF page."""
        if self.kind != "pdf":
            return
        for it in data.get("items", []):
            n = (it.get("slide") or {}).get("n")
            r = (it.get("rects") or [None])[0]
            if r:
                pt = (r["x"] + min(r["w"], 40) / 2, r["y"] + r["h"] / 2)
            elif it.get("x") is not None:
                pt = (it["x"] + (it.get("w") or 0) / 2, it["y"] + (it.get("h") or 0) / 2) if it.get("type") != "arrow" else (it["x"], it["y"])
            else:
                continue
            tex = self.tex_at(n, *pt) if n else None
            if tex:
                it["tex"] = tex
            else:
                it.pop("tex", None)

    def frame(self):
        if self.kind == "html":
            return "/doc/" + quote(str(self.path.relative_to(self.docroot)))
        return "/viewer"

    def source(self):
        s = self.config.get("source")
        return str((self.path.parent / s).resolve()) if s else ""

    def info(self):
        return {"name": self.path.name, "path": str(self.path), "kind": self.kind, "frame": self.frame(), "build": self.build(),
                "rev": self.rev(), "config": self.config, "source": self.source(), "review": str(self.review),
                "annotations": str(self.ann), "text": str(self.md), "tool": str(TOOL), "dpi": PDF_DPI if self.kind == "pdf" else None, "lang": UI_LANG,
                "textLayer": self.kind == "html" or (self.kind == "pdf" and any(p["blocks"] for p in self.pdf_text()))}

    # -- stored notes --
    def ensure(self):
        self.review.mkdir(parents=True, exist_ok=True)
        (self.review / ".gitignore").write_text("*\n")
        (self.review / "README.md").write_text(
            f"# Review notes for {self.path.name}\n\n"
            f"Written by Redpen ({TOOL}). This folder is ignored by git.\n\n"
            "- `annotations.md`: the reviewer's notes as text. Read this first.\n"
            "- `annotations.json`: the same notes with coordinates, target elements and image paths.\n"
            "- `images/`: screenshots and pictures the reviewer attached.\n"
            "- `archive/`: earlier rounds, with what was done about each note.\n\n"
            f"An agent asked to apply these notes follows `{TOOL / 'AGENTS.md'}`.\n"
            f"Reopen the review page: `python3 {TOOL / 'review.py'} \"{self.path}\"`\n")

    def load(self):
        try:
            d = json.loads(self.ann.read_text())
            return d if isinstance(d, dict) and isinstance(d.get("items"), list) else None
        except Exception:
            return None

    def save(self, data):
        self.ensure()
        self.enrich(data)
        self.backup()
        tmp = self.ann.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1))
        os.replace(tmp, self.ann)
        self.md.write_text(self.markdown(data))

    def backup(self):
        """Before the notes are replaced or archived, keep the previous version in history/ (at most one copy per 15 s, newest 300)."""
        if not self.ann.exists():
            return
        hist = self.review / "history"
        hist.mkdir(parents=True, exist_ok=True)
        old = sorted(hist.glob("annotations-*.json"))
        if old and time.time() - old[-1].stat().st_mtime < 15:
            return
        shutil.copy2(self.ann, hist / f"annotations-{time.strftime('%Y%m%d-%H%M%S')}.json")
        for extra in old[:-299]:
            extra.unlink()

    def last(self):
        fs = sorted(self.archive.glob("annotations-*.json")) if self.archive.exists() else []
        try:
            return json.loads(fs[-1].read_text()) if fs else {}
        except Exception:
            return {}

    def do_archive(self, summary=None):
        data = self.load()
        if data is None:
            return None
        hist = self.review / "history"
        hist.mkdir(parents=True, exist_ok=True)
        shutil.copy2(self.ann, hist / f"annotations-{time.strftime('%Y%m%d-%H%M%S')}-before-archive.json")
        if summary:
            data["summary"] = summary
        data["archived"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        self.archive.mkdir(parents=True, exist_ok=True)
        dest = self.archive / f"annotations-{time.strftime('%Y%m%d-%H%M%S')}.json"
        dest.write_text(json.dumps(data, ensure_ascii=False, indent=1))
        dest.with_suffix(".md").write_text(self.markdown(data))
        self.ann.unlink()
        if self.md.exists():
            self.md.unlink()
        return dest

    # -- text for people and agents --
    def lang(self, data=None, lang=None):
        """Language of the notes: the one asked for, else the one they were made in, else the command line's."""
        if lang in ("en", "zh"):
            return lang
        data = data if data is not None else self.load()
        v = (data or {}).get("lang")
        return v if v in ("en", "zh") else ("zh" if data and data.get("items") else cli_lang())

    def markdown(self, data=None, lang=None):
        data = data if data is not None else self.load()
        lang = self.lang(data or {}, lang)
        _ = lambda s, **kw: tr(s, lang, **kw)
        if not data or (not data.get("items") and not (data.get("general") or "").strip()):
            return _("# 修改意见：{name}\n\n目前没有标注。\n", name=self.path.name)
        items = data.get("items", [])
        kind = _({"html": "HTML", "pdf": "PDF", "image": "图片|kind", "images": "图片文件夹"}[self.kind])
        L = [_("# 修改意见：{name}", name=self.path.name), "",
             _("- 审阅的文件：`{path}`（{kind}）", path=self.path, kind=kind)]
        if self.source():
            L.append(_("- 要改的源文件：`{src}`", src=self.source()))
        if self.config.get("build"):
            L.append(_("- 改完后在 `{dir}` 运行：`{cmd}`", dir=self.path.parent, cmd=self.config["build"]))
        if self.kind == "pdf":
            L.append(_("- 每条后面的“TeX 位置”来自 SyncTeX，是这处内容在源文件里的行号，可以直接去改") if any(i.get("tex") for i in items)
                     else _("- 这个 PDF 没有 SyncTeX 信息：用每条的“原文 / 对象”在 .tex 里搜索来定位（编译时加 -synctex=1 以后会直接给出行号）"))
        if any(i.get("type") == "ink" for i in items):
            L.append(_("- “手写批注”是从另外批注过的副本里找出来的笔迹：内容在图片里，必须打开图片读"))
        L.append(_("- 共 {n} 条，文件版本 {build}", n=len(items), build=data.get("build") or "?")
                 + ("" if data.get("build") == self.build() else _("（文件现在的版本是 {build}，标注之后文件改过）", build=self.build())))
        L.append(_("- 坐标以每页左上角为原点，单位是该页自己的像素，页面尺寸写在每页标题后面")
                 + (_("；PDF 按 {dpi} dpi 渲染，像素 ÷ {dpi} × 72 = pt", dpi=PDF_DPI) if self.kind == "pdf" else ""))
        L.append(_("- 每条的完整数据（目标元素的路径、原文、图片路径）在 `{name}` 里，用 id 对应", name=self.ann.name))
        L.append("")
        if (data.get("general") or "").strip():
            L += [_("## 总体意见"), data["general"].strip(), ""]
        if data.get("summary"):
            L += [_("## 本轮修改说明"), str(data["summary"]).strip(), ""]
        groups = {}
        for it in items:
            groups.setdefault((it.get("slide") or {}).get("n", 0), []).append(it)
        for n in sorted(groups):
            s = groups[n][0].get("slide") or {}
            size = _("（{w} × {h}）", w=s.get("w"), h=s.get("h")) if s.get("w") else ""
            L.append(f"## {s.get('page') or _('整页')}{_('｜')}{s.get('title') or ''} {size}".rstrip())
            for k, it in enumerate(groups[n]):
                L += self.item_lines(k + 1, it, lang)
            L.append("")
        return "\n".join(L)

    @staticmethod
    def type_name(it, lang="zh"):
        t = it.get("type")
        if t == "op":
            return tr(OPS.get(it.get("op"), "整页操作"), lang)
        if t == "new":
            return tr("前面加一页" if it.get("where") == "before" else "后面加一页", lang)
        return tr(TYPES.get(t, t or "?"), lang)

    def item_lines(self, k, it, lang="zh"):
        _ = lambda s, **kw: tr(s, lang, **kw)
        t, s = it.get("type"), it.get("slide") or {}
        head = f"{k}. " + _("【") + self.type_name(it, lang)
        if t in ("pin", "box", "el", "text", "slide", "pen", "arrow"):
            head += " · " + _(KINDS.get(it.get("kind"), it.get("kind") or ""))
        head += _("】") + (_("【重要】") if it.get("pri") else "") + (_("【所有页同样处理】") if it.get("all") else "")
        if t == "pin":
            head += _(" 位置 ({x}, {y})", x=it.get("x"), y=it.get("y"))
        if t in ("box", "el", "pen", "image", "ink"):
            head += _(" 区域 x={x} y={y} 宽={w} 高={h}", x=it.get("x"), y=it.get("y"), w=it.get("w"), h=it.get("h"))
        if t == "arrow":
            head += _(" 从 ({x}, {y}) 到 ({x2}, {y2})", x=it.get("x"), y=it.get("y"), x2=it.get("x2"), y2=it.get("y2"))
        out = [head + f"  `id:{it.get('id')}`"]
        add = lambda label, v: out.append(f"   {_(label)}{_('：')}{v}")
        pos = lambda v: _("之前" if v == "before" else "之后")
        if t == "image":
            add("用法", _(IMGMODES.get(it.get("mode") or "add")))
        if target_line(it.get("target"), lang):
            add("对象", target_line(it["target"], lang))
        if t == "arrow" and target_line(it.get("target2"), lang):
            add("指向", target_line(it["target2"], lang))
        if it.get("quote"):
            add("原文", f"“{it['quote']}”")
        if t == "edit":
            add("原文", f"“{it.get('original', '')}”")
        if it.get("replacement"):
            add("改成", f"“{it['replacement']}”")
        if t == "new":
            add("新页", _("{title}（放在{page}{pos}，版式：{layout}）", title=it.get("title") or _("（标题未填）"), page=s.get("page", _("这页")),
                        pos=pos(it.get("where")), layout=_(LAYOUTS.get(it.get("layout") or "auto"))))
        if t == "move":
            add("移到", _("{page}｜{title} {pos}", page=it.get("refPage", ""), title=it.get("refTitle", ""), pos=pos(it.get("pos"))) if it.get("ref") else _("（未选位置）"))
        if it.get("text") and not (t == "notes" and it.get("text") == it.get("original")):
            add("新讲稿" if t == "notes" else "意见", str(it["text"]).replace("\n", "\n   "))
        if it.get("tex"):
            add("TeX 位置", f"`{it['tex']['file']}:{it['tex']['line']}`")
        if it.get("images"):
            add("笔迹截图（打开看）" if t == "ink" else "图片", _("，").join(f"`{m.get('path') or m.get('name')}`" for m in it["images"]))
        if it.get("pageImage"):
            add("整页（带批注）", f"`{it['pageImage']}`")
        if it.get("status") or it.get("reply"):
            add("处理结果", (_(STATUS.get(it.get("status"), "")) + " " + str(it.get("reply") or "")).strip())
        return out

    def prompt(self, lang=None):
        lang = self.lang(None, lang)
        _ = lambda s, **kw: tr(s, lang, **kw)
        L = [_("请按我在审阅工具里留的标注修改：{path}", path=self.path), "",
             _("1. 先读标注清单：{md}", md=self.md),
             _("2. 需要坐标、目标元素或图片时查：{ann}（我附的截图和图片在 {images}/）", ann=self.ann, images=self.images)]
        if self.source() or self.config.get("build"):
            L.append("3. " + (_("要改的源文件是 {src}", src=self.source()) if self.source() else _("直接改上面这个文件"))
                     + (_("；改完在 {dir} 运行 `{cmd}`", dir=self.path.parent, cmd=self.config["build"]) if self.config.get("build") else ""))
        else:
            L.append(_("3. 先确认这个文件是手写的还是由别的源文件生成的，改源文件") + ("" if self.kind == "html" else _("（图片和 PDF 要改生成它的源文件，然后重新导出）")))
        L += [_("4. 规则和数据格式见：{agents}", agents=TOOL / "AGENTS.md"),
              _("5. 改完后在 annotations.json 里给每条写上 status 和 reply，然后运行：python3 {tool} archive \"{path}\" --summary \"一句话说明改了什么\"", tool=TOOL / "review.py", path=self.path)]
        return "\n".join(L) + "\n"


def natural(name):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name)]


def target_line(t, lang="zh"):
    if not t or t.get("tag") in ("slide", "page", None):
        return ""
    if t.get("asset") is not None:
        name = t.get("asset") or t.get("src") or tr("图片|one", lang)
        return tr("图片|one", lang) + " " + name + (tr("（", lang) + t["alt"][:40] + tr("）", lang) if t.get("alt") else "")
    if t.get("text"):
        return "“" + t["text"][:90] + ("…" if len(t["text"]) > 90 else "") + "”"
    return f"<{t.get('tag')}>"


def parse_bbox(text, k):
    """pdftotext -bbox-layout output -> pages of blocks of lines, scaled by k."""
    pages, page, block, line = [], None, None, None
    num = lambda tag, name: float(re.search(name + r'="([-0-9.]+)"', tag).group(1)) * k
    box = lambda tag: {"x": round(num(tag, "xMin"), 1), "y": round(num(tag, "yMin"), 1),
                       "w": round(num(tag, "xMax") - num(tag, "xMin"), 1), "h": round(num(tag, "yMax") - num(tag, "yMin"), 1)}
    for m in re.finditer(r"<(page|block|line|word)\b([^>]*)>(?:([^<]*)</word>)?|</(block|line)>", text):
        tag, attrs, word, close = m.group(1), m.group(2), m.group(3), m.group(4)
        if tag == "page":
            page = {"w": round(num(attrs, "width")), "h": round(num(attrs, "height")), "blocks": []}
            pages.append(page)
        elif tag == "block" and page is not None:
            block = dict(box(attrs), lines=[])
        elif tag == "line" and block is not None:
            line = dict(box(attrs), t=[])
        elif tag == "word" and line is not None:
            line["t"].append(html.unescape(word or ""))
        elif close == "line" and line is not None and block is not None:
            line["t"] = " ".join(line["t"])
            if line["t"].strip():
                block["lines"].append(line)
            line = None
        elif close == "block" and block is not None and page is not None:
            if block["lines"]:
                page["blocks"].append(block)
            block = None
    return pages


def render_pages(path, out):
    """Page images of a PDF, an image, or a folder of images."""
    path = Path(path)
    if path.is_dir():
        return sorted((f for f in path.iterdir() if f.suffix.lower() in IMG_EXT), key=lambda f: natural(f.name))
    if path.suffix.lower() == ".pdf":
        exe = shutil.which("pdftoppm")
        if not exe:
            raise SystemExit(tr("读 PDF 需要 pdftoppm（macOS：brew install poppler；Linux：apt install poppler-utils）"))
        subprocess.run([exe, "-png", "-r", str(PDF_DPI), str(path), str(Path(out) / "m")], check=True)
        return sorted(Path(out).glob("m-*.png"), key=lambda f: natural(f.name))
    return [path]


def import_marked(t, marked):
    """Find what was drawn on a copy of the file (annotated on an iPad, say) and store each mark as a note with a picture of it."""
    try:
        import numpy as np
        from PIL import Image, ImageFilter
    except ImportError:
        raise SystemExit(tr("导入手写批注需要 Pillow 和 numpy：pip install pillow numpy"))
    marked = Path(marked).expanduser().resolve()
    if not marked.exists():
        raise SystemExit(tr("找不到文件：{p}", p=marked))
    if t.kind == "html":
        raise SystemExit(tr("HTML 不能直接对比。请把它导出的 PDF 作为 FILE：review.py import 原始.pdf 批注过的.pdf"))
    if marked == t.path:
        raise SystemExit(tr("需要两个文件：没批注的原件和批注过的副本"))
    t.ensure()
    t.images.mkdir(parents=True, exist_ok=True)
    data = t.load() or {"tool": "Redpen", "file": str(t.path), "kind": t.kind, "build": t.build(), "general": "", "items": []}
    lang = data["lang"] = t.lang(data)
    stamp, made, cell = time.strftime("%Y%m%d-%H%M%S"), 0, 24
    with tempfile.TemporaryDirectory() as tmp:
        a_pages, b_pages = t.page_files(), render_pages(marked, tmp)
        if len(a_pages) != len(b_pages):
            print(tr("注意：原件 {a} 页，批注件 {b} 页，只对比前 {m} 页", a=len(a_pages), b=len(b_pages), m=min(len(a_pages), len(b_pages))))
        for n, (fa, fb) in enumerate(zip(a_pages, b_pages), 1):
            A, B = Image.open(fa).convert("RGB"), Image.open(fb).convert("RGB")
            if B.size != A.size:
                B = B.resize(A.size, Image.LANCZOS)
            # ink makes the page darker or more colourful; a light blur keeps re-rendering and JPEG noise out
            a_, b_ = (np.asarray(im.filter(ImageFilter.GaussianBlur(1.2)), dtype=np.int16) for im in (A, B))
            mask = ((a_.mean(axis=2) - b_.mean(axis=2)) > 45) | (((b_.max(axis=2) - b_.min(axis=2)) - (a_.max(axis=2) - a_.min(axis=2))) > 50)
            H, W = mask.shape
            gh, gw = -(-H // cell), -(-W // cell)
            pad = np.zeros((gh * cell, gw * cell), bool)
            pad[:H, :W] = mask
            cells = pad.reshape(gh, cell, gw, cell).sum(axis=(1, 3)) >= 5
            if not cells.any():
                continue
            page_img = t.images / f"ink-{stamp}-p{n:02d}.png"
            B.save(page_img)
            title = tr("第 {n} 页", lang, n=n) if t.kind == "pdf" else fa.name
            regions = []
            if cells.mean() > 0.3:
                regions.append((0, 0, W, H, True))
            else:
                grow = cells.copy()   # join strokes that are within a cell of each other
                grow[1:] |= cells[:-1]; grow[:-1] |= cells[1:]; grow[:, 1:] |= cells[:, :-1]; grow[:, :-1] |= cells[:, 1:]
                seen = np.zeros_like(grow)
                for i, j in zip(*np.nonzero(grow)):
                    if seen[i, j]:
                        continue
                    stack, comp = [(i, j)], []
                    seen[i, j] = True
                    while stack:
                        y, x = stack.pop()
                        comp.append((y, x))
                        for dy in (-1, 0, 1):
                            for dx in (-1, 0, 1):
                                yy, xx = y + dy, x + dx
                                if 0 <= yy < gh and 0 <= xx < gw and grow[yy, xx] and not seen[yy, xx]:
                                    seen[yy, xx] = True
                                    stack.append((yy, xx))
                    ys, xs = [c[0] for c in comp], [c[1] for c in comp]
                    sub = mask[min(ys) * cell:(max(ys) + 1) * cell, min(xs) * cell:(max(xs) + 1) * cell]
                    if sub.sum() < 30:
                        continue
                    py, px = np.nonzero(sub)
                    if max(px.max() - px.min(), py.max() - py.min()) < 14 or min(px.max() - px.min(), py.max() - py.min()) < 3:
                        continue
                    x0, y0 = min(xs) * cell + px.min(), min(ys) * cell + py.min()
                    regions.append((int(x0), int(y0), int(px.max() - px.min() + 1), int(py.max() - py.min() + 1), False))
                regions.sort(key=lambda r: (r[1] // 60, r[0]))
            for k, (x, y, w, h, whole) in enumerate(regions, 1):
                m = 70
                crop = B if whole else B.crop((max(0, x - m), max(0, y - m), min(W, x + w + m), min(H, y + h + m)))
                out = page_img if whole else t.images / f"ink-{stamp}-p{n:02d}-{k}.png"
                if not whole:
                    crop.save(out)
                under = t.words_in(n, (x, y, w, h)) if t.kind == "pdf" and not whole else ""
                it = {"id": f"ink{stamp[-6:]}{n:02d}{k:02d}", "type": "ink", "kind": "comment", "source": marked.name,
                      "slide": {"n": n, "page": tr("第 {n} 页", lang, n=n), "title": title, "w": W, "h": H}, "x": x, "y": y, "w": w, "h": h,
                      "text": tr("这一页和原件整体不同，请看整页图", lang) if whole else "", "pageImage": str(page_img),
                      "images": [{"name": out.name, "path": str(out), "url": f"/review/images/{quote(out.name)}"}],
                      "created": time.strftime("%Y-%m-%dT%H:%M:%S")}
                if under:
                    it["target"] = {"tag": "text", "text": under[:400]}
                data["items"].append(it)
                made += 1
    if not made:
        print(tr("没有发现和原件不同的地方。确认批注件是在同一份原件上写的。"))
        return
    t.save(data)
    print(tr("找到 {n} 处手写批注，已写入 {ann}\n文字清单：{md}\n每处的笔迹截图在 {images}/（需要看图才能读出内容）", n=made, ann=t.ann, md=t.md, images=t.images))


VIEWER = """<!doctype html><html><head><meta charset="utf-8"><title>__TITLE__</title>
<style>html,body{margin:0;min-height:100%;background:#2B303B}body{display:grid;place-items:center;min-height:100vh}
.holder{display:none;position:relative;margin:14px;flex:none}.holder.on{display:block}
.slide{position:absolute;left:0;top:0;transform-origin:0 0;background:#fff;box-shadow:0 4px 30px rgba(0,0,0,.45)}
.slide img{display:block;width:100%;height:100%;user-select:none;-webkit-user-select:none;-webkit-user-drag:none}
.tl{position:absolute;inset:0;overflow:hidden;line-height:1}.blk{position:absolute}
.ln{position:absolute;white-space:pre;color:transparent;transform-origin:0 0;font-family:Helvetica,Arial,sans-serif;cursor:text}
.ln::selection{background:rgba(30,110,255,.32);color:transparent}</style></head><body>
__PAGES__
<script>
(function(){
const all=[...document.querySelectorAll('.slide')];let cur=0,z=1;
const cx=document.createElement('canvas').getContext('2d');
document.querySelectorAll('.ln').forEach(l=>{const fs=parseFloat(l.style.fontSize);cx.font=fs+'px Helvetica, Arial, sans-serif';
  const w=cx.measureText(l.textContent).width;if(w>0)l.style.transform='scaleX('+(+l.dataset.w/w).toFixed(4)+')';});
function fit(){all.forEach(s=>{const w=s._w||1200,h=s._h||800,k=Math.min((innerWidth-28)/w,(innerHeight-28)/h)*z,p=s.parentElement;
  s.style.width=w+'px';s.style.height=h+'px';s.style.transform='scale('+k+')';p.style.width=w*k+'px';p.style.height=h*k+'px';});}
all.forEach(s=>{const im=s.querySelector('img'),set=()=>{s._w=im.naturalWidth||1200;s._h=im.naturalHeight||800;fit();};
  if(im.complete&&im.naturalWidth)set();else im.addEventListener('load',set);});
function go(i){cur=Math.max(0,Math.min(all.length-1,i));all.forEach((s,k)=>{s.classList.toggle('active',k===cur);s.parentElement.classList.toggle('on',k===cur);});
  try{history.replaceState(null,'','#'+(cur+1));}catch(_){}scrollTo(0,0);document.dispatchEvent(new CustomEvent('slidechange'));}
addEventListener('resize',fit);
addEventListener('keydown',e=>{if(e.metaKey||e.ctrlKey||e.altKey)return;const k=e.key;
  if(['ArrowRight','PageDown'].includes(k)){e.preventDefault();go(cur+1);}else if(['ArrowLeft','PageUp'].includes(k)){e.preventDefault();go(cur-1);}
  else if(k==='+'||k==='=')zoom(1);else if(k==='-')zoom(-1);else if(k==='0')zoom(0);});
function zoom(d){z=d===0?1:Math.max(1,Math.min(8,z*(d>0?1.25:0.8)));fit();}
window.__deck={all,order:()=>all,main:()=>all,fit,zoom,step:d=>go(cur+d),goTo:el=>go(all.indexOf(el)),current:()=>all[cur]};
fit();go(Math.max(0,(+location.hash.slice(1)||1)-1));
})();
</script></body></html>"""


def viewer_html(t, lang=None):
    esc = lambda s: str(s).replace("&", "&amp;").replace("<", "&lt;").replace('"', "&quot;")
    text = t.pdf_text()

    def layer(i):
        if i >= len(text) or not text[i]["blocks"]:
            return ""
        out = ['<div class="tl">']
        for b in text[i]["blocks"]:
            out.append(f'<div class="blk" data-rv-block style="left:{b["x"]}px;top:{b["y"]}px;width:{b["w"]}px;height:{b["h"]}px">')
            for ln in b["lines"]:
                out.append(f'<span class="ln" data-w="{ln["w"]}" style="left:{ln["x"] - b["x"]:.1f}px;top:{ln["y"] - b["y"]:.1f}px;height:{ln["h"]}px;font-size:{ln["h"] * 0.86:.1f}px">{esc(ln["t"])} </span>')
            out.append("</div>")
        return "".join(out) + "</div>"

    pages = "\n".join(f'<div class="holder"><section class="slide" data-title="{esc(p["title"])}"><img src="{esc(p["url"])}" alt="{esc(p["title"])}">{layer(i)}</section></div>' for i, p in enumerate(t.pages(lang if lang in ("en", "zh") else None)))
    return VIEWER.replace("__TITLE__", esc(t.path.name)).replace("__PAGES__", pages or "<p style='color:#fff'>" + tr("这个文件夹里没有图片", lang if lang in ("en", "zh") else None) + "</p>")


class Handler(BaseHTTPRequestHandler):
    server_version = "Redpen/" + __version__
    target = None
    port = 8765
    token = None     # set in --lan mode: other devices must present it
    lan_url = None

    def log_message(self, fmt, *args):
        if self.command != "GET":
            print(time.strftime("%H:%M:%S"), self.command, self.path.split("?")[0], args[1] if len(args) > 1 else "", flush=True)

    def send(self, code, body=b"", ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def loopback(self):
        return self.client_address[0] in ("127.0.0.1", "::1") and self.headers.get("Host", "") in {f"127.0.0.1:{self.port}", f"localhost:{self.port}"}

    def allowed(self):
        """This computer's own browser, or (in --lan mode) a device that opened the link with the token."""
        if self.loopback():
            return True
        if not self.token:
            return False
        c = SimpleCookie(self.headers.get("Cookie", "")).get("rvk")
        return bool(c) and hmac.compare_digest(c.value, self.token)

    def local(self):
        """Writes must come from this server's own page, not from another website."""
        origin = self.headers.get("Origin")
        return self.allowed() and (origin is None or urlparse(origin).netloc == self.headers.get("Host", ""))

    def body(self, limit):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if 0 < n <= limit else None

    def static(self, root, rel):
        root = root.resolve()
        f = (root / rel).resolve()
        if not (f == root or root in f.parents) or not f.is_file():
            return self.send(404, {"error": "not found"})
        ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json", "image/svg+xml"):
            ctype += "; charset=utf-8"
        self.send(200, f.read_bytes(), ctype)

    def do_GET(self):
        t, url = self.target, urlparse(self.path)
        path, lang = unquote(url.path), parse_qs(url.query).get("lang", [None])[0]
        if self.token and path == "/" and hmac.compare_digest(parse_qs(url.query).get("k", [""])[0], self.token):
            self.send_response(302)
            self.send_header("Set-Cookie", f"rvk={self.token}; Path=/; HttpOnly; SameSite=Strict")
            self.send_header("Location", "/")
            self.send_header("Content-Length", "0")
            return self.end_headers()
        if not self.allowed():
            return self.send(403, tr("需要从这台电脑打开，或用带口令的链接打开。"), "text/plain; charset=utf-8")
        if path in ("/", "/index.html"):
            return self.send(200, (TOOL / "app.html").read_bytes(), "text/html; charset=utf-8")
        if path == "/app.js":
            return self.send(200, (TOOL / "app.js").read_bytes(), "text/javascript; charset=utf-8")
        if path == "/viewer":
            return self.send(200, viewer_html(t, lang), "text/html; charset=utf-8")
        if path == "/api/info":
            return self.send(200, dict(t.info(), lan=self.lan_url if self.loopback() else None))
        if path == "/api/annotations":
            return self.send(200, t.ann.read_bytes() if t.ann.exists() else b"{}")
        if path == "/api/last":
            return self.send(200, t.last())
        if path == "/api/text":
            return self.send(200, t.markdown(lang=lang), "text/plain; charset=utf-8")
        if path == "/api/prompt":
            return self.send(200, t.prompt(lang), "text/plain; charset=utf-8")
        if path.startswith("/doc/"):
            return self.static(t.docroot, path[5:])
        if path.startswith("/pages/"):
            return self.static(t.review / "pages", Path(path).name)
        if path.startswith("/review/images/"):
            return self.static(t.images, Path(path).name)
        self.send(404, {"error": "not found"})

    do_HEAD = do_GET

    def do_POST(self):
        t = self.target
        if not self.local():
            return self.send(403, {"error": "forbidden"})
        url = urlparse(self.path)
        if url.path == "/api/annotations":
            try:
                data = json.loads(self.body(MAX_JSON))
                assert isinstance(data, dict) and isinstance(data.get("items"), list)
            except Exception:
                return self.send(400, {"error": "bad annotations"})
            base = data.pop("_base", None)
            if base is not None and t.ann.exists() and str(base) != t.rev():
                return self.send(409, {"error": "changed", "rev": t.rev(), "current": t.load() or {}})
            t.save(data)
            return self.send(200, {"ok": True, "items": len(data["items"]), "rev": t.rev()})
        if url.path == "/api/upload":
            name = Path(parse_qs(url.query).get("name", ["image.png"])[0]).name
            ext, raw = Path(name).suffix.lower(), self.body(MAX_FILE)
            if ext not in UPLOAD or raw is None:
                return self.send(400, {"error": "unsupported file"})
            stem = re.sub(r"[^0-9A-Za-z._-]+", "-", Path(name).stem).strip("-.")[:60] or "image"
            t.ensure()
            t.images.mkdir(parents=True, exist_ok=True)
            out, k = t.images / f"{time.strftime('%Y%m%d-%H%M%S')}-{stem}{ext}", 1
            while out.exists():
                out = t.images / f"{time.strftime('%Y%m%d-%H%M%S')}-{stem}-{k}{ext}"
                k += 1
            out.write_bytes(raw)
            return self.send(200, {"path": str(out), "url": f"/review/images/{quote(out.name)}"})
        if url.path == "/api/archive":
            dest = t.do_archive()
            return self.send(200, {"ok": True, "archived": str(dest) if dest else None})
        self.send(404, {"error": "not found"})


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except Exception:
        return socket.gethostname()
    finally:
        s.close()


def serve(t, port, open_browser, lan=False):
    t.ensure()
    if t.kind != "html":
        n = len(t.page_files())
        t.pdf_text()
        print(tr("{name}: {n} 页", name=t.path.name, n=n), flush=True)
    Handler.target = t
    srv = None
    for p in range(port, port + 30):
        try:
            srv = ThreadingHTTPServer(("0.0.0.0" if lan else "127.0.0.1", p), Handler)
            Handler.port = p
            break
        except OSError:
            continue
    if srv is None:
        raise SystemExit(tr("端口 {a}–{b} 都被占用了，用 --port 换一个", a=port, b=port + 29))
    url = f"http://127.0.0.1:{Handler.port}/"
    print(tr("Redpen: {url}\n  文件: {path}\n  标注: {ann}", url=url, path=t.path, ann=t.ann), flush=True)
    if lan:
        Handler.token = "".join(secrets.choice("abcdefghjkmnpqrstuvwxyz23456789") for _ in range(8))
        Handler.lan_url = f"http://{lan_ip()}:{Handler.port}/?k={Handler.token}"
        print(tr("  iPad 或其他设备（同一个 Wi-Fi 或 Tailscale）打开: {url}", url=Handler.lan_url), flush=True)
    print(tr("  按 Ctrl+C 停止"), flush=True)
    if open_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print(tr("\n已停止"))


def main(argv=None):
    global _lang, UI_LANG
    argv = list(sys.argv[1:] if argv is None else argv)
    cmd = argv.pop(0) if argv and argv[0] in ("serve", "show", "prompt", "archive", "import") else "serve"
    ap = argparse.ArgumentParser(prog="review.py", description="Mark up an HTML deck, HTML page, image or PDF; an AI agent applies the notes.")
    ap.add_argument("file", help="HTML file, PDF, image, or a folder of images")
    if cmd == "import":
        ap.add_argument("marked", help="the copy that was annotated elsewhere (PDF or image)")
    ap.add_argument("--lan", action="store_true", help="let other devices on the network open the page (iPad); the link carries a token")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8765")))
    ap.add_argument("--no-open", action="store_true", help="do not open the browser")
    ap.add_argument("--source", help="the file an agent should edit, when FILE is generated (relative to FILE's folder)")
    ap.add_argument("--build", help="command that regenerates FILE after the source was edited")
    ap.add_argument("--slides", help="CSS selector of one slide, when the deck is not detected")
    ap.add_argument("--notes", help="CSS selector of the speaker notes inside a slide")
    ap.add_argument("--title", help="CSS selector of the title inside a slide")
    ap.add_argument("--root", help="folder to serve, when the HTML loads files from a parent folder (relative to FILE's folder)")
    ap.add_argument("--page", action="store_true", help="treat an HTML file as one scrolling page, not slides")
    ap.add_argument("--summary", help="archive: one line on what was changed")
    ap.add_argument("--lang", choices=("en", "zh"), help="language of the review page and of what is printed here "
                    "(default: REDPEN_LANG, else the system language; the page has its own switch, which is remembered)")
    a = ap.parse_args(argv)
    env = (os.environ.get("REDPEN_LANG") or "").lower()[:2]
    if a.lang or env in ("en", "zh"):
        UI_LANG = _lang = a.lang or env
    opts = {k: getattr(a, k) for k in ("source", "build", "slides", "notes", "title", "root")}
    if a.page:
        opts["mode"] = "page"
    t = Target(a.file, opts)
    if cmd == "show":
        sys.stdout.write(t.markdown(lang=a.lang))
    elif cmd == "prompt":
        sys.stdout.write(t.prompt(a.lang))
    elif cmd == "import":
        import_marked(t, a.marked)
    elif cmd == "archive":
        dest = t.do_archive(a.summary)
        print(tr("已归档到 {dest}", dest=dest) if dest else tr("没有需要归档的标注"))
    else:
        serve(t, a.port, not a.no_open, a.lan)


if __name__ == "__main__":
    main()
