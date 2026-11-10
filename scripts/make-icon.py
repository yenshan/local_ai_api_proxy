"""Render the app's code-bracket icon with no external Python dependencies."""
import math
from pathlib import Path
import struct
import subprocess
import zlib

root = Path(__file__).resolve().parent.parent
folder = root / 'build'
folder.mkdir(exist_ok=True)
segments = [(395, 335, 255, 512), (255, 512, 395, 689),
            (629, 335, 769, 512), (769, 512, 629, 689), (567, 305, 457, 719)]

def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))

def rounded_distance(x, y):
    qx, qy = abs(x - 512) - 235, abs(y - 512) - 235
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - 190

def segment_distance(x, y, line):
    ax, ay, bx, by = line
    dx, dy = bx - ax, by - ay
    t = max(0, min(1, ((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy)))
    return math.hypot(x-ax-t*dx, y-ay-t*dy)

pixels = bytearray()
for y in range(1024):
    pixels.append(0)
    for x in range(1024):
        distance = rounded_distance(x, y)
        alpha = round(255 * max(0, min(1, .5-distance)))
        rgb = (20, 35, 27)
        if alpha:
            if distance > -5: rgb = (57, 84, 65)
            else:
                glyph = min(segment_distance(x, y, line) for line in segments)
                blend = max(0, min(1, 23.5-glyph))
                rgb = tuple(round(c+(a-c)*blend) for c,a in zip(rgb,(167,234,208)))
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
