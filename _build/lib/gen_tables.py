# -*- coding: utf-8 -*-
"""Generate tables.js (bar-code symbol tables) from the python-barcode package.

Tables are ISO/IEC 15417 (Code 128), ISO/IEC 16388 (Code 39),
GS1 General Specifications (EAN/UPC), ISO/IEC 16390 (ITF) symbol data.
python-barcode is MIT licensed; only public standard tables are extracted.
"""
import io
import os
import sys

sys.path.insert(0, r"C:\Users\Mask\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\Lib\site-packages")

from barcode.charsets import ean as cean
from barcode.charsets import itf as citf
from barcode.charsets import code39 as c39
from barcode.charsets import code128 as c128

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "src", "tables.js")
os.makedirs(os.path.dirname(OUT), exist_ok=True)


def js_arr(items, per_line=6, indent="    "):
    out = []
    line = indent
    for i, it in enumerate(items):
        piece = '"%s",' % it
        if len(line) + len(piece) > 100:
            out.append(line.rstrip())
            line = indent
        line += piece
    if line.strip():
        out.append(line.rstrip().rstrip(","))
    return "[\n" + "\n".join(out) + "\n]"


def js_num_arr(nums, per_line=20, indent="    "):
    out = []
    line = indent
    for n in nums:
        piece = "%s," % n
        if len(line) + len(piece) > 100:
            out.append(line.rstrip())
            line = indent
        line += piece
    if line.strip():
        out.append(line.rstrip().rstrip(","))
    return "[\n" + "\n".join(out) + "\n]"


assert len(c128.CODES) == 106, len(c128.CODES)
assert len(c39.CODES) == 43, len(c39.CODES)
assert len(cean.LEFT_PATTERN) == 10

# Code 128 stop: python-barcode ships the 6 element body (11 modules); the
# specification appends a 2 module termination bar -> 13 modules total.
STOP = c128.STOP + "11"
assert len(STOP) == 13, len(STOP)

parts = []
parts.append("// ---- Symbol tables (generated; see lib/gen_tables.py) ----")
parts.append("// Code 128 (ISO/IEC 15417): 11 module patterns for values 0..105, +13 module STOP")
parts.append("var C128_CODE = " + js_arr(c128.CODES) + ";")
parts.append('var C128_STOP = "%s";' % STOP)
parts.append("var C128_START = { A: 103, B: 104, C: 105 };")
parts.append("var C128_TO = { A: 101, B: 100, C: 99 };")
parts.append("")
parts.append("// Code 39 (ISO/IEC 16388): 15 module patterns, 9 elements, 3 wide")
parts.append("var C39_CHARS = " + js_arr(list(c39.REF)) + ";")
parts.append("var C39_CODE = " + js_arr(c39.CODES) + ";")
parts.append('var C39_EDGE = "%s";' % c39.EDGE)
parts.append('var C39_GAP = "%s";' % c39.MIDDLE)
parts.append("")
parts.append("// EAN/UPC: 7 module digit patterns, A = odd parity, B = even parity, C = right")
parts.append("var EAN_A = " + js_arr(list(cean.CODES["A"])) + ";")
parts.append("var EAN_B = " + js_arr(list(cean.CODES["B"])) + ";")
parts.append("var EAN_C = " + js_arr(list(cean.CODES["C"])) + ";")
parts.append("var EAN_LEFT_PARITY = " + js_arr(list(cean.LEFT_PATTERN)) + ";")
parts.append('var EAN_EDGE = "%s";' % cean.EDGE)
parts.append('var EAN_MIDDLE = "%s";' % cean.MIDDLE)
parts.append("")
parts.append("// Interleaved 2 of 5 (ISO/IEC 16390)")
parts.append("var ITF_CODE = " + js_arr(list(citf.CODES)) + ";")
parts.append('var ITF_START = "%s";' % citf.START)
parts.append('var ITF_STOP = "%s";' % citf.STOP)

text = "\n".join(parts) + "\n"
with io.open(OUT, "w", encoding="ascii", newline="\n") as f:
    f.write(text)
print("wrote", OUT, len(text), "bytes")
print(text[:400])
