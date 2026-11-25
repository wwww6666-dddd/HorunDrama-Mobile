"""给 Termux 版 Node / 依赖库 / ffmpeg 改动态链接信息。

Android 只认 APK lib/<abi>/ 下无版本号的 lib*.so，且原来的 RUNPATH 指向
/data/data/com.termux/files/usr/lib，安装后不存在。这里把 DT_NEEDED 改成无版本名
（例如 libssl.so.3 → libssl.so），把 DT_RUNPATH 改成 $ORIGIN，不改代码段。

用法：python patch_elf.py <jniLibs/<abi> 目录>
"""
import os
import re
import struct
import sys

sys.path.insert(0, r"D:\红果短剧手机端\.tmp\pylibs")
from elftools.elf.elffile import ELFFile

DIR = sys.argv[1] if len(sys.argv) > 1 else r"D:\红果短剧手机端\.tmp\runtime-stage\jniLibs\arm64-v8a"
RUNPATH_OLD = [
    "/data/data/com.termux/files/usr/lib",
    "/data/user/0/com.termux/files/usr/lib",
]
RUNPATH_NEW = "$ORIGIN"
VERSIONED = re.compile(r"^(lib.+?\.so)\.\d+$")


def dynamic_needed(path):
    with open(path, "rb") as f:
        elf = ELFFile(f)
        dyn = elf.get_section_by_name(".dynamic")
        if dyn is None:
            return []
        return [t.needed for t in dyn.iter_tags() if t.entry.d_tag == "DT_NEEDED"]


def dynamic_soname(path):
    with open(path, "rb") as f:
        elf = ELFFile(f)
        dyn = elf.get_section_by_name(".dynamic")
        if dyn is None:
            return None
        for tag in dyn.iter_tags():
            if tag.entry.d_tag == "DT_SONAME":
                return tag.soname
    return None


def patch_strings(path, replacements):
    with open(path, "rb+") as f:
        elf = ELFFile(f)
        section = elf.get_section_by_name(".dynstr")
        if section is None:
            raise RuntimeError("没有 .dynstr: " + path)
        data = bytearray(section.data())
        for old, new in replacements:
            if len(new) > len(old):
                raise RuntimeError("新字符串更长: " + old)
            old_bytes = old.encode("utf-8") + b"\x00"
            start = 0
            while True:
                index = data.find(old_bytes, start)
                if index < 0:
                    break
                data[index:index + len(old_bytes)] = (
                    new.encode("utf-8") + b"\x00" + b"\x00" * (len(old) - len(new))
                )
                start = index + len(old_bytes)
        f.seek(section["sh_offset"])
        f.write(data)


def elf_hash(name):
    value = 0
    for byte in name:
        value = (value << 4) + byte
        high = value & 0xF0000000
        if high:
            value ^= high >> 24
        value &= ~high
    return value & 0xFFFFFFFF


def patch_version_needs(path):
    """DT_NEEDED 改名后，.gnu.version_r 里每条 Vernaux 的 vna_hash 必须同步重算。

    链接器是按 vna_hash 去 DT_NEEDED 里找文件的，只改字符串不改 hash 会报
    "cannot find libcrypto.so from verneed[0] in DT_NEEDED list"。
    vna_hash 在 Elf_Vernaux 开头，父文件名在 Elf_Verneed.vn_file。
    """
    with open(path, "rb+") as f:
        elf = ELFFile(f)
        dynstr = elf.get_section_by_name(".dynstr")
        section = elf.get_section_by_name(".gnu.version_r")
        if dynstr is None or section is None:
            return
        strings = dynstr.data()
        data = bytearray(section.data())
        offset = 0
        while offset + 16 <= len(data):
            version, count, file_offset, aux_offset, next_offset = struct.unpack_from("<HHIII", data, offset)
            if file_offset >= len(strings):
                break
            name = strings[file_offset:].split(b"\x00", 1)[0]
            aux = offset + aux_offset
            for _ in range(count):
                if aux + 16 > len(data):
                    break
                struct.pack_into("<I", data, aux, elf_hash(name))
                aux_next = struct.unpack_from("<I", data, aux + 12)[0]
                if aux_next == 0:
                    break
                aux += aux_next
            if next_offset == 0:
                break
            offset += next_offset
        f.seek(section["sh_offset"])
        f.write(data)


def clear_symbol_versions(path):
    """把所有符号版本改成 VER_NDX_GLOBAL(1)。

    Termux 的 x86_64 Node 带 LIBC/OPENSSL_3.x 符号版本；Bionic 不实现 ELF
    符号版本，链接器会报 cannot locate symbol "free"。清成全局后按名字解析。
    """
    with open(path, "rb+") as f:
        elf = ELFFile(f)
        section = elf.get_section_by_name(".gnu.version")
        if section is None:
            return
        count = len(section.data()) // 2
        data = b"\x01\x00" * count
        f.seek(section["sh_offset"])
        f.write(data)


def main():
    files = [n for n in os.listdir(DIR) if n.endswith(".so")]
    for name in files:
        path = os.path.join(DIR, name)
        replacements = []
        for needed in dynamic_needed(path):
            match = VERSIONED.match(needed)
            if not match:
                continue
            target = match.group(1)
            if os.path.exists(os.path.join(DIR, target)):
                replacements.append((needed, target))
        # 库自身的 SONAME 也要改成文件名，否则链接器按 SONAME 登记后，
        # 别的库用无版本名 DT_NEEDED 找它时会找不到。
        soname = dynamic_soname(path)
        if soname:
            match = VERSIONED.match(soname)
            if match:
                replacements.append((soname, name))
        for old in RUNPATH_OLD:
            replacements.append((old, RUNPATH_NEW))
        patch_strings(path, replacements)
        patch_version_needs(path)
        clear_symbol_versions(path)
        print("patched", name, os.path.getsize(path))


if __name__ == "__main__":
    main()
