"""给 Termux 版 Node 与依赖库改动态链接信息。

Android 只认识 APK lib/<abi>/ 下无版本号的 lib*.so，且原来的 RUNPATH 指向
/data/data/com.termux/files/usr/lib，安装后不存在。这里把 DT_NEEDED 改成无版本名，
把 DT_RUNPATH 改成 $ORIGIN（同目录查找），不改任何代码段。
"""
import os
import sys

sys.path.insert(0, r"D:\红果短剧手机端\.tmp\pylibs")
from elftools.elf.elffile import ELFFile

DIR = sys.argv[1] if len(sys.argv) > 1 else r"D:\红果短剧手机端\.tmp\runtime-stage\jniLibs\arm64-v8a"

NEEDED = {
    "libz.so.1": "libz.so",
    "libcrypto.so.3": "libcrypto.so",
    "libssl.so.3": "libssl.so",
    "libicui18n.so.79": "libicui18n.so",
    "libicuuc.so.79": "libicuuc.so",
    "libicudata.so.79": "libicudata.so",
}
RUNPATH_OLD = "/data/data/com.termux/files/usr/lib"
RUNPATH_NEW = "$ORIGIN"


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


def main():
    files = [n for n in os.listdir(DIR) if n.endswith(".so")]
    for name in files:
        path = os.path.join(DIR, name)
        patch_strings(path, list(NEEDED.items()) + [(RUNPATH_OLD, RUNPATH_NEW)])
        print("patched", name, os.path.getsize(path))


if __name__ == "__main__":
    main()
