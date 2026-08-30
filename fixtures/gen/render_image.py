"""Render invoice lines to a PNG that looks like a scanned page. Used by generate-pdfs.ts.
usage: render_image.py out.png dpi rotate noise "line1|line2|..."
"""
# WHAT THIS FILE DOES
#
# Paints the text of an invoice onto a blank white page image, so the result looks like a paper invoice that went
# through a scanner. generate-pdfs.ts then wraps that picture in a PDF with no text layer, which forces the
# application to use OCR (text recognition from an image) to read it. Optionally the page is degraded the way real
# scans are: slightly blurred, sprinkled with dark specks, tilted a degree or so, or turned on its side.
# "dpi" (dots per inch) is the scan resolution - higher means sharper text; 200 is a normal office scanner,
# 110-120 is fax quality. The same recipe always produces the same page on the same machine, but fonts and the
# imaging library differ between machines, so the exact pixels (and hence the file's fingerprint) may not.
import sys, random, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

# A real typeface is needed to draw legible text. Try the common locations on each operating system;
# FIXTURE_FONT lets a machine with fonts elsewhere point at one explicitly.
FONT_CANDIDATES = [
    os.environ.get('FIXTURE_FONT', ''),
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',            # Debian/Ubuntu
    '/usr/share/fonts/dejavu/DejaVuSans.ttf',                     # Fedora
    '/opt/homebrew/share/fonts/DejaVuSans.ttf',                   # macOS (brew font-dejavu)
    '/System/Library/Fonts/Supplemental/Arial.ttf',               # macOS system
    'C:/Windows/Fonts/arial.ttf',
]
def load_font(size):
    for f in FONT_CANDIDATES:
        if f and os.path.exists(f):
            return ImageFont.truetype(f, size)
    sys.exit('render_image.py: no TrueType font found; set FIXTURE_FONT=/path/to/font.ttf')
# Read the instructions passed by generate-pdfs.ts: output file, resolution, rotation in degrees,
# whether to add noise ("1" = yes), and the invoice text with "|" between lines.
out, dpi, rotate, noise, text = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4] == '1', sys.argv[5]
# Step 1: a blank white US-Letter page (8.5 x 11 inches) at the requested resolution, in greyscale like a scan.
w, h = int(8.5 * dpi), int(11 * dpi)
img = Image.new('L', (w, h), 255)
d = ImageDraw.Draw(img)
# Step 2: type the invoice lines in black, starting one inch from the top-left corner, with text sized in
# proportion to the resolution (so it is the same physical size on the page whatever the dpi).
font = load_font(int(dpi * 0.16))
y = int(dpi * 1.0)
for line in text.split('|'):
    d.text((int(dpi * 1.0), y), line, font=font, fill=0)
    y += int(dpi * 0.3)
# Step 3 (only for "noisy" fixtures): make the page look like a poor photocopy.
if noise:
    # 3a. Blur: softens the letter edges, as an out-of-focus or low-quality scanner does. Letters like 0/O and 5/S
    #     start to look alike, which is exactly what tests the OCR's honesty.
    img = img.filter(ImageFilter.GaussianBlur(radius=dpi / 150))
    # 3b. Speckle: scatter dark dots over about 1% of the page - the dust and toner spots of a real scan.
    #     OCR must not mistake specks for punctuation or parts of letters.
    px = img.load()
    for _ in range(int(w * h * 0.01)):
        x, yy = random.randrange(w), random.randrange(h)
        px[x, yy] = random.randrange(0, 120)
    # 3c. Skew: tilt the page 1.5 degrees, as happens when paper is fed into a scanner slightly crooked.
    #     Lines of text are then no longer perfectly horizontal; OCR must cope.
    img = img.rotate(1.5, fillcolor=255)   # slight skew
# Step 4 (only when a rotation was requested): turn the whole page, e.g. 90 degrees for a page scanned sideways.
# Unlike a rotated native PDF, nothing in the file says it is rotated - the software has to notice on its own.
if rotate:
    img = img.rotate(rotate, expand=True, fillcolor=255)
# Step 5: save the picture, recording the dpi so the PDF knows the intended physical page size.
img.save(out, dpi=(dpi, dpi))
