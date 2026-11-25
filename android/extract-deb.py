"""解开 .deb（ar 归档）里的 data.tar.*，不依赖 dpkg/7zip。

用法：python extract-deb.py <deb> <目标目录>
"""
import io
import os
import sys
import tarfile


def main() -> int:
    if len(sys.argv) != 3:
        print("用法: extract-deb.py <deb> <dest>")
        return 2
    deb, dest = sys.argv[1], sys.argv[2]
    os.makedirs(dest, exist_ok=True)
    with open(deb, "rb") as f:
        if f.read(8) != b"!<arch>\n":
            raise SystemExit("不是 ar/deb 文件: " + deb)
        while True:
            header = f.read(60)
            if len(header) < 60:
                break
            name = header[0:16].decode("utf-8", "replace").strip().rstrip("/")
            size = int(header[48:58].decode("ascii").strip())
            data_offset = f.tell()
            if name.startswith("data.tar"):
                payload = f.read(size)
                with tarfile.open(fileobj=io.BytesIO(payload), mode="r:*") as tar:
                    tar.extractall(dest, filter="data")
                print(f"extracted {name} -> {dest}")
                return 0
            f.seek(data_offset + size + (size % 2))
    raise SystemExit("deb 里没有 data.tar.*: " + deb)


if __name__ == "__main__":
    sys.exit(main())
