"""Read the CLR managed-resource directory without loading or executing the PE."""
import argparse
import hashlib
import struct
import xml.etree.ElementTree as ET
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('executable', type=Path)
parser.add_argument('msi', type=Path)
args = parser.parse_args()
data = args.executable.read_bytes()
package = args.msi.read_bytes()
u16 = lambda offset: struct.unpack_from('<H', data, offset)[0]
u32 = lambda offset: struct.unpack_from('<I', data, offset)[0]
pe = u32(0x3c)
if data[pe:pe+4] != b'PE\0\0':
    raise SystemExit('Not a PE executable')
sections, optional_size = u16(pe+6), u16(pe+20)
optional = pe+24
magic = u16(optional)
if magic not in (0x10b, 0x20b):
    raise SystemExit('Unsupported PE optional header')
directories = optional+(112 if magic == 0x20b else 96)
section_table = optional+optional_size

def file_offset(rva):
    for index in range(sections):
        entry = section_table+index*40
        virtual_size, virtual_address, raw_size, raw_address = struct.unpack_from('<IIII', data, entry+8)
        if virtual_address <= rva < virtual_address+max(virtual_size, raw_size):
            offset = raw_address+rva-virtual_address
            if offset >= len(data):
                break
            return offset
    raise ValueError('RVA is outside PE sections')

cli = file_offset(u32(directories+14*8))
resource_rva, resource_size = struct.unpack_from('<II', data, cli+24)
resource_start = file_offset(resource_rva)
resource_end = resource_start+resource_size
if resource_end > len(data):
    raise SystemExit('Truncated managed resources')
resources = data[resource_start:resource_end]
# Each embedded CLR resource has a 32-bit byte length followed by its bytes.
needle = struct.pack('<I', len(package))+package
if resources.count(needle) != 1:
    raise SystemExit('Expected exactly one complete MSI in the CLR embedded-resource directory')

# Read RT_MANIFEST directly from the native resource directory; never load the executable.
native_start = file_offset(u32(directories+2*8))
def resource_entries(relative):
    directory = native_start+relative
    count = u16(directory+12)+u16(directory+14)
    return [struct.unpack_from('<II', data, directory+16+i*8) for i in range(count)]

manifest_type = next((offset & 0x7fffffff for name, offset in resource_entries(0) if name == 24), None)
if manifest_type is None:
    raise SystemExit('Missing embedded application manifest')
_, name_offset = resource_entries(manifest_type)[0]
_, language_offset = resource_entries(name_offset & 0x7fffffff)[0]
manifest_rva, manifest_size = struct.unpack_from('<II', data, native_start+language_offset)
manifest_start = file_offset(manifest_rva)
manifest = ET.fromstring(data[manifest_start:manifest_start+manifest_size])
def manifest_text(namespace, name):
    element = manifest.find('.//{'+namespace+'}'+name)
    return None if element is None else element.text
if manifest_text('http://schemas.microsoft.com/SMI/2016/WindowsSettings', 'dpiAwareness') != 'PerMonitorV2, PerMonitor':
    raise SystemExit('Embedded manifest must declare PerMonitorV2, PerMonitor')
if manifest_text('http://schemas.microsoft.com/SMI/2005/WindowsSettings', 'dpiAware') != 'true/pm':
    raise SystemExit('Embedded manifest is missing its DPI fallback')
execution = manifest.find('.//{urn:schemas-microsoft-com:asm.v3}requestedExecutionLevel')
if execution is None or execution.get('level') != 'asInvoker' or execution.get('uiAccess') != 'false':
    raise SystemExit('Setup must retain asInvoker without UIAccess')
print('Embedded MSI SHA256 verified: '+hashlib.sha256(package).hexdigest())
print('Embedded native manifest verified: PerMonitorV2, PerMonitor; true/pm; asInvoker, UIAccess=false')
