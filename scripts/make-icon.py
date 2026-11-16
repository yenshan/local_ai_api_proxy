"""Render the sidebar's centered command icon with no external dependencies."""
import math
from pathlib import Path
import struct
import subprocess
import zlib

root = Path(__file__).resolve().parent.parent
folder = root / 'build'
folder.mkdir(exist_ok=True)
# Match the 30px sidebar tile and its 22px SVG (viewBox 0 0 24 24).
tile_scale = 850 / 30
glyph_scale = 22 * tile_scale / 24
segments = [(8, 5.5, 8, 18.5), (16, 5.5, 16, 18.5),
            (5.5, 8, 18.5, 8), (5.5, 16, 18.5, 16)]
loops = [(5.5, 5.5, 1, 1), (18.5, 5.5, -1, 1),
         (18.5, 18.5, -1, -1), (5.5, 18.5, 1, -1)]

def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))

def rounded_distance(x, y):
    radius = 11 * tile_scale
    qx, qy = abs(x - 512) - (425 - radius), abs(y - 512) - (425 - radius)
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - radius

def segment_distance(x, y, line):
    ax, ay, bx, by = line
    dx, dy = bx - ax, by - ay
    t = max(0, min(1, ((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy)))
    return math.hypot(x-ax-t*dx, y-ay-t*dy)

def glyph_distance(x, y):
    x, y = (x - 512) / glyph_scale + 12, (y - 512) / glyph_scale + 12
    distance = min(segment_distance(x, y, line) for line in segments)
    for cx, cy, sx, sy in loops:
        dx, dy = x - cx, y - cy
        # Each loop follows the SVG's outer 270-degree arc.
        if dx * sx > 0 and dy * sy > 0:
            arc = min(math.hypot(dx - sx * 2.5, dy),
                      math.hypot(dx, dy - sy * 2.5))
        else:
            arc = abs(math.hypot(dx, dy) - 2.5)
        distance = min(distance, arc)
    return distance * glyph_scale

pixels = bytearray()
for y in range(1024):
    pixels.append(0)
    for x in range(1024):
        distance = rounded_distance(x + .5, y + .5)
        alpha = round(255 * max(0, min(1, .5-distance)))
        rgb = (220, 239, 229)
        if alpha:
            border = max(0, min(1, distance + tile_scale + .5))
            rgb = tuple(round(c + (a-c)*border) for c,a in zip(rgb,(215,226,219)))
            glyph = glyph_distance(x + .5, y + .5)
            blend = max(0, min(1, .9 * glyph_scale + .5 - glyph))
            rgb = tuple(round(c+(a-c)*blend) for c,a in zip(rgb,(35,115,78)))
        pixels.extend((*rgb, alpha))
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB',1024,1024,8,6,0,0,0)) + chunk(b'IDAT',zlib.compress(pixels,9)) + chunk(b'IEND',b'')
source = folder / 'icon.png'
source.write_bytes(png)
iconset = folder / 'icon.iconset'
iconset.mkdir(exist_ok=True)
for size in (16,32,128,256,512):
    for factor in (1,2):
        target = iconset / f'icon_{size}x{size}{"@2x" if factor==2 else ""}.png'
        subprocess.run(['sips','-z',str(size*factor),str(size*factor),str(source),'--out',str(target)],check=True,capture_output=True)
icns = bytearray()
for kind, filename in [(b'icp4','icon_16x16.png'), (b'icp5','icon_32x32.png'), (b'icp6','icon_32x32@2x.png'), (b'ic07','icon_128x128.png'), (b'ic08','icon_256x256.png'), (b'ic09','icon_512x512.png'), (b'ic10','icon_512x512@2x.png')]:
    data = (iconset / filename).read_bytes()
    icns.extend(kind + struct.pack('>I', len(data) + 8) + data)
(folder/'icon.icns').write_bytes(b'icns' + struct.pack('>I', len(icns) + 8) + icns)
print(folder/'icon.icns')
